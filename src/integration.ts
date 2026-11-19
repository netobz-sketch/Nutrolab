/**
 * API de integração servidor a servidor para o LN Evolution.
 * Contrato: docs/INTEGRACAO-LN-EVOLUTION.md.
 *
 * - Autenticação por `X-Integration-Token` comparado em tempo constante com
 *   `INTEGRATION_TOKEN`. Sem token configurado, todas as rotas respondem 404.
 * - Isenta da checagem de `ALLOWED_HOSTS` (ver hook em app.ts): chega pela rede
 *   interna do Docker com host `nutrolab:8090`. No Caddy público o prefixo é
 *   bloqueado, então o token nunca é aceito pela internet.
 * - Só leitura dos dados clínicos já produzidos pelo motor; as escritas são a
 *   criação de caso em branco (status `aberto`, `created_by` null, ligado ao
 *   paciente pelo `code`) e o envio de anexos ao caso (v2).
 * - Nunca devolve nome de paciente: o DTO não tem o campo e os relatórios em
 *   Markdown têm a linha de identificação reduzida ao código.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { allRules, audit, getAsyncDb, num, numOrNull, str, strOrNull, type Row } from './db.js';
import { CONTEXTS, evaluateAll, SYSTEMS, type Evaluation, type Rule, type Score } from './engine/index.js';
import { appUrl } from './mail.js';
import { loadCase, loadResults, printAnalysisHtml, profileOf, storeCaseFile, toInputs } from './routes/cases.routes.js';
import type { CaseRow } from './views/pages.js';

/* ----------------------------------------------------------------- DTOs */

export type SystemStatus = 'otimo' | 'adequado' | 'atencao' | 'alterado' | 'sem_dados';

export interface IntegrationAnalysisSummary {
  id: number;
  caseId: number;
  createdAt: string;
  finalizedAt: string | null;
  score: number | null;
  aiUsed: boolean;
  url: string;
}

export interface IntegrationCase {
  id: number;
  patientCode: string;
  status: 'aberto' | 'revisado' | 'arquivado';
  sex: 'M' | 'F' | null;
  birthDate: string | null;
  goal: string;
  createdAt: string;
  updatedAt: string;
  filesCount: number;
  resultsCount: number;
  latestAnalysis: IntegrationAnalysisSummary | null;
  url: string;
}

export interface IntegrationScoreBySystem {
  system: string;
  label: string;
  score: number | null;
  status: SystemStatus;
}

export interface IntegrationMarker {
  exam: string;
  label: string;
  system: string;
  value: number | null;
  valueRaw: string;
  unit: string | null;
  collectionDate: string | null;
  classification: string | null;
  labFlag: string | null;
  confidence: string;
}

export interface IntegrationAnalysis extends IntegrationAnalysisSummary {
  patientCode: string;
  scoreBySystem: IntegrationScoreBySystem[];
  markers: IntegrationMarker[];
  highlights: { favorable: string[]; attention: string[] };
  approvedConductCount: number;
  patientReportMarkdown: string | null;
  technicalReportMarkdown: string | null;
}

export interface IntegrationMarkerPoint {
  date: string;
  value: number;
  classification: string | null;
  analysisId: number;
  caseId: number;
}

export interface IntegrationMarkerSeries {
  exam: string;
  label: string;
  unit: string | null;
  system: string;
  points: IntegrationMarkerPoint[];
}

/* ------------------------------------------------------------ utilidades */

const APP_VERSION: string = (() => {
  try {
    const raw = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

/** Comparação em tempo constante: hashes SHA-256 igualam o tamanho antes do timingSafeEqual. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  return crypto.timingSafeEqual(sha256(presented), sha256(expected));
}

function caseUrl(caseId: number): string {
  return `${appUrl()}/casos/${caseId}`;
}
function analysisUrl(caseId: number, analysisId: number): string {
  return `${appUrl()}/casos/${caseId}/analises/${analysisId}`;
}

/** `datetime('now')` do SQLite vem como "AAAA-MM-DD HH:MM:SS" em UTC; devolve ISO. */
function isoTimestamp(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  return m ? `${m[1]}T${m[2]}Z` : value;
}

/**
 * Faixas de status por sistema, derivadas do score 0–100 que o motor já calculou
 * por sistema (`Score.bySystem[].score`): ≥85 ótimo · ≥70 adequado · ≥50 atenção ·
 * <50 alterado. Sistema sem item pontuado → `sem_dados` (score null).
 */
export function systemStatus(score: number | null): SystemStatus {
  if (score === null) return 'sem_dados';
  if (score >= 85) return 'otimo';
  if (score >= 70) return 'adequado';
  if (score >= 50) return 'atencao';
  return 'alterado';
}

function parseScore(raw: string | null): Score | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Score>;
    if (!parsed || !Array.isArray(parsed.bySystem)) return null;
    return { total: typeof parsed.total === 'number' ? parsed.total : null, counted: typeof parsed.counted === 'number' ? parsed.counted : 0, bySystem: parsed.bySystem, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return null;
  }
}

/** Nome legível e sistema do catálogo (primeiro alias; regra ativa tem prioridade). */
interface CatalogEntry { label: string; system: string }
function catalogIndex(rules: Rule[]): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  const sorted = [...rules].sort((a, b) => (a.status === 'ativo' ? 0 : 1) - (b.status === 'ativo' ? 0 : 1));
  for (const r of sorted) {
    if (map.has(r.exam_canonical)) continue;
    map.set(r.exam_canonical, { label: r.aliases[0] ?? r.exam_canonical, system: r.system || 'outros' });
  }
  return map;
}

function markerOf(ev: Evaluation, catalog: Map<string, CatalogEntry>): IntegrationMarker {
  const exam = ev.exam_canonical ?? ev.result.exam_raw;
  const entry = ev.exam_canonical ? catalog.get(ev.exam_canonical) : undefined;
  return {
    exam,
    label: entry?.label ?? ev.result.exam_raw,
    system: ev.rule?.system ?? entry?.system ?? 'outros',
    value: ev.parsed.kind === 'numeric' ? ev.parsed.number : null,
    valueRaw: ev.result.value_raw,
    unit: ev.unit ?? ev.result.unit_raw,
    collectionDate: ev.result.collection_date,
    classification: ev.exam_canonical ? ev.classification : null,
    labFlag: ev.result.lab_flag,
    confidence: ev.result.confidence,
  };
}

/** Classificação de cada linha de `results` do caso (não excluídas) pelas regras ATIVAS do motor. */
async function evaluateCaseResults(c: CaseRow): Promise<Evaluation[]> {
  const results = (await loadResults(c.id)).filter((r) => !r.excluded);
  return evaluateAll(toInputs(results), (await allRules()), profileOf(c));
}

const MAX_HIGHLIGHTS = 6;
const MAX_HIGHLIGHT_CHARS = 160;

function sectionBody(markdown: string, title: string): string {
  const re = new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  return re.exec(markdown)?.[1] ?? '';
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Frases curtas de uma seção do relatório: quebra por frase, até 6, cada uma ≤ 160 caracteres. */
export function sentencesOf(sectionMarkdown: string): string[] {
  const out: string[] = [];
  for (const line of sectionMarkdown.split('\n')) {
    const clean = stripMarkdown(line);
    if (!clean) continue;
    for (const sentence of clean.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9"(])/)) {
      const s = sentence.trim();
      if (!s) continue;
      out.push(s.length > MAX_HIGHLIGHT_CHARS ? `${s.slice(0, MAX_HIGHLIGHT_CHARS - 1).replace(/\s+\S*$/, '')}…` : s);
      if (out.length >= MAX_HIGHLIGHTS) return out;
    }
  }
  return out;
}

export function highlightsOf(markdown: string): { favorable: string[]; attention: string[] } {
  return { favorable: sentencesOf(sectionBody(markdown, 'Pontos favoráveis')), attention: sentencesOf(sectionBody(markdown, 'Pontos que merecem atenção')) };
}

/**
 * Os relatórios trazem o nome do paciente na linha de identificação. A integração
 * é pseudônima (o LN Evolution identifica pelo UUID), então a linha fica só com o
 * código e qualquer outra ocorrência do nome é substituída.
 */
export function redactPatientName(markdown: string | null, patientName: string, patientCode: string): string | null {
  if (markdown === null) return null;
  let out = markdown.replace(/^- Paciente: .*?\(código (.*?)\)$/m, '- Paciente: código $1').replace(/\*\*Paciente:\*\* [^·\n]*· /g, '');
  const name = patientName.trim();
  if (name.length >= 3) out = out.split(name).join(`código ${patientCode}`);
  return out;
}

/* ------------------------------------------------------------- consultas */

interface AnalysisRecord {
  id: number;
  caseId: number;
  createdAt: string;
  finalizedAt: string | null;
  score: number | null;
  aiUsed: boolean;
  scoreJson: string | null;
  markdownPatient: string | null;
  finalPatient: string | null;
  finalTechnical: string | null;
}

const ANALYSIS_COLS = 'id, case_id, created_at, finalized_at, score, ai_used, score_json, markdown_patient, final_patient, final_technical';

function rowToAnalysis(a: Row): AnalysisRecord {
  return {
    id: num(a, 'id'),
    caseId: num(a, 'case_id'),
    createdAt: str(a, 'created_at'),
    finalizedAt: strOrNull(a, 'finalized_at'),
    score: numOrNull(a, 'score'),
    aiUsed: num(a, 'ai_used') === 1,
    scoreJson: strOrNull(a, 'score_json'),
    markdownPatient: strOrNull(a, 'markdown_patient'),
    finalPatient: strOrNull(a, 'final_patient'),
    finalTechnical: strOrNull(a, 'final_technical'),
  };
}

function summaryOf(a: AnalysisRecord): IntegrationAnalysisSummary {
  return { id: a.id, caseId: a.caseId, createdAt: isoTimestamp(a.createdAt) ?? a.createdAt, finalizedAt: isoTimestamp(a.finalizedAt), score: a.score, aiUsed: a.aiUsed, url: analysisUrl(a.caseId, a.id) };
}

async function analysesOfCase(caseId: number): Promise<AnalysisRecord[]> {
  return ((await getAsyncDb().prepare(`SELECT ${ANALYSIS_COLS} FROM analyses WHERE case_id = ? ORDER BY id DESC`).all(caseId)) as Row[]).map(rowToAnalysis);
}

async function analysisById(id: number): Promise<AnalysisRecord | null> {
  const row = (await getAsyncDb().prepare(`SELECT ${ANALYSIS_COLS} FROM analyses WHERE id = ?`).get(id)) as Row | undefined;
  return row ? rowToAnalysis(row) : null;
}

interface CaseCounts { filesCount: number; resultsCount: number; updatedAt: string }
async function caseCounts(caseId: number): Promise<CaseCounts> {
  const row = (await getAsyncDb()
    .prepare('SELECT updated_at, (SELECT COUNT(*) FROM case_files f WHERE f.case_id = c.id) AS files_count, (SELECT COUNT(*) FROM results r WHERE r.case_id = c.id AND r.excluded = 0) AS results_count FROM cases c WHERE c.id = ?')
    .get(caseId)) as Row | undefined;
  return { filesCount: row ? num(row, 'files_count') : 0, resultsCount: row ? num(row, 'results_count') : 0, updatedAt: row ? str(row, 'updated_at') : '' };
}

function caseStatus(status: string): IntegrationCase['status'] {
  return status === 'revisado' || status === 'arquivado' ? status : 'aberto';
}

async function toIntegrationCase(c: CaseRow, analyses: AnalysisRecord[]): Promise<IntegrationCase> {
  const counts = await caseCounts(c.id);
  const latest = analyses[0];
  return {
    id: c.id,
    patientCode: c.patient_code,
    status: caseStatus(c.status),
    sex: c.sex === 'M' || c.sex === 'F' ? c.sex : null,
    birthDate: c.birth_date,
    goal: c.goal,
    createdAt: isoTimestamp(c.created_at) ?? c.created_at,
    updatedAt: isoTimestamp(counts.updatedAt) ?? counts.updatedAt,
    filesCount: counts.filesCount,
    resultsCount: counts.resultsCount,
    latestAnalysis: latest ? summaryOf(latest) : null,
    url: caseUrl(c.id),
  };
}

async function casesOfPatient(patientCode: string): Promise<CaseRow[]> {
  const ids = ((await getAsyncDb().prepare('SELECT id FROM cases WHERE patient_code = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC').all(patientCode)) as Row[]).map((r) => num(r, 'id'));
  const out: CaseRow[] = [];
  for (const id of ids) {
    const c = await loadCase(id);
    if (c) out.push(c);
  }
  return out;
}

async function buildAnalysis(c: CaseRow, a: AnalysisRecord): Promise<IntegrationAnalysis> {
  const catalog = catalogIndex((await allRules()));
  const evals = await evaluateCaseResults(c);
  const markers = evals.map((ev) => markerOf(ev, catalog));
  const stored = parseScore(a.scoreJson);
  const scored = new Map((stored?.bySystem ?? []).map((s) => [s.system, s]));
  const systems = new Set<string>([...scored.keys(), ...markers.map((m) => m.system)]);
  const scoreBySystem: IntegrationScoreBySystem[] = [...systems]
    .map((system) => {
      const s = scored.get(system);
      const score = s && s.n > 0 ? s.score : null;
      return { system, label: s?.label ?? SYSTEMS[system] ?? system, score, status: systemStatus(score) };
    })
    .sort((x, y) => x.label.localeCompare(y.label, 'pt-BR'));
  const finalized = a.finalizedAt !== null;
  const highlightSource = (finalized ? a.finalPatient : null) ?? a.markdownPatient ?? '';
  const approved = (await getAsyncDb().prepare("SELECT COUNT(*) AS n FROM conduct_items WHERE analysis_id = ? AND status = 'aprovada'").get(a.id)) as Row;
  return {
    ...summaryOf(a),
    patientCode: c.patient_code,
    scoreBySystem,
    markers,
    highlights: highlightsOf(highlightSource),
    approvedConductCount: num(approved, 'n'),
    patientReportMarkdown: finalized ? redactPatientName(a.finalPatient, c.patient_name, c.patient_code) : null,
    technicalReportMarkdown: finalized ? redactPatientName(a.finalTechnical, c.patient_name, c.patient_code) : null,
  };
}

const DEFAULT_SERIES_LIMIT = 12;
const MAX_SERIES_LIMIT = 50;

/**
 * Séries por exame canônico ao longo das análises FINALIZADAS do paciente. Um ponto
 * por data de coleta (ou data da análise quando a coleta não foi informada); a mesma
 * data não se repete — vale o ponto da análise mais recente. Só pontos numéricos.
 */
async function markerSeries(patientCode: string, exams: Set<string> | null, limit: number): Promise<IntegrationMarkerSeries[]> {
  const catalog = catalogIndex((await allRules()));
  type Acc = { exam: string; label: string; unit: string | null; system: string; byDate: Map<string, IntegrationMarkerPoint> };
  const acc = new Map<string, Acc>();
  for (const c of await casesOfPatient(patientCode)) {
    const finalizedAnalyses = (await analysesOfCase(c.id)).filter((a) => a.finalizedAt !== null).sort((x, y) => x.id - y.id);
    if (!finalizedAnalyses.length) continue;
    const evals = await evaluateCaseResults(c);
    for (const a of finalizedAnalyses) {
      for (const ev of evals) {
        const marker = markerOf(ev, catalog);
        if (marker.value === null) continue;
        if (exams && !exams.has(marker.exam)) continue;
        const date = marker.collectionDate ?? a.createdAt.slice(0, 10);
        const entry = acc.get(marker.exam) ?? { exam: marker.exam, label: marker.label, unit: marker.unit, system: marker.system, byDate: new Map() };
        entry.byDate.set(date, { date, value: marker.value, classification: marker.classification, analysisId: a.id, caseId: c.id });
        entry.unit = marker.unit ?? entry.unit;
        acc.set(marker.exam, entry);
      }
    }
  }
  const series = [...acc.values()]
    .map((e) => ({ exam: e.exam, label: e.label, unit: e.unit, system: e.system, points: [...e.byDate.values()].sort((p, q) => p.date.localeCompare(q.date)) }))
    .filter((s) => exams !== null || s.points.length >= 2)
    .sort((x, y) => y.points.length - x.points.length || x.label.localeCompare(y.label, 'pt-BR'));
  return series.slice(0, limit);
}

/* ---------------------------------------------------------------- rotas */

const CreateCaseBody = z.object({
  patientCode: z.string().trim().min(1, 'patientCode obrigatório').max(40).regex(/^[\w.\-/ ]*$/u, 'patientCode: use só letras, números, ponto, traço ou barra'),
  sex: z.enum(['M', 'F']).nullish(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'birthDate deve ser AAAA-MM-DD').nullish(),
  goal: z.string().trim().max(2000).nullish(),
  contexts: z.union([z.array(z.string().trim().max(40)).max(20), z.string().trim().max(400)]).nullish(),
  comorbidities: z.string().trim().max(2000).nullish(),
  medications: z.string().trim().max(2000).nullish(),
  supplements: z.string().trim().max(2000).nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

const MarkersQuery = z.object({
  exams: z.string().trim().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SERIES_LIMIT).optional(),
});

interface ApiError { status: number; code: string; message: string }
const ERR = {
  unauthorized: { status: 401, code: 'UNAUTHORIZED', message: 'Token de integração ausente ou inválido.' },
  notFound: { status: 404, code: 'NOT_FOUND', message: 'Recurso não encontrado.' },
  tooMany: { status: 429, code: 'RATE_LIMITED', message: 'Limite de requisições excedido; tente novamente em instantes.' },
  internal: { status: 500, code: 'INTERNAL', message: 'Erro interno ao atender a integração.' },
} satisfies Record<string, ApiError>;

function sendError(reply: FastifyReply, err: ApiError, message?: string): FastifyReply {
  return reply.code(err.status).send({ error: { code: err.code, message: message ?? err.message } });
}

function idParam(request: FastifyRequest, key: string): number | null {
  const raw = (request.params as Record<string, string | undefined>)[key] ?? '';
  return /^\d{1,12}$/.test(raw) ? Number(raw) : null;
}

function codeParam(request: FastifyRequest): string | null {
  const raw = (request.params as { code?: string }).code ?? '';
  const code = decodeURIComponent(raw).trim();
  return code && code.length <= 40 && /^[\w.\-/ ]*$/u.test(code) ? code : null;
}

async function record(request: FastifyRequest, action: string, entity: string, entityId: string | number | null, details: unknown): Promise<void> {
  await audit(null, `integ_${action}`, entity, entityId, details, request.id);
}

function toContextList(value: string[] | string | null | undefined): string[] {
  const arr = value === null || value === undefined ? [] : Array.isArray(value) ? value : value.split(/[|,]/);
  return [...new Set(arr.map((c) => c.trim()).filter((c) => c && c !== 'geral' && c in CONTEXTS))];
}

export interface IntegrationOptions {
  /** Token aceito; vazio/indefinido desliga a integração (404 em todas as rotas). */
  token?: string | undefined;
  /** Requisições por minuto por token. */
  limitPerMinute?: number;
}

/** Janela fixa de 60 s em memória, por token (a chave é o hash, nunca o token). */
class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly max: number) {}
  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }
}

export async function integrationRoutes(app: FastifyInstance, opts: IntegrationOptions = {}): Promise<void> {
  const token = (opts.token ?? process.env.INTEGRATION_TOKEN ?? '').trim();
  const limitPerMinute = opts.limitPerMinute ?? Number(process.env.INTEGRATION_RATE_LIMIT ?? 120);
  const enabled = token.length > 0;
  const limiter = new RateLimiter(Number.isFinite(limitPerMinute) && limitPerMinute > 0 ? limitPerMinute : 120);
  const tokenKey = enabled ? sha256(token).toString('hex') : '';

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!enabled) return sendError(reply, ERR.notFound);
    const presented = request.headers['x-integration-token'];
    if (typeof presented !== 'string' || !tokenMatches(presented, token)) {
      request.log.warn({ ip: request.ip }, 'integração: token inválido');
      return sendError(reply, ERR.unauthorized);
    }
    if (!limiter.allow(tokenKey)) return sendError(reply, ERR.tooMany);
  });

  app.setNotFoundHandler(async (_request, reply) => sendError(reply, ERR.notFound));

  app.setErrorHandler(async (error: unknown, request, reply) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? (error as { statusCode?: unknown }).statusCode : undefined;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const message = statusCode === 400 ? 'Corpo da requisição inválido (JSON malformado).' : statusCode === 413 ? 'Corpo da requisição grande demais.' : statusCode === 415 ? 'Content-Type não suportado; envie application/json.' : 'Requisição inválida.';
      return reply.code(statusCode).send({ error: { code: 'BAD_REQUEST', message } });
    }
    request.log.error({ err: error }, 'integração: erro não tratado');
    return sendError(reply, ERR.internal);
  });

  app.get('/health', async (request) => {
    await record(request, 'health', 'system', null, null);
    return { data: { ok: true, app: 'nutrolab', version: APP_VERSION } };
  });

  app.get('/patients/:code/cases', async (request, reply) => {
    const code = codeParam(request);
    if (code === null) return sendError(reply, ERR.notFound, 'Código de paciente inválido.');
    const cases = await Promise.all((await casesOfPatient(code)).map(async (c) => toIntegrationCase(c, await analysesOfCase(c.id))));
    await record(request, 'patient_cases', 'patient', code, { patient_code: code, cases: cases.length });
    return { data: cases };
  });

  app.get('/cases/:id', async (request, reply) => {
    const id = idParam(request, 'id');
    const c = id === null ? null : await loadCase(id);
    if (!c) return sendError(reply, ERR.notFound, 'Caso não encontrado.');
    const analyses = await analysesOfCase(c.id);
    await record(request, 'case', 'case', c.id, { patient_code: c.patient_code });
    return { data: { ...(await toIntegrationCase(c, analyses)), analyses: analyses.map(summaryOf) } };
  });

  app.post('/cases', async (request, reply) => {
    const parsed = CreateCaseBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({ error: { code: 'VALIDATION', message: issue ? `${issue.path.join('.') || 'corpo'}: ${issue.message}` : 'Dados inválidos.' } });
    }
    const d = parsed.data;
    const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const prefix = `Criado pelo LN Evolution em ${today}.`;
    const notes = d.notes ? `${prefix}\n${d.notes}` : prefix;
    // Paciente canônico: o `code` é o uuid do clinica-api; cria o cadastro pseudônimo se ainda não existir.
    const adb = getAsyncDb();
    let patient = (await adb.prepare('SELECT id FROM patients WHERE code = ? AND deleted_at IS NULL').get(d.patientCode)) as Row | undefined;
    if (!patient) {
      await adb.prepare('INSERT INTO patients(code, name, birth_date, sex, comorbidities, medications, supplements, goal, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(d.patientCode, d.patientCode, d.birthDate ?? null, d.sex ?? null, d.comorbidities ?? '', d.medications ?? '', d.supplements ?? '', d.goal ?? '');
      patient = (await adb.prepare('SELECT id FROM patients WHERE code = ?').get(d.patientCode)) as Row;
    }
    const info = await adb
      .prepare("INSERT INTO cases(patient_id, patient_code, sex, birth_date, contexts, medications, supplements, comorbidities, goal, notes, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberto', NULL)")
      .run(num(patient, 'id'), d.patientCode, d.sex ?? null, d.birthDate ?? null, toContextList(d.contexts).join('|'), d.medications ?? '', d.supplements ?? '', d.comorbidities ?? '', d.goal ?? '', notes);
    const id = Number(info.lastInsertRowid);
    await record(request, 'create_case', 'case', id, { patient_code: d.patientCode });
    return reply.code(201).send({ data: { id, url: caseUrl(id) } });
  });

  app.get('/analyses/:id', async (request, reply) => {
    const id = idParam(request, 'id');
    const a = id === null ? null : await analysisById(id);
    const c = a ? await loadCase(a.caseId) : null;
    if (!a || !c) return sendError(reply, ERR.notFound, 'Análise não encontrada.');
    await record(request, 'analysis', 'analysis', a.id, { patient_code: c.patient_code, case_id: c.id });
    return { data: await buildAnalysis(c, a) };
  });

  app.get('/patients/:code/markers', async (request, reply) => {
    const code = codeParam(request);
    if (code === null) return sendError(reply, ERR.notFound, 'Código de paciente inválido.');
    const q = MarkersQuery.safeParse(request.query ?? {});
    if (!q.success) return reply.code(400).send({ error: { code: 'VALIDATION', message: 'Parâmetros inválidos: exams (lista separada por vírgula) e limit (1 a 50).' } });
    const exams = q.data.exams ? new Set(q.data.exams.split(',').map((e) => e.trim()).filter(Boolean)) : null;
    const series = await markerSeries(code, exams && exams.size ? exams : null, q.data.limit ?? DEFAULT_SERIES_LIMIT);
    await record(request, 'patient_markers', 'patient', code, { patient_code: code, exams: exams ? [...exams] : null, series: series.length });
    return { data: series };
  });

  /* ------------------------------------------------------------- v2 */
  app.post('/cases/:id/files', async (request, reply) => {
    const id = idParam(request, 'id');
    const c = id === null ? null : await loadCase(id);
    if (!c) return sendError(reply, ERR.notFound, 'Caso não encontrado.');
    if (!request.isMultipart()) return reply.code(400).send({ error: { code: 'VALIDATION', message: 'Envie multipart/form-data com um arquivo.' } });
    let fileId: number | null = null;
    let rejected = false;
    for await (const part of request.files({ limits: { fileSize: 25 * 1024 * 1024, files: 1 } })) {
      const buf = await part.toBuffer();
      if (part.file.truncated) {
        rejected = true;
        continue;
      }
      fileId = await storeCaseFile(c.id, buf, part.filename);
      if (fileId === null) rejected = true;
    }
    if (fileId === null) {
      return reply.code(rejected ? 415 : 400).send({ error: { code: rejected ? 'UNSUPPORTED_FILE' : 'VALIDATION', message: rejected ? 'Formato não aceito: PDF, JPG, PNG ou WebP até 25 MB.' : 'Nenhum arquivo enviado.' } });
    }
    await record(request, 'upload_file', 'case', c.id, { patient_code: c.patient_code, file_id: fileId });
    return reply.code(201).send({ data: { fileId } });
  });

  app.get('/analyses/:id/export', async (request, reply) => {
    const id = idParam(request, 'id');
    const a = id === null ? null : await analysisById(id);
    const c = a ? await loadCase(a.caseId) : null;
    if (!a || !c) return sendError(reply, ERR.notFound, 'Análise não encontrada.');
    const q = request.query as { format?: string; type?: string };
    const format = q.format === 'html' ? 'html' : q.format === 'md' || q.format === undefined ? 'md' : null;
    const type = q.type === 'tecnico' ? 'tecnico' : q.type === 'resumido' || q.type === undefined ? 'resumido' : null;
    if (!format || !type) return reply.code(400).send({ error: { code: 'VALIDATION', message: 'format deve ser md ou html; type deve ser resumido ou tecnico.' } });
    if (!a.finalizedAt) return reply.code(409).send({ error: { code: 'NOT_FINALIZED', message: 'O relatório só é exportado depois de finalizado pelo médico.' } });
    const raw = type === 'tecnico' ? a.finalTechnical : a.finalPatient;
    const markdown = redactPatientName(raw, c.patient_name, c.patient_code) ?? '';
    await record(request, 'export_analysis', 'analysis', a.id, { patient_code: c.patient_code, format, type });
    if (format === 'md') return reply.type('text/markdown; charset=utf-8').send(markdown);
    const row = (await getAsyncDb().prepare('SELECT * FROM analyses WHERE id = ?').get(a.id)) as Row;
    return reply.type('text/html; charset=utf-8').send(await printAnalysisHtml(c, row, type, markdown));
  });
}

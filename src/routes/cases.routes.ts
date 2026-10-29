import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../auth.js';
import { AiError, AI_MODEL, aiEnabled, extractFromFile, suggestConduct, suggestFormulas, writeReports, type Reports } from '../ai.js';
import { allFormulas, allGuidances, allRules, audit, enabledCalcIds, getDb, list, num, numOrNull, reportSettings, str, strOrNull, tableVersion, UPLOAD_DIR, type Formula, type Row } from '../db.js';
import { applicableGuidances, COMPLAINTS, computeDerived, computeScore, CONTEXTS, evaluateAll, evaluateResult, gaugeSvg, type Evaluation, type PatientProfile, type ResultInput } from '../engine/index.js';
import { renderMarkdown } from '../markdown.js';
import { buildPatientReport, buildTechnicalReport, CONDUCT_KIND_LABEL, type ConductItem, type ReportInput } from '../report.js';
import { h, layout } from '../views/html.js';
import { analysisPage, caseFormPage, caseFormulasPage, casePage, casesPage, conductPage, conferencePage, type AnalysisRow, type CaseRow, type ConductRow, type FileRow, type ResultRow } from '../views/pages.js';
import type { Score } from '../engine/index.js';

const MAX_PDF = 25 * 1024 * 1024;

export type FileMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
function sniffMime(buf: Buffer): FileMime | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const CaseBody = z.object({
  patient_code: z.string().trim().max(40).regex(/^[\w.\-/ ]*$/u, 'use só letras, números, ponto, traço ou barra').default(''),
  patient_name: z.string().trim().max(120).default(''),
  menopause: z.enum(['', 'nao', 'peri', 'pos']).default(''),
  complaints: z.union([z.string(), z.array(z.string())]).optional(),
  ai_notes: z.string().trim().max(5000).default(''),
  sex: z.enum(['', 'M', 'F']).default(''),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')).default(''),
  contexts: z.union([z.string(), z.array(z.string())]).optional(),
  medications: z.string().trim().max(2000).default(''),
  supplements: z.string().trim().max(2000).default(''),
  comorbidities: z.string().trim().max(2000).default(''),
  goal: z.string().trim().max(2000).default(''),
  notes: z.string().trim().max(5000).default(''),
});

const ResultBody = z.object({
  exam_raw: z.string().trim().min(1).max(120),
  value_raw: z.string().trim().min(1).max(60),
  unit_raw: z.string().trim().max(40).default(''),
  lab_reference: z.string().trim().max(120).default(''),
  lab_flag: z.string().trim().max(40).default(''),
  collection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')).default(''),
  source_file: z.string().trim().max(200).default(''),
  page: z.string().regex(/^\d*$/).default(''),
  confidence: z.enum(['alta', 'media', 'baixa']).default('alta'),
});

function toList(v: string | string[] | undefined): string[] {
  const arr = v === undefined ? [] : Array.isArray(v) ? v : [v];
  return arr.filter((c) => c in CONTEXTS && c !== 'geral');
}
function toComplaints(v: string | string[] | undefined): string[] {
  const arr = v === undefined ? [] : Array.isArray(v) ? v : [v];
  return arr.filter((c) => c in COMPLAINTS);
}
/** Contextos efetivos: os marcados + o derivado da menopausa. */
function effectiveContexts(contexts: string[], menopause: string): string[] {
  const set = new Set(contexts);
  if (menopause === 'pos') set.add('pos_menopausa');
  if (menopause === 'nao') set.add('pre_menopausa');
  return [...set];
}

function rowToCase(row: Row): CaseRow {
  return {
    id: num(row, 'id'),
    patient_code: str(row, 'patient_code'),
    patient_name: str(row, 'patient_name'),
    complaints: list(str(row, 'complaints')),
    menopause: str(row, 'menopause'),
    ai_notes: str(row, 'ai_notes'),
    doctor_notes: str(row, 'doctor_notes'),
    sex: strOrNull(row, 'sex'),
    birth_date: strOrNull(row, 'birth_date'),
    contexts: list(str(row, 'contexts')),
    medications: str(row, 'medications'),
    supplements: str(row, 'supplements'),
    comorbidities: str(row, 'comorbidities'),
    goal: str(row, 'goal'),
    notes: str(row, 'notes'),
    status: str(row, 'status'),
    created_at: str(row, 'created_at'),
    results_count: numOrNull(row, 'results_count') ?? undefined,
    analyses_count: numOrNull(row, 'analyses_count') ?? undefined,
    last_collection: strOrNull(row, 'last_collection'),
  };
}

function loadCase(id: number): CaseRow | null {
  const row = getDb().prepare('SELECT * FROM cases WHERE id = ? AND deleted_at IS NULL').get(id) as Row | undefined;
  return row ? rowToCase(row) : null;
}

function loadResults(caseId: number): ResultRow[] {
  return (getDb().prepare('SELECT * FROM results WHERE case_id = ? ORDER BY collection_date, id').all(caseId) as Row[]).map((r) => ({
    id: num(r, 'id'),
    exam_raw: str(r, 'exam_raw'),
    exam_canonical: strOrNull(r, 'exam_canonical'),
    value_raw: str(r, 'value_raw'),
    unit_raw: strOrNull(r, 'unit_raw'),
    lab_reference: strOrNull(r, 'lab_reference'),
    lab_flag: strOrNull(r, 'lab_flag'),
    collection_date: strOrNull(r, 'collection_date'),
    source_file: strOrNull(r, 'source_file'),
    page: numOrNull(r, 'page'),
    confidence: str(r, 'confidence'),
    origin: str(r, 'origin'),
    checked: num(r, 'checked') === 1,
    excluded: num(r, 'excluded') === 1,
  }));
}

function loadFiles(caseId: number): FileRow[] {
  return (getDb().prepare('SELECT * FROM case_files WHERE case_id = ? ORDER BY id').all(caseId) as Row[]).map((r) => ({ id: num(r, 'id'), original_name: str(r, 'original_name'), size: num(r, 'size'), created_at: str(r, 'created_at'), mime: str(r, 'mime') || 'application/pdf' }));
}

function profileOf(c: CaseRow): PatientProfile {
  return { sex: c.sex === 'M' || c.sex === 'F' ? c.sex : null, birthDate: c.birth_date, contexts: new Set(effectiveContexts(c.contexts, c.menopause)) };
}

function toInputs(results: ResultRow[]): ResultInput[] {
  return results.map((r) => ({ ...r, confidence: r.confidence as ResultInput['confidence'], derived: false }));
}

function page(request: FastifyRequest, reply: FastifyReply, title: string, body: string, flash?: { kind: 'ok' | 'err' | 'warn'; text: string } | null) {
  const q = request.query as { msg?: string; kind?: string };
  const f = flash ?? (q.msg ? { kind: (q.kind === 'err' || q.kind === 'warn' ? q.kind : 'ok') as 'ok' | 'err' | 'warn', text: q.msg } : null);
  return reply.type('text/html; charset=utf-8').send(layout({ title, user: request.user, body, flash: f, aiOn: aiEnabled(), active: request.url.split('/')[1]?.split('?')[0] }));
}

function redirectMsg(reply: FastifyReply, to: string, msg: string, kind: 'ok' | 'err' | 'warn' = 'ok') {
  return reply.redirect(`${to}?kind=${kind}&msg=${encodeURIComponent(msg)}`);
}

function evaluateCase(c: CaseRow, results: ResultRow[]) {
  const rules = allRules();
  const profile = profileOf(c);
  const evals = evaluateAll(toInputs(results.filter((r) => !r.excluded)), rules, profile);
  const derived = computeDerived(evals, enabledCalcIds(), profile);
  const derivedEvals: Evaluation[] = derived
    .filter((d) => d.value !== null)
    .map((d, i) =>
      evaluateResult(
        { id: -1 - i, exam_raw: d.name, exam_canonical: d.id, value_raw: String(d.value).replace('.', ','), unit_raw: d.unit, lab_reference: null, lab_flag: null, collection_date: d.collection_date, source_file: 'cálculo', page: null, confidence: 'alta', derived: true },
        rules,
        profile,
      ),
    );
  const guidances = applicableGuidances([...evals, ...derivedEvals], allGuidances(), profile);
  const score = computeScore([...evals, ...derivedEvals]);
  return { rules, profile, evals, derived, derivedEvals, guidances, score };
}

function loadAnalyses(caseId: number): AnalysisRow[] {
  return (getDb().prepare('SELECT id, created_at, table_version, ai_used, ai_model, score, finalized_at FROM analyses WHERE case_id = ? ORDER BY id DESC').all(caseId) as Row[]).map((a) => ({ id: num(a, 'id'), created_at: str(a, 'created_at'), table_version: str(a, 'table_version'), ai_used: num(a, 'ai_used') === 1, ai_model: strOrNull(a, 'ai_model'), score: numOrNull(a, 'score'), finalized_at: strOrNull(a, 'finalized_at') }));
}

function loadAnalysis(caseId: number, analysisId: number): Row | null {
  return (getDb().prepare('SELECT * FROM analyses WHERE id = ? AND case_id = ?').get(analysisId, caseId) as Row | undefined) ?? null;
}

function loadConduct(analysisId: number): ConductRow[] {
  return (getDb().prepare('SELECT * FROM conduct_items WHERE analysis_id = ? ORDER BY position, id').all(analysisId) as Row[]).map((r) => ({ id: num(r, 'id'), kind: str(r, 'kind'), title: str(r, 'title'), rationale: str(r, 'rationale'), exams: list(str(r, 'exams')), sources: list(str(r, 'sources')), origin: str(r, 'origin'), status: str(r, 'status') }));
}

function caseInfoOf(c: CaseRow, files: string[]): ReportInput['caseInfo'] {
  return { id: c.id, patient_code: c.patient_code, patient_name: c.patient_name, sex: c.sex === 'M' || c.sex === 'F' ? c.sex : null, birth_date: c.birth_date, medications: c.medications, supplements: c.supplements, comorbidities: c.comorbidities, goal: c.goal, complaints: c.complaints, menopause: c.menopause, ai_notes: c.ai_notes, files };
}

/** Pergunta para o OpenEvidence a partir dos pontos críticos (fora do alvo / crítico). */
function criticalQuery(evals: Evaluation[], profile: PatientProfile): string {
  const flagged = evals.filter((e) => e.critical || ['abaixo_do_alvo', 'acima_do_alvo', 'qualitativo_nao_compativel'].includes(e.classification));
  const parts = flagged.slice(0, 4).map((e) => `${(e.exam_canonical ?? e.result.exam_raw).replace(/_/g, ' ')} ${e.classification.includes('abaixo') ? 'low' : e.classification.includes('acima') ? 'high' : 'abnormal'} (${e.result.value_raw} ${e.result.unit_raw ?? ''})`.trim());
  const who = profile.sex === 'F' ? 'adult woman' : profile.sex === 'M' ? 'adult man' : 'adult';
  return parts.length ? `Evaluation and management in ${who} with ${parts.join(', ')}: workup, supplementation and follow-up interval` : 'Interpretation of routine laboratory panel in nutrology follow-up';
}

function scoreFromRow(row: Row): Score | null {
  const raw = strOrNull(row, 'score_json');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Score;
  } catch {
    return null;
  }
}

function reportPayload(c: CaseRow, profile: PatientProfile, evals: Evaluation[], derived: ReturnType<typeof computeDerived>, guidances: ReturnType<typeof applicableGuidances>, score: Score) {
  return {
    paciente: { codigo: c.patient_code, sexo: c.sex, nascimento: c.birth_date, menopausa: c.menopause || null, contextos: [...profile.contexts], queixas: c.complaints.map((k) => COMPLAINTS[k] ?? k), comorbidades: c.comorbidities, medicamentos: c.medications, suplementos: c.supplements, objetivo: c.goal, observacoes_do_medico: c.ai_notes },
    score: { total: score.total, por_sistema: score.bySystem },
    resultados: evals.map((e) => ({ sistema: e.rule?.system ?? 'outros', exame: e.exam_canonical ?? e.result.exam_raw, valor: e.result.value_raw, unidade: e.result.unit_raw, referencia_lab: e.result.lab_reference, sinal_lab: e.result.lab_flag, normalidade: e.normality, alvo: e.rule ? { min: e.rule.target_min, max: e.rule.target_max, texto: e.rule.target_text, unidade: e.rule.unit } : null, classificacao: e.classification, critico: e.critical, data: e.result.collection_date, confianca: e.result.confidence, notas: e.notes })),
    calculos: derived.map((d) => ({ indice: d.name, valor: d.value, motivo: d.reason, data: d.collection_date })),
    orientacoes_aplicaveis: guidances.map((g) => ({ codigo: g.guidance.code, titulo: g.guidance.title })),
  };
}

function pickMarkdown(row: Row, tipo: 'resumido' | 'tecnico'): string {
  if (tipo === 'tecnico') return strOrNull(row, 'final_technical') ?? strOrNull(row, 'markdown_technical') ?? str(row, 'markdown');
  return strOrNull(row, 'final_patient') ?? strOrNull(row, 'markdown_patient') ?? str(row, 'markdown');
}

/**
 * O relatório final é reconstruído a partir dos dados + conduta; para não perder a
 * redação da IA feita na minuta, copia as seções narrativas (que o gerador sem
 * narrativa deixa com texto padrão) da minuta para o final, quando existirem.
 */
function mergeNarrative(draft: string, rebuilt: string): string {
  if (!draft) return rebuilt;
  const sections = (md: string) => {
    const map = new Map<string, string>();
    const parts = md.split(/^## /m);
    for (const p of parts.slice(1)) {
      const nl = p.indexOf('\n');
      map.set(p.slice(0, nl).trim(), p.slice(nl + 1));
    }
    return map;
  };
  const d = sections(draft);
  const narrativeSections = ['Visão geral', 'Por sistema', 'Pontos favoráveis', 'Pontos que merecem atenção', 'Mensagem final', 'Síntese', 'Leitura integrada', 'Resultados por sistema'];
  let out = rebuilt;
  for (const name of narrativeSections) {
    const body = d.get(name);
    if (!body) continue;
    out = out.replace(new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm'), `## ${name}\n${body}`);
  }
  return out;
}

const ConductItemBody = z.object({ kind: z.string().trim().default('outro'), title: z.string().trim().min(1).max(200), rationale: z.string().trim().max(3000).default(''), action: z.string().trim().default('salvar') });

export async function casesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (_request, reply) => reply.redirect('/casos'));

  app.get('/casos', async (request, reply) => {
    const rows = getDb()
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM results r WHERE r.case_id = c.id) AS results_count,
         (SELECT COUNT(*) FROM analyses a WHERE a.case_id = c.id) AS analyses_count,
         (SELECT MAX(collection_date) FROM results r WHERE r.case_id = c.id) AS last_collection
         FROM cases c WHERE c.deleted_at IS NULL ORDER BY c.updated_at DESC LIMIT 200`,
      )
      .all() as Row[];
    return page(request, reply, 'Casos', casesPage(rows.map(rowToCase), tableVersion(), aiEnabled()));
  });

  app.get('/casos/novo', async (request, reply) => page(request, reply, 'Novo caso', caseFormPage(null, null)));

  app.post('/casos', async (request, reply) => {
    const parsed = CaseBody.safeParse(request.body);
    if (!parsed.success) return page(request, reply, 'Novo caso', caseFormPage(null, parsed.error.issues[0]?.message ?? 'Dados inválidos.'));
    const d = parsed.data;
    const info = getDb()
      .prepare('INSERT INTO cases(patient_code, patient_name, menopause, complaints, ai_notes, sex, birth_date, contexts, medications, supplements, comorbidities, goal, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.patient_code || 'novo', d.patient_name, d.menopause, toComplaints(d.complaints).join('|'), d.ai_notes, d.sex || null, d.birth_date || null, toList(d.contexts).join('|'), d.medications, d.supplements, d.comorbidities, d.goal, d.notes, request.user?.id ?? null);
    const id = Number(info.lastInsertRowid);
    if (!d.patient_code) getDb().prepare('UPDATE cases SET patient_code = ? WHERE id = ?').run(`P-${String(id).padStart(4, '0')}`, id);
    audit(request.user?.id ?? null, 'criar', 'case', id, { patient_code: d.patient_code || `P-${String(id).padStart(4, '0')}` }, request.id);
    return redirectMsg(reply, `/casos/${id}`, 'Caso criado. Etapa 2: anexe os exames (PDF ou imagem) e extraia.');
  });

  app.get('/casos/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const c = loadCase(id);
    if (!c) return reply.code(404).send('Caso não encontrado');
    const results = loadResults(id);
    const { evals } = evaluateCase(c, results);
    const analyses = loadAnalyses(id);
    return page(request, reply, `Caso ${c.patient_code}`, casePage({ c, files: loadFiles(id), results, evals, analyses, aiOn: aiEnabled(), isAdmin: request.user?.role === 'admin', tableVersion: tableVersion(), examOptions: [...new Set(allRules().map((r) => r.exam_canonical))].sort() }));
  });

  app.get('/casos/:id/editar', async (request, reply) => {
    const c = loadCase(Number((request.params as { id: string }).id));
    if (!c) return reply.code(404).send('Caso não encontrado');
    return page(request, reply, 'Editar caso', caseFormPage(c, null));
  });

  app.post('/casos/:id/editar', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const c = loadCase(id);
    if (!c) return reply.code(404).send('Caso não encontrado');
    const parsed = CaseBody.safeParse(request.body);
    if (!parsed.success) return page(request, reply, 'Editar caso', caseFormPage(c, parsed.error.issues[0]?.message ?? 'Dados inválidos.'));
    const d = parsed.data;
    getDb()
      .prepare("UPDATE cases SET patient_code=?, patient_name=?, menopause=?, complaints=?, ai_notes=?, sex=?, birth_date=?, contexts=?, medications=?, supplements=?, comorbidities=?, goal=?, notes=?, updated_at=datetime('now') WHERE id=?")
      .run(d.patient_code || c.patient_code, d.patient_name, d.menopause, toComplaints(d.complaints).join('|'), d.ai_notes, d.sex || null, d.birth_date || null, toList(d.contexts).join('|'), d.medications, d.supplements, d.comorbidities, d.goal, d.notes, id);
    audit(request.user?.id ?? null, 'editar', 'case', id, { before: { sex: c.sex, birth_date: c.birth_date, contexts: c.contexts }, after: { sex: d.sex, birth_date: d.birth_date, contexts: toList(d.contexts) } }, request.id);
    return redirectMsg(reply, `/casos/${id}`, 'Caso atualizado.');
  });

  app.post('/casos/:id/status', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const c = loadCase(id);
    if (!c) return reply.code(404).send('Caso não encontrado');
    const status = (request.body as { status?: string } | null)?.status;
    if (status !== 'aberto' && status !== 'revisado' && status !== 'arquivado') return redirectMsg(reply, `/casos/${id}`, 'Status inválido.', 'err');
    getDb().prepare("UPDATE cases SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
    audit(request.user?.id ?? null, 'status', 'case', id, { before: c.status, after: status }, request.id);
    return redirectMsg(reply, `/casos/${id}`, `Caso marcado como ${status}.`);
  });

  app.post('/casos/:id/excluir', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const c = loadCase(id);
    if (!c) return reply.code(404).send('Caso não encontrado');
    const db = getDb();
    for (const f of db.prepare('SELECT stored_name FROM case_files WHERE case_id = ?').all(id) as Row[]) {
      fs.rmSync(path.join(UPLOAD_DIR, str(f, 'stored_name')), { force: true });
    }
    db.prepare('DELETE FROM case_files WHERE case_id = ?').run(id);
    db.prepare('DELETE FROM conduct_items WHERE case_id = ?').run(id);
    db.prepare("UPDATE cases SET deleted_at = datetime('now'), status = 'arquivado', patient_name = NULL WHERE id = ?").run(id);
    audit(request.user?.id ?? null, 'excluir', 'case', id, { patient_code: c.patient_code, files_removed: true }, request.id);
    return redirectMsg(reply, '/casos', 'Caso excluído e PDFs removidos do servidor.');
  });

  app.post('/casos/:id/arquivos', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const c = loadCase(id);
    if (!c) return reply.code(404).send('Caso não encontrado');
    let saved = 0;
    let rejected = 0;
    for await (const part of request.files({ limits: { fileSize: MAX_PDF, files: 10 } })) {
      const buf = await part.toBuffer();
      const mime = sniffMime(buf);
      if (part.file.truncated || !mime) {
        rejected += 1;
        continue;
      }
      const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      const stored = `${id}-${crypto.randomUUID()}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
      const original = path.basename(part.filename || `exames.${ext}`).slice(0, 120);
      getDb().prepare('INSERT INTO case_files(case_id, original_name, stored_name, size, mime) VALUES (?, ?, ?, ?, ?)').run(id, original, stored, buf.length, mime);
      saved += 1;
    }
    audit(request.user?.id ?? null, 'upload', 'case', id, { saved, rejected }, request.id);
    return redirectMsg(reply, `/casos/${id}`, rejected ? `${saved} arquivo(s) salvo(s); ${rejected} rejeitado(s) (aceitos: PDF, JPG, PNG, WebP até 25 MB).` : `${saved} arquivo(s) salvo(s). Agora extraia os exames de cada arquivo.`, rejected ? 'warn' : 'ok');
  });

  app.post('/casos/:id/arquivos/:fid/excluir', async (request, reply) => {
    const { id, fid } = request.params as { id: string; fid: string };
    const row = getDb().prepare('SELECT * FROM case_files WHERE id = ? AND case_id = ?').get(Number(fid), Number(id)) as Row | undefined;
    if (!row) return reply.code(404).send('Arquivo não encontrado');
    fs.rmSync(path.join(UPLOAD_DIR, str(row, 'stored_name')), { force: true });
    getDb().prepare('DELETE FROM case_files WHERE id = ?').run(Number(fid));
    audit(request.user?.id ?? null, 'excluir_arquivo', 'case', Number(id), { file: str(row, 'original_name') }, request.id);
    return redirectMsg(reply, `/casos/${id}`, 'Arquivo removido.');
  });

  app.post('/casos/:id/arquivos/:fid/extrair', async (request, reply) => {
    const { id, fid } = request.params as { id: string; fid: string };
    const caseId = Number(id);
    const c = loadCase(caseId);
    const row = getDb().prepare('SELECT * FROM case_files WHERE id = ? AND case_id = ?').get(Number(fid), caseId) as Row | undefined;
    if (!c || !row) return reply.code(404).send('Arquivo não encontrado');
    if (!aiEnabled()) return redirectMsg(reply, `/casos/${caseId}`, 'IA desligada: configure ANTHROPIC_API_KEY.', 'err');
    const original = str(row, 'original_name');
    try {
      const pdf = fs.readFileSync(path.join(UPLOAD_DIR, str(row, 'stored_name')));
      const mime = (str(row, 'mime') || 'application/pdf') as FileMime;
      const catalog = Object.values(
        allRules().reduce<Record<string, { exam: string; aliases: string[] }>>((acc, r) => {
          const entry = acc[r.exam_canonical] ?? { exam: r.exam_canonical, aliases: [] };
          entry.aliases = [...new Set([...entry.aliases, ...r.aliases])];
          acc[r.exam_canonical] = entry;
          return acc;
        }, {}),
      );
      const extraction = await extractFromFile(pdf, mime, catalog, caseId);
      const insert = getDb().prepare("INSERT INTO results(case_id, exam_raw, exam_canonical, value_raw, unit_raw, lab_reference, lab_flag, collection_date, source_file, page, confidence, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ia')");
      const known = new Set(allRules().map((r) => r.exam_canonical));
      for (const r of extraction.results) {
        const canonical = r.exam_canonical && known.has(r.exam_canonical) ? r.exam_canonical : null;
        const date = r.collection_date && /^\d{4}-\d{2}-\d{2}$/.test(r.collection_date) ? r.collection_date : null;
        insert.run(caseId, r.exam_raw.slice(0, 120), canonical, r.value_raw.slice(0, 60), r.unit_raw?.slice(0, 40) ?? null, r.lab_reference?.slice(0, 120) ?? null, r.lab_flag?.slice(0, 40) ?? null, date, original, r.page, r.confidence);
      }
      audit(request.user?.id ?? null, 'extrair_ia', 'case', caseId, { file: original, results: extraction.results.length, pages: extraction.pages_read, warnings: extraction.warnings }, request.id);
      const warn = extraction.warnings.length ? ` Avisos: ${extraction.warnings.join(' · ')}` : '';
      return redirectMsg(reply, `/casos/${caseId}`, `${extraction.results.length} resultado(s) extraído(s) de ${extraction.pages_read} página(s).${warn}`, extraction.warnings.length ? 'warn' : 'ok');
    } catch (error) {
      request.log.error({ err: error }, 'falha na extração');
      const msg = error instanceof AiError ? error.message : 'Falha inesperada ao ler o PDF.';
      return redirectMsg(reply, `/casos/${caseId}`, msg, 'err');
    }
  });

  app.post('/casos/:id/resultados', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!loadCase(id)) return reply.code(404).send('Caso não encontrado');
    const parsed = ResultBody.safeParse(request.body);
    if (!parsed.success) return redirectMsg(reply, `/casos/${id}`, `Resultado inválido: ${parsed.error.issues[0]?.message ?? ''}`, 'err');
    const d = parsed.data;
    getDb()
      .prepare("INSERT INTO results(case_id, exam_raw, exam_canonical, value_raw, unit_raw, lab_reference, lab_flag, collection_date, source_file, page, confidence, origin) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')")
      .run(id, d.exam_raw, d.value_raw, d.unit_raw || null, d.lab_reference || null, d.lab_flag || null, d.collection_date || null, d.source_file || null, d.page ? Number(d.page) : null, d.confidence);
    audit(request.user?.id ?? null, 'lancar_resultado', 'case', id, { exam: d.exam_raw }, request.id);
    return redirectMsg(reply, `/casos/${id}`, 'Resultado lançado.');
  });

  app.get('/casos/:id/conferencia', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const c = loadCase(id);
    if (!c) return reply.code(404).send('Caso não encontrado');
    const results = loadResults(id);
    const all = evaluateAll(toInputs(results), allRules(), profileOf(c));
    return page(request, reply, 'Conferência', conferencePage(c, results, all, [...new Set(allRules().map((r) => r.exam_canonical))].sort()));
  });

  app.post('/casos/:id/conferencia', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const c = loadCase(id);
    if (!c) return reply.code(404).send('Caso não encontrado');
    const body = (request.body ?? {}) as Record<string, string | string[]>;
    const one = (k: string) => {
      const v = body[k];
      return (Array.isArray(v) ? v[0] : v) ?? '';
    };
    const okAll = one('action') === 'ok_todos';
    const known = new Set(allRules().map((r) => r.exam_canonical));
    const update = getDb().prepare('UPDATE results SET exam_raw = ?, exam_canonical = ?, value_raw = ?, unit_raw = ?, lab_reference = ?, lab_flag = ?, collection_date = ?, excluded = ?, checked = ? WHERE id = ? AND case_id = ?');
    let changed = 0;
    for (const r of loadResults(id)) {
      const k = (f: string) => one(`${f}_${r.id}`).trim();
      if (!(`exam_raw_${r.id}` in body)) continue;
      const examRaw = k('exam_raw').slice(0, 120) || r.exam_raw;
      const canonical = known.has(k('exam_canonical')) ? k('exam_canonical') : null;
      const value = k('value_raw').slice(0, 60) || r.value_raw;
      const unit = k('unit_raw').slice(0, 40) || null;
      const ref = k('lab_reference').slice(0, 120) || null;
      const flag = k('lab_flag').slice(0, 40) || null;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(k('collection_date')) ? k('collection_date') : null;
      const include = one(`include_${r.id}`) === '1';
      const checked = include && (okAll || one(`checked_${r.id}`) === '1');
      update.run(examRaw, canonical, value, unit, ref, flag, date, include ? 0 : 1, checked ? 1 : 0, r.id, id);
      changed += 1;
    }
    getDb().prepare("UPDATE cases SET updated_at = datetime('now') WHERE id = ?").run(id);
    audit(request.user?.id ?? null, okAll ? 'conferir_todos' : 'conferir', 'case', id, { rows: changed }, request.id);
    return redirectMsg(reply, `/casos/${id}/conferencia`, okAll ? 'Todos os resultados incluídos foram marcados como conferidos.' : 'Alterações salvas.');
  });

  app.post('/casos/:id/resultados/:rid/vincular', async (request, reply) => {
    const { id, rid } = request.params as { id: string; rid: string };
    if (!loadCase(Number(id))) return reply.code(404).send('Caso não encontrado');
    const chosen = ((request.body as { exam_canonical?: string } | null)?.exam_canonical ?? '').trim();
    const known = new Set(allRules().map((r) => r.exam_canonical));
    if (chosen && !known.has(chosen)) return redirectMsg(reply, `/casos/${id}`, 'Exame inexistente na tabela.', 'err');
    const before = getDb().prepare('SELECT exam_canonical FROM results WHERE id = ? AND case_id = ?').get(Number(rid), Number(id)) as Row | undefined;
    if (!before) return reply.code(404).send('Resultado não encontrado');
    getDb().prepare('UPDATE results SET exam_canonical = ? WHERE id = ? AND case_id = ?').run(chosen || null, Number(rid), Number(id));
    audit(request.user?.id ?? null, 'vincular_resultado', 'case', Number(id), { result_id: Number(rid), before: strOrNull(before, 'exam_canonical'), after: chosen || null }, request.id);
    return redirectMsg(reply, `/casos/${id}`, chosen ? `Resultado vinculado a ${chosen}.` : 'Vínculo removido.');
  });

  app.post('/casos/:id/resultados/:rid/excluir', async (request, reply) => {
    const { id, rid } = request.params as { id: string; rid: string };
    const info = getDb().prepare('DELETE FROM results WHERE id = ? AND case_id = ?').run(Number(rid), Number(id));
    audit(request.user?.id ?? null, 'excluir_resultado', 'case', Number(id), { result_id: Number(rid), changes: Number(info.changes) }, request.id);
    return redirectMsg(reply, `/casos/${id}`, 'Resultado removido.');
  });

  app.post('/casos/:id/analisar', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const c = loadCase(id);
    if (!c) return reply.code(404).send('Caso não encontrado');
    const results = loadResults(id).filter((r) => !r.excluded);
    if (!results.length) return redirectMsg(reply, `/casos/${id}`, 'Lance ou extraia ao menos um resultado antes de gerar o relatório.', 'err');
    if (results.some((r) => !r.checked)) return redirectMsg(reply, `/casos/${id}/conferencia`, 'Confira todos os resultados incluídos antes de gerar o relatório (botão "OK em todos").', 'warn');
    const wantNarrative = (request.body as { narrative?: string } | null)?.narrative === '1' && aiEnabled();
    const { profile, evals, derived, derivedEvals, guidances, score } = evaluateCase(c, results);
    let narrative: Reports | null = null;
    let warning = '';
    if (wantNarrative) {
      try {
        narrative = await writeReports(reportPayload(c, profile, evals, derived, guidances, score), id);
      } catch (error) {
        request.log.error({ err: error }, 'falha na redação');
        warning = ` Redação automática falhou (${error instanceof AiError ? error.message : 'erro inesperado'}); relatório gerado só com o motor de regras.`;
      }
    }
    const version = tableVersion();
    const input: ReportInput = { caseInfo: caseInfoOf(c, loadFiles(id).map((f) => f.original_name)), profile, evals, derived, derivedEvals, guidances, score, tableVersion: version, narrative, aiModel: narrative ? AI_MODEL : null, generatedAt: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }), settings: reportSettings() };
    const technical = buildTechnicalReport(input);
    const patient = buildPatientReport(input);
    const info = getDb().prepare('INSERT INTO analyses(case_id, markdown, markdown_patient, markdown_technical, table_version, ai_used, ai_model, score, score_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, technical, patient, technical, version, narrative ? 1 : 0, narrative ? AI_MODEL : null, score.total, JSON.stringify(score), request.user?.id ?? null);
    getDb().prepare("UPDATE cases SET updated_at = datetime('now') WHERE id = ?").run(id);
    const analysisId = Number(info.lastInsertRowid);
    audit(request.user?.id ?? null, 'gerar_analise', 'analysis', analysisId, { case_id: id, results: results.length, ai: !!narrative, score: score.total, table_version: version, guidances: guidances.map((g) => g.guidance.code) }, request.id);
    return redirectMsg(reply, `/casos/${id}/analises/${analysisId}`, `Relatórios gerados. Score ${score.total ?? 'não calculado'}.${warning}`, warning ? 'warn' : 'ok');
  });

  app.get('/casos/:id/analises/:aid', async (request, reply) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const c = loadCase(Number(id));
    const row = c ? loadAnalysis(Number(id), Number(aid)) : null;
    if (!c || !row) return reply.code(404).send('Análise não encontrada');
    const { evals, profile } = evaluateCase(c, loadResults(Number(id)));
    const analysis = loadAnalyses(Number(id)).find((a) => a.id === Number(aid));
    if (!analysis) return reply.code(404).send('Análise não encontrada');
    const q = request.query as { msg?: string; kind?: string };
    return page(request, reply, `Análise #${aid}`, analysisPage({
      c, analysis, score: scoreFromRow(row),
      patientHtml: renderMarkdown(str(row, 'markdown_patient') || str(row, 'markdown')),
      technicalHtml: renderMarkdown(str(row, 'markdown_technical') || str(row, 'markdown')),
      finalPatientHtml: strOrNull(row, 'final_patient') ? renderMarkdown(str(row, 'final_patient')) : null,
      finalTechnicalHtml: strOrNull(row, 'final_technical') ? renderMarkdown(str(row, 'final_technical')) : null,
      conductCount: loadConduct(Number(aid)).length, criticalQuery: criticalQuery(evals, profile), aiOn: aiEnabled(),
    }), q.msg ? { kind: (q.kind === 'err' || q.kind === 'warn' ? q.kind : 'ok') as 'ok' | 'err' | 'warn', text: q.msg } : null);
  });

  /* ------------------------------------------------------------ conduta */
  const conductView = async (request: FastifyRequest, reply: FastifyReply, error: string | null = null) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const c = loadCase(Number(id));
    const row = c ? loadAnalysis(Number(id), Number(aid)) : null;
    const analysis = loadAnalyses(Number(id)).find((a) => a.id === Number(aid));
    if (!c || !row || !analysis) return reply.code(404).send('Análise não encontrada');
    const { evals, profile } = evaluateCase(c, loadResults(Number(id)));
    const searchNote = getSettingLocal(`conduct.search.${aid}`);
    return page(request, reply, 'Conduta', conductPage({ c, analysis, items: loadConduct(Number(aid)), doctorNotes: c.doctor_notes, aiOn: aiEnabled(), criticalQuery: criticalQuery(evals, profile), error, searchNote }));
  };
  const getSettingLocal = (key: string): string | null => {
    const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r ? str(r, 'value') : null;
  };

  app.get('/casos/:id/analises/:aid/conduta', async (request, reply) => conductView(request, reply));

  app.post('/casos/:id/analises/:aid/conduta/sugerir', async (request, reply) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const c = loadCase(Number(id));
    const row = c ? loadAnalysis(Number(id), Number(aid)) : null;
    if (!c || !row) return reply.code(404).send('Análise não encontrada');
    if (strOrNull(row, 'finalized_at')) return conductView(request, reply, 'Relatório já finalizado; reabra para alterar a conduta.');
    if (!aiEnabled()) return conductView(request, reply, 'IA desligada.');
    const { evals, profile, derived, guidances, score } = evaluateCase(c, loadResults(Number(id)));
    try {
      const library = allGuidances().filter((g) => g.status === 'ativo').map((g) => ({ codigo: g.code, titulo: g.title, exame: g.exam_canonical, gatilho: g.trigger, texto: g.patient_text }));
      const { conduct, searches } = await suggestConduct({ ...reportPayload(c, profile, evals, derived, guidances, score), biblioteca_do_medico: library }, Number(id));
      const insert = getDb().prepare("INSERT INTO conduct_items(case_id, analysis_id, kind, title, rationale, exams, sources, origin, status, position) VALUES (?, ?, ?, ?, ?, ?, ?, 'ia', 'sugerida', ?)");
      let pos = loadConduct(Number(aid)).length;
      for (const item of conduct.itens) {
        insert.run(Number(id), Number(aid), item.tipo, item.titulo.slice(0, 200), item.justificativa.slice(0, 3000), item.exames.join('|'), item.fontes.join('|'), pos);
        pos += 1;
      }
      getDb().prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`conduct.search.${aid}`, conduct.pesquisa_openevidence.slice(0, 4000));
      audit(request.user?.id ?? null, 'sugerir_conduta_ia', 'analysis', Number(aid), { items: conduct.itens.length, searches }, request.id);
      return reply.redirect(`/casos/${id}/analises/${aid}/conduta?kind=ok&msg=${encodeURIComponent(`${conduct.itens.length} sugestão(ões) geradas com ${searches} consulta(s) à literatura. Revise cada uma e use o botão do OpenEvidence para aprofundar.`)}`);
    } catch (error) {
      request.log.error({ err: error }, 'falha na sugestão de conduta');
      return conductView(request, reply, error instanceof AiError ? error.message : 'Falha inesperada ao sugerir conduta.');
    }
  });

  app.post('/casos/:id/analises/:aid/conduta/novo', async (request, reply) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const c = loadCase(Number(id));
    const row = c ? loadAnalysis(Number(id), Number(aid)) : null;
    if (!c || !row) return reply.code(404).send('Análise não encontrada');
    const parsed = ConductItemBody.safeParse(request.body);
    if (!parsed.success) return conductView(request, reply, 'Preencha o título.');
    const d = parsed.data;
    const kind = d.kind in CONDUCT_KIND_LABEL ? d.kind : 'outro';
    getDb().prepare("INSERT INTO conduct_items(case_id, analysis_id, kind, title, rationale, origin, status, position) VALUES (?, ?, ?, ?, ?, 'medico', 'aprovada', ?)").run(Number(id), Number(aid), kind, d.title, d.rationale, loadConduct(Number(aid)).length);
    audit(request.user?.id ?? null, 'conduta_manual', 'analysis', Number(aid), { title: d.title }, request.id);
    return reply.redirect(`/casos/${id}/analises/${aid}/conduta`);
  });

  app.post('/casos/:id/analises/:aid/conduta/:cid', async (request, reply) => {
    const { id, aid, cid } = request.params as { id: string; aid: string; cid: string };
    const c = loadCase(Number(id));
    const row = c ? loadAnalysis(Number(id), Number(aid)) : null;
    if (!c || !row) return reply.code(404).send('Análise não encontrada');
    if (strOrNull(row, 'finalized_at')) return conductView(request, reply, 'Relatório já finalizado; reabra para alterar.');
    const parsed = ConductItemBody.safeParse(request.body);
    if (!parsed.success) return conductView(request, reply, 'Título obrigatório.');
    const d = parsed.data;
    const item = getDb().prepare('SELECT * FROM conduct_items WHERE id = ? AND analysis_id = ?').get(Number(cid), Number(aid)) as Row | undefined;
    if (!item) return reply.code(404).send('Item não encontrado');
    if (d.action === 'excluir') {
      getDb().prepare('DELETE FROM conduct_items WHERE id = ?').run(Number(cid));
    } else {
      const status = d.action === 'aprovar' ? 'aprovada' : d.action === 'rejeitar' ? 'rejeitada' : str(item, 'status');
      const kind = d.kind in CONDUCT_KIND_LABEL ? d.kind : str(item, 'kind');
      getDb().prepare("UPDATE conduct_items SET kind = ?, title = ?, rationale = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(kind, d.title, d.rationale, status, Number(cid));
    }
    audit(request.user?.id ?? null, `conduta_${d.action}`, 'conduct', Number(cid), { analysis_id: Number(aid), title: d.title }, request.id);
    return reply.redirect(`/casos/${id}/analises/${aid}/conduta`);
  });

  /* ----------------------------------------------------------- fórmulas */
  const formulasView = async (request: FastifyRequest, reply: FastifyReply, error: string | null = null) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const c = loadCase(Number(id));
    const row = c ? loadAnalysis(Number(id), Number(aid)) : null;
    const analysis = loadAnalyses(Number(id)).find((a) => a.id === Number(aid));
    if (!c || !row || !analysis) return reply.code(404).send('Análise não encontrada');
    const formulas = allFormulas().filter((f) => f.status === 'ativo');
    const byId = new Map(formulas.map((f) => [f.id, f]));
    const raw = getSettingLocal(`formulas.sug.${aid}`);
    const stored = raw ? (JSON.parse(raw) as { items: Array<{ formula_id: number; justificativa: string; ajuste: string; conduct_id: number | null }>; note: string }) : { items: [], note: '' };
    const conduct = loadConduct(Number(aid));
    const suggestions = stored.items.map((it) => ({ formula: byId.get(it.formula_id) ?? allFormulas().find((f) => f.id === it.formula_id) ?? ({ id: it.formula_id, name: 'item removido do banco', kind: 'manipulada', composition: '', posology: '', indications: '', exams: [], contraindications: '', notes: '', status: 'inativo' } as Formula), justificativa: it.justificativa, ajuste: it.ajuste, conductId: it.conduct_id, status: conduct.find((ci) => ci.id === it.conduct_id)?.status ?? null }));
    return page(request, reply, 'Fórmulas', caseFormulasPage({ c, analysis, formulas, suggestions, note: stored.note || null, aiOn: aiEnabled(), error }));
  };
  app.get('/casos/:id/analises/:aid/formulas', async (request, reply) => formulasView(request, reply));

  const addFormulaToConduct = (caseId: number, analysisId: number, f: Formula, justificativa: string, ajuste: string, status: 'sugerida' | 'aprovada'): number => {
    const rationale = `${justificativa}\n\nComposição: ${f.composition}\nPosologia: ${f.posology}${ajuste ? `\nAjuste sugerido: ${ajuste}` : ''}${f.contraindications ? `\nContraindicações/monitorização: ${f.contraindications}` : ''}`;
    const info = getDb().prepare("INSERT INTO conduct_items(case_id, analysis_id, kind, title, rationale, exams, origin, status, position) VALUES (?, ?, ?, ?, ?, ?, 'biblioteca', ?, ?)").run(caseId, analysisId, f.kind === 'suplemento' ? 'suplementacao' : 'medicamentoso', f.name, rationale, f.exams.join('|'), status, loadConduct(analysisId).length);
    return Number(info.lastInsertRowid);
  };

  app.post('/casos/:id/analises/:aid/formulas/sugerir', async (request, reply) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const c = loadCase(Number(id));
    const row = c ? loadAnalysis(Number(id), Number(aid)) : null;
    if (!c || !row) return reply.code(404).send('Análise não encontrada');
    if (strOrNull(row, 'finalized_at')) return formulasView(request, reply, 'Relatório já finalizado; reabra na conduta para alterar.');
    if (!aiEnabled()) return formulasView(request, reply, 'IA desligada.');
    const bank = allFormulas().filter((f) => f.status === 'ativo');
    if (!bank.length) return formulasView(request, reply, 'Seu banco não tem itens ativos; cadastre e ative em Fórmulas e medicamentos.');
    const { evals, profile, derived, guidances, score } = evaluateCase(c, loadResults(Number(id)));
    try {
      const res = await suggestFormulas({ ...reportPayload(c, profile, evals, derived, guidances, score), banco: bank.map((f) => ({ formula_id: f.id, nome: f.name, tipo: f.kind, composicao: f.composition, posologia: f.posology, indicacoes: f.indications, exames: f.exams, contraindicacoes: f.contraindications })) }, Number(id));
      const items = res.sugestoes.filter((sg) => bank.some((f) => f.id === sg.formula_id)).map((sg) => {
        const f = bank.find((x) => x.id === sg.formula_id) as Formula;
        return { formula_id: sg.formula_id, justificativa: sg.justificativa, ajuste: sg.ajuste, conduct_id: addFormulaToConduct(Number(id), Number(aid), f, sg.justificativa, sg.ajuste, 'sugerida') };
      });
      getDb().prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`formulas.sug.${aid}`, JSON.stringify({ items, note: res.observacao.slice(0, 2000) }));
      audit(request.user?.id ?? null, 'sugerir_formulas_ia', 'analysis', Number(aid), { items: items.length }, request.id);
      return reply.redirect(`/casos/${id}/analises/${aid}/formulas?kind=ok&msg=${encodeURIComponent(`${items.length} sugestão(ões) do seu banco. Aprove ou rejeite cada uma.`)}`);
    } catch (error) {
      request.log.error({ err: error }, 'falha na sugestão de fórmulas');
      return formulasView(request, reply, error instanceof AiError ? error.message : 'Falha inesperada na IA.');
    }
  });

  app.post('/casos/:id/analises/:aid/formulas/:fid/adicionar', async (request, reply) => {
    const { id, aid, fid } = request.params as { id: string; aid: string; fid: string };
    const c = loadCase(Number(id));
    const row = c ? loadAnalysis(Number(id), Number(aid)) : null;
    if (!c || !row) return reply.code(404).send('Análise não encontrada');
    if (strOrNull(row, 'finalized_at')) return formulasView(request, reply, 'Relatório já finalizado.');
    const f = allFormulas().find((x) => x.id === Number(fid) && x.status === 'ativo');
    if (!f) return formulasView(request, reply, 'Item não encontrado ou inativo.');
    const cid = addFormulaToConduct(Number(id), Number(aid), f, 'Adicionado manualmente pelo médico.', '', 'aprovada');
    audit(request.user?.id ?? null, 'formula_adicionada', 'conduct', cid, { formula_id: f.id }, request.id);
    return reply.redirect(`/casos/${id}/analises/${aid}/conduta?kind=ok&msg=${encodeURIComponent(`${f.name} adicionado à conduta (aprovado).`)}`);
  });

  app.post('/casos/:id/analises/:aid/finalizar', async (request, reply) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const c = loadCase(Number(id));
    const row = c ? loadAnalysis(Number(id), Number(aid)) : null;
    if (!c || !row) return reply.code(404).send('Análise não encontrada');
    const body = (request.body ?? {}) as { action?: string; doctor_notes?: string };
    if (body.action === 'reabrir') {
      getDb().prepare('UPDATE analyses SET final_patient = NULL, final_technical = NULL, finalized_at = NULL WHERE id = ?').run(Number(aid));
      audit(request.user?.id ?? null, 'reabrir_analise', 'analysis', Number(aid), null, request.id);
      return reply.redirect(`/casos/${id}/analises/${aid}/conduta`);
    }
    const notes = (body.doctor_notes ?? '').trim().slice(0, 5000);
    getDb().prepare("UPDATE cases SET doctor_notes = ?, updated_at = datetime('now') WHERE id = ?").run(notes, Number(id));
    const approved: ConductItem[] = loadConduct(Number(aid)).filter((i) => i.status === 'aprovada').map((i) => ({ kind: i.kind, title: i.title, rationale: i.rationale, exams: i.exams, sources: i.sources, origin: i.origin }));
    const results = loadResults(Number(id)).filter((r) => !r.excluded);
    const { profile, evals, derived, derivedEvals, guidances, score } = evaluateCase(c, results);
    const narrativeRaw = strOrNull(row, 'markdown_patient');
    void narrativeRaw;
    const input: ReportInput = { caseInfo: caseInfoOf({ ...c, doctor_notes: notes }, loadFiles(Number(id)).map((f) => f.original_name)), profile, evals, derived, derivedEvals, guidances, score, tableVersion: str(row, 'table_version'), narrative: null, aiModel: strOrNull(row, 'ai_model'), generatedAt: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }), conduct: approved, doctorNotes: notes, authorName: request.user?.name ?? 'médico responsável', settings: reportSettings() };
    // Mantém a redação já gerada: reaproveita as seções narrativas do markdown anterior quando existirem.
    const finalPatient = mergeNarrative(str(row, 'markdown_patient'), buildPatientReport(input));
    const finalTechnical = mergeNarrative(str(row, 'markdown_technical'), buildTechnicalReport(input));
    getDb().prepare("UPDATE analyses SET final_patient = ?, final_technical = ?, finalized_at = datetime('now') WHERE id = ?").run(finalPatient, finalTechnical, Number(aid));
    getDb().prepare("UPDATE cases SET status = 'revisado', updated_at = datetime('now') WHERE id = ?").run(Number(id));
    audit(request.user?.id ?? null, 'finalizar_analise', 'analysis', Number(aid), { approved: approved.length, notes: !!notes }, request.id);
    return reply.redirect(`/casos/${id}/analises/${aid}?kind=ok&msg=${encodeURIComponent('Relatório final gerado com a conduta aprovada. Imprima ou salve em PDF.')}`);
  });

  app.get('/casos/:id/analises/:aid/imprimir', async (request, reply) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const tipo = (request.query as { tipo?: string }).tipo === 'tecnico' ? 'tecnico' : 'resumido';
    const c = loadCase(Number(id));
    const row = c ? loadAnalysis(Number(id), Number(aid)) : null;
    if (!row || !c) return reply.code(404).send('Análise não encontrada');
    const md = pickMarkdown(row, tipo);
    const score = scoreFromRow(row);
    audit(request.user?.id ?? null, 'imprimir_analise', 'analysis', Number(aid), { tipo }, request.id);
    const gauge = `<div style="text-align:center;margin:8px 0 18px">${gaugeSvg(score?.total ?? null, 220)}</div>`;
    return reply.type('text/html; charset=utf-8').send(layout({ title: `Análise #${aid} (${tipo})`, user: request.user, body: gauge + renderMarkdown(md), print: true }));
  });

  app.get('/casos/:id/analises/:aid/download', async (request, reply) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const tipo = (request.query as { tipo?: string }).tipo === 'tecnico' ? 'tecnico' : 'resumido';
    const c = loadCase(Number(id));
    const row = c ? loadAnalysis(Number(id), Number(aid)) : null;
    if (!row || !c) return reply.code(404).send('Análise não encontrada');
    const last = getDb().prepare('SELECT MAX(collection_date) AS d FROM results WHERE case_id = ?').get(Number(id)) as Row;
    const date = strOrNull(last, 'd') ?? str(row, 'created_at').slice(0, 10);
    const name = `analise-exames_${c.patient_code.replace(/[^\w.-]+/g, '-')}_${date}_${tipo}.md`;
    audit(request.user?.id ?? null, 'baixar_analise', 'analysis', Number(aid), { file: name }, request.id);
    return reply.header('Content-Disposition', `attachment; filename="${name}"`).type('text/markdown; charset=utf-8').send(pickMarkdown(row, tipo));
  });

  app.get('/casos/:id/previa', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const c = loadCase(id);
    if (!c) return reply.code(404).send('Caso não encontrado');
    const { evals } = evaluateCase(c, loadResults(id));
    return reply.send({ data: evals.map((e) => ({ exam: e.exam_canonical, classification: e.classification, notes: e.notes })), meta: { requestId: request.id } });
  });

  app.get('/casos/:id/arquivos/:fid', async (request, reply) => {
    const { id, fid } = request.params as { id: string; fid: string };
    const row = getDb().prepare('SELECT * FROM case_files WHERE id = ? AND case_id = ?').get(Number(fid), Number(id)) as Row | undefined;
    if (!row) return reply.code(404).send('Arquivo não encontrado');
    audit(request.user?.id ?? null, 'ver_arquivo', 'case', Number(id), { file: str(row, 'original_name') }, request.id);
    return reply.type(str(row, 'mime') || 'application/pdf').header('Content-Disposition', `inline; filename="${h(str(row, 'original_name'))}"`).send(fs.createReadStream(path.join(UPLOAD_DIR, str(row, 'stored_name'))));
  });
}

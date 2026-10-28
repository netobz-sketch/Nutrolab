import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../auth.js';
import { AiError, AI_MODEL, aiEnabled, extractFromPdf, writeNarrative, type Narrative } from '../ai.js';
import { allGuidances, allRules, audit, enabledCalcIds, getDb, list, num, numOrNull, str, strOrNull, tableVersion, UPLOAD_DIR, type Row } from '../db.js';
import { applicableGuidances, computeDerived, CONTEXTS, evaluateAll, evaluateResult, type Evaluation, type PatientProfile, type ResultInput } from '../engine/index.js';
import { renderMarkdown } from '../markdown.js';
import { buildReport } from '../report.js';
import { h, layout } from '../views/html.js';
import { analysisPage, caseFormPage, casePage, casesPage, type AnalysisRow, type CaseRow, type FileRow, type ResultRow } from '../views/pages.js';

const MAX_PDF = 25 * 1024 * 1024;

const CaseBody = z.object({
  patient_code: z.string().trim().min(1).max(40).regex(/^[\w.\-/ ]+$/u, 'use só letras, números, ponto, traço ou barra'),
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

function rowToCase(row: Row): CaseRow {
  return {
    id: num(row, 'id'),
    patient_code: str(row, 'patient_code'),
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
  }));
}

function loadFiles(caseId: number): FileRow[] {
  return (getDb().prepare('SELECT * FROM case_files WHERE case_id = ? ORDER BY id').all(caseId) as Row[]).map((r) => ({ id: num(r, 'id'), original_name: str(r, 'original_name'), size: num(r, 'size'), created_at: str(r, 'created_at') }));
}

function profileOf(c: CaseRow): PatientProfile {
  return { sex: c.sex === 'M' || c.sex === 'F' ? c.sex : null, birthDate: c.birth_date, contexts: new Set(c.contexts) };
}

function toInputs(results: ResultRow[]): ResultInput[] {
  return results.map((r) => ({ ...r, confidence: r.confidence as ResultInput['confidence'], derived: false }));
}

function page(request: FastifyRequest, reply: FastifyReply, title: string, body: string, flash?: { kind: 'ok' | 'err' | 'warn'; text: string } | null) {
  const q = request.query as { msg?: string; kind?: string };
  const f = flash ?? (q.msg ? { kind: (q.kind === 'err' || q.kind === 'warn' ? q.kind : 'ok') as 'ok' | 'err' | 'warn', text: q.msg } : null);
  return reply.type('text/html; charset=utf-8').send(layout({ title, user: request.user, body, flash: f, aiOn: aiEnabled() }));
}

function redirectMsg(reply: FastifyReply, to: string, msg: string, kind: 'ok' | 'err' | 'warn' = 'ok') {
  return reply.redirect(`${to}?kind=${kind}&msg=${encodeURIComponent(msg)}`);
}

function evaluateCase(c: CaseRow, results: ResultRow[]) {
  const rules = allRules();
  const profile = profileOf(c);
  const evals = evaluateAll(toInputs(results), rules, profile);
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
  return { rules, profile, evals, derived, derivedEvals, guidances };
}

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
      .prepare('INSERT INTO cases(patient_code, sex, birth_date, contexts, medications, supplements, comorbidities, goal, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.patient_code, d.sex || null, d.birth_date || null, toList(d.contexts).join('|'), d.medications, d.supplements, d.comorbidities, d.goal, d.notes, request.user?.id ?? null);
    const id = Number(info.lastInsertRowid);
    audit(request.user?.id ?? null, 'criar', 'case', id, { patient_code: d.patient_code }, request.id);
    return reply.redirect(`/casos/${id}`);
  });

  app.get('/casos/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const c = loadCase(id);
    if (!c) return reply.code(404).send('Caso não encontrado');
    const results = loadResults(id);
    const { evals } = evaluateCase(c, results);
    const analyses: AnalysisRow[] = (getDb().prepare('SELECT id, created_at, table_version, ai_used, ai_model FROM analyses WHERE case_id = ? ORDER BY id DESC').all(id) as Row[]).map((a) => ({ id: num(a, 'id'), created_at: str(a, 'created_at'), table_version: str(a, 'table_version'), ai_used: num(a, 'ai_used') === 1, ai_model: strOrNull(a, 'ai_model') }));
    return page(request, reply, `Caso ${c.patient_code}`, casePage({ c, files: loadFiles(id), results, evals, analyses, aiOn: aiEnabled(), isAdmin: request.user?.role === 'admin', tableVersion: tableVersion() }));
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
      .prepare("UPDATE cases SET patient_code=?, sex=?, birth_date=?, contexts=?, medications=?, supplements=?, comorbidities=?, goal=?, notes=?, updated_at=datetime('now') WHERE id=?")
      .run(d.patient_code, d.sex || null, d.birth_date || null, toList(d.contexts).join('|'), d.medications, d.supplements, d.comorbidities, d.goal, d.notes, id);
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
    db.prepare("UPDATE cases SET deleted_at = datetime('now'), status = 'arquivado' WHERE id = ?").run(id);
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
      if (part.file.truncated || buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        rejected += 1;
        continue;
      }
      const stored = `${id}-${crypto.randomUUID()}.pdf`;
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
      const original = path.basename(part.filename || 'exames.pdf').slice(0, 120);
      getDb().prepare('INSERT INTO case_files(case_id, original_name, stored_name, size) VALUES (?, ?, ?, ?)').run(id, original, stored, buf.length);
      saved += 1;
    }
    audit(request.user?.id ?? null, 'upload', 'case', id, { saved, rejected }, request.id);
    return redirectMsg(reply, `/casos/${id}`, rejected ? `${saved} arquivo(s) salvo(s); ${rejected} rejeitado(s) (não é PDF ou excede 25 MB).` : `${saved} arquivo(s) salvo(s).`, rejected ? 'warn' : 'ok');
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
      const catalog = Object.values(
        allRules().reduce<Record<string, { exam: string; aliases: string[] }>>((acc, r) => {
          const entry = acc[r.exam_canonical] ?? { exam: r.exam_canonical, aliases: [] };
          entry.aliases = [...new Set([...entry.aliases, ...r.aliases])];
          acc[r.exam_canonical] = entry;
          return acc;
        }, {}),
      );
      const extraction = await extractFromPdf(pdf, catalog, caseId);
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
    const results = loadResults(id);
    if (!results.length) return redirectMsg(reply, `/casos/${id}`, 'Lance ao menos um resultado antes de gerar a análise.', 'err');
    const wantNarrative = (request.body as { narrative?: string } | null)?.narrative === '1' && aiEnabled();
    const { profile, evals, derived, derivedEvals, guidances } = evaluateCase(c, results);
    let narrative: Narrative | null = null;
    let warning = '';
    if (wantNarrative) {
      try {
        narrative = await writeNarrative(
          {
            paciente: { codigo: c.patient_code, sexo: c.sex, contextos: [...profile.contexts] },
            resultados: evals.map((e) => ({ exame: e.exam_canonical ?? e.result.exam_raw, valor: e.result.value_raw, unidade: e.result.unit_raw, referencia_lab: e.result.lab_reference, sinal_lab: e.result.lab_flag, classificacao: e.classification, critico: e.critical, data: e.result.collection_date, notas: e.notes })),
            calculos: derived.map((d) => ({ indice: d.name, valor: d.value, motivo: d.reason, data: d.collection_date })),
            orientacoes_aplicaveis: guidances.map((g) => g.guidance.title),
          },
          id,
        );
      } catch (error) {
        request.log.error({ err: error }, 'falha na redação');
        warning = ` Redação automática falhou (${error instanceof AiError ? error.message : 'erro inesperado'}); relatório gerado só com o motor de regras.`;
      }
    }
    const version = tableVersion();
    const markdown = buildReport({
      caseInfo: { id, patient_code: c.patient_code, sex: c.sex === 'M' || c.sex === 'F' ? c.sex : null, birth_date: c.birth_date, medications: c.medications, supplements: c.supplements, comorbidities: c.comorbidities, goal: c.goal, notes: c.notes, files: loadFiles(id).map((f) => f.original_name) },
      profile,
      evals,
      derived,
      derivedEvals,
      guidances,
      tableVersion: version,
      narrative,
      aiModel: narrative ? AI_MODEL : null,
      generatedAt: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    });
    const info = getDb().prepare('INSERT INTO analyses(case_id, markdown, table_version, ai_used, ai_model, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(id, markdown, version, narrative ? 1 : 0, narrative ? AI_MODEL : null, request.user?.id ?? null);
    getDb().prepare("UPDATE cases SET updated_at = datetime('now') WHERE id = ?").run(id);
    const analysisId = Number(info.lastInsertRowid);
    audit(request.user?.id ?? null, 'gerar_analise', 'analysis', analysisId, { case_id: id, results: results.length, ai: !!narrative, table_version: version, guidances: guidances.map((g) => g.guidance.code) }, request.id);
    return redirectMsg(reply, `/casos/${id}/analises/${analysisId}`, `Análise gerada.${warning}`, warning ? 'warn' : 'ok');
  });

  app.get('/casos/:id/analises/:aid', async (request, reply) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const row = getDb().prepare('SELECT * FROM analyses WHERE id = ? AND case_id = ?').get(Number(aid), Number(id)) as Row | undefined;
    if (!row || !loadCase(Number(id))) return reply.code(404).send('Análise não encontrada');
    return page(request, reply, `Análise #${aid}`, analysisPage(Number(id), Number(aid), renderMarkdown(str(row, 'markdown'))));
  });

  app.get('/casos/:id/analises/:aid/download', async (request, reply) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const c = loadCase(Number(id));
    const row = getDb().prepare('SELECT * FROM analyses WHERE id = ? AND case_id = ?').get(Number(aid), Number(id)) as Row | undefined;
    if (!row || !c) return reply.code(404).send('Análise não encontrada');
    const last = getDb().prepare('SELECT MAX(collection_date) AS d FROM results WHERE case_id = ?').get(Number(id)) as Row;
    const date = strOrNull(last, 'd') ?? str(row, 'created_at').slice(0, 10);
    const name = `analise-exames_${c.patient_code.replace(/[^\w.-]+/g, '-')}_${date}.md`;
    audit(request.user?.id ?? null, 'baixar_analise', 'analysis', Number(aid), { file: name }, request.id);
    return reply.header('Content-Disposition', `attachment; filename="${name}"`).type('text/markdown; charset=utf-8').send(str(row, 'markdown'));
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
    return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${h(str(row, 'original_name'))}"`).send(fs.createReadStream(path.join(UPLOAD_DIR, str(row, 'stored_name'))));
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createResetToken, hashPassword, requireAdmin, requireAuth, userExists } from '../auth.js';
import { appUrl, mailEnabled } from '../mail.js';
import { AI_MODEL, aiEnabled, AiError, draftFormula, extractFormulary } from '../ai.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { docxText } from '../docx.js';
import { allFormulas, allGuidances, allRules, allTemplates, rowToTemplate, audit, BRAND_DIR, enabledCalcIds, FORMULARY_DIR, getAsyncDb, num, numOrNull, parseCsv, reportSettings, rowToFormula, rowToGuidance, rowToRule, rulesToCsv, RULE_CSV_COLUMNS, setSetting, str, strOrNull, type Row } from '../db.js';
import { CALCS, CLASSIFICATIONS, CONTEXTS, SYSTEMS } from '../engine/index.js';
const CONDUCT_KIND_LABEL_UI: Record<string, string> = { suplementacao: 'Suplementação', estilo_de_vida: 'Estilo de vida', seguimento: 'Seguimento', exame: 'Exames complementares', encaminhamento: 'Encaminhamento', medicamentoso: 'Medicamentoso', outro: 'Outros' };
import { normalizeCouncilNumber, normalizeCpf } from '../cpf.js';
import { layout } from '../views/html.js';
import { auditPage, formulaFormPage, formulasPage, templateFormPage, templatesPage, guidanceFormPage, guidancesPage, quickRulesPage, reportsPage, ruleFormPage, rulesPage, settingsPage, type AuditRow, type FormularyFileRow, type ReportListRow, type UserRow } from '../views/pages.js';

const numOpt = z.string().trim().default('').transform((s) => (s === '' ? null : Number(s))).refine((n) => n === null || Number.isFinite(n), 'número inválido');
const intOpt = z.string().trim().default('').transform((s) => (s === '' ? null : Number(s))).refine((n) => n === null || Number.isInteger(n), 'inteiro inválido');
const multi = z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]));

const RuleBody = z
  .object({
    exam_canonical: z.string().trim().regex(/^[a-z0-9_]+$/, 'exame canônico deve ser snake_case'),
    aliases: z.string().trim().default(''),
    system: z.string().trim().default('outros'),
    normal_min: numOpt,
    normal_max: numOpt,
    sex: z.enum(['todos', 'M', 'F']),
    age_min: intOpt,
    age_max: intOpt,
    contexts: multi,
    unit: z.string().trim().min(1, 'unidade obrigatória').max(30),
    target_min: numOpt,
    target_max: numOpt,
    target_text: z.string().trim().max(80).default(''),
    critical_low: numOpt,
    critical_high: numOpt,
    guidance_ids: multi,
    clinical_source: z.string().trim().min(1, 'fonte clínica obrigatória').max(300),
    version: z.string().trim().min(1).max(20),
    reviewed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data de revisão inválida'),
    status: z.enum(['ativo', 'rascunho', 'inativo']),
  })
  .superRefine((r, ctx) => {
    if (r.target_min === null && r.target_max === null && !r.target_text && r.normal_min === null && r.normal_max === null) ctx.addIssue({ code: 'custom', message: 'preencha o alvo ótimo, o alvo textual ou a faixa de normalidade' });
    if (r.normal_min !== null && r.normal_max !== null && r.normal_min > r.normal_max) ctx.addIssue({ code: 'custom', message: 'normalidade mínima maior que a máxima' });
    if (!(r.system in SYSTEMS)) ctx.addIssue({ code: 'custom', message: 'sistema inválido' });
    if (r.target_min !== null && r.target_max !== null && r.target_min > r.target_max) ctx.addIssue({ code: 'custom', message: 'alvo mínimo maior que o máximo' });
    if (r.age_min !== null && r.age_max !== null && r.age_min > r.age_max) ctx.addIssue({ code: 'custom', message: 'idade mínima maior que a máxima' });
    if (r.critical_low !== null && r.target_min !== null && r.critical_low > r.target_min) ctx.addIssue({ code: 'custom', message: 'limite crítico inferior acima do alvo mínimo' });
    if (r.critical_high !== null && r.target_max !== null && r.critical_high < r.target_max) ctx.addIssue({ code: 'custom', message: 'limite crítico superior abaixo do alvo máximo' });
    if (Number.isNaN(new Date(r.reviewed_at).getTime())) ctx.addIssue({ code: 'custom', message: 'data de revisão inválida' });
    if (r.status === 'ativo' && /^exemplo/i.test(r.clinical_source)) ctx.addIssue({ code: 'custom', message: 'linha de exemplo não pode ser ativada: substitua a fonte clínica pela fonte real' });
    if (r.contexts.some((c) => !(c in CONTEXTS))) ctx.addIssue({ code: 'custom', message: 'contexto fora do vocabulário' });
  });

const GuidanceBody = z
  .object({
    code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]*$/, 'código deve ser MAIÚSCULAS, dígitos e hífens'),
    title: z.string().trim().min(1).max(120),
    exam_canonical: z.string().trim().regex(/^[a-z0-9_]*$/).default(''),
    trigger: z.string().refine((t) => (CLASSIFICATIONS as string[]).includes(t) || t === 'critico' || t === 'manual', 'gatilho inválido'),
    contexts_required: multi,
    contexts_excluded: multi,
    not_apply_note: z.string().trim().max(1000).default(''),
    patient_text: z.string().trim().min(1, 'texto ao paciente obrigatório').max(2000),
    requires_alert: z.enum(['0', '1']),
    clinical_source: z.string().trim().min(1, 'fonte clínica obrigatória').max(300),
    version: z.string().trim().min(1).max(20),
    reviewed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data de revisão inválida'),
    status: z.enum(['ativo', 'rascunho', 'inativo']),
  })
  .superRefine((g, ctx) => {
    if (g.status === 'ativo' && /^exemplo/i.test(g.clinical_source)) ctx.addIssue({ code: 'custom', message: 'orientação de exemplo não pode ser ativada: substitua a fonte clínica' });
    if (g.status === 'ativo' && /\b(mg|mcg|ui|comprimido|cápsula|gotas|dose)\b/i.test(g.patient_text)) ctx.addIssue({ code: 'custom', message: 'texto ao paciente parece conter dose/prescrição; isso exige processo explícito de validação médica e não pode ser ativado pela tela' });
  });

const UserBody = z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email().transform((e) => e.toLowerCase()), password: z.string().min(10, 'senha com ao menos 10 caracteres'), role: z.enum(['admin', 'medico']), cpf: z.string().trim().default(''), council: z.string().trim().default(''), council_number: z.string().trim().default(''), council_state: z.string().trim().toUpperCase().default('') });

function page(request: FastifyRequest, reply: FastifyReply, title: string, body: string) {
  const q = request.query as { msg?: string; kind?: string };
  const flash = q.msg ? { kind: (q.kind === 'err' || q.kind === 'warn' ? q.kind : 'ok') as 'ok' | 'err' | 'warn', text: q.msg } : null;
  return reply.type('text/html; charset=utf-8').send(layout({ title, user: request.user, body, flash, aiOn: aiEnabled(), active: request.url.split('/')[1]?.split('?')[0] }));
}
const ok = (reply: FastifyReply, to: string, msg: string) => reply.redirect(`${to}?kind=ok&msg=${encodeURIComponent(msg)}`);
const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? 'Dados inválidos.';
const calcIds = CALCS.map((c) => c.id);

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /* ---------------------------------------------------------------- regras */
  app.get('/regras', async (request, reply) => {
    const q = request.query as { sistema?: string; q?: string; pendentes?: string };
    const sys = q.sistema ?? null;
    const draftGuidances = (await allGuidances()).filter((g) => g.status === 'rascunho').length;
    return page(request, reply, 'Referências dos exames', quickRulesPage((await allRules()), sys && sys in SYSTEMS ? sys : null, (q.q ?? '').slice(0, 60), { pendingOnly: q.pendentes === '1', draftGuidances }));
  });
  app.get('/regras/lista', async (request, reply) => page(request, reply, 'Exames e referências', rulesPage((await allRules()), (await allGuidances()))));
  app.get('/regras/nova', async (request, reply) => page(request, reply, 'Nova regra', ruleFormPage(null, (await allGuidances()), null, calcIds)));

  app.get('/regras/rapido', async (request, reply) => reply.redirect(`/regras${request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}`));

  const QuickBody = z.object({ critical_low: numOpt, normal_min: numOpt, target_min: numOpt, target_max: numOpt, normal_max: numOpt, critical_high: numOpt, status: z.enum(['ativo', 'rascunho', 'inativo']), conferir: z.literal('1').optional() });
  app.post('/regras/:id/rapido', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = (await getAsyncDb().prepare('SELECT * FROM rules WHERE id = ?').get(id)) as Row | undefined;
    if (!row) return reply.code(404).send('Regra não encontrada');
    const parsed = QuickBody.safeParse(request.body);
    const q = request.query as { pendentes?: string };
    const back = (msg: string, kind = 'err') => reply.redirect(`/regras?sistema=${encodeURIComponent(str(row, 'system'))}${q.pendentes === '1' ? '&pendentes=1' : ''}&kind=${kind}&msg=${encodeURIComponent(msg)}#r${id}`);
    if (!parsed.success) return back(`${str(row, 'exam_canonical')}: ${firstIssue(parsed.error)}`);
    const d = parsed.data;
    const seq = [d.critical_low, d.normal_min, d.target_min, d.target_max, d.normal_max, d.critical_high].filter((v): v is number => v !== null);
    for (let i = 1; i < seq.length; i += 1) if ((seq[i] ?? 0) < (seq[i - 1] ?? 0)) return back(`${str(row, 'exam_canonical')}: os valores precisam crescer da esquerda para a direita (crítico ↓ ≤ normal ↓ ≤ ótimo ↓ ≤ ótimo ↑ ≤ normal ↑ ≤ crítico ↑).`);
    if (d.status === 'ativo' && /^exemplo/i.test(str(row, 'clinical_source'))) return back(`${str(row, 'exam_canonical')}: linha de exemplo não pode ser ativada; abra "Completo" e informe a fonte clínica.`);
    if (d.status === 'ativo' && seq.length === 0 && !strOrNull(row, 'target_text')) return back(`${str(row, 'exam_canonical')}: para ativar, informe ao menos uma faixa.`);
    const conferir = d.conferir === '1';
    if (conferir && d.status === 'rascunho') return back(`${str(row, 'exam_canonical')}: rascunho não se confere; ative a linha (ou inative, se não for usar) e clique em Conferido.`);
    const before = { critical_low: numOrNull(row, 'critical_low'), normal_min: numOrNull(row, 'normal_min'), target_min: numOrNull(row, 'target_min'), target_max: numOrNull(row, 'target_max'), normal_max: numOrNull(row, 'normal_max'), critical_high: numOrNull(row, 'critical_high'), status: str(row, 'status') };
    const after = { critical_low: d.critical_low, normal_min: d.normal_min, target_min: d.target_min, target_max: d.target_max, normal_max: d.normal_max, critical_high: d.critical_high, status: d.status };
    const changed = (Object.keys(after) as Array<keyof typeof after>).some((k) => after[k] !== before[k]);
    // Conferido marca a linha com os valores salvos agora; mudar valor sem conferir apaga a marca antiga.
    const check = conferir ? "checked_at=datetime('now'), checked_by=?" : changed ? 'checked_at=NULL, checked_by=NULL' : 'checked_by=checked_by';
    const user = request.user?.id ?? null;
    (await getAsyncDb().prepare(`UPDATE rules SET critical_low=?, normal_min=?, target_min=?, target_max=?, normal_max=?, critical_high=?, status=?, reviewed_at=date('now'), ${check}, updated_by=?, updated_at=datetime('now') WHERE id=?`).run(...[d.critical_low, d.normal_min, d.target_min, d.target_max, d.normal_max, d.critical_high, d.status, ...(conferir ? [user] : []), user, id]));
    await audit(user, conferir ? 'conferir_regra' : 'editar_rapido', 'rule', id, { before, after, changed }, request.id);
    return back(`${str(row, 'exam_canonical')} ${conferir ? 'conferido' : 'salvo'} (${d.status}).`, 'ok');
  });

  /* -------------------------------------------------------------- fórmulas */
  const FormulaBody = z.object({ name: z.string().trim().min(2).max(160), kind: z.enum(['manipulada', 'medicamento', 'suplemento']), composition: z.string().trim().max(4000).default(''), posology: z.string().trim().max(2000).default(''), indications: z.string().trim().max(3000).default(''), exams: z.string().trim().max(500).default(''), contraindications: z.string().trim().max(3000).default(''), notes: z.string().trim().max(3000).default(''), status: z.enum(['ativo', 'rascunho', 'inativo']) });
  const loadFormularyFiles = async (): Promise<FormularyFileRow[]> => ((await getAsyncDb().prepare('SELECT * FROM formula_files ORDER BY id DESC').all()) as Row[]).map((r) => ({ id: num(r, 'id'), original_name: str(r, 'original_name'), mime: str(r, 'mime'), size: num(r, 'size'), extracted_count: numOrNull(r, 'extracted_count'), created_at: str(r, 'created_at') }));
  const formulasView = async (request: FastifyRequest, reply: FastifyReply, error: string | null = null) => page(request, reply, 'Fórmulas', formulasPage((await allFormulas()), aiEnabled(), error, (await loadFormularyFiles())));
  app.get('/formulas', async (request, reply) => formulasView(request, reply));

  app.post('/formulas/arquivos', { preHandler: requireAdmin }, async (request, reply) => {
    let saved = 0;
    let rejected = 0;
    for await (const part of request.files({ limits: { fileSize: 25 * 1024 * 1024, files: 10 } })) {
      const buf = await part.toBuffer();
      const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
      const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50 && /\.docx$/i.test(part.filename ?? '');
      if (part.file.truncated || (!isPdf && !isZip)) {
        rejected += 1;
        continue;
      }
      const mime = isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const stored = `${crypto.randomUUID()}.${isPdf ? 'pdf' : 'docx'}`;
      fs.writeFileSync(path.join(FORMULARY_DIR, stored), buf);
      (await getAsyncDb().prepare('INSERT INTO formula_files(original_name, stored_name, mime, size, created_by) VALUES (?, ?, ?, ?, ?)').run(path.basename(part.filename || 'formulario').slice(0, 120), stored, mime, buf.length, request.user?.id ?? null));
      saved += 1;
    }
    await audit(request.user?.id ?? null, 'upload_formulario', 'formula_file', null, { saved, rejected }, request.id);
    return reply.redirect(`/formulas?kind=${rejected ? 'warn' : 'ok'}&msg=${encodeURIComponent(`${saved} arquivo(s) anexado(s).${rejected ? ` ${rejected} rejeitado(s): só .docx e .pdf até 25 MB.` : ' Agora clique em "Gerar fórmulas com IA".'}`)}`);
  });

  app.post('/formulas/arquivos/:id/extrair', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = (await getAsyncDb().prepare('SELECT * FROM formula_files WHERE id = ?').get(id)) as Row | undefined;
    if (!row) return reply.code(404).send('Arquivo não encontrado');
    if (!aiEnabled()) return formulasView(request, reply, 'IA desligada.');
    try {
      const buf = fs.readFileSync(path.join(FORMULARY_DIR, str(row, 'stored_name')));
      const catalog = [...new Set((await allRules()).map((r) => r.exam_canonical))];
      const source = str(row, 'mime') === 'application/pdf' ? ({ kind: 'pdf', data: buf } as const) : ({ kind: 'text', text: docxText(buf) } as const);
      if (source.kind === 'text' && source.text.length < 20) return formulasView(request, reply, 'O documento Word parece vazio ou sem texto legível.');
      const result = await extractFormulary(source, catalog);
      const insert = (await getAsyncDb().prepare("INSERT INTO formulas(name, kind, composition, posology, indications, exams, contraindications, notes, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rascunho', ?)"));
      for (const f of result.formulas) insert.run(f.nome.slice(0, 160), f.tipo, f.composicao.slice(0, 4000), f.posologia.slice(0, 2000), f.indicacoes.slice(0, 3000), f.exames.filter((x) => catalog.includes(x)).join('|'), f.contraindicacoes.slice(0, 3000), [`Origem: ${str(row, 'original_name')}`, f.observacoes].filter(Boolean).join(' · ').slice(0, 3000), request.user?.id ?? null);
      (await getAsyncDb().prepare('UPDATE formula_files SET extracted_count = ? WHERE id = ?').run(result.formulas.length, id));
      await audit(request.user?.id ?? null, 'extrair_formulario_ia', 'formula_file', id, { items: result.formulas.length, obs: result.observacoes.slice(0, 300) }, request.id);
      return reply.redirect(`/formulas?kind=ok&msg=${encodeURIComponent(`${result.formulas.length} item(ns) criados em rascunho a partir de ${str(row, 'original_name')}. Revise e ative.${result.observacoes ? ` Observações: ${result.observacoes.slice(0, 200)}` : ''}`)}`);
    } catch (error) {
      request.log.error({ err: error }, 'falha na leitura do formulário');
      return formulasView(request, reply, error instanceof AiError ? error.message : error instanceof Error && /docx/.test(error.message) ? error.message : 'Falha inesperada ao ler o arquivo.');
    }
  });

  app.post('/formulas/arquivos/:id/excluir', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = (await getAsyncDb().prepare('SELECT * FROM formula_files WHERE id = ?').get(id)) as Row | undefined;
    if (!row) return reply.code(404).send('Arquivo não encontrado');
    fs.rmSync(path.join(FORMULARY_DIR, str(row, 'stored_name')), { force: true });
    (await getAsyncDb().prepare('DELETE FROM formula_files WHERE id = ?').run(id));
    await audit(request.user?.id ?? null, 'excluir_formulario', 'formula_file', id, { file: str(row, 'original_name') }, request.id);
    return ok(reply, '/formulas', 'Arquivo removido.');
  });
  app.get('/formulas/nova', async (request, reply) => page(request, reply, 'Novo item', formulaFormPage(null, null)));
  app.get('/formulas/:id', async (request, reply) => {
    const row = (await getAsyncDb().prepare('SELECT * FROM formulas WHERE id = ?').get(Number((request.params as { id: string }).id))) as Row | undefined;
    if (!row) return reply.code(404).send('Item não encontrado');
    return page(request, reply, 'Item', formulaFormPage(rowToFormula(row), null));
  });
  app.post('/formulas/rascunho-ia', { preHandler: requireAdmin }, async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string; kind?: string; intent?: string };
    const name = (body.name ?? '').trim();
    const kind = ['manipulada', 'medicamento', 'suplemento'].includes(body.kind ?? '') ? (body.kind as string) : 'manipulada';
    if (!name) return page(request, reply, 'Fórmulas e medicamentos', formulasPage((await allFormulas()), aiEnabled(), 'Informe um nome ou intenção.'));
    try {
      const draft = await draftFormula(name, kind, (body.intent ?? '').trim(), [...new Set((await allRules()).map((r) => r.exam_canonical))]);
      await audit(request.user?.id ?? null, 'formula_rascunho_ia', 'formula', null, { name }, request.id);
      return page(request, reply, 'Rascunho', formulaFormPage({ name: draft.nome || name, kind: kind as 'manipulada', composition: draft.composicao, posology: draft.posologia, indications: draft.indicacoes, exams: draft.exames, contraindications: draft.contraindicacoes, notes: draft.observacoes, status: 'rascunho' }, null, true));
    } catch (error) {
      request.log.error({ err: error }, 'falha no rascunho de fórmula');
      return formulasView(request, reply, error instanceof AiError ? error.message : 'Falha inesperada na IA.');
    }
  });
  const saveFormula = async (request: FastifyRequest, reply: FastifyReply, id: number | null) => {
    const parsed = FormulaBody.safeParse(request.body);
    const current = id ? ((await getAsyncDb().prepare('SELECT * FROM formulas WHERE id = ?').get(id)) as Row | undefined) : undefined;
    if (id && !current) return reply.code(404).send('Item não encontrado');
    if (!parsed.success) return page(request, reply, 'Item', formulaFormPage(current ? rowToFormula(current) : null, firstIssue(parsed.error)));
    const d = parsed.data;
    const exams = d.exams.split(/[,|]/).map((x) => x.trim()).filter(Boolean).join('|');
    const params = [d.name, d.kind, d.composition, d.posology, d.indications, exams, d.contraindications, d.notes, d.status];
    let fid = id;
    if (id) (await getAsyncDb().prepare("UPDATE formulas SET name=?, kind=?, composition=?, posology=?, indications=?, exams=?, contraindications=?, notes=?, status=?, updated_at=datetime('now') WHERE id=?").run(...params, id));
    else fid = Number((await getAsyncDb().prepare('INSERT INTO formulas(name, kind, composition, posology, indications, exams, contraindications, notes, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...params, request.user?.id ?? null)).lastInsertRowid);
    await audit(request.user?.id ?? null, id ? 'editar' : 'criar', 'formula', fid, { before: current ? rowToFormula(current) : null, after: d }, request.id);
    return ok(reply, '/formulas', `${d.name} salvo (${d.status}).`);
  };
  app.post('/formulas', { preHandler: requireAdmin }, async (request, reply) => saveFormula(request, reply, null));
  app.post('/formulas/:id', { preHandler: requireAdmin }, async (request, reply) => saveFormula(request, reply, Number((request.params as { id: string }).id)));
  app.post('/formulas/:id/excluir', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = (await getAsyncDb().prepare('SELECT * FROM formulas WHERE id = ?').get(id)) as Row | undefined;
    if (!row) return reply.code(404).send('Item não encontrado');
    (await getAsyncDb().prepare('DELETE FROM formulas WHERE id = ?').run(id));
    await audit(request.user?.id ?? null, 'excluir', 'formula', id, { before: rowToFormula(row) }, request.id);
    return ok(reply, '/formulas', 'Item excluído.');
  });

  /* ------------------------------------------------------ modelos de conduta */
  const TemplateBody = z.object({ name: z.string().trim().min(2).max(160), profile: z.string().trim().max(3000).default(''), triggers: z.string().default(''), items: z.string().default(''), status: z.enum(['ativo', 'inativo']) });
  const parseTriggers = (text: string) => text.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const parseItems = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [kind = 'outro', title = '', rationale = ''] = l.split('|').map((x) => x.trim());
    return { kind: kind in CONDUCT_KIND_LABEL_UI ? kind : 'outro', title: title.slice(0, 200), rationale: rationale.slice(0, 1000) };
  }).filter((i) => i.title);
  app.get('/modelos', async (request, reply) => page(request, reply, 'Modelos de conduta', templatesPage((await allTemplates()))));
  app.get('/modelos/novo', async (request, reply) => page(request, reply, 'Novo modelo', templateFormPage(null, null)));
  app.get('/modelos/:id', async (request, reply) => {
    const row = (await getAsyncDb().prepare('SELECT * FROM conduct_templates WHERE id = ?').get(Number((request.params as { id: string }).id))) as Row | undefined;
    if (!row) return reply.code(404).send('Modelo não encontrado');
    return page(request, reply, 'Modelo', templateFormPage(rowToTemplate(row), null));
  });
  const saveTemplate = async (request: FastifyRequest, reply: FastifyReply, id: number | null) => {
    const parsed = TemplateBody.safeParse(request.body);
    const current = id ? ((await getAsyncDb().prepare('SELECT * FROM conduct_templates WHERE id = ?').get(id)) as Row | undefined) : undefined;
    if (id && !current) return reply.code(404).send('Modelo não encontrado');
    if (!parsed.success) return page(request, reply, 'Modelo', templateFormPage(current ? rowToTemplate(current) : null, firstIssue(parsed.error)));
    const d = parsed.data;
    const triggers = parseTriggers(d.triggers);
    const valid = new Set([...CLASSIFICATIONS, 'critico']);
    const bad = triggers.find((t) => !/^[a-z0-9_]+:[a-z_]+$/.test(t) || !valid.has(t.split(':')[1] ?? ''));
    if (bad) return page(request, reply, 'Modelo', templateFormPage(current ? rowToTemplate(current) : null, `gatilho inválido: ${bad} (use exame:classificação)`));
    const items = parseItems(d.items);
    if (!items.length) return page(request, reply, 'Modelo', templateFormPage(current ? rowToTemplate(current) : null, 'informe ao menos um item (tipo | título | justificativa)'));
    let tid = id;
    if (id) (await getAsyncDb().prepare("UPDATE conduct_templates SET name=?, profile=?, triggers=?, items=?, status=?, updated_at=datetime('now') WHERE id=?").run(d.name, d.profile, triggers.join('|'), JSON.stringify(items), d.status, id));
    else tid = Number((await getAsyncDb().prepare('INSERT INTO conduct_templates(name, profile, triggers, items, status, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(d.name, d.profile, triggers.join('|'), JSON.stringify(items), d.status, request.user?.id ?? null)).lastInsertRowid);
    await audit(request.user?.id ?? null, id ? 'editar' : 'criar', 'conduct_template', tid, { name: d.name, items: items.length, triggers }, request.id);
    return ok(reply, '/modelos', `Modelo "${d.name}" salvo (${d.status}).`);
  };
  app.post('/modelos', async (request, reply) => saveTemplate(request, reply, null));
  app.post('/modelos/:id', async (request, reply) => saveTemplate(request, reply, Number((request.params as { id: string }).id)));
  app.post('/modelos/:id/excluir', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    (await getAsyncDb().prepare('DELETE FROM conduct_templates WHERE id = ?').run(id));
    await audit(request.user?.id ?? null, 'excluir', 'conduct_template', id, null, request.id);
    return ok(reply, '/modelos', 'Modelo excluído.');
  });

  /* ------------------------------------------------------------- relatórios */
  const reportsList = async (): Promise<ReportListRow[]> => ((await getAsyncDb().prepare('SELECT a.id AS analysis_id, a.case_id, a.score, a.created_at, a.finalized_at, a.ai_used, c.patient_code, c.patient_name FROM analyses a JOIN cases c ON c.id = a.case_id WHERE c.deleted_at IS NULL ORDER BY a.id DESC LIMIT 200').all()) as Row[]).map((r) => ({ analysis_id: num(r, 'analysis_id'), case_id: num(r, 'case_id'), patient_code: str(r, 'patient_code'), patient_name: str(r, 'patient_name'), score: numOrNull(r, 'score'), created_at: str(r, 'created_at'), finalized_at: strOrNull(r, 'finalized_at'), ai_used: num(r, 'ai_used') === 1 }));
  app.get('/relatorios', async (request, reply) => page(request, reply, 'Relatórios', reportsPage((await reportsList()), (await reportSettings()), null, request.user?.role === 'admin')));
  const ReportCfg = z.object({ clinic_name: z.string().trim().max(120).default(''), clinic_info: z.string().trim().max(300).default(''), signature: z.string().trim().max(200).default(''), patient_intro: z.string().trim().max(2000).default(''), patient_closing: z.string().trim().max(2000).default(''), technical_footer: z.string().trim().max(2000).default(''), show_score: z.string().optional(), show_systems: z.string().optional(), show_guidances: z.string().optional() });
  app.post('/relatorios/logo', { preHandler: requireAdmin }, async (request, reply) => {
    const file = await request.file({ limits: { fileSize: 2 * 1024 * 1024 } });
    if (!file) return reply.redirect('/relatorios?kind=err&msg=' + encodeURIComponent('Envie uma imagem.'));
    const buf = await file.toBuffer();
    const kind = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.subarray(0, 4).toString('latin1') === 'RIFF' ? 'webp' : /^\s*(<\?xml|<svg)/i.test(buf.subarray(0, 200).toString('utf8')) ? 'svg' : null;
    if (!kind || file.file.truncated) return reply.redirect('/relatorios?kind=err&msg=' + encodeURIComponent('Formato não aceito ou arquivo acima de 2 MB (PNG, JPG, SVG, WebP).'));
    for (const f of fs.readdirSync(BRAND_DIR)) if (f.startsWith('logo.')) fs.rmSync(path.join(BRAND_DIR, f), { force: true });
    fs.writeFileSync(path.join(BRAND_DIR, `logo.${kind}`), buf);
    await setSetting('report.logo', `${kind}-${Date.now()}`);
    await audit(request.user?.id ?? null, 'logo', 'settings', 'relatorios', { kind, size: buf.length }, request.id);
    return ok(reply, '/relatorios', 'Logo atualizada.');
  });

  app.post('/relatorios/config', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = ReportCfg.safeParse(request.body);
    if (!parsed.success) return page(request, reply, 'Relatórios', reportsPage((await reportsList()), (await reportSettings()), firstIssue(parsed.error), true));
    const d = parsed.data;
    for (const k of ['clinic_name', 'clinic_info', 'signature', 'patient_intro', 'patient_closing', 'technical_footer'] as const) (await setSetting(`report.${k}`, d[k]));
    for (const k of ['show_score', 'show_systems', 'show_guidances'] as const) (await setSetting(`report.${k}`, d[k] === '1' ? '1' : '0'));
    await audit(request.user?.id ?? null, 'editar', 'settings', 'relatorios', d, request.id);
    return ok(reply, '/relatorios', 'Configuração dos relatórios salva.');
  });
  app.get('/regras/:id', async (request, reply) => {
    const row = (await getAsyncDb().prepare('SELECT * FROM rules WHERE id = ?').get(Number((request.params as { id: string }).id))) as Row | undefined;
    if (!row) return reply.code(404).send('Regra não encontrada');
    return page(request, reply, 'Regra', ruleFormPage(rowToRule(row), (await allGuidances()), null, calcIds));
  });

  const saveRule = async (request: FastifyRequest, reply: FastifyReply, id: number | null) => {
    const parsed = RuleBody.safeParse(request.body);
    const current = id ? ((await getAsyncDb().prepare('SELECT * FROM rules WHERE id = ?').get(id)) as Row | undefined) : undefined;
    if (id && !current) return reply.code(404).send('Regra não encontrada');
    if (!parsed.success) return page(request, reply, 'Regra', ruleFormPage(current ? rowToRule(current) : null, (await allGuidances()), firstIssue(parsed.error), calcIds));
    const r = parsed.data;
    const known = new Set((await allGuidances()).map((g) => g.code));
    const unknown = r.guidance_ids.filter((g) => !known.has(g));
    if (unknown.length) return page(request, reply, 'Regra', ruleFormPage(current ? rowToRule(current) : null, (await allGuidances()), `orientação inexistente: ${unknown.join(', ')}`, calcIds));
    const aliases = r.aliases.split('|').map((s) => s.trim()).filter(Boolean).join('|');
    const contexts = r.contexts.length ? r.contexts.join('|') : 'geral';
    const dup = (await getAsyncDb().prepare("SELECT id FROM rules WHERE status = 'ativo' AND exam_canonical = ? AND sex = ? AND IFNULL(age_min,-1) = IFNULL(?, -1) AND IFNULL(age_max,-1) = IFNULL(?, -1) AND contexts = ? AND unit = ? AND id != IFNULL(?, -1)").get(r.exam_canonical, r.sex, r.age_min, r.age_max, contexts, r.unit, id)) as Row | undefined;
    if (r.status === 'ativo' && dup) return page(request, reply, 'Regra', ruleFormPage(current ? rowToRule(current) : null, (await allGuidances()), `já existe regra ativa idêntica (#${num(dup, 'id')}); inative-a ou diferencie as condições`, calcIds));
    const params = [r.exam_canonical, aliases, r.sex, r.age_min, r.age_max, contexts, r.unit, r.target_min, r.target_max, r.target_text || null, r.critical_low, r.critical_high, r.guidance_ids.join('|'), r.clinical_source, r.version, r.reviewed_at, r.status, r.system, r.normal_min, r.normal_max, request.user?.id ?? null];
    let ruleId = id;
    if (id) {
      (await getAsyncDb().prepare("UPDATE rules SET exam_canonical=?, aliases=?, sex=?, age_min=?, age_max=?, contexts=?, unit=?, target_min=?, target_max=?, target_text=?, critical_low=?, critical_high=?, guidance_ids=?, clinical_source=?, version=?, reviewed_at=?, status=?, system=?, normal_min=?, normal_max=?, updated_by=?, checked_at=NULL, checked_by=NULL, updated_at=datetime('now') WHERE id=?").run(...params, id));
    } else {
      const info = (await getAsyncDb().prepare('INSERT INTO rules(exam_canonical, aliases, sex, age_min, age_max, contexts, unit, target_min, target_max, target_text, critical_low, critical_high, guidance_ids, clinical_source, version, reviewed_at, status, system, normal_min, normal_max, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...params));
      ruleId = Number(info.lastInsertRowid);
    }
    await audit(request.user?.id ?? null, id ? 'editar' : 'criar', 'rule', ruleId, { before: current ? rowToRule(current) : null, after: r }, request.id);
    return ok(reply, '/regras/lista', `Regra ${r.exam_canonical} salva (${r.status}).`);
  };
  app.get('/regras/exportar.csv', async (request, reply) => {
    await audit(request.user?.id ?? null, 'exportar', 'rule', null, { count: (await allRules()).length }, request.id);
    return reply.header('Content-Disposition', 'attachment; filename="valores-otimizados.csv"').type('text/csv; charset=utf-8').send(rulesToCsv((await allRules())));
  });

  app.post('/regras/importar', { preHandler: requireAdmin }, async (request, reply) => {
    const file = await request.file({ limits: { fileSize: 2 * 1024 * 1024 } });
    if (!file) return reply.redirect('/regras/lista?kind=err&msg=' + encodeURIComponent('Envie um arquivo CSV.'));
    const text = (await file.toBuffer()).toString('utf8').replace(/^\uFEFF/, '');
    const header = (text.split(/\r?\n/)[0] ?? '').trim();
    const legacyHeader = RULE_CSV_COLUMNS.slice(0, 17).join(',');
    if (header !== RULE_CSV_COLUMNS.join(',') && header !== legacyHeader) return reply.redirect('/regras/lista?kind=err&msg=' + encodeURIComponent('Cabeçalho do CSV diferente do esperado (use o arquivo exportado como modelo).'));
    const known = new Set((await allGuidances()).map((g) => g.code));
    const insert = (await getAsyncDb().prepare('INSERT INTO rules(exam_canonical, aliases, sex, age_min, age_max, contexts, unit, target_min, target_max, target_text, critical_low, critical_high, guidance_ids, clinical_source, version, reviewed_at, status, system, normal_min, normal_max, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'));
    let imported = 0;
    const errors: string[] = [];
    for (const [i, row] of parseCsv(text).entries()) {
      const line = i + 2;
      const parsed = RuleBody.safeParse({
        exam_canonical: str(row, 'exame_canonico'), aliases: str(row, 'aliases').split('|').join(' | '), sex: str(row, 'sexo') || 'todos',
        age_min: str(row, 'idade_min'), age_max: str(row, 'idade_max'), contexts: str(row, 'contexto').split('|').map((c) => c.trim()).filter((c) => c && c !== 'geral'),
        unit: str(row, 'unidade'), target_min: str(row, 'alvo_min'), target_max: str(row, 'alvo_max'), target_text: str(row, 'alvo_texto'),
        critical_low: str(row, 'limite_critico_inferior'), critical_high: str(row, 'limite_critico_superior'), guidance_ids: str(row, 'orientacao_id').split('|').map((c) => c.trim()).filter(Boolean),
        clinical_source: str(row, 'fonte_clinica'), version: str(row, 'versao') || '1.0', reviewed_at: str(row, 'data_revisao'), status: str(row, 'status') || 'rascunho',
        system: str(row, 'sistema') || 'outros', normal_min: str(row, 'normal_min'), normal_max: str(row, 'normal_max'),
      });
      if (!parsed.success) {
        errors.push(`linha ${line}: ${firstIssue(parsed.error)}`);
        continue;
      }
      const r = parsed.data;
      const unknown = r.guidance_ids.filter((g) => !known.has(g));
      if (unknown.length) {
        errors.push(`linha ${line}: orientação inexistente ${unknown.join(', ')}`);
        continue;
      }
      await insert.run(r.exam_canonical, r.aliases.split('|').map((a) => a.trim()).filter(Boolean).join('|'), r.sex, r.age_min, r.age_max, r.contexts.length ? r.contexts.join('|') : 'geral', r.unit, r.target_min, r.target_max, r.target_text || null, r.critical_low, r.critical_high, r.guidance_ids.join('|'), r.clinical_source, r.version, r.reviewed_at, r.status, r.system, r.normal_min, r.normal_max, request.user?.id ?? null);
      imported += 1;
    }
    await audit(request.user?.id ?? null, 'importar', 'rule', null, { imported, rejected: errors.length, errors: errors.slice(0, 20) }, request.id);
    const msg = `${imported} regra(s) importada(s).${errors.length ? ` ${errors.length} rejeitada(s): ${errors.slice(0, 5).join(' · ')}` : ''}`;
    return reply.redirect(`/regras/lista?kind=${errors.length ? 'warn' : 'ok'}&msg=${encodeURIComponent(msg)}`);
  });

  app.post('/regras', { preHandler: requireAdmin }, async (request, reply) => saveRule(request, reply, null));
  app.post('/regras/:id', { preHandler: requireAdmin }, async (request, reply) => saveRule(request, reply, Number((request.params as { id: string }).id)));
  app.post('/regras/:id/excluir', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = (await getAsyncDb().prepare('SELECT * FROM rules WHERE id = ?').get(id)) as Row | undefined;
    if (!row) return reply.code(404).send('Regra não encontrada');
    (await getAsyncDb().prepare('DELETE FROM rules WHERE id = ?').run(id));
    await audit(request.user?.id ?? null, 'excluir', 'rule', id, { before: rowToRule(row) }, request.id);
    return ok(reply, '/regras/lista', 'Regra excluída.');
  });

  /* ----------------------------------------------------------- orientações */
  app.get('/orientacoes', async (request, reply) => page(request, reply, 'Orientações', guidancesPage((await allGuidances()))));
  app.get('/orientacoes/nova', async (request, reply) => page(request, reply, 'Nova orientação', guidanceFormPage(null, null)));
  app.get('/orientacoes/:id', async (request, reply) => {
    const row = (await getAsyncDb().prepare('SELECT * FROM guidances WHERE id = ?').get(Number((request.params as { id: string }).id))) as Row | undefined;
    if (!row) return reply.code(404).send('Orientação não encontrada');
    return page(request, reply, 'Orientação', guidanceFormPage(rowToGuidance(row), null));
  });
  const saveGuidance = async (request: FastifyRequest, reply: FastifyReply, id: number | null) => {
    const parsed = GuidanceBody.safeParse(request.body);
    const current = id ? ((await getAsyncDb().prepare('SELECT * FROM guidances WHERE id = ?').get(id)) as Row | undefined) : undefined;
    if (id && !current) return reply.code(404).send('Orientação não encontrada');
    if (!parsed.success) return page(request, reply, 'Orientação', guidanceFormPage(current ? rowToGuidance(current) : null, firstIssue(parsed.error)));
    const g = parsed.data;
    const clash = (await getAsyncDb().prepare('SELECT id FROM guidances WHERE code = ? AND id != IFNULL(?, -1)').get(g.code, id)) as Row | undefined;
    if (clash) return page(request, reply, 'Orientação', guidanceFormPage(current ? rowToGuidance(current) : null, 'código já existe'));
    const params = [g.code, g.title, g.exam_canonical || null, g.trigger, g.contexts_required.join('|'), g.contexts_excluded.join('|'), g.not_apply_note, g.patient_text, Number(g.requires_alert), g.clinical_source, g.version, g.reviewed_at, g.status, request.user?.id ?? null];
    let gid = id;
    if (id) {
      (await getAsyncDb().prepare("UPDATE guidances SET code=?, title=?, exam_canonical=?, trigger=?, contexts_required=?, contexts_excluded=?, not_apply_note=?, patient_text=?, requires_alert=?, clinical_source=?, version=?, reviewed_at=?, status=?, updated_by=?, updated_at=datetime('now') WHERE id=?").run(...params, id));
    } else {
      const info = (await getAsyncDb().prepare('INSERT INTO guidances(code, title, exam_canonical, trigger, contexts_required, contexts_excluded, not_apply_note, patient_text, requires_alert, clinical_source, version, reviewed_at, status, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...params));
      gid = Number(info.lastInsertRowid);
    }
    await audit(request.user?.id ?? null, id ? 'editar' : 'criar', 'guidance', gid, { before: current ? rowToGuidance(current) : null, after: g }, request.id);
    return ok(reply, '/orientacoes', `Orientação ${g.code} salva (${g.status}).`);
  };
  app.post('/orientacoes', { preHandler: requireAdmin }, async (request, reply) => saveGuidance(request, reply, null));
  app.post('/orientacoes/:id', { preHandler: requireAdmin }, async (request, reply) => saveGuidance(request, reply, Number((request.params as { id: string }).id)));
  app.post('/orientacoes/:id/excluir', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = (await getAsyncDb().prepare('SELECT * FROM guidances WHERE id = ?').get(id)) as Row | undefined;
    if (!row) return reply.code(404).send('Orientação não encontrada');
    (await getAsyncDb().prepare('DELETE FROM guidances WHERE id = ?').run(id));
    await audit(request.user?.id ?? null, 'excluir', 'guidance', id, { before: rowToGuidance(row) }, request.id);
    return ok(reply, '/orientacoes', 'Orientação excluída.');
  });

  /* --------------------------------------------------------- configurações */
  const loadUsers = async (): Promise<UserRow[]> => ((await getAsyncDb().prepare('SELECT id, email, name, role, created_at, disabled_at, cpf, council, council_number, council_state FROM users ORDER BY id').all()) as Row[]).map((u) => ({ id: num(u, 'id'), email: str(u, 'email'), name: str(u, 'name'), role: str(u, 'role'), created_at: str(u, 'created_at'), disabled_at: strOrNull(u, 'disabled_at'), cpf: strOrNull(u, 'cpf'), council: strOrNull(u, 'council'), council_number: strOrNull(u, 'council_number'), council_state: strOrNull(u, 'council_state') }));
  const usage = async () => {
    const row = (await getAsyncDb().prepare('SELECT COUNT(*) AS calls, IFNULL(SUM(input_tokens),0) AS i, IFNULL(SUM(output_tokens),0) AS o FROM ai_usage').get()) as Row;
    return { calls: num(row, 'calls'), input: num(row, 'i'), output: num(row, 'o') };
  };
  const settings = async (request: FastifyRequest, reply: FastifyReply, error: string | null = null, resetLink: { email: string; link: string; expiresAt: string } | null = null) => page(request, reply, 'Configurações', settingsPage({ enabled: (await enabledCalcIds()), users: (await loadUsers()), aiOn: aiEnabled(), aiModel: AI_MODEL, error, usage: (await usage()), mailOn: mailEnabled(), resetLink }));

  app.get('/configuracoes', { preHandler: requireAdmin }, async (request, reply) => settings(request, reply));
  app.post('/configuracoes/calculos', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as { calc?: string | string[] } | null;
    const chosen = new Set(body?.calc === undefined ? [] : Array.isArray(body.calc) ? body.calc : [body.calc]);
    for (const c of CALCS) (await setSetting(`calc.${c.id}`, chosen.has(c.id) ? '1' : '0'));
    await audit(request.user?.id ?? null, 'editar', 'settings', 'calculos', { enabled: [...chosen] }, request.id);
    return ok(reply, '/configuracoes', 'Cálculos atualizados.');
  });
  app.post('/configuracoes/usuarios', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = UserBody.safeParse(request.body);
    if (!parsed.success) return settings(request, reply, firstIssue(parsed.error));
    const u = parsed.data;
    if (await userExists(u.email)) return settings(request, reply, 'e-mail já cadastrado');
    const cpf = u.cpf ? normalizeCpf(u.cpf) : null;
    if (u.cpf && !cpf) return settings(request, reply, 'CPF inválido');
    if (cpf && ((await getAsyncDb().prepare('SELECT 1 FROM users WHERE cpf = ?').get(cpf)) as Row | undefined)) return settings(request, reply, 'CPF já cadastrado');
    const info = (await getAsyncDb().prepare('INSERT INTO users(email, name, password_hash, role, cpf, council, council_number, council_state, profession) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(u.email, u.name, hashPassword(u.password), u.role, cpf, u.council || null, u.council_number ? normalizeCouncilNumber(u.council_number) : null, u.council_state || null, u.council === 'CRN' ? 'nutricionista' : u.council === 'CRM' ? 'medico' : null));
    await audit(request.user?.id ?? null, 'criar', 'user', Number(info.lastInsertRowid), { email: u.email, role: u.role }, request.id);
    return ok(reply, '/configuracoes', `Usuário ${u.email} criado.`);
  });
  app.post('/configuracoes/usuarios/:id/redefinir', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = (await getAsyncDb().prepare('SELECT email FROM users WHERE id = ? AND disabled_at IS NULL').get(id)) as Row | undefined;
    if (!row) return settings(request, reply, 'usuário não encontrado ou desativado');
    const { token, expiresAt } = await createResetToken(id, 'admin', request.user?.id ?? null);
    await audit(request.user?.id ?? null, 'gerar_link_redefinicao', 'user', id, { expiresAt }, request.id);
    const base = appUrl() || `${request.protocol}://${request.hostname}`;
    return settings(request, reply, null, { email: str(row, 'email'), link: `${base}/redefinir/${token}`, expiresAt });
  });

  app.post('/configuracoes/usuarios/:id/desativar', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (id === request.user?.id) return settings(request, reply, 'não é possível desativar a si mesmo');
    (await getAsyncDb().prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?").run(id));
    await audit(request.user?.id ?? null, 'desativar', 'user', id, null, request.id);
    return ok(reply, '/configuracoes', 'Usuário desativado.');
  });
  app.post('/configuracoes/usuarios/:id/ativar', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    (await getAsyncDb().prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(id));
    await audit(request.user?.id ?? null, 'reativar', 'user', id, null, request.id);
    return ok(reply, '/configuracoes', 'Usuário reativado.');
  });

  app.get('/auditoria', { preHandler: requireAdmin }, async (request, reply) => {
    const rows: AuditRow[] = ((await getAsyncDb().prepare('SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300').all()) as Row[]).map((r) => ({ id: num(r, 'id'), created_at: str(r, 'created_at'), user: str(r, 'user_name') || 'sistema', action: str(r, 'action'), entity: str(r, 'entity'), entity_id: strOrNull(r, 'entity_id'), details: strOrNull(r, 'details') }));
    return page(request, reply, 'Auditoria', auditPage(rows));
  });
}

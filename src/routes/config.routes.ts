import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createResetToken, hashPassword, requireAdmin, requireAuth, userExists } from '../auth.js';
import { appUrl, mailEnabled } from '../mail.js';
import { AI_MODEL, aiEnabled } from '../ai.js';
import { allGuidances, allRules, audit, enabledCalcIds, getDb, num, parseCsv, rowToGuidance, rowToRule, rulesToCsv, RULE_CSV_COLUMNS, setSetting, str, strOrNull, type Row } from '../db.js';
import { CALCS, CLASSIFICATIONS, CONTEXTS, SYSTEMS } from '../engine/index.js';
import { normalizeCouncilNumber, normalizeCpf } from '../cpf.js';
import { layout } from '../views/html.js';
import { auditPage, guidanceFormPage, guidancesPage, ruleFormPage, rulesPage, settingsPage, type AuditRow, type UserRow } from '../views/pages.js';

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
  app.get('/regras', async (request, reply) => page(request, reply, 'Regras', rulesPage(allRules(), allGuidances())));
  app.get('/regras/nova', async (request, reply) => page(request, reply, 'Nova regra', ruleFormPage(null, allGuidances(), null, calcIds)));
  app.get('/regras/:id', async (request, reply) => {
    const row = getDb().prepare('SELECT * FROM rules WHERE id = ?').get(Number((request.params as { id: string }).id)) as Row | undefined;
    if (!row) return reply.code(404).send('Regra não encontrada');
    return page(request, reply, 'Regra', ruleFormPage(rowToRule(row), allGuidances(), null, calcIds));
  });

  const saveRule = async (request: FastifyRequest, reply: FastifyReply, id: number | null) => {
    const parsed = RuleBody.safeParse(request.body);
    const current = id ? (getDb().prepare('SELECT * FROM rules WHERE id = ?').get(id) as Row | undefined) : undefined;
    if (id && !current) return reply.code(404).send('Regra não encontrada');
    if (!parsed.success) return page(request, reply, 'Regra', ruleFormPage(current ? rowToRule(current) : null, allGuidances(), firstIssue(parsed.error), calcIds));
    const r = parsed.data;
    const known = new Set(allGuidances().map((g) => g.code));
    const unknown = r.guidance_ids.filter((g) => !known.has(g));
    if (unknown.length) return page(request, reply, 'Regra', ruleFormPage(current ? rowToRule(current) : null, allGuidances(), `orientação inexistente: ${unknown.join(', ')}`, calcIds));
    const aliases = r.aliases.split('|').map((s) => s.trim()).filter(Boolean).join('|');
    const contexts = r.contexts.length ? r.contexts.join('|') : 'geral';
    const dup = getDb().prepare("SELECT id FROM rules WHERE status = 'ativo' AND exam_canonical = ? AND sex = ? AND IFNULL(age_min,-1) = IFNULL(?, -1) AND IFNULL(age_max,-1) = IFNULL(?, -1) AND contexts = ? AND unit = ? AND id != IFNULL(?, -1)").get(r.exam_canonical, r.sex, r.age_min, r.age_max, contexts, r.unit, id) as Row | undefined;
    if (r.status === 'ativo' && dup) return page(request, reply, 'Regra', ruleFormPage(current ? rowToRule(current) : null, allGuidances(), `já existe regra ativa idêntica (#${num(dup, 'id')}); inative-a ou diferencie as condições`, calcIds));
    const params = [r.exam_canonical, aliases, r.sex, r.age_min, r.age_max, contexts, r.unit, r.target_min, r.target_max, r.target_text || null, r.critical_low, r.critical_high, r.guidance_ids.join('|'), r.clinical_source, r.version, r.reviewed_at, r.status, r.system, r.normal_min, r.normal_max, request.user?.id ?? null];
    let ruleId = id;
    if (id) {
      getDb().prepare("UPDATE rules SET exam_canonical=?, aliases=?, sex=?, age_min=?, age_max=?, contexts=?, unit=?, target_min=?, target_max=?, target_text=?, critical_low=?, critical_high=?, guidance_ids=?, clinical_source=?, version=?, reviewed_at=?, status=?, system=?, normal_min=?, normal_max=?, updated_by=?, updated_at=datetime('now') WHERE id=?").run(...params, id);
    } else {
      const info = getDb().prepare('INSERT INTO rules(exam_canonical, aliases, sex, age_min, age_max, contexts, unit, target_min, target_max, target_text, critical_low, critical_high, guidance_ids, clinical_source, version, reviewed_at, status, system, normal_min, normal_max, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...params);
      ruleId = Number(info.lastInsertRowid);
    }
    audit(request.user?.id ?? null, id ? 'editar' : 'criar', 'rule', ruleId, { before: current ? rowToRule(current) : null, after: r }, request.id);
    return ok(reply, '/regras', `Regra ${r.exam_canonical} salva (${r.status}).`);
  };
  app.get('/regras/exportar.csv', async (request, reply) => {
    audit(request.user?.id ?? null, 'exportar', 'rule', null, { count: allRules().length }, request.id);
    return reply.header('Content-Disposition', 'attachment; filename="valores-otimizados.csv"').type('text/csv; charset=utf-8').send(rulesToCsv(allRules()));
  });

  app.post('/regras/importar', async (request, reply) => {
    const file = await request.file({ limits: { fileSize: 2 * 1024 * 1024 } });
    if (!file) return reply.redirect('/regras?kind=err&msg=' + encodeURIComponent('Envie um arquivo CSV.'));
    const text = (await file.toBuffer()).toString('utf8').replace(/^\uFEFF/, '');
    const header = (text.split(/\r?\n/)[0] ?? '').trim();
    const legacyHeader = RULE_CSV_COLUMNS.slice(0, 17).join(',');
    if (header !== RULE_CSV_COLUMNS.join(',') && header !== legacyHeader) return reply.redirect('/regras?kind=err&msg=' + encodeURIComponent('Cabeçalho do CSV diferente do esperado (use o arquivo exportado como modelo).'));
    const known = new Set(allGuidances().map((g) => g.code));
    const insert = getDb().prepare('INSERT INTO rules(exam_canonical, aliases, sex, age_min, age_max, contexts, unit, target_min, target_max, target_text, critical_low, critical_high, guidance_ids, clinical_source, version, reviewed_at, status, system, normal_min, normal_max, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    let imported = 0;
    const errors: string[] = [];
    parseCsv(text).forEach((row, i) => {
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
        return;
      }
      const r = parsed.data;
      const unknown = r.guidance_ids.filter((g) => !known.has(g));
      if (unknown.length) {
        errors.push(`linha ${line}: orientação inexistente ${unknown.join(', ')}`);
        return;
      }
      insert.run(r.exam_canonical, r.aliases.split('|').map((a) => a.trim()).filter(Boolean).join('|'), r.sex, r.age_min, r.age_max, r.contexts.length ? r.contexts.join('|') : 'geral', r.unit, r.target_min, r.target_max, r.target_text || null, r.critical_low, r.critical_high, r.guidance_ids.join('|'), r.clinical_source, r.version, r.reviewed_at, r.status, r.system, r.normal_min, r.normal_max, request.user?.id ?? null);
      imported += 1;
    });
    audit(request.user?.id ?? null, 'importar', 'rule', null, { imported, rejected: errors.length, errors: errors.slice(0, 20) }, request.id);
    const msg = `${imported} regra(s) importada(s).${errors.length ? ` ${errors.length} rejeitada(s): ${errors.slice(0, 5).join(' · ')}` : ''}`;
    return reply.redirect(`/regras?kind=${errors.length ? 'warn' : 'ok'}&msg=${encodeURIComponent(msg)}`);
  });

  app.post('/regras', async (request, reply) => saveRule(request, reply, null));
  app.post('/regras/:id', async (request, reply) => saveRule(request, reply, Number((request.params as { id: string }).id)));
  app.post('/regras/:id/excluir', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = getDb().prepare('SELECT * FROM rules WHERE id = ?').get(id) as Row | undefined;
    if (!row) return reply.code(404).send('Regra não encontrada');
    getDb().prepare('DELETE FROM rules WHERE id = ?').run(id);
    audit(request.user?.id ?? null, 'excluir', 'rule', id, { before: rowToRule(row) }, request.id);
    return ok(reply, '/regras', 'Regra excluída.');
  });

  /* ----------------------------------------------------------- orientações */
  app.get('/orientacoes', async (request, reply) => page(request, reply, 'Orientações', guidancesPage(allGuidances())));
  app.get('/orientacoes/nova', async (request, reply) => page(request, reply, 'Nova orientação', guidanceFormPage(null, null)));
  app.get('/orientacoes/:id', async (request, reply) => {
    const row = getDb().prepare('SELECT * FROM guidances WHERE id = ?').get(Number((request.params as { id: string }).id)) as Row | undefined;
    if (!row) return reply.code(404).send('Orientação não encontrada');
    return page(request, reply, 'Orientação', guidanceFormPage(rowToGuidance(row), null));
  });
  const saveGuidance = async (request: FastifyRequest, reply: FastifyReply, id: number | null) => {
    const parsed = GuidanceBody.safeParse(request.body);
    const current = id ? (getDb().prepare('SELECT * FROM guidances WHERE id = ?').get(id) as Row | undefined) : undefined;
    if (id && !current) return reply.code(404).send('Orientação não encontrada');
    if (!parsed.success) return page(request, reply, 'Orientação', guidanceFormPage(current ? rowToGuidance(current) : null, firstIssue(parsed.error)));
    const g = parsed.data;
    const clash = getDb().prepare('SELECT id FROM guidances WHERE code = ? AND id != IFNULL(?, -1)').get(g.code, id) as Row | undefined;
    if (clash) return page(request, reply, 'Orientação', guidanceFormPage(current ? rowToGuidance(current) : null, 'código já existe'));
    const params = [g.code, g.title, g.exam_canonical || null, g.trigger, g.contexts_required.join('|'), g.contexts_excluded.join('|'), g.not_apply_note, g.patient_text, Number(g.requires_alert), g.clinical_source, g.version, g.reviewed_at, g.status, request.user?.id ?? null];
    let gid = id;
    if (id) {
      getDb().prepare("UPDATE guidances SET code=?, title=?, exam_canonical=?, trigger=?, contexts_required=?, contexts_excluded=?, not_apply_note=?, patient_text=?, requires_alert=?, clinical_source=?, version=?, reviewed_at=?, status=?, updated_by=?, updated_at=datetime('now') WHERE id=?").run(...params, id);
    } else {
      const info = getDb().prepare('INSERT INTO guidances(code, title, exam_canonical, trigger, contexts_required, contexts_excluded, not_apply_note, patient_text, requires_alert, clinical_source, version, reviewed_at, status, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...params);
      gid = Number(info.lastInsertRowid);
    }
    audit(request.user?.id ?? null, id ? 'editar' : 'criar', 'guidance', gid, { before: current ? rowToGuidance(current) : null, after: g }, request.id);
    return ok(reply, '/orientacoes', `Orientação ${g.code} salva (${g.status}).`);
  };
  app.post('/orientacoes', async (request, reply) => saveGuidance(request, reply, null));
  app.post('/orientacoes/:id', async (request, reply) => saveGuidance(request, reply, Number((request.params as { id: string }).id)));
  app.post('/orientacoes/:id/excluir', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = getDb().prepare('SELECT * FROM guidances WHERE id = ?').get(id) as Row | undefined;
    if (!row) return reply.code(404).send('Orientação não encontrada');
    getDb().prepare('DELETE FROM guidances WHERE id = ?').run(id);
    audit(request.user?.id ?? null, 'excluir', 'guidance', id, { before: rowToGuidance(row) }, request.id);
    return ok(reply, '/orientacoes', 'Orientação excluída.');
  });

  /* --------------------------------------------------------- configurações */
  const loadUsers = (): UserRow[] => (getDb().prepare('SELECT id, email, name, role, created_at, disabled_at, cpf, council, council_number, council_state FROM users ORDER BY id').all() as Row[]).map((u) => ({ id: num(u, 'id'), email: str(u, 'email'), name: str(u, 'name'), role: str(u, 'role'), created_at: str(u, 'created_at'), disabled_at: strOrNull(u, 'disabled_at'), cpf: strOrNull(u, 'cpf'), council: strOrNull(u, 'council'), council_number: strOrNull(u, 'council_number'), council_state: strOrNull(u, 'council_state') }));
  const usage = () => {
    const row = getDb().prepare('SELECT COUNT(*) AS calls, IFNULL(SUM(input_tokens),0) AS i, IFNULL(SUM(output_tokens),0) AS o FROM ai_usage').get() as Row;
    return { calls: num(row, 'calls'), input: num(row, 'i'), output: num(row, 'o') };
  };
  const settings = (request: FastifyRequest, reply: FastifyReply, error: string | null = null, resetLink: { email: string; link: string; expiresAt: string } | null = null) => page(request, reply, 'Configurações', settingsPage({ enabled: enabledCalcIds(), users: loadUsers(), aiOn: aiEnabled(), aiModel: AI_MODEL, error, usage: usage(), mailOn: mailEnabled(), resetLink }));

  app.get('/configuracoes', { preHandler: requireAdmin }, async (request, reply) => settings(request, reply));
  app.post('/configuracoes/calculos', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as { calc?: string | string[] } | null;
    const chosen = new Set(body?.calc === undefined ? [] : Array.isArray(body.calc) ? body.calc : [body.calc]);
    for (const c of CALCS) setSetting(`calc.${c.id}`, chosen.has(c.id) ? '1' : '0');
    audit(request.user?.id ?? null, 'editar', 'settings', 'calculos', { enabled: [...chosen] }, request.id);
    return ok(reply, '/configuracoes', 'Cálculos atualizados.');
  });
  app.post('/configuracoes/usuarios', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = UserBody.safeParse(request.body);
    if (!parsed.success) return settings(request, reply, firstIssue(parsed.error));
    const u = parsed.data;
    if (userExists(u.email)) return settings(request, reply, 'e-mail já cadastrado');
    const cpf = u.cpf ? normalizeCpf(u.cpf) : null;
    if (u.cpf && !cpf) return settings(request, reply, 'CPF inválido');
    if (cpf && (getDb().prepare('SELECT 1 FROM users WHERE cpf = ?').get(cpf) as Row | undefined)) return settings(request, reply, 'CPF já cadastrado');
    const info = getDb().prepare('INSERT INTO users(email, name, password_hash, role, cpf, council, council_number, council_state, profession) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(u.email, u.name, hashPassword(u.password), u.role, cpf, u.council || null, u.council_number ? normalizeCouncilNumber(u.council_number) : null, u.council_state || null, u.council === 'CRN' ? 'nutricionista' : u.council === 'CRM' ? 'medico' : null);
    audit(request.user?.id ?? null, 'criar', 'user', Number(info.lastInsertRowid), { email: u.email, role: u.role }, request.id);
    return ok(reply, '/configuracoes', `Usuário ${u.email} criado.`);
  });
  app.post('/configuracoes/usuarios/:id/redefinir', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = getDb().prepare('SELECT email FROM users WHERE id = ? AND disabled_at IS NULL').get(id) as Row | undefined;
    if (!row) return settings(request, reply, 'usuário não encontrado ou desativado');
    const { token, expiresAt } = createResetToken(id, 'admin', request.user?.id ?? null);
    audit(request.user?.id ?? null, 'gerar_link_redefinicao', 'user', id, { expiresAt }, request.id);
    const base = appUrl() || `${request.protocol}://${request.hostname}`;
    return settings(request, reply, null, { email: str(row, 'email'), link: `${base}/redefinir/${token}`, expiresAt });
  });

  app.post('/configuracoes/usuarios/:id/desativar', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (id === request.user?.id) return settings(request, reply, 'não é possível desativar a si mesmo');
    getDb().prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?").run(id);
    audit(request.user?.id ?? null, 'desativar', 'user', id, null, request.id);
    return ok(reply, '/configuracoes', 'Usuário desativado.');
  });
  app.post('/configuracoes/usuarios/:id/ativar', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    getDb().prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(id);
    audit(request.user?.id ?? null, 'reativar', 'user', id, null, request.id);
    return ok(reply, '/configuracoes', 'Usuário reativado.');
  });

  app.get('/auditoria', { preHandler: requireAdmin }, async (request, reply) => {
    const rows: AuditRow[] = (getDb().prepare('SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300').all() as Row[]).map((r) => ({ id: num(r, 'id'), created_at: str(r, 'created_at'), user: str(r, 'user_name') || 'sistema', action: str(r, 'action'), entity: str(r, 'entity'), entity_id: strOrNull(r, 'entity_id'), details: strOrNull(r, 'details') }));
    return page(request, reply, 'Auditoria', auditPage(rows));
  });
}

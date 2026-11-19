import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth.js';
import { aiEnabled } from '../ai.js';
import { audit, CONSENT_DIR, CONSENT_VERSION, DEFAULT_CONSENT_TEXT, getAsyncDb, getSetting, nextPatientCode, num, rowToPatient, str, strOrNull, UPLOAD_DIR, type Patient, type Row } from '../db.js';
import { evolutionHtml, patientSeries, scoreTimeline } from '../evolution.js';
import { layout } from '../views/html.js';
import { consentPrintPage, patientFormPage, patientPage, patientsPage, type PatientCaseRow } from '../views/pages.js';

const PatientBody = z.object({
  code: z.string().trim().max(40).regex(/^[\w.\-/ ]*$/u, 'use só letras, números, ponto, traço ou barra').default(''),
  name: z.string().trim().min(2).max(120),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')).default(''),
  sex: z.enum(['', 'M', 'F']).default(''),
  phone: z.string().trim().max(40).default(''),
  email: z.string().trim().max(120).default(''),
  comorbidities: z.string().trim().max(2000).default(''),
  medications: z.string().trim().max(2000).default(''),
  supplements: z.string().trim().max(2000).default(''),
  goal: z.string().trim().max(2000).default(''),
  notes: z.string().trim().max(5000).default(''),
});

function page(request: FastifyRequest, reply: FastifyReply, title: string, body: string, flash?: { kind: 'ok' | 'err' | 'warn'; text: string } | null) {
  const q = request.query as { msg?: string; kind?: string };
  const f = flash ?? (q.msg ? { kind: (q.kind === 'err' || q.kind === 'warn' ? q.kind : 'ok') as 'ok' | 'err' | 'warn', text: q.msg } : null);
  return reply.type('text/html; charset=utf-8').send(layout({ title, user: request.user, body, flash: f, aiOn: aiEnabled(), active: 'pacientes' }));
}
const redirectMsg = (reply: FastifyReply, to: string, msg: string, kind: 'ok' | 'err' | 'warn' = 'ok') => reply.redirect(`${to}?kind=${kind}&msg=${encodeURIComponent(msg)}`);

export async function loadPatient(id: number): Promise<Patient | null> {
  const row = (await getAsyncDb().prepare('SELECT * FROM patients WHERE id = ? AND deleted_at IS NULL').get(id)) as Row | undefined;
  return row ? rowToPatient(row) : null;
}
export async function allPatients(query = ''): Promise<Patient[]> {
  const q = `%${query.trim().toLowerCase()}%`;
  return ((await getAsyncDb().prepare('SELECT * FROM patients WHERE deleted_at IS NULL AND (lower(name) LIKE ? OR lower(code) LIKE ?) ORDER BY name LIMIT 300').all(q, q)) as Row[]).map(rowToPatient);
}
export async function patientCases(patientId: number): Promise<PatientCaseRow[]> {
  return ((await getAsyncDb()
    .prepare(`SELECT c.id, c.status, c.created_at, (SELECT MAX(collection_date) FROM results r WHERE r.case_id = c.id) AS last_collection, (SELECT COUNT(*) FROM results r WHERE r.case_id = c.id AND r.excluded = 0) AS results_count, (SELECT score FROM analyses a WHERE a.case_id = c.id ORDER BY a.id DESC LIMIT 1) AS score, (SELECT MAX(id) FROM analyses a WHERE a.case_id = c.id) AS analysis_id FROM cases c WHERE c.patient_id = ? AND c.deleted_at IS NULL ORDER BY c.id DESC`)
    .all(patientId)) as Row[]).map((r) => ({ id: num(r, 'id'), status: str(r, 'status'), created_at: str(r, 'created_at'), last_collection: strOrNull(r, 'last_collection'), results_count: num(r, 'results_count'), score: strOrNull(r, 'score') === null ? null : num(r, 'score'), analysis_id: strOrNull(r, 'analysis_id') === null ? null : num(r, 'analysis_id') }));
}
export function consentText(): string {
  return getSetting('report.consent_text', '') || DEFAULT_CONSENT_TEXT;
}

export async function patientsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/pacientes', async (request, reply) => {
    const q = (request.query as { q?: string }).q ?? '';
    return page(request, reply, 'Pacientes', patientsPage(await allPatients(q), q));
  });
  app.get('/pacientes/novo', async (request, reply) => page(request, reply, 'Novo paciente', patientFormPage(null, null, nextPatientCode())));

  const save = async (request: FastifyRequest, reply: FastifyReply, id: number | null) => {
    const parsed = PatientBody.safeParse(request.body);
    const current = id ? await loadPatient(id) : null;
    if (id && !current) return reply.code(404).send('Paciente não encontrado');
    if (!parsed.success) return page(request, reply, 'Paciente', patientFormPage(current, parsed.error.issues[0]?.message ?? 'Dados inválidos.', nextPatientCode()));
    const d = parsed.data;
    const code = d.code || current?.code || nextPatientCode();
    const clash = (await getAsyncDb().prepare('SELECT id FROM patients WHERE code = ? AND id != IFNULL(?, -1)').get(code, id)) as Row | undefined;
    if (clash) return page(request, reply, 'Paciente', patientFormPage(current, `código ${code} já usado por outro paciente`, nextPatientCode()));
    let pid = id;
    if (id) {
      (await getAsyncDb().prepare("UPDATE patients SET code=?, name=?, birth_date=?, sex=?, phone=?, email=?, comorbidities=?, medications=?, supplements=?, goal=?, notes=?, updated_at=datetime('now') WHERE id=?").run(code, d.name, d.birth_date || null, d.sex || null, d.phone, d.email, d.comorbidities, d.medications, d.supplements, d.goal, d.notes, id));
      (await getAsyncDb().prepare("UPDATE cases SET patient_code=?, patient_name=?, updated_at=datetime('now') WHERE patient_id=? AND deleted_at IS NULL").run(code, d.name, id));
    } else {
      pid = Number((await getAsyncDb().prepare('INSERT INTO patients(code, name, birth_date, sex, phone, email, comorbidities, medications, supplements, goal, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(code, d.name, d.birth_date || null, d.sex || null, d.phone, d.email, d.comorbidities, d.medications, d.supplements, d.goal, d.notes, request.user?.id ?? null)).lastInsertRowid);
    }
    audit(request.user?.id ?? null, id ? 'editar' : 'criar', 'patient', pid, { code, changed: Object.keys(d) }, request.id);
    return redirectMsg(reply, `/pacientes/${pid}`, id ? 'Paciente atualizado.' : 'Paciente cadastrado. Registre o consentimento LGPD e abra o primeiro caso.');
  };
  app.post('/pacientes', async (request, reply) => save(request, reply, null));
  app.post('/pacientes/:id/editar', async (request, reply) => save(request, reply, Number((request.params as { id: string }).id)));

  app.get('/pacientes/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const p = await loadPatient(id);
    if (!p) return reply.code(404).send('Paciente não encontrado');
    const profile = { sex: p.sex, birthDate: p.birth_date, contexts: new Set<string>() };
    const evolution = evolutionHtml(await patientSeries(id, profile), await scoreTimeline(id));
    return page(request, reply, p.name, patientPage({ p, cases: await patientCases(id), evolution, isAdmin: request.user?.role === 'admin', consentVersion: CONSENT_VERSION }));
  });
  app.get('/pacientes/:id/editar', async (request, reply) => {
    const p = await loadPatient(Number((request.params as { id: string }).id));
    if (!p) return reply.code(404).send('Paciente não encontrado');
    return page(request, reply, 'Editar paciente', patientFormPage(p, null, p.code));
  });

  /* ------------------------------------------------------- consentimento */
  app.get('/pacientes/:id/termo', async (request, reply) => {
    const p = await loadPatient(Number((request.params as { id: string }).id));
    if (!p) return reply.code(404).send('Paciente não encontrado');
    audit(request.user?.id ?? null, 'imprimir_termo', 'patient', p.id, { version: CONSENT_VERSION }, request.id);
    return reply.type('text/html; charset=utf-8').send(layout({ title: `Termo de consentimento · ${p.code}`, user: request.user, body: consentPrintPage(p, consentText(), CONSENT_VERSION, getSetting('report.clinic_name', ''), getSetting('report.signature', '')), print: true }));
  });

  app.post('/pacientes/:id/consentimento', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const p = await loadPatient(id);
    if (!p) return reply.code(404).send('Paciente não encontrado');
    let status = '';
    let method = '';
    let date = '';
    let storedFile: string | null = null;
    let rejected = false;
    for await (const part of request.parts({ limits: { fileSize: 10 * 1024 * 1024, files: 1 } })) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        const kind = buf.subarray(0, 5).toString('latin1') === '%PDF-' ? 'pdf' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png' : null;
        if (!buf.length) continue;
        if (!kind || part.file.truncated) {
          rejected = true;
          continue;
        }
        storedFile = `${id}-${crypto.randomUUID()}.${kind}`;
        fs.writeFileSync(path.join(CONSENT_DIR, storedFile), buf);
      } else {
        const v = String(part.value ?? '');
        if (part.fieldname === 'status') status = v;
        if (part.fieldname === 'method') method = v.slice(0, 80);
        if (part.fieldname === 'date') date = v;
      }
    }
    if (rejected) return redirectMsg(reply, `/pacientes/${id}`, 'Arquivo do termo não aceito: envie PDF, JPG ou PNG até 10 MB.', 'err');
    if (!['assinado', 'recusado', 'revogado', 'pendente'].includes(status)) return redirectMsg(reply, `/pacientes/${id}`, 'Situação do consentimento inválida.', 'err');
    const when = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    if (storedFile && p.consent_file) fs.rmSync(path.join(CONSENT_DIR, p.consent_file), { force: true });
    (await getAsyncDb().prepare("UPDATE patients SET consent_status=?, consent_at=?, consent_method=?, consent_version=?, consent_file=COALESCE(?, consent_file), consent_by=?, updated_at=datetime('now') WHERE id=?").run(status, status === 'pendente' ? null : when, method, CONSENT_VERSION, storedFile, request.user?.id ?? null, id));
    audit(request.user?.id ?? null, 'consentimento', 'patient', id, { status, method, date: when, file: !!storedFile, version: CONSENT_VERSION }, request.id);
    return redirectMsg(reply, `/pacientes/${id}`, `Consentimento registrado: ${status}.`);
  });

  app.get('/pacientes/:id/consentimento/arquivo', async (request, reply) => {
    const p = await loadPatient(Number((request.params as { id: string }).id));
    if (!p || !p.consent_file) return reply.code(404).send('Sem arquivo');
    const ext = p.consent_file.split('.').pop();
    audit(request.user?.id ?? null, 'ver_termo', 'patient', p.id, null, request.id);
    return reply.type(ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg').send(fs.createReadStream(path.join(CONSENT_DIR, p.consent_file)));
  });

  app.post('/pacientes/:id/excluir', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const p = await loadPatient(id);
    if (!p) return reply.code(404).send('Paciente não encontrado');
    for (const c of ((await getAsyncDb().prepare('SELECT id FROM cases WHERE patient_id = ? AND deleted_at IS NULL').all(id))) as Row[]) {
      for (const f of ((await getAsyncDb().prepare('SELECT stored_name FROM case_files WHERE case_id = ?').all(num(c, 'id')))) as Row[]) fs.rmSync(path.join(UPLOAD_DIR, str(f, 'stored_name')), { force: true });
      (await getAsyncDb().prepare('DELETE FROM case_files WHERE case_id = ?').run(num(c, 'id')));
      (await getAsyncDb().prepare("UPDATE cases SET deleted_at = datetime('now'), status = 'arquivado', patient_name = NULL WHERE id = ?").run(num(c, 'id')));
    }
    if (p.consent_file) fs.rmSync(path.join(CONSENT_DIR, p.consent_file), { force: true });
    (await getAsyncDb().prepare("UPDATE patients SET deleted_at = datetime('now'), name = 'excluído', phone = '', email = '', notes = '', consent_file = NULL WHERE id = ?").run(id));
    audit(request.user?.id ?? null, 'excluir', 'patient', id, { code: p.code }, request.id);
    return redirectMsg(reply, '/pacientes', 'Paciente, casos e arquivos excluídos.');
  });
}

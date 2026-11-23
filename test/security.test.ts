/** Pacote de segurança S-NUTRO: escrita clínica só do administrador, trava da IA pelo termo, idade no lugar do nascimento e log sem dado pessoal. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nutrolab-seg-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_EMAIL = 'admin@seg.local';
process.env.ADMIN_NAME = 'Admin Seg';
process.env.ADMIN_PASSWORD = 'senha-admin-seg-1';
process.env.NODE_ENV = 'test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOTRUE_JWT_SECRET;

const { buildApp } = await import('../src/app.js');
const { getAsyncDb } = await import('../src/db.js');
const ai = await import('../src/ai.js');
const { ageInYears } = await import('../src/routes/cases.routes.js');
const { redactQuery, redactUrl, serializeRequest } = await import('../src/log-redact.js');
const app = await buildApp();
const H = { host: 'localhost', origin: 'http://localhost' };

const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const set = r.headers['set-cookie'];
  return String((Array.isArray(set) ? set[0] : set) ?? '').split(';')[0] ?? '';
};
const post = (cookie: string, url: string, data: Record<string, string>) =>
  app.inject({ method: 'POST', url, headers: { ...H, cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: form(data) });
const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { ...H, cookie } });
let admin = '';
let medico = '';

before(async () => {
  await app.ready();
  admin = cookieOf(await post('', '/login', { email: 'admin@seg.local', password: 'senha-admin-seg-1' }));
  assert.equal((await post(admin, '/configuracoes/usuarios', { name: 'Dra. Clínica', email: 'medica@seg.local', password: 'senha-medica-seg-1', role: 'medico' })).statusCode, 302);
  medico = cookieOf(await post('', '/login', { email: 'medica@seg.local', password: 'senha-medica-seg-1' }));
  assert.ok(admin && medico);
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('configuração clínica: médico lê, mas só o administrador grava regras, fórmulas e orientações', async () => {
  const rule = (await getAsyncDb().prepare("SELECT id FROM rules ORDER BY id LIMIT 1").get()) as { id: number };
  const writes: Array<[string, Record<string, string>]> = [
    [`/regras/${rule.id}/rapido`, { conferir: '1' }],
    [`/regras/${rule.id}`, { exam_canonical: 'x' }],
    ['/regras', { exam_canonical: 'x' }],
    ['/regras/importar', { csv: 'a' }],
    ['/formulas', { name: 'x' }],
    ['/formulas/1', { name: 'x' }],
    ['/formulas/rascunho-ia', { name: 'x' }],
    ['/formulas/arquivos/1/extrair', {}],
    ['/formulas/arquivos/1/excluir', {}],
    ['/orientacoes', { code: 'x' }],
    ['/orientacoes/1', { code: 'x' }],
  ];
  const before = (await getAsyncDb().prepare('SELECT (SELECT COUNT(*) FROM rules) AS r, (SELECT COUNT(*) FROM formulas) AS f, (SELECT COUNT(*) FROM guidances) AS g, (SELECT COUNT(*) FROM rules WHERE checked_at IS NOT NULL) AS c').get()) as Record<string, number>;
  for (const [url, data] of writes) assert.equal((await post(medico, url, data)).statusCode, 403, url);
  const upload = await app.inject({ method: 'POST', url: '/formulas/arquivos', headers: { ...H, cookie: medico, 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--\r\n' });
  assert.equal(upload.statusCode, 403, '/formulas/arquivos');
  const afterCounts = (await getAsyncDb().prepare('SELECT (SELECT COUNT(*) FROM rules) AS r, (SELECT COUNT(*) FROM formulas) AS f, (SELECT COUNT(*) FROM guidances) AS g, (SELECT COUNT(*) FROM rules WHERE checked_at IS NOT NULL) AS c').get()) as Record<string, number>;
  assert.deepEqual(afterCounts, before, 'nada gravado');
  for (const url of ['/regras', '/formulas', '/orientacoes', '/regras/exportar.csv']) assert.equal((await get(medico, url)).statusCode, 200, url);
  assert.equal((await post(admin, `/regras/${rule.id}/rapido`, { conferir: '1' })).statusCode, 302, 'administrador segue gravando');
});

async function caseWithConsent(status: 'pendente' | 'assinado' | 'recusado' | 'revogado'): Promise<number> {
  const adb = getAsyncDb();
  const code = `SEG-${status}-${Math.random().toString(36).slice(2, 8)}`;
  await adb.prepare('INSERT INTO patients(code, name, birth_date, consent_status) VALUES (?, ?, ?, ?)').run(code, `Paciente ${code}`, '1980-06-15', status);
  const pid = Number(((await adb.prepare('SELECT id FROM patients WHERE code = ?').get(code)) as { id: number }).id);
  return Number((await adb.prepare('INSERT INTO cases(patient_id, patient_code, birth_date) VALUES (?, ?, ?)').run(pid, code, '1980-06-15')).lastInsertRowid);
}

test('IA: sem termo assinado as 4 chamadas com dado do paciente nem começam', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-teste-sem-rede';
  try {
    for (const status of ['pendente', 'recusado', 'revogado'] as const) {
      const caseId = await caseWithConsent(status);
      assert.equal(await ai.aiConsentGiven(caseId), false, status);
      const calls: Array<[string, () => Promise<unknown>]> = [
        ['extração', () => ai.extractFromFile(Buffer.from('%PDF-1.4'), 'application/pdf', [], caseId)],
        ['relatórios', () => ai.writeReports({}, caseId)],
        ['conduta', () => ai.suggestConduct({}, caseId)],
        ['fórmulas', () => ai.suggestFormulas({}, caseId)],
      ];
      for (const [label, fn] of calls) await assert.rejects(fn, (e: unknown) => e instanceof ai.AiError && e.message === ai.NO_AI_CONSENT, `${status}: ${label}`);
    }
    assert.equal(await ai.aiConsentGiven(await caseWithConsent('assinado')), true);
    assert.equal(await ai.aiConsentGiven(999999), false, 'caso inexistente não libera');
    const used = (await getAsyncDb().prepare('SELECT COUNT(*) AS n FROM ai_usage').get()) as { n: number };
    assert.equal(used.n, 0, 'nenhuma chamada registrada');

    // a tela avisa e a rota de extração devolve a mensagem da trava
    const caseId = await caseWithConsent('pendente');
    const page = await get(admin, `/casos/${caseId}`);
    assert.match(page.body, /Paciente sem termo de IA assinado/);
    await getAsyncDb().prepare("INSERT INTO case_files(case_id, original_name, stored_name, size, mime) VALUES (?, 'laudo.pdf', 'nao-existe.pdf', 10, 'application/pdf')").run(caseId);
    const fid = Number(((await getAsyncDb().prepare('SELECT id FROM case_files WHERE case_id = ?').get(caseId)) as { id: number }).id);
    fs.writeFileSync(path.join(tmp, 'uploads', 'nao-existe.pdf'), '%PDF-1.4 teste');
    const r = await post(admin, `/casos/${caseId}/arquivos/${fid}/extrair`, {});
    assert.equal(r.statusCode, 302);
    assert.match(decodeURIComponent(String(r.headers.location)), /Paciente sem termo de IA assinado/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('IA recebe a idade em anos, nunca a data de nascimento', () => {
  assert.equal(ageInYears('1980-06-15', '2026-06-14'), 45);
  assert.equal(ageInYears('1980-06-15', '2026-06-15'), 46);
  assert.equal(ageInYears('2000-02-29', '2026-02-28'), 25);
  assert.equal(ageInYears(null), null);
  assert.equal(ageInYears('15/06/1980'), null);
  assert.equal(ageInYears('2030-01-01', '2026-01-01'), null, 'nascimento no futuro');
  // O módulo ao lado deste teste: .ts no tsx local, .js compilado no container do ensaio.
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const src = fs.readFileSync(new URL(`../src/routes/cases.routes.${ext}`, import.meta.url), 'utf8');
  const payload = src.slice(src.indexOf('function reportPayload('), src.indexOf('function pickMarkdown('));
  assert.match(payload, /idade_anos: ageInYears\(c\.birth_date\)/);
  assert.doesNotMatch(payload, /nascimento|birth_date(?!\))/);
});

test('log: só parâmetros da lista passam; busca, mensagem, destino e token de redefinição são mascarados', () => {
  assert.equal(redactQuery('/pacientes?q=Maria%20Silva&kind=ok'), '/pacientes?q=[redigido]&kind=ok');
  assert.equal(redactQuery('/casos/1?msg=Paciente%20Jo%C3%A3o&kind=warn'), '/casos/1?msg=[redigido]&kind=warn');
  assert.equal(redactQuery('/login?next=/pacientes/3&sso=falhou'), '/login?next=[redigido]&sso=falhou');
  assert.equal(redactQuery('/regras?sistema=tireoide&pendentes=1'), '/regras?sistema=tireoide&pendentes=1');
  assert.equal(redactQuery('/x?nome=Fulano&cpf=12345678900'), '/x?nome=[redigido]&cpf=[redigido]', 'parâmetro novo nasce mascarado');
  assert.equal(redactQuery('/casos'), '/casos');
  assert.equal(redactUrl('/redefinir/AbC123_token-secreto'), '/redefinir/[token]');
  assert.equal(redactUrl('/redefinir/AbC123?x=1'), '/redefinir/[token]?x=[redigido]');
  const fake = { method: 'GET', url: '/pacientes?q=Fulano', host: 'localhost', ip: '10.0.0.1', socket: { remotePort: 5555 } } as unknown as Parameters<typeof serializeRequest>[0];
  const out = JSON.stringify(serializeRequest(fake));
  assert.doesNotMatch(out, /Fulano/);
  assert.match(out, /q=\[redigido\]/);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nutrolab-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_EMAIL = 'medico@teste.local';
process.env.ADMIN_NAME = 'Médica Teste';
process.env.ADMIN_PASSWORD = 'senha-de-teste-123';
process.env.NODE_ENV = 'test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOTRUE_JWT_SECRET;

const { buildApp } = await import('../src/app.js');
const { fakeDocx } = await import('./docx.test.js');
const app = await buildApp();
const H = { host: 'localhost', origin: 'http://localhost' };
let cookie = '';

const form = (data: Record<string, string | string[]>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) (Array.isArray(v) ? v : [v]).forEach((x) => p.append(k, x));
  return p.toString();
};
const post = (url: string, data: Record<string, string | string[]>, extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { ...H, cookie, 'content-type': 'application/x-www-form-urlencoded', ...extra }, payload: form(data) });
const get = (url: string) => app.inject({ method: 'GET', url, headers: { ...H, cookie } });

before(async () => {
  await app.ready();
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('sem sessão redireciona para login; health é público', async () => {
  const r = await get('/casos');
  assert.equal(r.statusCode, 302);
  assert.match(r.headers.location ?? '', /^\/login/);
  const h = await get('/health');
  assert.equal(h.statusCode, 200);
  assert.equal(h.json().ai, 'off');
});

test('login errado 401, POST de origem estranha 403, login certo cria cookie', async () => {
  const bad = await post('/login', { email: 'medico@teste.local', password: 'errada' });
  assert.equal(bad.statusCode, 401);
  const csrf = await post('/login', { email: 'medico@teste.local', password: 'senha-de-teste-123' }, { origin: 'http://evil.example' });
  assert.equal(csrf.statusCode, 403);
  const ok = await post('/login', { email: 'medico@teste.local', password: 'senha-de-teste-123' });
  assert.equal(ok.statusCode, 302);
  const set = ok.headers['set-cookie'];
  const first = Array.isArray(set) ? set[0] : set;
  assert.ok(first && first.includes('nl_session='));
  assert.match(first, /HttpOnly/);
  cookie = first.split(';')[0] ?? '';
});

test('regra de exemplo não pode ser ativada; regra real pode', async () => {
  const base = { exam_canonical: 'vitamina_d_25oh', aliases: '25(OH)D | Vitamina D 25-OH | 25-Hidroxi Vitamina D', sex: 'todos', age_min: '', age_max: '', unit: 'ng/mL', target_min: '40', target_max: '80', target_text: '', critical_low: '10', critical_high: '150', version: '1.0', reviewed_at: '2026-10-28', status: 'ativo' };
  const rejected = await post('/regras/1', { ...base, clinical_source: 'EXEMPLO DE FORMATO' });
  assert.equal(rejected.statusCode, 200);
  assert.match(rejected.body, /linha de exemplo não pode ser ativada/);
  const accepted = await post('/regras/1', { ...base, clinical_source: 'Decisão da médica em 2026-10-28' });
  assert.equal(accepted.statusCode, 302);
  const dup = await post('/regras', { ...base, clinical_source: 'outra fonte' });
  assert.equal(dup.statusCode, 200);
  assert.match(dup.body, /já existe regra ativa idêntica/);
});

test('orientação ativa com dose é recusada', async () => {
  const r = await post('/orientacoes', { code: 'ORIENT-TESTE', title: 't', exam_canonical: 'vitamina_d_25oh', trigger: 'abaixo_do_alvo', not_apply_note: '', patient_text: 'Tome 2000 UI por dia.', requires_alert: '0', clinical_source: 'fonte', version: '1.0', reviewed_at: '2026-10-28', status: 'ativo' });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /dose\/prescrição/);
});

test('caso → resultados → análise → download, com classificação e nome pseudonimizado', async () => {
  const created = await post('/casos', { patient_code: 'P-0001', sex: 'F', birth_date: '1985-03-10', contexts: ['pre_menopausa', 'jejum'] });
  assert.equal(created.statusCode, 302);
  assert.match(created.headers.location ?? '', /^\/casos\/1/);
  for (const [exam_raw, value_raw, unit_raw] of [['25-Hidroxi Vitamina D', '8', 'ng/mL'], ['Ferritina', '1.250', 'ng/mL'], ['HBsAg', 'Não reagente', '']]) {
    const r = await post('/casos/1/resultados', { exam_raw: exam_raw ?? '', value_raw: value_raw ?? '', unit_raw: unit_raw ?? '', collection_date: '2026-10-15', confidence: 'alta', page: '', source_file: 'exames.pdf', lab_reference: '', lab_flag: '' });
    assert.equal(r.statusCode, 302);
  }
  const previa = await get('/casos/1/previa');
  const data = previa.json().data as Array<{ exam: string | null; classification: string }>;
  assert.equal(data[0]?.classification, 'abaixo_do_alvo');
  assert.equal(data[1]?.classification, 'sem_alvo');
  const page = await get('/casos/1');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /crítico baixo/);
  const blocked = await post('/casos/1/analisar', {});
  assert.match(blocked.headers.location ?? '', /conferencia/);
  const conf = await get('/casos/1/conferencia');
  assert.equal(conf.statusCode, 200);
  assert.match(conf.body, /3 resultado\(s\) ainda sem conferência/);
  const okAll = await post('/casos/1/conferencia', { action: 'ok_todos', exam_raw_1: '25-Hidroxi Vitamina D', value_raw_1: '8', unit_raw_1: 'ng/mL', include_1: '1', exam_raw_2: 'Ferritina', value_raw_2: '1.250', unit_raw_2: 'ng/mL', include_2: '1', exam_raw_3: 'HBsAg', value_raw_3: 'Não reagente', include_3: '1', collection_date_1: '2026-10-15', collection_date_2: '2026-10-15', collection_date_3: '2026-10-15' });
  assert.equal(okAll.statusCode, 302);
  assert.match((await get('/casos/1/conferencia')).body, /Todos conferidos/);
  const analyzed = await post('/casos/1/analisar', {});
  assert.equal(analyzed.statusCode, 302);
  assert.match(analyzed.headers.location ?? '', /^\/casos\/1\/analises\/1/);
  const view = await get('/casos/1/analises/1');
  assert.equal(view.statusCode, 200);
  assert.match(view.body, /Relatório dos seus exames/);
  assert.match(view.body, /Relatório técnico de exames/);
  assert.match(view.body, /Score 0 de 100/);
  const dl = await get('/casos/1/analises/1/download?tipo=tecnico');
  assert.equal(dl.statusCode, 200);
  assert.match(dl.headers['content-disposition'] ?? '', /analise-exames_P-0001_2026-10-15_tecnico\.md/);
  assert.match(dl.body, /Limite crítico cadastrado \(baixo\)/);
  assert.match(dl.body, /separador "\." seguido de 3 dígitos/);
  assert.match(dl.body, /Versão da tabela clínica: 2026-10-28 \(1 regras ativas\)/);
  assert.doesNotMatch(dl.body, /medico@teste\.local/);
});

test('vincular exame sem correspondência à tabela e versão para impressão', async () => {
  const before = (await get('/casos/1/previa')).json().data as Array<{ exam: string | null }>;
  assert.equal(before[1]?.exam, 'ferritina');
  const link = await post('/casos/1/resultados/2/vincular', { exam_canonical: 'vitamina_d_25oh' });
  assert.equal(link.statusCode, 302);
  const after = (await get('/casos/1/previa')).json().data as Array<{ exam: string | null; classification: string }>;
  assert.equal(after[1]?.exam, 'vitamina_d_25oh');
  assert.equal(after[1]?.classification, 'nao_comparavel');
  const bad = await post('/casos/1/resultados/2/vincular', { exam_canonical: 'inexistente' });
  assert.match(bad.headers.location ?? '', /Exame%20inexistente/);
  await post('/casos/1/resultados/2/vincular', { exam_canonical: '' });
  const printP = await get('/casos/1/analises/1/imprimir?tipo=resumido');
  assert.match(printP.body, /aria-label="Painel visual"/);
  const print = await get('/casos/1/analises/1/imprimir?tipo=tecnico');
  assert.equal(print.statusCode, 200);
  assert.match(print.body, /Imprimir \/ salvar em PDF/);
  assert.match(print.body, /<svg role="img" aria-label="Score/);
  assert.match(print.body, /aria-label="Painel visual"/);
  assert.doesNotMatch(print.body, /class="sidenav"/);
});

test('recuperação de senha: link do administrador, uso único, sessões antigas caem', async () => {
  const noMail = await get('/esqueci');
  assert.equal(noMail.statusCode, 200);
  assert.match(noMail.body, /link de redefinição/);
  assert.equal((await get('/redefinir/token-invalido-xxxxxxxxxxxx')).statusCode, 404);
  const create = await post('/configuracoes/usuarios', { name: 'Nutri', email: 'nutri@teste.local', password: 'senha-inicial-1', role: 'medico' });
  assert.equal(create.statusCode, 302);
  const users = await get('/configuracoes');
  const idMatch = /usuarios\/(\d+)\/redefinir/.exec(users.body.split('nutri@teste.local')[1] ?? '') ?? /usuarios\/(\d+)\/redefinir/.exec(users.body);
  const nutriId = Number(idMatch?.[1]);
  assert.ok(nutriId > 1);
  const gen = await post(`/configuracoes/usuarios/${nutriId}/redefinir`, {});
  assert.equal(gen.statusCode, 200);
  const link = /\/redefinir\/([A-Za-z0-9_-]+)/.exec(gen.body)?.[1];
  assert.ok(link, 'link gerado');
  const adminCookie = cookie;
  cookie = '';
  const form = await get(`/redefinir/${link}`);
  assert.equal(form.statusCode, 200);
  const weak = await post(`/redefinir/${link}`, { password: 'curta', confirm: 'curta' });
  assert.match(weak.body, /ao menos 10 caracteres/);
  const ok = await post(`/redefinir/${link}`, { password: 'nova-senha-forte-1', confirm: 'nova-senha-forte-1' });
  assert.equal(ok.statusCode, 302);
  assert.equal((await post(`/redefinir/${link}`, { password: 'outra-senha-forte-1', confirm: 'outra-senha-forte-1' })).statusCode, 404);
  const old = await post('/login', { email: 'nutri@teste.local', password: 'senha-inicial-1' });
  assert.equal(old.statusCode, 401);
  const fresh = await post('/login', { email: 'nutri@teste.local', password: 'nova-senha-forte-1' });
  assert.equal(fresh.statusCode, 302);
  cookie = adminCookie;
  const beforeChange = await get('/casos');
  assert.equal(beforeChange.statusCode, 200);
  const change = await post('/senha', { current: 'senha-de-teste-123', password: 'senha-admin-nova-1', confirm: 'senha-admin-nova-1' });
  assert.match(change.body, /Senha alterada/);
  const stale = await app.inject({ method: 'GET', url: '/casos', headers: { ...H, cookie: adminCookie } });
  assert.equal(stale.statusCode, 302, 'sessão antiga invalidada após troca de senha');
  const setNew = change.headers['set-cookie'];
  cookie = ((Array.isArray(setNew) ? setNew[0] : setNew) ?? '').split(';')[0] ?? '';
  assert.equal((await get('/casos')).statusCode, 200);
});

test('status do caso e exportação CSV', async () => {
  const st = await post('/casos/1/status', { status: 'revisado' });
  assert.equal(st.statusCode, 302);
  assert.match((await get('/casos/1')).body, /revisado/);
  const csv = await get('/regras/exportar.csv');
  assert.equal(csv.statusCode, 200);
  assert.match(csv.body.split('\n')[0] ?? '', /^exame_canonico,aliases,sexo/);
  assert.match(csv.body, /vitamina_d_25oh,25\(OH\)D\|Vitamina D 25-OH\|25-Hidroxi Vitamina D,todos/);
});

test('médico comum não acessa configurações; auditoria registrou as ações', async () => {
  const create = await post('/configuracoes/usuarios', { name: 'Recepção', email: 'recepcao@teste.local', password: 'senha-recepcao-1', role: 'medico' });
  assert.equal(create.statusCode, 302);
  const adminCookie = cookie;
  const login = await post('/login', { email: 'recepcao@teste.local', password: 'senha-recepcao-1' });
  const set = login.headers['set-cookie'];
  cookie = ((Array.isArray(set) ? set[0] : set) ?? '').split(';')[0] ?? '';
  assert.equal((await get('/configuracoes')).statusCode, 403);
  assert.equal((await get('/casos')).statusCode, 200);
  cookie = adminCookie;
  const audit = await get('/auditoria');
  assert.match(audit.body, /gerar_analise/);
  assert.match(audit.body, /login_falhou/);
});

test('etapa 5: conduta manual, finalização com observações, relatório final e reabertura', async () => {
  const conduct = await get('/casos/1/analises/1/conduta');
  assert.equal(conduct.statusCode, 200);
  assert.match(conduct.body, /openevidence\.com\/ask\?q=/);
  const add = await post('/casos/1/analises/1/conduta/novo', { kind: 'seguimento', title: 'Repetir vitamina D em 3 meses', rationale: 'Valor abaixo do limite crítico cadastrado.' });
  assert.equal(add.statusCode, 302);
  const list = await get('/casos/1/analises/1/conduta');
  const cid = /conduta\/(\d+)" class="card"/.exec(list.body)?.[1];
  assert.ok(cid, 'item criado');
  const rejected = await post(`/casos/1/analises/1/conduta/${cid}`, { action: 'rejeitar', kind: 'seguimento', title: 'Repetir vitamina D em 3 meses', rationale: 'x' });
  assert.equal(rejected.statusCode, 302);
  await post(`/casos/1/analises/1/conduta/${cid}`, { action: 'aprovar', kind: 'seguimento', title: 'Repetir vitamina D em 3 meses', rationale: 'Valor abaixo do limite crítico cadastrado.' });
  const fin = await post('/casos/1/analises/1/finalizar', { action: 'finalizar', doctor_notes: 'Manter hidratação adequada e trazer os exames anteriores na consulta.' });
  assert.equal(fin.statusCode, 302);
  const dlP = await get('/casos/1/analises/1/download?tipo=resumido');
  assert.match(dlP.body, /Orientações e próximos passos/);
  assert.match(dlP.body, /Repetir vitamina D em 3 meses/);
  assert.match(dlP.body, /Observações do seu médico/);
  assert.doesNotMatch(dlP.body, /Valor abaixo do limite crítico cadastrado/);
  const dlT = await get('/casos/1/analises/1/download?tipo=tecnico');
  assert.match(dlT.body, /Conduta aprovada pelo médico/);
  assert.match(dlT.body, /Valor abaixo do limite crítico cadastrado/);
  assert.match((await get('/casos/1')).body, /tag revisado/);
  const locked = await post(`/casos/1/analises/1/conduta/${cid}`, { action: 'rejeitar', kind: 'seguimento', title: 't', rationale: '' });
  assert.match(locked.body, /já finalizado/);
  const reopen = await post('/casos/1/analises/1/finalizar', { action: 'reabrir' });
  assert.equal(reopen.statusCode, 302);
  assert.match((await get('/casos/1/analises/1')).body, /tag aberto/);
});

test('login profissional: nome + CPF + conselho + senha; perfil e cadastro pelo administrador', async () => {
  const create = await post('/configuracoes/usuarios', { name: 'Ana Souza', email: 'ana@teste.local', password: 'senha-da-ana-123', role: 'medico', cpf: '529.982.247-25', council: 'CRN', council_number: '12345', council_state: 'SP' });
  assert.equal(create.statusCode, 302);
  const badCpf = await post('/configuracoes/usuarios', { name: 'X', email: 'x@teste.local', password: 'senha-xxxxx-123', role: 'medico', cpf: '111.111.111-11' });
  assert.match(badCpf.body, /CPF inválido/);
  const adminCookie = cookie;
  cookie = '';
  const form = await get('/login');
  assert.match(form.body, /Número do conselho/);
  const wrongName = await post('/login', { name: 'Ana Silva', cpf: '52998224725', council_number: '12345', password: 'senha-da-ana-123' });
  assert.equal(wrongName.statusCode, 401);
  const wrongCouncil = await post('/login', { name: 'Ana Souza', cpf: '529.982.247-25', council_number: '99999', password: 'senha-da-ana-123' });
  assert.equal(wrongCouncil.statusCode, 401);
  const ok = await post('/login', { name: 'ana souza', cpf: '529.982.247-25', council_number: '12345', password: 'senha-da-ana-123' });
  assert.equal(ok.statusCode, 302);
  assert.equal(ok.headers.location, '/casos');
  const set = ok.headers['set-cookie'];
  cookie = ((Array.isArray(set) ? set[0] : set) ?? '').split(';')[0] ?? '';
  const perfil = await get('/perfil');
  assert.equal(perfil.statusCode, 200);
  assert.match(perfil.body, /529\.982\.247-25/);
  cookie = adminCookie;
});

test('ajuste rápido das referências: ordem validada, barra renderizada, ativação', async () => {
  const pageQ = await get('/regras?sistema=vitaminas');
  assert.equal(pageQ.statusCode, 200);
  assert.match(pageQ.body, /class="refrow"/);
  assert.match(pageQ.body, /aria-label="ótimo de"/);
  assert.match(pageQ.body, /background:#2f7d4f/);
  const bad = await post('/regras/1/rapido', { critical_low: '10', normal_min: '30', target_min: '60', target_max: '50', normal_max: '100', critical_high: '150', status: 'ativo' });
  assert.match(bad.headers.location ?? '', /crescer%20da%20esquerda/);
  const okq = await post('/regras/1/rapido', { critical_low: '10', normal_min: '30', target_min: '40', target_max: '80', normal_max: '100', critical_high: '150', status: 'ativo' });
  assert.match(okq.headers.location ?? '', /^\/regras\?sistema=\w+&kind=ok/);
  assert.equal((await get('/regras/lista')).statusCode, 200);
  const previa = (await get('/casos/1/previa')).json().data as Array<{ exam: string | null; classification: string }>;
  assert.equal(previa[0]?.classification, 'abaixo_do_alvo');
});

test('aba Relatórios: lista e configuração entram no relatório', async () => {
  const list = await get('/relatorios');
  assert.equal(list.statusCode, 200);
  assert.match(list.body, /P-0001/);
  const cfg = await post('/relatorios/config', { clinic_name: 'Clínica Teste', clinic_info: 'Rua A, 1', signature: 'Dra. Teste · CRM 000', patient_intro: 'Olá! Este é o seu relatório.', patient_closing: 'Até a consulta.', technical_footer: 'Documento técnico.', show_score: '1', show_systems: '1', show_guidances: '1' });
  assert.equal(cfg.statusCode, 302);
  await post('/casos/1/analisar', {});
  const dl = await get('/casos/1/analises/2/download?tipo=resumido');
  assert.match(dl.body, /Clínica Teste/);
  assert.match(dl.body, /Olá! Este é o seu relatório\./);
  assert.match(dl.body, /Até a consulta\./);
});

test('banco de fórmulas: cadastro, ativação e inclusão na conduta do caso', async () => {
  const created = await post('/formulas', { name: 'Vitamina D3 10.000 UI + K2', kind: 'manipulada', composition: 'Colecalciferol 10.000 UI\nMenaquinona-7 100 mcg', posology: '1 cápsula ao dia, após o almoço', indications: 'Vitamina D abaixo do alvo', exams: 'vitamina_d_25oh', contraindications: 'Hipercalcemia; uso de varfarina', notes: '', status: 'ativo' });
  assert.equal(created.statusCode, 302);
  const bank = await get('/formulas');
  assert.match(bank.body, /Vitamina D3 10\.000 UI \+ K2/);
  const fid = /\/formulas\/(\d+)"/.exec(bank.body)?.[1];
  assert.ok(fid);
  const casePage = await get('/casos/1/analises/2/formulas');
  assert.equal(casePage.statusCode, 200);
  assert.match(casePage.body, /Adicionar à conduta/);
  const add = await post(`/casos/1/analises/2/formulas/${fid}/adicionar`, {});
  assert.equal(add.statusCode, 302);
  const conduct = await get('/casos/1/analises/2/conduta');
  assert.match(conduct.body, /Vitamina D3 10\.000 UI \+ K2/);
  assert.match(conduct.body, /biblioteca/);
  const fin = await post('/casos/1/analises/2/finalizar', { action: 'finalizar', doctor_notes: '' });
  assert.equal(fin.statusCode, 302);
  const dlT = await get('/casos/1/analises/2/download?tipo=tecnico');
  assert.match(dlT.body, /Medicamentoso/);
  assert.match(dlT.body, /Colecalciferol 10\.000 UI/);
  const dlP = await get('/casos/1/analises/2/download?tipo=resumido');
  assert.match(dlP.body, /Vitamina D3 10\.000 UI \+ K2/);
  assert.doesNotMatch(dlP.body, /Hipercalcemia/);
});

function multipart(fields: Array<{ name: string; filename: string; type: string; data: Buffer }>): { body: Buffer; type: string } {
  const boundary = '----nutrolabtest';
  const parts = fields.map((f) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`), f.data, Buffer.from('\r\n')]));
  return { body: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]), type: `multipart/form-data; boundary=${boundary}` };
}

test('fórmulas: anexo de formulário .docx aceito, .txt rejeitado; logo da clínica enviada e servida', async () => {
  const docx = fakeDocx('<w:document><w:body><w:p><w:r><w:t>Vitamina D3 10.000 UI</w:t></w:r></w:p></w:body></w:document>');
  const m = multipart([{ name: 'arquivo', filename: 'formulario.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: docx }, { name: 'arquivo', filename: 'nota.txt', type: 'text/plain', data: Buffer.from('texto') }]);
  const up = await app.inject({ method: 'POST', url: '/formulas/arquivos', headers: { ...H, cookie, 'content-type': m.type }, payload: m.body });
  assert.equal(up.statusCode, 302);
  assert.match(decodeURIComponent(up.headers.location ?? ''), /1 arquivo\(s\) anexado\(s\)\. 1 rejeitado/);
  const pageF = await get('/formulas');
  assert.match(pageF.body, /formulario\.docx/);
  assert.match(pageF.body, /ainda não lido/);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7a1a4000000004945e44ae426082', 'hex');
  const lm = multipart([{ name: 'logo', filename: 'logo.png', type: 'image/png', data: png }]);
  const logo = await app.inject({ method: 'POST', url: '/relatorios/logo', headers: { ...H, cookie, 'content-type': lm.type }, payload: lm.body });
  assert.equal(logo.statusCode, 302);
  const served = await get('/branding/logo');
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  const rel = await get('/relatorios');
  assert.match(rel.body, /\/branding\/logo\?v=png-/);
  const print = await get('/casos/1/analises/2/imprimir?tipo=resumido');
  assert.match(print.body, /\/branding\/logo/);
  assert.match(print.body, /Clínica Teste/);
});

test('pacientes: cadastro, consentimento LGPD, caso vinculado, evolução entre coletas', async () => {
  const logoLogin = await app.inject({ method: 'GET', url: '/login', headers: H });
  assert.match(logoLogin.body, /\/branding\/logo\?v=png-/);
  const list = await get('/pacientes');
  assert.equal(list.statusCode, 200);
  assert.match(list.body, /P-0001/);
  const created = await post('/pacientes', { name: 'João Evolução', code: 'EVO-1', birth_date: '1980-01-15', sex: 'M', phone: '11 99999-0000', comorbidities: 'HAS' });
  assert.equal(created.statusCode, 302);
  const pid = Number(/\/pacientes\/(\d+)/.exec(created.headers.location ?? '')?.[1]);
  assert.ok(pid > 0);
  let ficha = await get(`/pacientes/${pid}`);
  assert.match(ficha.body, /LGPD pendente/);
  assert.match(ficha.body, /Imprimir termo/);
  const termo = await get(`/pacientes/${pid}/termo`);
  assert.equal(termo.statusCode, 200);
  assert.match(termo.body, /João Evolução/);
  assert.match(termo.body, /Lei nº 13\.709\/2018/);
  const cm = multipart([{ name: 'file', filename: 'termo.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4\n%fake\n') }]);
  const body = Buffer.concat([Buffer.from(`------nutrolabtest\r\nContent-Disposition: form-data; name="status"\r\n\r\nassinado\r\n------nutrolabtest\r\nContent-Disposition: form-data; name="method"\r\n\r\npapel assinado\r\n------nutrolabtest\r\nContent-Disposition: form-data; name="date"\r\n\r\n2026-11-18\r\n`), cm.body]);
  const consent = await app.inject({ method: 'POST', url: `/pacientes/${pid}/consentimento`, headers: { ...H, cookie, 'content-type': cm.type }, payload: body });
  assert.equal(consent.statusCode, 302);
  ficha = await get(`/pacientes/${pid}`);
  assert.match(ficha.body, /LGPD assinado/);
  assert.match(ficha.body, /Ver termo assinado/);
  // dois casos do mesmo paciente com vitamina D em datas diferentes
  for (const [date, value] of [['2026-05-10', '18'], ['2026-11-10', '34']]) {
    const nc = await post('/casos', { patient_id: String(pid), patient_name: '', sex: 'M', birth_date: '1980-01-15', contexts: ['jejum'] });
    assert.equal(nc.statusCode, 302);
    const cid = Number(/\/casos\/(\d+)/.exec(nc.headers.location ?? '')?.[1]);
    const page = await get(`/casos/${cid}`);
    assert.match(page.body, /João Evolução/);
    await post(`/casos/${cid}/resultados`, { exam_raw: '25-Hidroxi Vitamina D', value_raw: value ?? '', unit_raw: 'ng/mL', collection_date: date ?? '', confidence: 'alta', page: '', source_file: '', lab_reference: '', lab_flag: '' });
    const conf = await get(`/casos/${cid}/conferencia`);
    const rid = /include_(\d+)/.exec(conf.body)?.[1];
    await post(`/casos/${cid}/conferencia`, { action: 'ok_todos', [`exam_raw_${rid}`]: '25-Hidroxi Vitamina D', [`value_raw_${rid}`]: value ?? '', [`unit_raw_${rid}`]: 'ng/mL', [`include_${rid}`]: '1', [`collection_date_${rid}`]: date ?? '' });
    const an = await post(`/casos/${cid}/analisar`, {});
    assert.equal(an.statusCode, 302);
  }
  ficha = await get(`/pacientes/${pid}`);
  assert.match(ficha.body, /Evolução entre coletas/);
  assert.match(ficha.body, /aria-label="Evolução"/);
  assert.match(ficha.body, /Score ao longo do tempo/);
  // painel do segundo caso mostra o valor anterior
  const cases = await get(`/pacientes/${pid}`);
  const lastCase = Math.max(...[...cases.body.matchAll(/\/casos\/(\d+)"/g)].map((m) => Number(m[1])));
  const an2 = await get(`/casos/${lastCase}`);
  const aid = /analises\/(\d+)/.exec(an2.body)?.[1];
  const view = await get(`/casos/${lastCase}/analises/${aid}`);
  assert.match(view.body, /anterior: 18 ng\/mL em 10\/05\/2026/);
});

test('modelos de conduta: criar, gatilho casa com o caso, aplicar, salvar a partir da conduta', async () => {
  const bad = await post('/modelos', { name: 'Teste', profile: '', triggers: 'vitamina_d_25oh:qualquer', items: 'seguimento | Repetir | x', status: 'ativo' });
  assert.match(bad.body, /gatilho inválido/);
  const created = await post('/modelos', { name: 'Vitamina D baixa', profile: 'Deficiência de vitamina D', triggers: 'vitamina_d_25oh:abaixo_do_alvo', items: 'suplementacao | Vitamina D3 | 25(OH)D abaixo do alvo\nseguimento | Repetir 25(OH)D em 3 meses | acompanhar', status: 'ativo' });
  assert.equal(created.statusCode, 302);
  const listT = await get('/modelos');
  assert.match(listT.body, /Vitamina D baixa/);
  const tid = /\/modelos\/(\d+)"/.exec(listT.body)?.[1];
  const conduct = await get('/casos/1/analises/2/conduta');
  assert.equal(conduct.statusCode, 200);
  // análise 2 do caso 1 está finalizada; reabrir para aplicar
  await post('/casos/1/analises/2/finalizar', { action: 'reabrir' });
  const conduct2 = await get('/casos/1/analises/2/conduta');
  assert.match(conduct2.body, /Combinam com este caso/);
  const applied = await post('/casos/1/analises/2/conduta/modelo', { template_id: tid ?? '' });
  assert.equal(applied.statusCode, 302);
  const after = await get('/casos/1/analises/2/conduta');
  assert.match(after.body, /Repetir 25\(OH\)D em 3 meses/);
  assert.match(after.body, /modelo: Vitamina D baixa/);
  const saveAs = await post('/casos/1/analises/2/conduta/salvar-modelo', {});
  assert.equal(saveAs.statusCode, 302);
  assert.match(saveAs.headers.location ?? '', /^\/modelos\/\d+/);
  const newT = await get((saveAs.headers.location ?? '').split('?')[0] ?? '');
  assert.match(newT.body, /Modelo do caso #1/);
  assert.match(newT.body, /vitamina_d_25oh:abaixo_do_alvo/);
});

test('hormônios femininos: faixa por fase do ciclo; anticoncepcional combinado suspende as faixas do ciclo', async () => {
  const rule = await post('/regras', { exam_canonical: 'estradiol', aliases: 'Estradiol | E2', sex: 'F', contexts: ['fase_lutea'], unit: 'pg/mL', normal_min: '40', normal_max: '260', target_min: '60', target_max: '260', target_text: '', critical_low: '', critical_high: '', clinical_source: 'teste por fase', version: '1.0', reviewed_at: '2026-11-18', status: 'ativo', system: 'hormonal', age_min: '', age_max: '' });
  assert.equal(rule.statusCode, 302);
  const run = async (extra: Record<string, string>) => {
    const nc = await post('/casos', { patient_name: 'Hormonal Teste', sex: 'F', birth_date: '1990-02-02', menopause: 'nao', ...extra });
    const cid = Number(/\/casos\/(\d+)/.exec(nc.headers.location ?? '')?.[1]);
    await post(`/casos/${cid}/resultados`, { exam_raw: 'Estradiol', value_raw: '120', unit_raw: 'pg/mL', collection_date: '2026-11-01', confidence: 'alta', page: '', source_file: '', lab_reference: '', lab_flag: '' });
    const previa = (await get(`/casos/${cid}/previa`)).json().data as Array<{ exam: string | null; classification: string; notes: string[] }>;
    return { cid, ev: previa[0] };
  };
  const lutea = await run({ cycle_phase: 'lutea' });
  assert.equal(lutea.ev?.exam, 'estradiol');
  assert.equal(lutea.ev?.classification, 'dentro_do_alvo');
  const semFase = await run({});
  assert.equal(semFase.ev?.classification, 'nao_comparavel');
  assert.ok(semFase.ev?.notes.some((n) => n.includes('fase_lutea')));
  const pilula = await run({ cycle_phase: 'lutea', contraceptive: 'combinado' });
  assert.equal(pilula.ev?.classification, 'nao_comparavel');
  const conf = await get(`/casos/${pilula.cid}/conferencia`);
  const rid = /include_(\d+)/.exec(conf.body)?.[1];
  await post(`/casos/${pilula.cid}/conferencia`, { action: 'ok_todos', [`exam_raw_${rid}`]: 'Estradiol', [`value_raw_${rid}`]: '120', [`unit_raw_${rid}`]: 'pg/mL', [`include_${rid}`]: '1', [`collection_date_${rid}`]: '2026-11-01' });
  const an = await post(`/casos/${pilula.cid}/analisar`, {});
  const aid = /analises\/(\d+)/.exec(an.headers.location ?? '')?.[1];
  const tech = await get(`/casos/${pilula.cid}/analises/${aid}/download?tipo=tecnico`);
  assert.match(tech.body, /anticoncepcional hormonal combinado/);
  assert.match(tech.body, /Contexto hormonal: fase do ciclo lutea · anticoncepcional combinado/);
});

test('sem GOTRUE_JWT_SECRET o Bearer é ignorado (nada muda)', async () => {
  const r = await app.inject({ method: 'GET', url: '/casos', headers: { ...H, authorization: 'Bearer a.b.c' } });
  assert.equal(r.statusCode, 302);
});

test('design LN: só tema claro, sem alternância, nome e fonte local', async () => {
  const page = await get('/casos');
  assert.match(page.body, /LN Medicina Integrada · Exames<\/title>/);
  assert.match(page.body, /tokens LN v1\.0\.0|--ink-900:#111111/);
  assert.doesNotMatch(page.body, /prefers-color-scheme|data-theme|nlToggleTheme/);
  const font = await app.inject({ method: 'GET', url: '/assets/fonts/inter-latin-400-700.woff2', headers: H });
  assert.equal(font.statusCode, 200);
  assert.equal(font.headers['content-type'], 'font/woff2');
  assert.equal((await app.inject({ method: 'GET', url: '/assets/fonts/..%2Fpackage.json', headers: H })).statusCode, 404);
});

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

const { buildApp } = await import('../src/app.js');
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
  const print = await get('/casos/1/analises/1/imprimir?tipo=tecnico');
  assert.equal(print.statusCode, 200);
  assert.match(print.body, /Imprimir \/ salvar em PDF/);
  assert.match(print.body, /<svg role="img" aria-label="Score/);
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

/**
 * v2.3: cliente `app` (prontuário do sistema integrado). Tokens por cliente, limite e auditoria
 * por cliente, visão geral do paciente (`/patients/:code/overview`) e `status` nas séries.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nutrolab-integ-app-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_EMAIL = 'medico@teste.local';
process.env.ADMIN_NAME = 'Médica Teste';
process.env.ADMIN_PASSWORD = 'senha-de-teste-123';
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://nutrolab.teste.local/';
process.env.ALLOWED_HOSTS = 'nutrolab.teste.local';
process.env.INTEGRATION_RATE_LIMIT = '200';
delete process.env.ANTHROPIC_API_KEY;

const LN = 'token-ln-de-teste-0123456789abcdef0123456789';
const APP = 'token-app-de-teste-fedcba9876543210fedcba98';
process.env.INTEGRATION_TOKENS = `app:${APP}`;
process.env.INTEGRATION_TOKEN = LN; // legado: vale como o do cliente ln

const { buildApp } = await import('../src/app.js');
const { getAsyncDb, allRules, tableVersion } = await import('../src/db.js');
const { evaluateAll, computeScore } = await import('../src/engine/index.js');
const { loadCase, loadResults, profileOf, toInputs } = await import('../src/routes/cases.routes.js');
const { parseIntegrationTokens, clientForToken, scoreCounts } = await import('../src/integration.js');
import type { IntegrationMarkerSeries, IntegrationPatientOverview } from '../src/integration.js';

type App = Awaited<ReturnType<typeof buildApp>>;
const INTERNAL = { host: 'nutrolab:8090' };
let app: App;
const PATIENT = '7c1d2e3f-4a5b-4c6d-8e7f-0123456789ab';
const OTHER = '11111111-2222-4333-8444-555555555555';

const get = (url: string, token = APP) => app.inject({ method: 'GET', url, headers: { ...INTERNAL, 'x-integration-token': token } });
const post = (url: string, payload: unknown, token = APP) => app.inject({ method: 'POST', url, headers: { ...INTERNAL, 'x-integration-token': token, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });

before(async () => {
  app = await buildApp();
  await app.ready();
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseIntegrationTokens: nome:token por cliente, legado vira ln, vazio e malformado ignorados', () => {
  assert.deepEqual(parseIntegrationTokens({ INTEGRATION_TOKENS: 'ln:aaa, app:bbb' }).clients, [{ name: 'ln', token: 'aaa' }, { name: 'app', token: 'bbb' }]);
  assert.deepEqual(parseIntegrationTokens({ INTEGRATION_TOKEN: 'legado' }).clients, [{ name: 'ln', token: 'legado' }]);
  // ln explícito em INTEGRATION_TOKENS vence o legado
  assert.deepEqual(parseIntegrationTokens({ INTEGRATION_TOKENS: 'ln:novo', INTEGRATION_TOKEN: 'legado' }).clients, [{ name: 'ln', token: 'novo' }]);
  // compose com a variável vazia gera "app:" — ignorado sem aviso; o legado segue valendo
  const composeVazio = parseIntegrationTokens({ INTEGRATION_TOKENS: 'ln:,app:', INTEGRATION_TOKEN: 'legado' });
  assert.deepEqual(composeVazio, { clients: [{ name: 'ln', token: 'legado' }], ignored: [] });
  const ruim = parseIntegrationTokens({ INTEGRATION_TOKENS: 'semnome,:x,APP:y,app:z,app:w' });
  assert.deepEqual(ruim.clients, [{ name: 'app', token: 'y' }]);
  assert.deepEqual(ruim.ignored, ['posição 1', 'posição 2', 'app (repetido)', 'app (repetido)']);
  assert.ok(ruim.ignored.every((i) => !/[yzw]$/.test(i) || i.includes('repetido')), 'o valor do token não vai para o aviso');
  assert.deepEqual(parseIntegrationTokens({}).clients, []);
  const clients = [{ name: 'ln', token: 'aaa' }, { name: 'app', token: 'bbb' }];
  assert.equal(clientForToken('bbb', clients), 'app');
  assert.equal(clientForToken('aaa', clients), 'ln');
  assert.equal(clientForToken('ccc', clients), null);
  assert.equal(clientForToken(undefined, clients), null);
});

test('os dois clientes entram; token errado → 401; auditoria registra o cliente', async () => {
  assert.equal((await get('/api/integration/health', APP)).statusCode, 200);
  assert.equal((await get('/api/integration/health', LN)).statusCode, 200);
  assert.equal((await get('/api/integration/health', 'errado')).statusCode, 401);
  const rows = (await getAsyncDb().prepare("SELECT details FROM audit_log WHERE action = 'integ_health' ORDER BY id").all()) as Array<{ details: string | null }>;
  assert.deepEqual(rows.map((r) => JSON.parse(r.details ?? '{}').client), ['app', 'ln']);
  assert.ok(rows.every((r) => !(r.details ?? '').includes(APP) && !(r.details ?? '').includes(LN)), 'token nunca na auditoria');
});

test('rate limit separado por cliente: o ln esgotado não derruba o app', async () => {
  const own = await buildApp();
  await own.ready();
  try {
    const call = (token: string) => own.inject({ method: 'GET', url: '/api/integration/health', headers: { ...INTERNAL, 'x-integration-token': token } });
    let last = 0;
    for (let i = 0; i < 260 && last !== 429; i += 1) last = (await call(LN)).statusCode;
    assert.equal(last, 429, 'ln estourou o limite');
    assert.equal((await call(APP)).statusCode, 200, 'app segue com a janela própria');
  } finally {
    await own.close();
  }
});

test('overview de paciente que ainda não existe no NutroLab: 200, consentStatus null, sem casos', async () => {
  const r = await get(`/api/integration/patients/${PATIENT}/overview`);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().data, { patientCode: PATIENT, consentStatus: null, cases: [], lastAnalysisId: null });
  assert.equal((await get('/api/integration/patients/%3Cscript%3E/overview')).statusCode, 404, 'código inválido');
  assert.equal((await app.inject({ method: 'GET', url: `/api/integration/patients/${PATIENT}/overview`, headers: INTERNAL })).statusCode, 401);
});

test('overview: caso criado pelo app, análises com contagens do score gravado, sem valores de marcadores', async () => {
  const created = await post('/api/integration/cases', { patientCode: PATIENT, sex: 'F', birthDate: '1980-05-20', consentIaClinica: 'aceito', consentVersion: '1.0' });
  assert.equal(created.statusCode, 201);
  const caseId = created.json().data.id as number;
  const row = await loadCase(caseId);
  assert.match(row?.notes ?? '', /^Criado pelo prontuário do LN Medicina Integrada em \d{2}\/\d{2}\/\d{4}\.$/);

  const empty = (await get(`/api/integration/patients/${PATIENT}/overview`)).json().data as IntegrationPatientOverview;
  assert.equal(empty.consentStatus, 'assinado');
  assert.equal(empty.cases.length, 1);
  assert.deepEqual(empty.cases[0]?.analyses, []);
  assert.equal(empty.cases[0]?.status, 'aberto');
  assert.equal(empty.cases[0]?.url, `/casos/${caseId}`);
  assert.match(empty.cases[0]?.openedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(empty.lastAnalysisId, null);

  // Regras ativas: vitamina D com ótimo 40–80 (35 fica fora do ótimo, dentro do normal); glicose só normalidade.
  await getAsyncDb().prepare("UPDATE rules SET target_min = 40, target_max = 80, normal_min = 30, normal_max = 100, critical_low = 10, critical_high = 150, clinical_source = 'teste', status = 'ativo' WHERE exam_canonical = 'vitamina_d_25oh'").run();
  await getAsyncDb().prepare("UPDATE rules SET clinical_source = 'teste', status = 'ativo' WHERE exam_canonical = 'glicose_jejum'").run();
  const ins = getAsyncDb().prepare("INSERT INTO results(case_id, exam_raw, exam_canonical, value_raw, unit_raw, collection_date, confidence, origin, checked, excluded) VALUES (?, ?, NULL, ?, ?, ?, 'alta', 'manual', 1, ?)");
  await ins.run(caseId, 'Vitamina D', '35', 'ng/mL', '2026-10-15', 0);
  await ins.run(caseId, 'Glicose', '92', 'mg/dL', '2026-10-15', 0);
  await ins.run(caseId, 'Glicose', '300', 'mg/dL', '2026-12-31', 1); // excluída: não conta na data
  const c = await loadCase(caseId);
  assert.ok(c);
  const score = computeScore(evaluateAll(toInputs((await loadResults(caseId)).filter((r) => !r.excluded)), await allRules(), profileOf(c)));
  assert.deepEqual(scoreCounts(score), { totalCount: 2, alteredCount: 1 });
  const mk = (finalized: boolean) => getAsyncDb().prepare(`INSERT INTO analyses(case_id, markdown, markdown_patient, table_version, ai_used, score, score_json, final_patient, finalized_at, created_at) VALUES (?, 'x', 'x', ?, 0, ?, ?, ${finalized ? "'x', datetime('now')" : 'NULL, NULL'}, ?)`);
  const finalId = Number((await (await mk(true)).run(caseId, await tableVersion(), score.total, JSON.stringify(score), '2026-10-16 10:00:00')).lastInsertRowid);
  const draftId = Number((await (await mk(false)).run(caseId, await tableVersion(), score.total, '{}', '2026-10-17 10:00:00')).lastInsertRowid);

  // Outro paciente não aparece.
  await post('/api/integration/cases', { patientCode: OTHER });

  const r = await get(`/api/integration/patients/${PATIENT}/overview`);
  assert.equal(r.statusCode, 200);
  const o = r.json().data as IntegrationPatientOverview;
  assert.equal(o.cases.length, 1);
  assert.equal(o.lastAnalysisId, draftId);
  assert.deepEqual(o.cases[0]?.analyses, [
    { id: draftId, examDate: '2026-10-15', status: 'minuta', reviewed: false, totalCount: 0, alteredCount: 0, url: `/casos/${caseId}/analises/${draftId}` },
    { id: finalId, examDate: '2026-10-15', status: 'finalizada', reviewed: true, totalCount: 2, alteredCount: 1, url: `/casos/${caseId}/analises/${finalId}` },
  ]);
  // Nada de valor clínico bruto na resposta.
  for (const forbidden of ['"value', 'markdown', 'ng/mL', 'Vitamina', 'Glicose', '"35"', 'patient_name']) assert.ok(!r.body.includes(forbidden), forbidden);

  const audit = (await getAsyncDb().prepare("SELECT details FROM audit_log WHERE action = 'integ_patient_overview' ORDER BY id DESC LIMIT 1").get()) as { details: string };
  assert.deepEqual(JSON.parse(audit.details), { client: 'app', patient_code: PATIENT, cases: 1 });
});

test('overview: caso excluído some; markers traz status normal/alterado por ponto', async () => {
  const series = (await get(`/api/integration/patients/${PATIENT}/markers?exams=vitamina_d_25oh,glicose_jejum`)).json().data as IntegrationMarkerSeries[];
  const vitD = series.find((s) => s.exam === 'vitamina_d_25oh');
  const glic = series.find((s) => s.exam === 'glicose_jejum');
  assert.equal(vitD?.points[0]?.status, 'alterado', 'fora do ótimo');
  assert.equal(glic?.points[0]?.status, 'normal');
  assert.deepEqual(Object.keys(vitD?.points[0] ?? {}).sort(), ['analysisId', 'caseId', 'classification', 'date', 'status', 'value']);

  await getAsyncDb().prepare("UPDATE cases SET deleted_at = datetime('now') WHERE patient_code = ?").run(PATIENT);
  const o = (await get(`/api/integration/patients/${PATIENT}/overview`)).json().data as IntegrationPatientOverview;
  assert.deepEqual(o.cases, []);
  assert.equal(o.lastAnalysisId, null);
  assert.equal(o.consentStatus, 'assinado', 'o cadastro pseudônimo continua');
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nutrolab-integ-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_EMAIL = 'medico@teste.local';
process.env.ADMIN_NAME = 'Médica Teste';
process.env.ADMIN_PASSWORD = 'senha-de-teste-123';
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://nutrolab.teste.local/';
// Host público exigido pelas telas; a API de integração chega com outro host (rede interna do Docker).
process.env.ALLOWED_HOSTS = 'nutrolab.teste.local';
process.env.INTEGRATION_RATE_LIMIT = '45';
delete process.env.INTEGRATION_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const TOKEN = 'token-de-teste-para-integracao-0123456789abcdef';
const { buildApp } = await import('../src/app.js');
const { getAsyncDb, allRules, tableVersion } = await import('../src/db.js');
const { evaluateAll, computeScore } = await import('../src/engine/index.js');
const { buildPatientReport, buildTechnicalReport } = await import('../src/report.js');
const { loadCase, loadResults, profileOf, toInputs } = await import('../src/routes/cases.routes.js');
const { highlightsOf, redactPatientName, sentencesOf, systemStatus, tokenMatches } = await import('../src/integration.js');
import type { ReportInput } from '../src/report.js';
import type { IntegrationAnalysis, IntegrationCase, IntegrationMarkerSeries } from '../src/integration.js';

type App = Awaited<ReturnType<typeof buildApp>>;
const INTERNAL = { host: 'nutrolab:8090' };
let app: App;
const PATIENT = '3f2b1c4e-9d8a-4b7c-8e1f-123456789abc';
let caseId = 0;
let analysisId = 0;

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { ...INTERNAL, 'x-integration-token': TOKEN, ...headers } });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, headers: { ...INTERNAL, 'x-integration-token': TOKEN, 'content-type': 'application/json', ...headers }, payload: JSON.stringify(payload) });

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('sem INTEGRATION_TOKEN no ambiente todas as rotas respondem 404 em JSON', async () => {
  // O hook `before` já configurou o token para o app principal; este app nasce sem ele.
  const saved = process.env.INTEGRATION_TOKEN;
  delete process.env.INTEGRATION_TOKEN;
  const off = await buildApp();
  process.env.INTEGRATION_TOKEN = saved;
  await off.ready();
  for (const url of ['/api/integration/health', '/api/integration/cases/1', '/api/integration/inexistente']) {
    const r = await off.inject({ method: 'GET', url, headers: { ...INTERNAL, 'x-integration-token': TOKEN } });
    assert.equal(r.statusCode, 404, url);
    assert.equal(r.json().error.code, 'NOT_FOUND');
  }
  await off.close();
});

before(async () => {
  process.env.INTEGRATION_TOKEN = TOKEN;
  app = await buildApp();
  await app.ready();
});
after(async () => {
  await app.close();
});

test('token ausente ou errado → 401; comparação é por hash e não vaza tamanho', async () => {
  const none = await app.inject({ method: 'GET', url: '/api/integration/health', headers: INTERNAL });
  assert.equal(none.statusCode, 401);
  assert.deepEqual(Object.keys(none.json()), ['error']);
  assert.equal(none.json().error.code, 'UNAUTHORIZED');
  const wrong = await get('/api/integration/health', { 'x-integration-token': 'errado' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches(`${TOKEN}x`, TOKEN), false);
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
});

test('health com token e isenção de ALLOWED_HOSTS só para /api/integration/*', async () => {
  const h = await get('/api/integration/health');
  assert.equal(h.statusCode, 200);
  assert.equal(h.json().data.ok, true);
  assert.equal(h.json().data.app, 'nutrolab');
  assert.match(h.json().data.version, /^\d+\.\d+\.\d+$/);
  // mesmo host interno, fora do prefixo: a checagem de host continua valendo
  const blocked = await app.inject({ method: 'GET', url: '/casos', headers: INTERNAL });
  assert.equal(blocked.statusCode, 421);
  const login = await app.inject({ method: 'GET', url: '/login', headers: { host: 'nutrolab.teste.local' } });
  assert.equal(login.statusCode, 200);
});

test('POST /cases valida, cria caso aberto sem autor e com nota prefixada; GET por patient_code', async () => {
  const bad = await post('/api/integration/cases', { patientCode: PATIENT, sex: 'X' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'VALIDATION');
  const badDate = await post('/api/integration/cases', { patientCode: PATIENT, birthDate: '10/03/1985' });
  assert.equal(badDate.statusCode, 400);
  assert.match(badDate.json().error.message, /birthDate/);
  const malformed = await app.inject({ method: 'POST', url: '/api/integration/cases', headers: { ...INTERNAL, 'x-integration-token': TOKEN, 'content-type': 'application/json' }, payload: '{nao é json' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, 'BAD_REQUEST');

  const created = await post('/api/integration/cases', { patientCode: PATIENT, sex: 'F', birthDate: '1985-03-10', goal: 'Emagrecimento', contexts: ['jejum', 'pre_menopausa', 'invalido'], comorbidities: 'Hipotireoidismo', medications: 'Levotiroxina', supplements: 'Vitamina D', notes: 'Retorno em 90 dias.' });
  assert.equal(created.statusCode, 201);
  caseId = created.json().data.id;
  assert.ok(caseId > 0);
  assert.equal(created.json().data.url, `https://nutrolab.teste.local/casos/${caseId}`);
  const row = await loadCase(caseId);
  assert.ok(row);
  assert.equal(row.status, 'aberto');
  assert.match(row.notes, /^Criado pelo LN Evolution em \d{2}\/\d{2}\/\d{4}\.\nRetorno em 90 dias\.$/);
  assert.deepEqual(row.contexts.sort(), ['jejum', 'pre_menopausa']);
  const createdBy = (await getAsyncDb().prepare('SELECT created_by FROM cases WHERE id = ?').get(caseId)) as { created_by: number | null };
  assert.equal(createdBy.created_by, null);

  const list = await get(`/api/integration/patients/${PATIENT}/cases`);
  assert.equal(list.statusCode, 200);
  const cases = list.json().data as IntegrationCase[];
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.patientCode, PATIENT);
  assert.equal(cases[0]?.sex, 'F');
  assert.equal(cases[0]?.birthDate, '1985-03-10');
  assert.equal(cases[0]?.latestAnalysis, null);
  assert.equal(cases[0]?.resultsCount, 0);
  assert.match(cases[0]?.createdAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal((await get('/api/integration/patients/outro-paciente/cases')).json().data.length, 0);
  assert.equal((await get('/api/integration/cases/999')).statusCode, 404);
});

test('GET /analyses/:id: score, scoreBySystem, markers, highlights e relatórios sem nome do paciente', async () => {
  // Regras ativas de verdade (o catálogo nasce em rascunho). Vitamina D com ótimo e crítico; glicose só com normalidade.
  (await getAsyncDb().prepare("UPDATE rules SET target_min = 40, target_max = 80, normal_min = 30, normal_max = 100, critical_low = 10, critical_high = 150, clinical_source = 'Decisão da médica em 2026-10-28', status = 'ativo' WHERE exam_canonical = 'vitamina_d_25oh'").run());
  (await getAsyncDb().prepare("UPDATE rules SET clinical_source = 'Decisão da médica em 2026-10-28', status = 'ativo' WHERE exam_canonical = 'glicose_jejum'").run());
  (await getAsyncDb().prepare("UPDATE rules SET clinical_source = 'Decisão da médica em 2026-10-28', status = 'ativo' WHERE exam_canonical = 'ferritina'").run());
  // Nome existe na tabela (coluna patient_name) e NÃO pode aparecer em nenhuma resposta.
  (await getAsyncDb().prepare('UPDATE cases SET patient_name = ? WHERE id = ?').run('Maria Exemplo da Silva', caseId));
  const insert = (await getAsyncDb().prepare("INSERT INTO results(case_id, exam_raw, exam_canonical, value_raw, unit_raw, lab_reference, lab_flag, collection_date, source_file, confidence, origin, checked, excluded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exames.pdf', ?, 'manual', 1, ?)"));
  // Nome fora dos aliases: vinculado ao canônico na conferência (coluna exam_canonical), como faz a tela.
  await insert.run(caseId, '25-Hidroxi Vitamina D', 'vitamina_d_25oh', '35', 'ng/mL', '30 a 100', 'L', '2026-10-15', 'alta', 0);
  await insert.run(caseId, 'Glicose', null, '92', 'mg/dL', '70 a 99', null, '2026-10-15', 'alta', 0);
  await insert.run(caseId, 'Ferritina', null, '1.250', 'ng/mL', null, null, '2026-10-15', 'media', 0);
  await insert.run(caseId, 'HBsAg', null, 'Não reagente', null, null, null, '2026-10-15', 'alta', 0);
  await insert.run(caseId, 'Exame excluído', null, '1', 'mg/dL', null, null, '2026-10-15', 'baixa', 1);

  // Análise montada pelo motor e pelos geradores de relatório, como faz /casos/:id/analisar.
  const c = await loadCase(caseId);
  assert.ok(c);
  const results = (await loadResults(caseId)).filter((r) => !r.excluded);
  const profile = profileOf(c);
  const evals = evaluateAll(toInputs(results), (await allRules()), profile);
  const score = computeScore(evals);
  assert.equal(score.total, 80); // vitamina D fora do ótimo e dentro do normal (0,6) + glicose normal (1) → 80
  const base: ReportInput = { caseInfo: { id: c.id, patient_code: c.patient_code, patient_name: c.patient_name, sex: 'F', birth_date: c.birth_date, medications: c.medications, supplements: c.supplements, comorbidities: c.comorbidities, goal: c.goal, complaints: [], menopause: '', ai_notes: '', files: ['exames.pdf'] }, profile, evals, derived: [], derivedEvals: [], guidances: [], score, tableVersion: (await tableVersion()), narrative: null, aiModel: null, generatedAt: '15/11/2026 10:00:00' };
  const draftPatient = buildPatientReport(base);
  const draftTechnical = buildTechnicalReport(base);
  const info = (await getAsyncDb().prepare('INSERT INTO analyses(case_id, markdown, markdown_patient, markdown_technical, table_version, ai_used, score, score_json, created_by) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL)').run(caseId, draftTechnical, draftPatient, draftTechnical, base.tableVersion, score.total, JSON.stringify(score)));
  analysisId = Number(info.lastInsertRowid);

  // Minuta (não finalizada): relatórios null, destaques vêm do markdown_patient.
  const draft = await get(`/api/integration/analyses/${analysisId}`);
  assert.equal(draft.statusCode, 200);
  const d = draft.json().data as IntegrationAnalysis;
  assert.equal(d.finalizedAt, null);
  assert.equal(d.patientReportMarkdown, null);
  assert.equal(d.technicalReportMarkdown, null);
  assert.ok(d.highlights.favorable.length >= 1);
  assert.match(d.highlights.favorable[0] ?? '', /dentro do que consideramos ideal/);

  // Finalização com conduta aprovada (2 aprovadas, 1 rejeitada).
  const conduct = (await getAsyncDb().prepare("INSERT INTO conduct_items(case_id, analysis_id, kind, title, rationale, origin, status, position) VALUES (?, ?, 'seguimento', ?, 'x', 'medico', ?, 0)"));
  await conduct.run(caseId, analysisId, 'Repetir vitamina D em 3 meses', 'aprovada');
  await conduct.run(caseId, analysisId, 'Conferir ferritina em laudo legível', 'aprovada');
  await conduct.run(caseId, analysisId, 'Item descartado', 'rejeitada');
  const finalInput: ReportInput = { ...base, conduct: [{ kind: 'seguimento', title: 'Repetir vitamina D em 3 meses', rationale: 'x', exams: [], sources: [], origin: 'medico' }], authorName: 'Médica Teste' };
  (await getAsyncDb().prepare("UPDATE analyses SET final_patient = ?, final_technical = ?, finalized_at = datetime('now') WHERE id = ?").run(buildPatientReport(finalInput), buildTechnicalReport(finalInput), analysisId));

  const r = await get(`/api/integration/analyses/${analysisId}`);
  assert.equal(r.statusCode, 200);
  const a = r.json().data as IntegrationAnalysis;
  assert.equal(a.id, analysisId);
  assert.equal(a.caseId, caseId);
  assert.equal(a.patientCode, PATIENT);
  assert.equal(a.score, 80);
  assert.equal(a.aiUsed, false);
  assert.match(a.finalizedAt ?? '', /T.*Z$/);
  assert.equal(a.url, `https://nutrolab.teste.local/casos/${caseId}/analises/${analysisId}`);
  assert.equal(a.approvedConductCount, 2);

  const bySystem = new Map(a.scoreBySystem.map((s) => [s.system, s]));
  assert.deepEqual(bySystem.get('vitaminas'), { system: 'vitaminas', label: 'Vitaminas', score: 60, status: 'atencao' });
  assert.deepEqual(bySystem.get('metabolico'), { system: 'metabolico', label: 'Metabolismo glicídico', score: 100, status: 'otimo' });
  assert.equal(bySystem.get('ferro')?.status, 'sem_dados', 'ferritina não pontuou (valor ambíguo) → sistema presente sem dados');
  assert.equal(bySystem.get('ferro')?.score, null);
  assert.equal(bySystem.get('outros')?.status, 'sem_dados');
  assert.equal(a.scoreBySystem.map((s) => s.label).join(','), [...a.scoreBySystem.map((s) => s.label)].sort((x, y) => x.localeCompare(y, 'pt-BR')).join(','));

  assert.equal(a.markers.length, 4, 'um marcador por linha de results não excluída');
  const vitD = a.markers.find((m) => m.exam === 'vitamina_d_25oh');
  assert.deepEqual(vitD, { exam: 'vitamina_d_25oh', label: '25-hidroxivitamina D', system: 'vitaminas', value: 35, valueRaw: '35', unit: 'ng/mL', collectionDate: '2026-10-15', classification: 'abaixo_do_alvo', labFlag: 'L', confidence: 'alta' });
  const gli = a.markers.find((m) => m.exam === 'glicose_jejum');
  assert.equal(gli?.classification, 'dentro_do_alvo');
  assert.equal(gli?.label, 'Glicose');
  const fer = a.markers.find((m) => m.exam === 'ferritina');
  assert.equal(fer?.value, null, '"1.250" é ambíguo para o motor: sem valor numérico');
  assert.equal(fer?.classification, 'nao_comparavel');
  assert.equal(fer?.confidence, 'media');
  const hbs = a.markers.find((m) => m.exam === 'hbsag');
  assert.equal(hbs?.system, 'outros');
  assert.equal(hbs?.value, null);
  assert.equal(hbs?.classification, 'sem_alvo');

  assert.ok(a.highlights.favorable.length >= 1 && a.highlights.favorable.length <= 6);
  assert.ok(a.highlights.attention.length >= 1 && a.highlights.attention.length <= 6);
  for (const s of [...a.highlights.favorable, ...a.highlights.attention]) assert.ok(s.length <= 160 && !s.includes('**'), s);
  assert.match(a.highlights.attention.join(' '), /fora do que consideramos ideal/);

  assert.match(a.patientReportMarkdown ?? '', /^# Relatório dos seus exames/m);
  assert.match(a.patientReportMarkdown ?? '', /Repetir vitamina D em 3 meses/);
  assert.match(a.technicalReportMarkdown ?? '', /Conduta aprovada pelo médico/);
  assert.match(a.technicalReportMarkdown ?? '', new RegExp(`- Paciente: código ${PATIENT}`));

  // Nenhum campo identificador: nem no DTO, nem dentro dos relatórios.
  const body = r.body;
  assert.doesNotMatch(body, /Maria/);
  assert.doesNotMatch(body, /patient_name|patientName|cpf/i);
  assert.doesNotMatch(body, /medico@teste\.local/);
  const caseBody = (await get(`/api/integration/cases/${caseId}`)).body;
  assert.doesNotMatch(caseBody, /Maria|patient_name|patientName/);
  const detail = JSON.parse(caseBody).data as IntegrationCase & { analyses: unknown[] };
  assert.equal(detail.resultsCount, 4);
  assert.equal(detail.latestAnalysis?.id, analysisId);
  assert.equal(detail.analyses.length, 1);
  assert.equal(detail.status, 'aberto');
});

test('GET /patients/:code/markers: séries cronológicas só de análises finalizadas, dedup por data', async () => {
  // Segundo caso do mesmo paciente, coleta anterior, com análise finalizada e outra em minuta.
  const second = await post('/api/integration/cases', { patientCode: PATIENT, sex: 'F', birthDate: '1985-03-10' });
  const case2 = second.json().data.id as number;
  const ins = (await getAsyncDb().prepare("INSERT INTO results(case_id, exam_raw, exam_canonical, value_raw, unit_raw, collection_date, confidence, origin, checked, excluded) VALUES (?, ?, NULL, ?, ?, ?, 'alta', 'manual', 1, 0)"));
  await ins.run(case2, 'Vitamina D', '18', 'ng/mL', '2026-04-02');
  await ins.run(case2, 'Glicose', '101', 'mg/dL', '2026-04-02');
  const c2 = await loadCase(case2);
  assert.ok(c2);
  const evals2 = evaluateAll(toInputs(await loadResults(case2)), (await allRules()), profileOf(c2));
  const score2 = computeScore(evals2);
  const mk = async (final: boolean) => (await getAsyncDb().prepare(`INSERT INTO analyses(case_id, markdown, markdown_patient, table_version, ai_used, score, score_json, final_patient, finalized_at) VALUES (?, 'x', 'x', ?, 0, ?, ?, ${final ? "'x', datetime('now')" : 'NULL, NULL'})`).run(case2, (await tableVersion()), score2.total, JSON.stringify(score2)));
  const finalized2 = Number((await mk(true)).lastInsertRowid);
  await mk(false);
  // Terceiro caso só com minuta: não entra nas séries.
  const third = await post('/api/integration/cases', { patientCode: PATIENT });
  const case3 = third.json().data.id as number;
  await ins.run(case3, 'Vitamina D', '70', 'ng/mL', '2026-11-01');
  (await getAsyncDb().prepare("INSERT INTO analyses(case_id, markdown, table_version, ai_used, score_json) VALUES (?, 'x', ?, 0, '{}')").run(case3, (await tableVersion())));

  const all = await get(`/api/integration/patients/${PATIENT}/markers`);
  assert.equal(all.statusCode, 200);
  const series = all.json().data as IntegrationMarkerSeries[];
  assert.deepEqual(series.map((s) => s.exam).sort(), ['glicose_jejum', 'vitamina_d_25oh'], 'sem exams: só marcadores com ≥ 2 pontos (ferritina e HBsAg ficam de fora)');
  const vitD = series.find((s) => s.exam === 'vitamina_d_25oh');
  assert.equal(vitD?.label, '25-hidroxivitamina D');
  assert.equal(vitD?.unit, 'ng/mL');
  assert.equal(vitD?.system, 'vitaminas');
  assert.deepEqual(vitD?.points, [
    { date: '2026-04-02', value: 18, classification: 'abaixo_do_alvo', analysisId: finalized2, caseId: case2 },
    { date: '2026-10-15', value: 35, classification: 'abaixo_do_alvo', analysisId, caseId },
  ]);
  const gli = series.find((s) => s.exam === 'glicose_jejum');
  assert.equal(gli?.points[0]?.classification, 'acima_do_alvo');
  assert.equal(gli?.points[1]?.value, 92);

  const filtered = await get(`/api/integration/patients/${PATIENT}/markers?exams=hbsag,glicose_jejum,inexistente&limit=1`);
  const f = filtered.json().data as IntegrationMarkerSeries[];
  assert.equal(f.length, 1, 'limit aplicado');
  assert.equal(f[0]?.exam, 'glicose_jejum', 'com exams, série de 1 ponto (hbsag) não tem valor numérico; glicose vem primeiro por ter mais pontos');
  assert.equal((await get(`/api/integration/patients/${PATIENT}/markers?limit=0`)).statusCode, 400);
  assert.equal((await get('/api/integration/patients/ninguem/markers')).json().data.length, 0);
  assert.doesNotMatch(all.body, /Maria/);

  const cases = (await get(`/api/integration/patients/${PATIENT}/cases`)).json().data as IntegrationCase[];
  assert.equal(cases.length, 3);
  assert.equal(cases[0]?.id, case3, 'ordem decrescente por updatedAt');
});

test('v2 POST /cases/:id/files: aceita PDF/imagem pelo mesmo pipeline e recusa outros formatos', async () => {
  const boundary = '----integ';
  const mp = (name: string, type: string, data: Buffer) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const send = (body: Buffer) => app.inject({ method: 'POST', url: `/api/integration/cases/${caseId}/files`, headers: { ...INTERNAL, 'x-integration-token': TOKEN, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  const ok = await send(mp('laudo.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n% laudo de teste\n')));
  assert.equal(ok.statusCode, 201);
  const fileId = ok.json().data.fileId as number;
  assert.ok(fileId > 0);
  const row = (await getAsyncDb().prepare('SELECT case_id, mime, original_name FROM case_files WHERE id = ?').get(fileId)) as { case_id: number; mime: string; original_name: string };
  assert.equal(row.case_id, caseId);
  assert.equal(row.mime, 'application/pdf');
  assert.equal(row.original_name, 'laudo.pdf');
  const bad = await send(mp('nota.txt', 'text/plain', Buffer.from('texto qualquer que não é laudo')));
  assert.equal(bad.statusCode, 415);
  assert.equal(bad.json().error.code, 'UNSUPPORTED_FILE');
  const json = await post(`/api/integration/cases/${caseId}/files`, {});
  assert.equal(json.statusCode, 400);
  const missing = await app.inject({ method: 'POST', url: '/api/integration/cases/999999/files', headers: { ...INTERNAL, 'x-integration-token': TOKEN, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: mp('laudo.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n')) });
  assert.equal(missing.statusCode, 404);
});

test('v2 GET /analyses/:id/export: md e html só quando finalizada, sem o nome do paciente', async () => {
  const md = await get(`/api/integration/analyses/${analysisId}/export?format=md&type=tecnico`);
  assert.equal(md.statusCode, 200);
  assert.match(md.headers['content-type'] ?? '', /text\/markdown/);
  assert.match(md.body, /Relatório técnico de exames/);
  assert.doesNotMatch(md.body, /Maria/);
  const html = await get(`/api/integration/analyses/${analysisId}/export?format=html`);
  assert.equal(html.statusCode, 200);
  assert.match(html.headers['content-type'] ?? '', /text\/html/);
  assert.match(html.body, /Relatório dos seus exames/);
  assert.match(html.body, /Imprimir \/ salvar em PDF/);
  assert.doesNotMatch(html.body, /Maria/);
  assert.equal((await get(`/api/integration/analyses/${analysisId}/export?format=pdf`)).statusCode, 400);
  // minuta: 409
  const draftId = Number((await getAsyncDb().prepare("INSERT INTO analyses(case_id, markdown, markdown_patient, markdown_technical, table_version, ai_used) VALUES (?, 'x', 'x', 'x', 'v', 0)").run(caseId)).lastInsertRowid);
  const draft = await get(`/api/integration/analyses/${draftId}/export?format=md`);
  assert.equal(draft.statusCode, 409);
  assert.equal(draft.json().error.code, 'NOT_FINALIZED');
  (await getAsyncDb().prepare('DELETE FROM analyses WHERE id = ?').run(draftId));
});

test('v2 POST /cases liga o caso ao paciente canônico pelo code (uuid do clinica-api)', async () => {
  const p = (await getAsyncDb().prepare('SELECT id FROM patients WHERE code = ?').get(PATIENT)) as { id: number } | undefined;
  assert.ok(p);
  const c = (await getAsyncDb().prepare('SELECT patient_id FROM cases WHERE id = ?').get(caseId)) as { patient_id: number };
  assert.equal(c.patient_id, p.id);
});

test('id numérico inválido → 404 no envelope da API; o token continua sendo exigido antes', async () => {
  for (const url of ['/api/integration/cases/undefined', '/api/integration/analyses/NaN', '/api/integration/analyses/0/export', '/api/integration/analyses/abc/export']) {
    const r = await get(url);
    if (r.statusCode === 404 && r.json().error?.code === 'NOT_FOUND') continue;
    assert.fail(`${url}: ${r.statusCode} ${r.body}`);
  }
  const anon = await app.inject({ method: 'GET', url: '/api/integration/cases/undefined', headers: INTERNAL });
  assert.equal(anon.statusCode, 401);
  assert.equal((await get(`/api/integration/cases/${caseId}`)).statusCode, 200, 'id válido continua funcionando');
});

test('v2.1 GET /patients/:code/summary-for-report: só a análise finalizada mais recente, sem markdown e sem nome', async () => {
  const r = await get(`/api/integration/patients/${PATIENT}/summary-for-report`);
  assert.equal(r.statusCode, 200);
  const s = r.json().data as Record<string, unknown> & { highlights: { favorable: string[]; attention: string[] } };
  assert.deepEqual(Object.keys(s).sort(), ['analysisId', 'caseId', 'collectionDate', 'finalizedAt', 'highlights', 'patientCode', 'score', 'status']);
  assert.equal(s.patientCode, PATIENT);
  // Esperado: a FINALIZADA mais recente do paciente (o teste de séries criou outra, mais nova, e um rascunho depois dela).
  const expected = (await getAsyncDb().prepare("SELECT a.id, a.case_id, a.score FROM analyses a JOIN cases c ON c.id = a.case_id WHERE c.patient_code = ? AND c.deleted_at IS NULL AND a.finalized_at IS NOT NULL ORDER BY a.finalized_at DESC, a.id DESC LIMIT 1").get(PATIENT)) as { id: number; case_id: number; score: number | null };
  const newestAny = (await getAsyncDb().prepare('SELECT MAX(a.id) AS m FROM analyses a JOIN cases c ON c.id = a.case_id WHERE c.patient_code = ? AND c.deleted_at IS NULL').get(PATIENT)) as { m: number };
  assert.ok(newestAny.m > expected.id, 'há rascunho mais novo que a finalizada: o resumo não pode usá-lo');
  assert.equal(s.analysisId, expected.id);
  assert.equal(s.caseId, expected.case_id);
  assert.equal(s.score, expected.score);
  assert.match(String(s.finalizedAt), /T.*Z$/);
  assert.match(String(s.collectionDate), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(s.highlights.favorable) && Array.isArray(s.highlights.attention));
  assert.doesNotMatch(r.body, /Maria|Exemplo da Silva|#|\*\*/, 'sem nome do paciente e sem markdown');
  // Destaque que cita o nome do paciente: sai redigido (o PDF do LN não pode carregar o nome).
  const savedFinal = (await getAsyncDb().prepare('SELECT final_patient FROM analyses WHERE id = ?').get(expected.id)) as { final_patient: string | null };
  const savedName = (await getAsyncDb().prepare('SELECT patient_name FROM cases WHERE id = ?').get(expected.case_id)) as { patient_name: string | null };
  await getAsyncDb().prepare('UPDATE cases SET patient_name = ? WHERE id = ?').run('Maria Exemplo da Silva', expected.case_id);
  const pid = (await getAsyncDb().prepare('SELECT patient_id FROM cases WHERE id = ?').get(expected.case_id)) as { patient_id: number };
  const savedRegistry = (await getAsyncDb().prepare('SELECT name FROM patients WHERE id = ?').get(pid.patient_id)) as { name: string };
  await getAsyncDb().prepare('UPDATE patients SET name = ? WHERE id = ?').run('Maria E. Silva', pid.patient_id);
  await getAsyncDb().prepare('UPDATE analyses SET final_patient = ? WHERE id = ?').run('## Pontos favoráveis\n\nMaria Exemplo da Silva, sua glicose está ótima.\n\n## Pontos que merecem atenção\n\nA vitamina D de Maria Exemplo da Silva está baixa.\n', expected.id);
  const named = await get(`/api/integration/patients/${PATIENT}/summary-for-report`);
  const hl = named.json().data.highlights as { favorable: string[]; attention: string[] };
  assert.equal(hl.favorable.length, 1);
  assert.equal(hl.attention.length, 1);
  assert.doesNotMatch(named.body, /Maria|Exemplo da Silva|##/);
  assert.match(hl.favorable[0] ?? '', new RegExp(`^código ${PATIENT}, sua glicose`));
  // nome só no cadastro (o do caso é outro): também redigido
  await getAsyncDb().prepare('UPDATE analyses SET final_patient = ? WHERE id = ?').run('## Pontos favoráveis\n\nMaria E. Silva, tudo certo.\n', expected.id);
  assert.doesNotMatch((await get(`/api/integration/patients/${PATIENT}/summary-for-report`)).body, /Maria/);
  // cadastro com nome = código (paciente criado pela integração): o código não é redigido duas vezes
  await getAsyncDb().prepare('UPDATE patients SET name = ? WHERE id = ?').run(PATIENT, pid.patient_id);
  await getAsyncDb().prepare('UPDATE analyses SET final_patient = ? WHERE id = ?').run('## Pontos favoráveis\n\nMaria Exemplo da Silva, tudo certo.\n', expected.id);
  const once = (await get(`/api/integration/patients/${PATIENT}/summary-for-report`)).json().data.highlights.favorable[0] as string;
  assert.equal(once, `código ${PATIENT}, tudo certo.`);
  await getAsyncDb().prepare('UPDATE analyses SET final_patient = ? WHERE id = ?').run(savedFinal.final_patient, expected.id);
  await getAsyncDb().prepare('UPDATE cases SET patient_name = ? WHERE id = ?').run(savedName.patient_name, expected.case_id);
  await getAsyncDb().prepare('UPDATE patients SET name = ? WHERE id = ?').run(savedRegistry.name, pid.patient_id);

  const none = await get('/api/integration/patients/paciente-sem-analise/summary-for-report');
  assert.equal(none.statusCode, 200);
  assert.equal(none.json().data, null);
  assert.equal((await get('/api/integration/patients/%3Cscript%3E/summary-for-report')).statusCode, 404);
  // os destaques da análise completa (v1) também saem com o nome redigido
  assert.doesNotMatch(JSON.stringify((await get(`/api/integration/analyses/${analysisId}`)).json().data.highlights), /Maria|Exemplo da Silva/);
});

test('v2.1 POST /cases: origem "ln" e lnPatientId guardado; id inválido recusado', async () => {
  const bad = await post('/api/integration/cases', { patientCode: PATIENT, lnPatientId: '../admin' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error.message, /lnPatientId/);
  const created = await post('/api/integration/cases', { patientCode: PATIENT, lnPatientId: '7c1e0b8a-1f2d-4e3a-9b8c-0d1e2f3a4b5c' });
  assert.equal(created.statusCode, 201);
  const row = (await getAsyncDb().prepare('SELECT origin, ln_patient_id FROM cases WHERE id = ?').get(created.json().data.id)) as { origin: string; ln_patient_id: string | null };
  assert.deepEqual({ ...row }, { origin: 'ln', ln_patient_id: '7c1e0b8a-1f2d-4e3a-9b8c-0d1e2f3a4b5c' });
  const old = (await getAsyncDb().prepare('SELECT origin, ln_patient_id FROM cases WHERE id = ?').get(caseId)) as { origin: string; ln_patient_id: string | null };
  assert.deepEqual({ ...old }, { origin: 'ln', ln_patient_id: null }, 'caso criado pela integração sem lnPatientId continua origem ln');
});

test('auditoria registra cada chamada com user_id nulo e ação integ_*', async () => {
  const rows = (await getAsyncDb().prepare("SELECT action, entity, user_id, details, request_id FROM audit_log WHERE action LIKE 'integ_%' ORDER BY id").all()) as Array<{ action: string; entity: string; user_id: number | null; details: string | null; request_id: string | null }>;
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['integ_health', 'integ_patient_cases', 'integ_case', 'integ_create_case', 'integ_analysis', 'integ_patient_markers', 'integ_upload_file', 'integ_export_analysis']) assert.ok(actions.has(a), a);
  assert.ok(rows.every((r) => r.user_id === null && r.request_id));
  const create = rows.find((r) => r.action === 'integ_create_case');
  assert.equal(JSON.parse(create?.details ?? '{}').patient_code, PATIENT);
  assert.ok(rows.every((r) => !(r.details ?? '').includes('Maria')));
});

test('rate limit por token: excedeu o limite por minuto → 429', async () => {
  // Limite injetado por INTEGRATION_RATE_LIMIT=45; as chamadas anteriores já consumiram parte da janela.
  let last = 0;
  for (let i = 0; i < 60; i += 1) {
    last = (await get('/api/integration/health')).statusCode;
    if (last === 429) break;
  }
  assert.equal(last, 429);
  const r = await get('/api/integration/health');
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().error.code, 'RATE_LIMITED');
  // token errado continua 401 (a autenticação vem antes da contagem)
  assert.equal((await get('/api/integration/health', { 'x-integration-token': 'errado' })).statusCode, 401);
});

test('utilitários puros: faixas de status, frases curtas e redação do nome', () => {
  assert.equal(systemStatus(null), 'sem_dados');
  assert.equal(systemStatus(85), 'otimo');
  assert.equal(systemStatus(84), 'adequado');
  assert.equal(systemStatus(70), 'adequado');
  assert.equal(systemStatus(69), 'atencao');
  assert.equal(systemStatus(50), 'atencao');
  assert.equal(systemStatus(49), 'alterado');
  const long = 'A'.repeat(200);
  const s = sentencesOf(`**Primeira** frase. Segunda frase! Terceira? ${long}. Quinta. Sexta. Sétima. Oitava.`);
  assert.equal(s.length, 6);
  assert.equal(s[0], 'Primeira frase.');
  assert.ok((s[3]?.length ?? 0) <= 160 && s[3]?.endsWith('…'));
  const h = highlightsOf('## Pontos favoráveis\n\n- Item um.\n- Item dois.\n\n## Pontos que merecem atenção\n\nAtenção aqui.\n\n## Mensagem final\n\nFim.');
  assert.deepEqual(h, { favorable: ['Item um.', 'Item dois.'], attention: ['Atenção aqui.'] });
  assert.equal(redactPatientName(null, 'Ana', 'X'), null);
  assert.equal(redactPatientName('**Paciente:** Ana Souza · **Coleta:** 2026-10-15\n- Paciente: Ana Souza (código P-1)\nAna Souza voltou.', 'Ana Souza', 'P-1'), '**Coleta:** 2026-10-15\n- Paciente: código P-1\ncódigo P-1 voltou.');
});

test('termo ia_clinica do LN: criação com aceito libera a IA; PATCH revogado fecha na hora; validação e token', async () => {
  // App próprio: o limite por minuto do app principal já foi gasto pelo teste de rate limit.
  const own = await buildApp();
  await own.ready();
  const send = (method: 'POST' | 'PATCH', url: string, body: unknown, headers: Record<string, string> = {}) => own.inject({ method, url, headers: { ...INTERNAL, 'x-integration-token': TOKEN, 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) });
  const code = '9a8b7c6d-1111-4222-8333-444455556666';
  const created = await send('POST', '/api/integration/cases', { patientCode: code, sex: 'F', consentIaClinica: 'aceito', consentVersion: '1.0' });
  assert.equal(created.statusCode, 201);
  const newCase = created.json().data.id as number;
  const consent = async () => (await getAsyncDb().prepare('SELECT consent_status, consent_method, consent_version FROM patients WHERE code = ?').get(code)) as { consent_status: string; consent_method: string; consent_version: string };
  assert.deepEqual({ ...(await consent()) }, { consent_status: 'assinado', consent_method: 'ln:ia_clinica v1.0', consent_version: '1.0' });
  const { aiConsentGiven } = await import('../src/ai.js');
  assert.equal(await aiConsentGiven(newCase), true);

  const patch = (body: unknown, c = code, headers: Record<string, string> = {}) => send('PATCH', `/api/integration/patients/${encodeURIComponent(c)}/consent`, body, headers);
  const revoked = await patch({ consentIaClinica: 'revogado', consentVersion: '1.0' });
  assert.equal(revoked.statusCode, 200);
  assert.deepEqual(revoked.json().data, { patientCode: code, consentStatus: 'revogado' });
  assert.equal((await consent()).consent_status, 'revogado');
  assert.equal(await aiConsentGiven(newCase), false, 'revogação fecha a trava');

  assert.equal((await patch({ consentIaClinica: 'talvez' })).statusCode, 400);
  assert.equal((await patch({})).statusCode, 400);
  assert.equal((await patch({ consentIaClinica: 'aceito' }, 'paciente-que-nao-existe')).statusCode, 404);
  assert.equal((await patch({ consentIaClinica: 'aceito' }, code, { 'x-integration-token': 'errado' })).statusCode, 401);
  assert.equal((await consent()).consent_status, 'revogado', 'recusas não mudam o estado');

  // caso novo sem o campo não mexe no termo já gravado
  assert.equal((await send('POST', '/api/integration/cases', { patientCode: code })).statusCode, 201);
  assert.equal((await consent()).consent_status, 'revogado');
  const audits = (await getAsyncDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'integ_consent'").get()) as { n: number };
  assert.equal(Number(audits.n), 2);
  await own.close();
});

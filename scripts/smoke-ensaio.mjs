// Smoke de ponta a ponta contra um servidor NutroLab REAL (HTTP), com dados fictícios.
// Uso: node scripts/smoke-ensaio.mjs <fase>   fase = "fluxo" (cria e confere) | "persistencia" (após reiniciar)
const BASE = process.env.SMOKE_URL ?? 'http://localhost:8090';
const EMAIL = process.env.ADMIN_EMAIL;
const PASS = process.env.ADMIN_PASSWORD;
const phase = process.argv[2] ?? 'fluxo';
let cookie = '';
const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'ok' : 'FALHOU'} - ${name}${cond || !detail ? '' : ` (${detail})`}`);
};
const H = () => ({ origin: BASE, cookie });
const form = (data) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) (Array.isArray(v) ? v : [v]).forEach((x) => p.append(k, x));
  return p.toString();
};
const get = (url) => fetch(BASE + url, { headers: H(), redirect: 'manual' });
const post = (url, data) => fetch(BASE + url, { method: 'POST', headers: { ...H(), 'content-type': 'application/x-www-form-urlencoded' }, body: form(data), redirect: 'manual' });

const health = await fetch(BASE + '/health');
check('GET /health 200', health.status === 200, String(health.status));
const bad = await post('/login', { email: EMAIL, password: 'senha-errada-xyz' });
check('login com senha errada não entra', bad.status !== 302 || !(bad.headers.get('set-cookie') ?? '').includes('='), String(bad.status));
const login = await post('/login', { email: EMAIL, password: PASS });
cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
check('login do administrador (302 + cookie)', login.status === 302 && cookie.includes('='), String(login.status));
const casos = await get('/casos');
check('GET /casos autenticado 200', casos.status === 200, String(casos.status));

if (phase === 'fluxo') {
  const created = await post('/casos', { patient_code: 'SMOKE-0001', patient_name: 'Paciente Fictício Smoke', sex: 'F', birth_date: '1985-03-10', contexts: ['pre_menopausa', 'jejum'] });
  const loc = created.headers.get('location') ?? '';
  const id = (loc.match(/^\/casos\/(\d+)/) ?? [])[1];
  check('cria caso (302 → /casos/:id)', created.status === 302 && !!id, `${created.status} ${loc}`);
  for (const [exam_raw, value_raw, unit_raw] of [['25-Hidroxi Vitamina D', '8', 'ng/mL'], ['Ferritina', '120', 'ng/mL']]) {
    const r = await post(`/casos/${id}/resultados`, { exam_raw, value_raw, unit_raw, collection_date: '2026-11-18', confidence: 'alta', page: '', source_file: 'smoke.pdf', lab_reference: '', lab_flag: '' });
    check(`lança resultado ${exam_raw}`, r.status === 302, String(r.status));
  }
  const blocked = await post(`/casos/${id}/analisar`, {});
  check('análise bloqueada antes da conferência', /conferencia/.test(blocked.headers.get('location') ?? ''));
  const ok = await post(`/casos/${id}/conferencia`, { action: 'ok_todos', exam_raw_1: '25-Hidroxi Vitamina D', value_raw_1: '8', unit_raw_1: 'ng/mL', include_1: '1', collection_date_1: '2026-11-18', exam_raw_2: 'Ferritina', value_raw_2: '120', unit_raw_2: 'ng/mL', include_2: '1', collection_date_2: '2026-11-18' });
  check('conferência "OK em todos"', ok.status === 302, String(ok.status));
  const analyzed = await post(`/casos/${id}/analisar`, {});
  const aloc = analyzed.headers.get('location') ?? '';
  const aid = (aloc.match(/\/analises\/(\d+)/) ?? [])[1];
  check('gera análise (302 → /analises/:id)', analyzed.status === 302 && !!aid, `${analyzed.status} ${aloc}`);
  const view = await get(`/casos/${id}/analises/${aid}`);
  const vb = await view.text();
  const missing = [['resumido', /Relatório dos seus exames/], ['técnico', /Relatório técnico de exames/], ['score por sistema', /Score por sistema/]].filter(([, re]) => !re.test(vb)).map(([n]) => n);
  check('tela da análise com os dois relatórios e score', view.status === 200 && missing.length === 0, `${view.status} faltando: ${missing.join(', ')}`);
  const dl = await get(`/casos/${id}/analises/${aid}/download?tipo=tecnico`);
  const db = await dl.text();
  check('exporta relatório técnico (.md, sem e-mail do médico)', dl.status === 200 && /\.md/.test(dl.headers.get('content-disposition') ?? '') && !db.includes(EMAIL), String(dl.status));
  const pr = await get(`/casos/${id}/analises/${aid}/imprimir?tipo=resumido`);
  check('versão para impressão do resumido', pr.status === 200 && /<html/i.test(await pr.text()), String(pr.status));
  const csv = await get('/regras/exportar.csv');
  const cb = await csv.text();
  check('exporta regras em CSV', csv.status === 200 && cb.startsWith('exame_canonico,'), String(csv.status));
}

if (phase === 'persistencia') {
  const body = await casos.text();
  check('caso do smoke continua listado após reiniciar', /SMOKE-0001/.test(body));
  const csv = await get('/regras/exportar.csv');
  check('exportação de regras após reiniciar', csv.status === 200, String(csv.status));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`smoke ${phase}: ${results.length - failed}/${results.length} ok`);
process.exit(failed ? 1 : 0);

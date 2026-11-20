import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nutrolab-sso-'));
const SECRET = 'segredo-de-teste-gotrue-com-32-caracteres!!';
process.env.DATA_DIR = tmp;
process.env.ADMIN_EMAIL = 'admin@sso.local';
process.env.ADMIN_PASSWORD = 'senha-admin-sso-1';
process.env.NODE_ENV = 'test';
process.env.GOTRUE_JWT_SECRET = SECRET;
delete process.env.ANTHROPIC_API_KEY;

const { buildApp } = await import('../src/app.js');
const { getAsyncDb } = await import('../src/db.js');
const app = await buildApp();
const H = { host: 'localhost' };

function jwt(claims: Record<string, unknown>, secret = SECRET, alg = 'HS256'): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg, typ: 'JWT' });
  const body = enc(claims);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const now = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({ sub: crypto.randomUUID(), email: 'Medica@LN.local', role: 'authenticated', exp: now() + 600, app_metadata: { role: 'medico' }, user_metadata: { full_name: 'Dra. Médica LN' }, ...over });
const call = (token: string) => app.inject({ method: 'GET', url: '/casos', headers: { ...H, authorization: `Bearer ${token}` } });

before(async () => {
  await app.ready();
});
after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('JWT válido: cria o usuário no primeiro acesso (papel mapeado) e reaproveita depois', async () => {
  const r = await call(jwt(claims()));
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Dra\. Médica LN/);
  const row = (await getAsyncDb().prepare("SELECT email, role, password_hash FROM users WHERE email = 'medica@ln.local'").get()) as { email: string; role: string; password_hash: string };
  assert.equal(row.role, 'medico');
  assert.match(row.password_hash, /^sso:/);
  const again = await call(jwt(claims({ email: 'MEDICA@ln.local' })));
  assert.equal(again.statusCode, 200);
  const n = (await getAsyncDb().prepare("SELECT COUNT(*) AS n FROM users WHERE lower(email) = 'medica@ln.local'").get()) as { n: number };
  assert.equal(n.n, 1);
});

test('nutricionista vira medico; administrador vira admin (acessa configurações)', async () => {
  assert.equal((await call(jwt(claims({ email: 'nutri@ln.local', app_metadata: { role: 'nutricionista' } })))).statusCode, 200);
  const row = (await getAsyncDb().prepare("SELECT role FROM users WHERE email = 'nutri@ln.local'").get()) as { role: string };
  assert.equal(row.role, 'medico');
  const adm = await app.inject({ method: 'GET', url: '/configuracoes', headers: { ...H, authorization: `Bearer ${jwt(claims({ email: 'chefe@ln.local', app_metadata: { role: 'administrador' } }))}` } });
  assert.equal(adm.statusCode, 200);
});

test('expirado, assinatura inválida e algoritmo diferente são recusados com 401', async () => {
  assert.equal((await call(jwt(claims({ exp: now() - 5 })))).statusCode, 401);
  assert.equal((await call(jwt(claims(), 'outro-segredo-qualquer-xxxxxxxxxxxxx'))).statusCode, 401);
  const none = jwt(claims(), SECRET, 'none');
  const r = await call(none);
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error.message, 'algoritmo não aceito');
  assert.equal((await call('nao.e.jwt')).statusCode, 401);
});

test('papel não permitido: 403 e nenhum usuário criado', async () => {
  const r = await call(jwt(claims({ email: 'recepcao@ln.local', app_metadata: { role: 'recepcao' } })));
  assert.equal(r.statusCode, 403);
  const n = (await getAsyncDb().prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'recepcao@ln.local'").get()) as { n: number };
  assert.equal(n.n, 0);
});

test('usuário desativado: 403 mesmo com token válido', async () => {
  (await getAsyncDb().prepare("UPDATE users SET disabled_at = datetime('now') WHERE email = 'nutri@ln.local'").run());
  const r = await call(jwt(claims({ email: 'nutri@ln.local', app_metadata: { role: 'nutricionista' } })));
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error.message, 'usuário desativado');
});

test('sem Bearer o fluxo de cookie segue igual (redireciona ao login)', async () => {
  const r = await app.inject({ method: 'GET', url: '/casos', headers: H });
  assert.equal(r.statusCode, 302);
});

/* ----------------------------------------- senha única: login no GoTrue */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

type FakeMode = 'ok' | 'wrong' | 'down503' | 'badtoken' | 'ratelimit' | 'otheremail' | 'badrole';
let fakeMode: FakeMode = 'ok';
const seen: Array<{ apikey: string | undefined; url: string | undefined; body: string }> = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => { body += c.toString(); });
  req.on('end', () => {
    seen.push({ apikey: req.headers.apikey as string | undefined, url: req.url, body });
    const { email } = JSON.parse(body || '{}') as { email?: string };
    const send = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (fakeMode === 'wrong') return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    if (fakeMode === 'down503') return send(503, { message: 'unavailable' });
    if (fakeMode === 'ratelimit') return send(429, { message: 'rate limit' });
    if (fakeMode === 'badtoken') return send(200, { access_token: jwt(claims({ email }), 'outro-segredo-qualquer-com-32-caracteres') });
    if (fakeMode === 'otheremail') return send(200, { access_token: jwt(claims({ email: 'outra@ln.local' })) });
    if (fakeMode === 'badrole') return send(200, { access_token: jwt(claims({ email, app_metadata: { role: 'recepcao' } })) });
    return send(200, { access_token: jwt(claims({ email, app_metadata: { role: 'administrador' }, user_metadata: { full_name: 'Dr. Senha Única' } })), token_type: 'bearer' });
  });
});
await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
after(() => new Promise<void>((resolve) => fake.close(() => resolve())));

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/login', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ email, password }).toString() });
const withGotrue = async <T>(fn: () => Promise<T>, url = fakeUrl): Promise<T> => {
  process.env.GOTRUE_URL = url;
  process.env.GOTRUE_ANON_KEY = 'anon-publica-de-teste';
  try {
    return await fn();
  } finally {
    delete process.env.GOTRUE_URL;
    delete process.env.GOTRUE_ANON_KEY;
  }
};
const lastLoginAudit = async () => (await getAsyncDb().prepare("SELECT action, details FROM audit_log WHERE action IN ('login', 'login_falhou') ORDER BY id DESC LIMIT 1").get()) as { action: string; details: string };

test('senha única: GoTrue aceita → cookie de sessão, usuário mapeado, apikey enviada e via=gotrue', async () => {
  await withGotrue(async () => {
    fakeMode = 'ok';
    seen.length = 0;
    const r = await login('Unica@LN.local', 'senha-do-gotrue-1');
    assert.equal(r.statusCode, 302);
    assert.match(String(r.headers['set-cookie'] ?? ''), /nl_session=/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.apikey, 'anon-publica-de-teste');
    assert.equal(seen[0]?.url, '/auth/v1/token?grant_type=password');
    assert.deepEqual(JSON.parse(seen[0]?.body ?? '{}'), { email: 'unica@ln.local', password: 'senha-do-gotrue-1' });
    const u = (await getAsyncDb().prepare("SELECT role, name, password_hash FROM users WHERE email = 'unica@ln.local'").get()) as { role: string; name: string; password_hash: string };
    assert.equal(u.role, 'admin');
    assert.equal(u.name, 'Dr. Senha Única');
    assert.match(u.password_hash, /^sso:/, 'senha local inutilizável');
    const a = await lastLoginAudit();
    assert.equal(a.action, 'login');
    assert.equal(JSON.parse(a.details).via, 'gotrue');
    assert.doesNotMatch(a.details, /senha-do-gotrue/);
  });
});

test('senha única: GoTrue recusa a senha → 401 e a senha LOCAL não é tentada', async () => {
  await withGotrue(async () => {
    fakeMode = 'wrong';
    // admin@sso.local tem senha local válida (bootstrap); com o GoTrue recusando, ela não abre a conta.
    const r = await login('admin@sso.local', 'senha-admin-sso-1');
    assert.equal(r.statusCode, 401);
    assert.match(r.body, /E-mail ou senha incorretos/);
    assert.equal(r.headers['set-cookie'], undefined);
    const a = await lastLoginAudit();
    assert.equal(a.action, 'login_falhou');
    assert.equal(JSON.parse(a.details).modo, 'gotrue');
  });
});

test('senha única: GoTrue fora do ar (503 ou sem conexão) → login local, via=local_fallback', async () => {
  await withGotrue(async () => {
    fakeMode = 'down503';
    const r = await login('admin@sso.local', 'senha-admin-sso-1');
    assert.equal(r.statusCode, 302);
    assert.equal(JSON.parse((await lastLoginAudit()).details).via, 'local_fallback');
    const wrongLocal = await login('admin@sso.local', 'senha-errada-local');
    assert.equal(wrongLocal.statusCode, 401, 'no fallback a senha local continua sendo verificada');
  });
  // porta fechada: conexão recusada
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  await withGotrue(async () => {
    const r = await login('admin@sso.local', 'senha-admin-sso-1');
    assert.equal(r.statusCode, 302);
  }, `http://127.0.0.1:${port}`);
});

test('senha única: token inválido, de outro e-mail, papel sem acesso e limite de tentativas são recusados sem cair no local', async () => {
  await withGotrue(async () => {
    for (const [mode, status, text] of [['badtoken', 401, /confirmar o acesso/], ['otheremail', 401, /confirmar o acesso/], ['badrole', 401, /perfil não tem acesso/], ['ratelimit', 429, /Muitas tentativas/]] as const) {
      fakeMode = mode;
      const r = await login('admin@sso.local', 'senha-admin-sso-1');
      assert.equal(r.statusCode, status, mode);
      assert.match(r.body, text, mode);
      assert.equal(r.headers['set-cookie'], undefined, mode);
    }
    const n = (await getAsyncDb().prepare("SELECT COUNT(*) AS n FROM users WHERE email IN ('outra@ln.local')").get()) as { n: number };
    assert.equal(n.n, 0);
  });
});

test('sem GOTRUE_URL/GOTRUE_ANON_KEY o login por e-mail segue local, sem chamar o GoTrue', async () => {
  seen.length = 0;
  const r = await login('admin@sso.local', 'senha-admin-sso-1');
  assert.equal(r.statusCode, 302);
  assert.equal(seen.length, 0);
  assert.equal(JSON.parse((await lastLoginAudit()).details).via, 'local');
});

test('trocar senha e esqueci a senha apontam para a senha central quando o login único está ligado', async () => {
  const page = (url: string) => app.inject({ method: 'GET', url, headers: { ...H, authorization: `Bearer ${jwt(claims())}` } });
  const before = await page('/senha');
  assert.equal(before.statusCode, 200);
  assert.doesNotMatch(before.body, /acesso LN Medicina Integrada/);
  assert.doesNotMatch((await page('/esqueci')).body, /acesso LN Medicina Integrada/);

  process.env.GOTRUE_PUBLIC_APP_URL = 'https://app.ln.test/';
  try {
    await withGotrue(async () => {
      const senha = await page('/senha');
      assert.match(senha.body, /Sua senha é a do acesso LN Medicina Integrada/);
      assert.match(senha.body, /href="https:\/\/app\.ln\.test\/configuracoes"/);
      assert.match(senha.body, /name="current"/, 'a senha local de emergência continua trocável');
      const esqueci = await page('/esqueci');
      assert.match(esqueci.body, /href="https:\/\/app\.ln\.test\/recuperar-senha"/);
      assert.match(esqueci.body, /Senha local de emergência/);
    });
    process.env.GOTRUE_PUBLIC_APP_URL = 'javascript:alert(1)';
    await withGotrue(async () => {
      const esqueci = await page('/esqueci');
      assert.match(esqueci.body, /Sua senha é a do acesso LN Medicina Integrada/);
      assert.doesNotMatch(esqueci.body, /recuperar-senha|javascript:/, 'URL inválida esconde o link');
    });
  } finally {
    delete process.env.GOTRUE_PUBLIC_APP_URL;
  }
});

const APP = 'https://app.ln.test';
const handoff = (fields: Record<string, string>, origin: string | null = APP) =>
  app.inject({ method: 'POST', url: '/sso/callback', headers: { ...H, ...(origin ? { origin } : {}), 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() });
const withApp = async <T>(fn: () => Promise<T>): Promise<T> => {
  process.env.GOTRUE_PUBLIC_APP_URL = APP;
  try {
    return await fn();
  } finally {
    delete process.env.GOTRUE_PUBLIC_APP_URL;
  }
};
const handoffToken = () => jwt(claims({ email: 'handoff@ln.local', app_metadata: { role: 'medico' }, user_metadata: { full_name: 'Dra. Handoff' } }));

test('sso handoff: token válido entra, cookie emitido e destino interno por navegação do próprio NutroLab', async () => {
  await withApp(async () => {
    const token = handoffToken();
    const r = await handoff({ access_token: token, return: '/pacientes' });
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers['set-cookie'] ?? ''), /nl_session=[^;]+;.*SameSite=Strict/i);
    assert.match(r.body, /http-equiv="refresh" content="0;url=\/pacientes"/);
    const a = await lastLoginAudit();
    assert.equal(a.action, 'login');
    assert.equal(JSON.parse(a.details).via, 'sso_handoff');
    const all = (await getAsyncDb().prepare('SELECT details FROM audit_log').all()) as { details: string | null }[];
    assert.ok(all.every((x) => !(x.details ?? '').includes(token.slice(-20))), 'token não vai para a auditoria');
    const cookie = String(r.headers['set-cookie']).split(';')[0] ?? '';
    const casos = await app.inject({ method: 'GET', url: '/casos', headers: { ...H, cookie } });
    assert.equal(casos.statusCode, 200);
    assert.match(casos.body, /Dra\. Handoff/);
  });
});

test('sso handoff: token expirado pede um novo ao broker uma vez; com retry=1 vai ao login', async () => {
  await withApp(async () => {
    const expired = jwt(claims({ email: 'handoff@ln.local', exp: now() - 5 }));
    const first = await handoff({ access_token: expired, return: '/casos' });
    assert.equal(first.statusCode, 302);
    assert.equal(first.headers.location, `${APP}/sso/exames?retry=1`);
    assert.equal(first.headers['set-cookie'], undefined);
    const second = await handoff({ access_token: expired, return: '/casos', retry: '1' });
    assert.equal(second.statusCode, 302);
    assert.match(String(second.headers.location), /^\/login\?sso=falhou/);
    const page = await app.inject({ method: 'GET', url: String(second.headers.location), headers: H });
    assert.match(page.body, /Não deu para entrar direto pelo sistema integrado/);
    assert.equal(JSON.parse((await lastLoginAudit()).details).modo, 'sso_handoff');
  });
});

test('sso handoff: Origin errado ou ausente → 403; papel sem acesso → 403 sem sessão; sem a env → 404', async () => {
  await withApp(async () => {
    assert.equal((await handoff({ access_token: handoffToken() }, 'https://malicioso.test')).statusCode, 403);
    assert.equal((await handoff({ access_token: handoffToken() }, `${APP}:8443`)).statusCode, 403);
    assert.equal((await handoff({ access_token: handoffToken() }, null)).statusCode, 403);
    const badRole = await handoff({ access_token: jwt(claims({ email: 'recepcao@ln.local', app_metadata: { role: 'recepcao' } })) });
    assert.equal(badRole.statusCode, 403);
    assert.equal(badRole.headers['set-cookie'], undefined);
  });
  assert.equal((await handoff({ access_token: handoffToken() })).statusCode, 404);
});

test('sso handoff: return externo é recusado e cai em /casos', async () => {
  await withApp(async () => {
    for (const ret of ['https://malicioso.test/x', '//malicioso.test', '/\\malicioso.test', 'javascript:alert(1)', '/ok\nSet-Cookie: x']) {
      const r = await handoff({ access_token: handoffToken(), return: ret });
      assert.equal(r.statusCode, 200, ret);
      assert.match(r.body, /content="0;url=\/casos"/, ret);
    }
  });
});

test('GET /login?from=app vai ao broker; marca e "Início" apontam para o sistema integrado', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/login?from=app', headers: H })).statusCode, 200, 'sem a env: tela de login');
  await withApp(async () => {
    const r = await app.inject({ method: 'GET', url: '/login?from=app', headers: H });
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.location, `${APP}/sso/exames`);
    const casos = await call(jwt(claims()));
    assert.match(casos.body, new RegExp(`class="brand" href="${APP}"`));
    assert.match(casos.body, /Início · LN Medicina Integrada/);
    assert.match(casos.body, /href="\/casos"/, 'Casos segue no menu');
  });
  const plain = await call(jwt(claims()));
  assert.match(plain.body, /class="brand" href="\/casos"/);
  assert.doesNotMatch(plain.body, /Início · LN Medicina Integrada/);
});

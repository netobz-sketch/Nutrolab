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

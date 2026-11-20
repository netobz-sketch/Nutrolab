import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { bootstrapAdmin, COOKIE_NAME, sessionUser } from './auth.js';
import { userFromBearer } from './sso.js';
import { aiEnabled, AI_MODEL } from './ai.js';
import { closeDbConnection, openDb } from './db.js';
import { authRoutes } from './routes/auth.routes.js';
import { casesRoutes } from './routes/cases.routes.js';
import { configRoutes } from './routes/config.routes.js';
import { patientsRoutes } from './routes/patients.routes.js';
import { integrationRoutes } from './integration.js';
import { invalidIdParam } from './route-ids.js';

const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export async function buildApp(): Promise<ReturnType<typeof Fastify>> {
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
  bodyLimit: 1024 * 1024,
  trustProxy: true,
});

await app.register(cookie);
await app.register(formbody);
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

await openDb();
// Fechar o app fecha a conexão com o banco (testes e desligamento): a conexão do Postgres segura o processo vivo.
app.addHook('onClose', async () => closeDbConnection());
await bootstrapAdmin((msg) => app.log.warn(msg));

app.decorateRequest('user', null);

app.addHook('onRequest', async (request, reply) => {
  const hostname = request.hostname.split(':')[0] ?? '';
  // A API de integração chega pela rede interna do Docker (host nutrolab:8090) e é
  // protegida por token (src/integration.ts); o token substitui a checagem de host.
  const integration = request.url.startsWith('/api/integration/');
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(hostname) && request.url !== '/health' && !integration) {
    return reply.code(421).send('host não permitido');
  }
  if (request.method === 'POST' && request.url.split('?')[0] !== '/sso/callback') {
    const origin = request.headers.origin ?? request.headers.referer;
    if (origin) {
      try {
        if (new URL(origin).hostname !== hostname) return reply.code(403).send('origem inválida');
      } catch {
        return reply.code(403).send('origem inválida');
      }
    } else if (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin' && request.headers['sec-fetch-site'] !== 'none') {
      return reply.code(403).send('origem inválida');
    }
  }
  request.user = await sessionUser(request.cookies[COOKIE_NAME]);
  // SSO GoTrue (dual-accept): Bearer só é considerado quando não há sessão por cookie.
  if (!request.user && !integration && request.headers.authorization) {
    const sso = await userFromBearer(request.headers.authorization);
    if (sso && !sso.ok) {
      request.log.warn({ reason: sso.reason }, 'sso recusado');
      return reply.code(sso.status).type('application/json').send({ error: { code: sso.status === 401 ? 'unauthorized' : 'forbidden', message: sso.reason } });
    }
    if (sso?.ok) request.user = sso.user;
  }
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'");
});

app.get('/health', async () => ({ status: 'ok', ai: aiEnabled() ? AI_MODEL : 'off' }));

// Id numérico inválido na URL → 404 antes de qualquer consulta, pelo handler de 404 de cada contexto
// (HTML nas telas, envelope JSON na API de integração, que já validou o token no onRequest).
app.addHook('preValidation', async (request, reply) => {
  if (invalidIdParam(request.params)) return reply.callNotFound();
});
await app.register(authRoutes);
await app.register(casesRoutes);
await app.register(configRoutes);
await app.register(patientsRoutes);
await app.register(integrationRoutes, { prefix: '/api/integration' });

app.setNotFoundHandler(async (_request, reply) => reply.code(404).type('text/html; charset=utf-8').send('<p>Página não encontrada. <a href="/casos">Voltar</a></p>'));
app.setErrorHandler(async (error: unknown, request, reply) => {
  request.log.error({ err: error }, 'erro não tratado');
  const code = typeof error === 'object' && error !== null && 'statusCode' in error ? (error as { statusCode?: unknown }).statusCode : undefined;
  const status = typeof code === 'number' && code >= 400 ? code : 500;
  return reply.code(status).type('text/html; charset=utf-8').send(`<p>Ocorreu um erro (${status}). Tente novamente; se persistir, avise o administrador. Referência: ${request.id}</p>`);
});

return app;
}

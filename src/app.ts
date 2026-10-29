import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { bootstrapAdmin, COOKIE_NAME, sessionUser } from './auth.js';
import { aiEnabled, AI_MODEL } from './ai.js';
import { openDb } from './db.js';
import { authRoutes } from './routes/auth.routes.js';
import { casesRoutes } from './routes/cases.routes.js';
import { configRoutes } from './routes/config.routes.js';

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

openDb();
bootstrapAdmin((msg) => app.log.warn(msg));

app.decorateRequest('user', null);

app.addHook('onRequest', async (request, reply) => {
  const hostname = request.hostname.split(':')[0] ?? '';
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(hostname) && request.url !== '/health') {
    return reply.code(421).send('host não permitido');
  }
  if (request.method === 'POST') {
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
  request.user = sessionUser(request.cookies[COOKIE_NAME]);
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'");
});

app.get('/health', async () => ({ status: 'ok', ai: aiEnabled() ? AI_MODEL : 'off' }));

await app.register(authRoutes);
await app.register(casesRoutes);
await app.register(configRoutes);

app.setNotFoundHandler(async (_request, reply) => reply.code(404).type('text/html; charset=utf-8').send('<p>Página não encontrada. <a href="/casos">Voltar</a></p>'));
app.setErrorHandler(async (error: unknown, request, reply) => {
  request.log.error({ err: error }, 'erro não tratado');
  const code = typeof error === 'object' && error !== null && 'statusCode' in error ? (error as { statusCode?: unknown }).statusCode : undefined;
  const status = typeof code === 'number' && code >= 400 ? code : 500;
  return reply.code(status).type('text/html; charset=utf-8').send(`<p>Ocorreu um erro (${status}). Tente novamente; se persistir, avise o administrador. Referência: ${request.id}</p>`);
});

return app;
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, COOKIE_NAME, createSessionToken, hashPassword, loginAllowed, loginSucceeded, requireAuth } from '../auth.js';
import { audit, getDb } from '../db.js';
import { layout } from '../views/html.js';
import { loginPage } from '../views/pages.js';

const PasswordBody = z.object({ current: z.string().min(1), password: z.string().min(10, 'nova senha com ao menos 10 caracteres'), confirm: z.string() }).refine((b) => b.password === b.confirm, 'a confirmação não confere');

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1), next: z.string().optional() });

function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/casos';
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/login', async (request, reply) => {
    if (request.user) return reply.redirect('/casos');
    const q = request.query as { next?: string };
    return reply.type('text/html; charset=utf-8').send(layout({ title: 'Entrar', user: null, body: loginPage(null, safeNext(q.next)) }));
  });

  app.post('/login', async (request, reply) => {
    const parsed = LoginBody.safeParse(request.body);
    const render = (msg: string, next = '/casos') => reply.code(401).type('text/html; charset=utf-8').send(layout({ title: 'Entrar', user: null, body: loginPage(msg, next) }));
    if (!parsed.success) return render('Informe e-mail e senha válidos.');
    if (!loginAllowed(request.ip)) return render('Muitas tentativas. Aguarde 15 minutos.');
    const user = authenticate(parsed.data.email, parsed.data.password);
    if (!user) {
      audit(null, 'login_falhou', 'user', parsed.data.email.toLowerCase(), { ip: request.ip }, request.id);
      return render('E-mail ou senha incorretos.', safeNext(parsed.data.next));
    }
    loginSucceeded(request.ip);
    audit(user.id, 'login', 'user', user.id, { ip: request.ip }, request.id);
    reply.setCookie(COOKIE_NAME, createSessionToken(user.id), {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 3600,
    });
    return reply.redirect(safeNext(parsed.data.next));
  });

  const passwordForm = (error: string | null, ok = false) => `<div class="card login"><h1>Alterar senha</h1>${error ? `<div class="flash err">${error}</div>` : ''}${ok ? '<div class="flash ok">Senha alterada.</div>' : ''}
<form method="post" action="/senha"><label>Senha atual</label><input name="current" type="password" autocomplete="current-password" required>
<label>Nova senha (mín. 10)</label><input name="password" type="password" autocomplete="new-password" minlength="10" required>
<label>Confirmar nova senha</label><input name="confirm" type="password" autocomplete="new-password" required>
<p><button class="btn" type="submit">Salvar</button> <a class="btn sec" href="/casos">Voltar</a></p></form></div>`;

  app.get('/senha', { preHandler: requireAuth }, async (request, reply) => reply.type('text/html; charset=utf-8').send(layout({ title: 'Alterar senha', user: request.user, body: passwordForm(null) })));

  app.post('/senha', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.redirect('/login');
    const parsed = PasswordBody.safeParse(request.body);
    const render = (msg: string | null, ok = false) => reply.type('text/html; charset=utf-8').send(layout({ title: 'Alterar senha', user, body: passwordForm(msg, ok) }));
    if (!parsed.success) return render(parsed.error.issues[0]?.message ?? 'Dados inválidos.');
    if (!authenticate(user.email, parsed.data.current)) return render('Senha atual incorreta.');
    getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(parsed.data.password), user.id);
    audit(user.id, 'alterar_senha', 'user', user.id, null, request.id);
    return render(null, true);
  });

  app.post('/logout', async (request, reply) => {
    if (request.user) audit(request.user.id, 'logout', 'user', request.user.id, null, request.id);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.redirect('/login');
  });
}

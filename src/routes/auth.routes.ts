import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, consumeReset, COOKIE_NAME, createResetToken, createSessionToken, findUserByEmail, findUserById, findValidReset, loginAllowed, loginSucceeded, requireAuth, resetAllowed, setPassword } from '../auth.js';
import { audit, getDb, type Row } from '../db.js';
import { appUrl, mailEnabled, sendResetEmail } from '../mail.js';
import { forgotPage, resetPage } from '../views/pages.js';
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
    reply.setCookie(COOKIE_NAME, createSessionToken(user), {
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
    setPassword(user.id, parsed.data.password);
    audit(user.id, 'alterar_senha', 'user', user.id, null, request.id);
    // nova sessão para este aparelho; as outras sessões caem porque a versão da senha mudou
    const fresh = findUserById(user.id);
    if (fresh) reply.setCookie(COOKIE_NAME, createSessionToken(fresh), { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 3600 });
    return render(null, true);
  });

  app.get('/esqueci', async (request, reply) => reply.type('text/html; charset=utf-8').send(layout({ title: 'Esqueci a senha', user: null, body: forgotPage(null, mailEnabled()) })));

  app.post('/esqueci', async (request, reply) => {
    const email = String((request.body as { email?: string } | null)?.email ?? '').trim().toLowerCase();
    const done = 'Se este e-mail estiver cadastrado, você receberá um link válido por 1 hora. Confira também a caixa de spam.';
    if (!mailEnabled()) return reply.type('text/html; charset=utf-8').send(layout({ title: 'Esqueci a senha', user: null, body: forgotPage(null, false) }));
    if (!resetAllowed(request.ip)) return reply.code(429).type('text/html; charset=utf-8').send(layout({ title: 'Esqueci a senha', user: null, body: forgotPage('Muitas tentativas. Aguarde 15 minutos.', true) }));
    const user = email ? findUserByEmail(email) : null;
    if (user) {
      const { token } = createResetToken(user.id, 'email', null);
      try {
        await sendResetEmail(user.email, `${appUrl()}/redefinir/${token}`);
        audit(user.id, 'reset_email', 'user', user.id, { ip: request.ip }, request.id);
      } catch (error) {
        request.log.error({ err: error }, 'falha ao enviar e-mail de redefinição');
      }
    } else {
      audit(null, 'reset_email_desconhecido', 'user', email, { ip: request.ip }, request.id);
    }
    return reply.type('text/html; charset=utf-8').send(layout({ title: 'Esqueci a senha', user: null, body: forgotPage(done, true, true) }));
  });

  app.get('/redefinir/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const reset = findValidReset(token);
    return reply.code(reset ? 200 : 404).type('text/html; charset=utf-8').send(layout({ title: 'Redefinir senha', user: null, body: resetPage(token, reset ? null : 'Link inválido, já usado ou vencido. Peça um novo ao administrador.', !reset) }));
  });

  app.post('/redefinir/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const reset = findValidReset(token);
    const render = (msg: string | null, dead = false, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(layout({ title: 'Redefinir senha', user: null, body: resetPage(token, msg, dead) }));
    if (!reset) return render('Link inválido, já usado ou vencido. Peça um novo ao administrador.', true, 404);
    const body = request.body as { password?: string; confirm?: string } | null;
    const password = body?.password ?? '';
    if (password.length < 10) return render('A nova senha precisa ter ao menos 10 caracteres.');
    if (password !== body?.confirm) return render('A confirmação não confere.');
    const row = getDb().prepare('SELECT email FROM users WHERE id = ? AND disabled_at IS NULL').get(reset.userId) as Row | undefined;
    if (!row) return render('Usuário desativado.', true, 404);
    setPassword(reset.userId, password);
    consumeReset(reset.id);
    audit(reset.userId, 'redefinir_senha', 'user', reset.userId, { ip: request.ip }, request.id);
    const user = findUserById(reset.userId);
    if (user) {
      reply.setCookie(COOKIE_NAME, createSessionToken(user), { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 3600 });
    }
    return reply.redirect('/casos?kind=ok&msg=' + encodeURIComponent('Senha redefinida. Você já está conectado.'));
  });

  app.post('/logout', async (request, reply) => {
    if (request.user) audit(request.user.id, 'logout', 'user', request.user.id, null, request.id);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.redirect('/login');
  });
}

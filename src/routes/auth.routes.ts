import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, authenticateProfessional, consumeReset, updateProfile, COOKIE_NAME, createResetToken, createSessionToken, findUserByEmail, findUserById, findValidReset, loginAllowed, loginSucceeded, requireAuth, resetAllowed, setPassword } from '../auth.js';
import { audit, BRAND_DIR, getAsyncDb, type Row } from '../db.js';
import { gotruePasswordConfigured, gotruePasswordLogin, ssoEnabled, userFromClaims, verifyGotrueJwt } from '../sso.js';
import fs from 'node:fs';
import path from 'node:path';
import { appUrl, mailEnabled, sendResetEmail } from '../mail.js';
import { centralPasswordNotice, forgotPage, profilePage, resetPage } from '../views/pages.js';
import { centralPasswordLinks, integratedAppBase } from '../ln-link.js';
import { normalizeText } from '../engine/index.js';
import { COUNCILS, normalizeCouncilNumber, normalizeCpf, UFS } from '../cpf.js';
import { attr, layout } from '../views/html.js';
import { loginPage } from '../views/pages.js';

const PasswordBody = z.object({ current: z.string().min(1), password: z.string().min(10, 'nova senha com ao menos 10 caracteres'), confirm: z.string() }).refine((b) => b.password === b.confirm, 'a confirmação não confere');

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1), next: z.string().optional() });
const ProLoginBody = z.object({ name: z.string().trim().min(3), cpf: z.string().min(11), council_number: z.string().trim().min(2), password: z.string().min(1), next: z.string().optional() });
const ProfileBody = z.object({
  name: z.string().trim().min(3).max(120),
  email: z.string().trim().email().transform((e) => e.toLowerCase()),
  cpf: z.string().trim().default(''),
  council: z.string().trim().default(''),
  council_number: z.string().trim().max(20).default(''),
  council_state: z.string().trim().default(''),
  profession: z.string().trim().default(''),
});

/** Só caminho interno: começa com uma barra, sem "//", sem barra invertida nem caractere de controle. */
export function safeNext(next: string | undefined): string {
  return typeof next === 'string' && /^\/(?![/\\])[^\\\u0000-\u001f]*$/.test(next) ? next : '/casos';
}


export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Fonte Inter servida localmente (design LN), pública e imutável.
  app.get('/assets/fonts/:file', async (request, reply) => {
    const file = (request.params as { file: string }).file;
    if (!/^[a-z0-9-]+\.woff2$/.test(file)) return reply.code(404).send('não encontrado');
    const full = path.resolve('assets/fonts', file);
    if (!fs.existsSync(full)) return reply.code(404).send('não encontrado');
    return reply.type('font/woff2').header('Cache-Control', 'public, max-age=31536000, immutable').send(fs.readFileSync(full));
  });

  // Logo da clínica: pública (aparece na tela de login).
  app.get('/branding/logo', async (_request, reply) => {
    const f = fs.readdirSync(BRAND_DIR).find((x) => x.startsWith('logo.'));
    if (!f) return reply.code(404).send('sem logo');
    const ext = f.split('.').pop();
    const type = ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/svg+xml';
    return reply.type(type).header('Cache-Control', 'public, max-age=86400').send(fs.readFileSync(path.join(BRAND_DIR, f)));
  });

  app.get('/login', async (request, reply) => {
    if (request.user) return reply.redirect('/casos');
    const q = request.query as { next?: string; modo?: string; from?: string; sso?: string };
    // Vindo do sistema integrado: o broker de lá repassa a sessão por POST em /sso/callback.
    const broker = integratedAppBase();
    if (q.from === 'app' && broker && ssoEnabled()) return reply.redirect(`${broker}/sso/exames`);
    const ssoFailed = q.sso === 'falhou';
    return reply.type('text/html; charset=utf-8').send(layout({ title: 'Entrar', user: null, body: loginPage(ssoFailed ? 'Não deu para entrar direto pelo sistema integrado. Entre com seu e-mail e a senha do acesso LN Medicina Integrada.' : null, safeNext(q.next), ssoFailed || q.modo === 'email' ? 'email' : 'profissional') }));
  });

  app.post('/login', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const mode: 'email' | 'profissional' = body.cpf !== undefined ? 'profissional' : 'email';
    const render = (msg: string, next = '/casos', code = 401) => reply.code(code).type('text/html; charset=utf-8').send(layout({ title: 'Entrar', user: null, body: loginPage(msg, next, mode) }));
    if (!loginAllowed(request.ip)) return render('Muitas tentativas. Aguarde 15 minutos.', '/casos', 429);
    let user = null;
    let who = '';
    let next: string | undefined;
    let via: 'gotrue' | 'local' | 'local_fallback' | 'profissional' = 'profissional';
    if (mode === 'profissional') {
      const parsed = ProLoginBody.safeParse(body);
      if (!parsed.success) return render('Informe nome, CPF, número do conselho e senha.');
      const cpf = normalizeCpf(parsed.data.cpf);
      if (!cpf) return render('CPF inválido.');
      who = cpf;
      next = parsed.data.next;
      user = await authenticateProfessional(cpf, normalizeCouncilNumber(parsed.data.council_number), parsed.data.password);
      if (user && normalizeText(user.name) !== normalizeText(parsed.data.name)) {
        await audit(user.id, 'login_falhou', 'user', user.id, { ip: request.ip, motivo: 'nome não confere' }, request.id);
        user = null;
      }
    } else {
      const parsed = LoginBody.safeParse(body);
      if (!parsed.success) return render('Informe e-mail e senha válidos.');
      who = parsed.data.email.toLowerCase();
      next = parsed.data.next;
      // Senha única: o GoTrue decide. Recusa dele é definitiva; só a indisponibilidade cai na senha local.
      const sso = await gotruePasswordLogin(parsed.data.email, parsed.data.password);
      if (sso.kind === 'ok') {
        user = sso.user;
        via = 'gotrue';
      } else if (sso.kind === 'denied') {
        await audit(null, 'login_falhou', 'user', who, { ip: request.ip, modo: 'gotrue', motivo: sso.reason }, request.id);
        return render(sso.message, safeNext(next), sso.reason.startsWith('limite') ? 429 : 401);
      } else {
        if (gotruePasswordConfigured()) request.log.warn({ motivo: sso.reason }, 'senha única indisponível: login local');
        user = await authenticate(parsed.data.email, parsed.data.password);
        via = gotruePasswordConfigured() ? 'local_fallback' : 'local';
      }
    }
    if (!user) {
      await audit(null, 'login_falhou', 'user', who, { ip: request.ip, modo: mode === 'email' ? via : mode }, request.id);
      return render(mode === 'profissional' ? 'Dados não conferem. Verifique nome, CPF, número do conselho e senha.' : 'E-mail ou senha incorretos.', safeNext(next));
    }
    const parsedNext = next;
    loginSucceeded(request.ip);
    await audit(user.id, 'login', 'user', user.id, { ip: request.ip, modo: mode, via }, request.id);
    reply.setCookie(COOKIE_NAME, createSessionToken(user), {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 3600,
    });
    const incomplete = !user.cpf || !user.council_number;
    return reply.redirect(incomplete && mode === 'email' ? '/perfil?kind=warn&msg=' + encodeURIComponent('Complete seu cadastro profissional (CPF e conselho) para entrar pela tela profissional.') : safeNext(parsedNext));
  });

  /**
   * Passagem de sessão do sistema integrado (contrato: PLANO-LN-MEDICINA-INTEGRADA §9).
   * O financeiro posta access_token + return (+ retry=1 na segunda tentativa) por formulário;
   * validamos o JWT como no Bearer, emitimos o nl_session normal (12 h, sem renovação pelo
   * GoTrue) e seguimos para `return` (só caminho interno). Nenhum token vai para URL, log ou
   * auditoria; refresh_token não é recebido.
   */
  app.post('/sso/callback', async (request, reply) => {
    const broker = integratedAppBase();
    const secret = process.env.GOTRUE_JWT_SECRET?.trim();
    if (!broker || !secret) return reply.code(404).send('não encontrado');
    let originOk = false;
    try {
      originOk = !!request.headers.origin && new URL(request.headers.origin).origin === new URL(broker).origin;
    } catch {
      originOk = false;
    }
    if (!originOk) return reply.code(403).send('origem inválida');
    if (!loginAllowed(request.ip)) return reply.code(429).type('text/html; charset=utf-8').send(layout({ title: 'Entrar', user: null, body: loginPage('Muitas tentativas. Aguarde 15 minutos.', '/casos', 'email') }));
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = typeof body.access_token === 'string' ? body.access_token.trim() : '';
    const target = safeNext(typeof body.return === 'string' ? body.return : undefined);
    const secure = process.env.NODE_ENV === 'production';
    const verified = token ? verifyGotrueJwt(token, secret) : { error: 'sem token' };
    const result = 'error' in verified ? { ok: false as const, status: 401 as const, reason: verified.error } : await userFromClaims(verified.claims);
    if (!result.ok) {
      const who = 'claims' in verified ? (verified.claims.email ?? '').toLowerCase() : '';
      await audit(null, 'login_falhou', 'user', who, { ip: request.ip, modo: 'sso_handoff', motivo: result.reason }, request.id);
      if (result.status === 403) {
        return reply.code(403).type('text/html; charset=utf-8').send(layout({ title: 'Entrar', user: null, body: loginPage('Seu perfil não tem acesso ao NutroLab. Fale com o administrador.', target, 'email') }));
      }
      // Token vencido ou inválido: pede um novo ao broker UMA vez (ele reposta com retry=1);
      // na segunda falha, login normal.
      if (body.retry !== '1') return reply.redirect(`${broker}/sso/exames?retry=1`);
      return reply.redirect('/login?sso=falhou&next=' + encodeURIComponent(target));
    }
    loginSucceeded(request.ip);
    await audit(result.user.id, 'login', 'user', result.user.id, { ip: request.ip, modo: 'email', via: 'sso_handoff' }, request.id);
    reply.setCookie(COOKIE_NAME, createSessionToken(result.user), { path: '/', httpOnly: true, sameSite: 'strict', secure, maxAge: 12 * 3600 });
    // O cookie é SameSite=Strict: um 302 direto, ainda dentro da navegação vinda do financeiro, chegaria
    // sem ele. A página abaixo segue para o destino como navegação do próprio NutroLab.
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${attr(target)}"><title>Entrando…</title></head><body><p><a href="${attr(target)}">Continuar para o NutroLab</a></p></body></html>`);
  });

  app.get('/perfil', { preHandler: requireAuth }, async (request, reply) => {
    const q = request.query as { msg?: string; kind?: string };
    const flash = q.msg ? { kind: (q.kind === 'err' || q.kind === 'warn' ? q.kind : 'ok') as 'ok' | 'err' | 'warn', text: q.msg } : null;
    return reply.type('text/html; charset=utf-8').send(layout({ title: 'Meu cadastro', user: request.user, body: profilePage(request.user, null, COUNCILS, UFS), flash }));
  });

  app.post('/perfil', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.redirect('/login');
    const parsed = ProfileBody.safeParse(request.body);
    const render = (msg: string) => reply.type('text/html; charset=utf-8').send(layout({ title: 'Meu cadastro', user, body: profilePage(user, msg, COUNCILS, UFS) }));
    if (!parsed.success) return render(parsed.error.issues[0]?.message ?? 'Dados inválidos.');
    const d = parsed.data;
    const cpf = d.cpf ? normalizeCpf(d.cpf) : null;
    if (d.cpf && !cpf) return render('CPF inválido.');
    if (d.council && !(d.council in COUNCILS)) return render('Conselho inválido.');
    if (d.council_state && !UFS.includes(d.council_state)) return render('UF inválida.');
    if (d.profession && d.profession !== 'medico' && d.profession !== 'nutricionista') return render('Profissão inválida.');
    const clash = (await getAsyncDb().prepare('SELECT id FROM users WHERE (email = ? OR (cpf IS NOT NULL AND cpf = ?)) AND id != ?').get(d.email, cpf, user.id)) as Row | undefined;
    if (clash) return render('E-mail ou CPF já usado por outro usuário.');
    await updateProfile(user.id, { name: d.name, email: d.email, cpf, council: d.council || null, council_number: d.council_number ? normalizeCouncilNumber(d.council_number) : null, council_state: d.council_state || null, profession: d.profession || null });
    await audit(user.id, 'editar_perfil', 'user', user.id, { cpf: !!cpf, council: d.council, council_number: !!d.council_number }, request.id);
    return reply.redirect('/perfil?kind=ok&msg=' + encodeURIComponent('Cadastro atualizado.'));
  });

  const passwordForm = (error: string | null, ok = false) => {
    const central = centralPasswordLinks();
    return `<div class="card login"><h1>${central ? 'Senha local de emergência' : 'Alterar senha'}</h1>${central ? centralPasswordNotice(central, 'change') + '<p class="muted small">Aqui você troca só a senha local, usada no login profissional (CPF e conselho) e quando o acesso central estiver fora do ar.</p>' : ''}${error ? `<div class="flash err">${error}</div>` : ''}${ok ? '<div class="flash ok">Senha alterada.</div>' : ''}
<form method="post" action="/senha"><label>Senha atual</label><input name="current" type="password" autocomplete="current-password" required>
<label>Nova senha (mín. 10)</label><input name="password" type="password" autocomplete="new-password" minlength="10" required>
<label>Confirmar nova senha</label><input name="confirm" type="password" autocomplete="new-password" required>
<p><button class="btn" type="submit">Salvar</button> <a class="btn sec" href="/casos">Voltar</a></p></form></div>`;
  };

  app.get('/senha', { preHandler: requireAuth }, async (request, reply) => reply.type('text/html; charset=utf-8').send(layout({ title: 'Alterar senha', user: request.user, body: passwordForm(null) })));

  app.post('/senha', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.redirect('/login');
    const parsed = PasswordBody.safeParse(request.body);
    const render = (msg: string | null, ok = false) => reply.type('text/html; charset=utf-8').send(layout({ title: 'Alterar senha', user, body: passwordForm(msg, ok) }));
    if (!parsed.success) return render(parsed.error.issues[0]?.message ?? 'Dados inválidos.');
    if (!await authenticate(user.email, parsed.data.current)) return render('Senha atual incorreta.');
    await setPassword(user.id, parsed.data.password);
    await audit(user.id, 'alterar_senha', 'user', user.id, null, request.id);
    // nova sessão para este aparelho; as outras sessões caem porque a versão da senha mudou
    const fresh = await findUserById(user.id);
    if (fresh) reply.setCookie(COOKIE_NAME, createSessionToken(fresh), { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 3600 });
    return render(null, true);
  });

  app.get('/esqueci', async (request, reply) => reply.type('text/html; charset=utf-8').send(layout({ title: 'Esqueci a senha', user: null, body: forgotPage(null, mailEnabled(), false, centralPasswordLinks()) })));

  app.post('/esqueci', async (request, reply) => {
    const email = String((request.body as { email?: string } | null)?.email ?? '').trim().toLowerCase();
    const done = 'Se este e-mail estiver cadastrado, você receberá um link válido por 1 hora. Confira também a caixa de spam.';
    if (!mailEnabled()) return reply.type('text/html; charset=utf-8').send(layout({ title: 'Esqueci a senha', user: null, body: forgotPage(null, false, false, centralPasswordLinks()) }));
    if (!resetAllowed(request.ip)) return reply.code(429).type('text/html; charset=utf-8').send(layout({ title: 'Esqueci a senha', user: null, body: forgotPage('Muitas tentativas. Aguarde 15 minutos.', true, false, centralPasswordLinks()) }));
    const user = email ? await findUserByEmail(email) : null;
    if (user) {
      const { token } = await createResetToken(user.id, 'email', null);
      try {
        await sendResetEmail(user.email, `${appUrl()}/redefinir/${token}`);
        await audit(user.id, 'reset_email', 'user', user.id, { ip: request.ip }, request.id);
      } catch (error) {
        request.log.error({ err: error }, 'falha ao enviar e-mail de redefinição');
      }
    } else {
      await audit(null, 'reset_email_desconhecido', 'user', email, { ip: request.ip }, request.id);
    }
    return reply.type('text/html; charset=utf-8').send(layout({ title: 'Esqueci a senha', user: null, body: forgotPage(done, true, true) }));
  });

  app.get('/redefinir/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const reset = await findValidReset(token);
    return reply.code(reset ? 200 : 404).type('text/html; charset=utf-8').send(layout({ title: 'Redefinir senha', user: null, body: resetPage(token, reset ? null : 'Link inválido, já usado ou vencido. Peça um novo ao administrador.', !reset) }));
  });

  app.post('/redefinir/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const reset = await findValidReset(token);
    const render = (msg: string | null, dead = false, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(layout({ title: 'Redefinir senha', user: null, body: resetPage(token, msg, dead) }));
    if (!reset) return render('Link inválido, já usado ou vencido. Peça um novo ao administrador.', true, 404);
    const body = request.body as { password?: string; confirm?: string } | null;
    const password = body?.password ?? '';
    if (password.length < 10) return render('A nova senha precisa ter ao menos 10 caracteres.');
    if (password !== body?.confirm) return render('A confirmação não confere.');
    const row = (await getAsyncDb().prepare('SELECT email FROM users WHERE id = ? AND disabled_at IS NULL').get(reset.userId)) as Row | undefined;
    if (!row) return render('Usuário desativado.', true, 404);
    await setPassword(reset.userId, password);
    await consumeReset(reset.id);
    await audit(reset.userId, 'redefinir_senha', 'user', reset.userId, { ip: request.ip }, request.id);
    const user = await findUserById(reset.userId);
    if (user) {
      reply.setCookie(COOKIE_NAME, createSessionToken(user), { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 3600 });
    }
    return reply.redirect('/casos?kind=ok&msg=' + encodeURIComponent('Senha redefinida. Você já está conectado.'));
  });

  app.post('/logout', async (request, reply) => {
    if (request.user) (await audit(request.user.id, 'logout', 'user', request.user.id, null, request.id));
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.redirect('/login');
  });
}

/**
 * SSO do LN Medicina Integrada: aceita `Authorization: Bearer <JWT>` emitido pelo
 * GoTrue (HS256, segredo em GOTRUE_JWT_SECRET). Sem a env, nada muda: só o cookie
 * de sessão vale. O usuário é mapeado por e-mail (sem distinção de caixa); se não
 * existir, é criado no primeiro acesso com o papel do app_metadata.role.
 */
import crypto from 'node:crypto';
import { findUserByEmail, findUserById, type SessionUser } from './auth.js';
import { audit, getAsyncDb, num, type Row } from './db.js';

export function ssoEnabled(): boolean {
  return !!process.env.GOTRUE_JWT_SECRET?.trim();
}

/** Papéis do LN aceitos aqui e o papel correspondente no NutroLab. */
const ROLE_MAP: Record<string, 'admin' | 'medico'> = { administrador: 'admin', medico: 'medico', nutricionista: 'medico' };

export interface GotrueClaims {
  sub?: string;
  email?: string;
  role?: string;
  exp?: number;
  app_metadata?: { role?: string };
  user_metadata?: { name?: string; full_name?: string };
}

export type SsoResult = { ok: true; user: SessionUser } | { ok: false; status: 401 | 403; reason: string };

function b64urlJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** Valida assinatura HS256 e expiração. Devolve as claims ou o motivo da recusa. */
export function verifyGotrueJwt(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): { claims: GotrueClaims } | { error: string } {
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'token malformado' };
  const [h, p, sig] = parts as [string, string, string];
  let header: { alg?: string };
  let claims: GotrueClaims;
  try {
    header = b64urlJson(h) as { alg?: string };
    claims = b64urlJson(p) as GotrueClaims;
  } catch {
    return { error: 'token malformado' };
  }
  if (header.alg !== 'HS256') return { error: 'algoritmo não aceito' };
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { error: 'assinatura inválida' };
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) return { error: 'token expirado' };
  if (claims.role !== 'authenticated') return { error: 'papel do token não autenticado' };
  if (!claims.email) return { error: 'token sem e-mail' };
  return { claims };
}

export async function userFromBearer(authorization: string | undefined): Promise<SsoResult | null> {
  const secret = process.env.GOTRUE_JWT_SECRET?.trim();
  if (!secret || !authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m || !m[1]) return null;
  const v = verifyGotrueJwt(m[1], secret);
  if ('error' in v) return { ok: false, status: 401, reason: v.error };
  return userFromClaims(v.claims);
}

/**
 * Usuário do NutroLab para claims GoTrue JÁ VALIDADAS: mapeia por e-mail (sem distinção
 * de caixa) e cria no primeiro acesso com o papel do app_metadata.role. Usado pelo
 * Bearer e pelo login com a senha única.
 */
export async function userFromClaims(claims: GotrueClaims): Promise<SsoResult> {
  const email = (claims.email ?? '').trim().toLowerCase();
  const lnRole = (claims.app_metadata?.role ?? '').toLowerCase();
  const mapped = ROLE_MAP[lnRole];
  // Usuário existente (ativo ou não) por e-mail, sem distinção de caixa.
  const row = (await getAsyncDb().prepare('SELECT id, disabled_at FROM users WHERE lower(email) = ?').get(email)) as Row | undefined;
  if (row) {
    if (row.disabled_at) return { ok: false, status: 403, reason: 'usuário desativado' };
    if (!mapped) return { ok: false, status: 403, reason: `papel "${lnRole || 'vazio'}" sem acesso ao NutroLab` };
    const user = await findUserById(num(row, 'id'));
    return user ? { ok: true, user } : { ok: false, status: 403, reason: 'usuário indisponível' };
  }
  if (!mapped) return { ok: false, status: 403, reason: `papel "${lnRole || 'vazio'}" sem acesso ao NutroLab` };
  const name = (claims.user_metadata?.full_name ?? claims.user_metadata?.name ?? email).slice(0, 120);
  // Senha inutilizável: quem entra por SSO não usa senha local até definir uma.
  const unusable = `sso:${crypto.randomBytes(16).toString('hex')}`;
  const id = Number((await getAsyncDb().prepare('INSERT INTO users(email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(email, name, unusable, mapped)).lastInsertRowid);
  await audit(id, 'sso_criar_usuario', 'user', id, { email, ln_role: lnRole, role: mapped, sub: claims.sub ?? null });
  const user = await findUserByEmail(email);
  return user ? { ok: true, user } : { ok: false, status: 403, reason: 'falha ao criar usuário' };
}

/* ------------------------------------------------- senha única (GoTrue) */

const GOTRUE_TIMEOUT_MS = Number(process.env.GOTRUE_TIMEOUT_MS ?? 5000);

/**
 * Resultado do login por e-mail+senha no GoTrue:
 * - `ok`: senha certa e token válido → usuário do NutroLab.
 * - `denied`: o GoTrue respondeu e recusou (senha errada, conta sem acesso, limite de tentativas).
 *   NUNCA cai na senha local: senão a senha antiga continuaria abrindo a conta.
 * - `unavailable`: sem GOTRUE_URL/GOTRUE_ANON_KEY/GOTRUE_JWT_SECRET, ou o GoTrue não respondeu
 *   (rede, tempo esgotado, erro 5xx). Só aqui o login local é usado (decisão do Dr. Leônidas).
 */
export type PasswordLoginResult = { kind: 'ok'; user: SessionUser } | { kind: 'denied'; reason: string; message: string } | { kind: 'unavailable'; reason: string };

export function gotruePasswordConfigured(): boolean {
  return !!(process.env.GOTRUE_URL?.trim() && process.env.GOTRUE_ANON_KEY?.trim() && process.env.GOTRUE_JWT_SECRET?.trim());
}

function gotrueBase(): string | null {
  const raw = process.env.GOTRUE_URL?.trim() ?? '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export async function gotruePasswordLogin(email: string, password: string): Promise<PasswordLoginResult> {
  email = email.trim().toLowerCase();
  const secret = process.env.GOTRUE_JWT_SECRET?.trim();
  const anon = process.env.GOTRUE_ANON_KEY?.trim();
  const base = gotrueBase();
  if (!secret || !anon || !base) return { kind: 'unavailable', reason: 'senha única não configurada' };
  let response: Response;
  try {
    response = await fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anon, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(GOTRUE_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error && error.name === 'TimeoutError' ? 'GoTrue sem resposta' : 'GoTrue inacessível' };
  }
  if (response.status >= 500) return { kind: 'unavailable', reason: `GoTrue respondeu ${response.status}` };
  if (response.status === 429) return { kind: 'denied', reason: 'limite de tentativas no GoTrue', message: 'Muitas tentativas. Aguarde alguns minutos.' };
  if (!response.ok) return { kind: 'denied', reason: `GoTrue recusou (${response.status})`, message: 'E-mail ou senha incorretos.' };
  let token = '';
  try {
    const body = (await response.json()) as { access_token?: unknown };
    token = typeof body.access_token === 'string' ? body.access_token : '';
  } catch {
    token = '';
  }
  // Resposta 200 sem token válido não é "fora do ar": recusa (não confia, não cai no local).
  const v = verifyGotrueJwt(token, secret);
  if ('error' in v) return { kind: 'denied', reason: `token do GoTrue recusado: ${v.error}`, message: 'Não foi possível confirmar o acesso. Tente de novo.' };
  if ((v.claims.email ?? '').trim().toLowerCase() !== email) return { kind: 'denied', reason: 'token de outro e-mail', message: 'Não foi possível confirmar o acesso. Tente de novo.' };
  const mapped = await userFromClaims(v.claims);
  if (!mapped.ok) return { kind: 'denied', reason: mapped.reason, message: mapped.reason === 'usuário desativado' ? 'Usuário desativado.' : 'Seu perfil não tem acesso ao NutroLab.' };
  return { kind: 'ok', user: mapped.user };
}

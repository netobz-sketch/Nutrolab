/**
 * SSO do LN Medicina Integrada: aceita `Authorization: Bearer <JWT>` emitido pelo
 * GoTrue (HS256, segredo em GOTRUE_JWT_SECRET). Sem a env, nada muda: só o cookie
 * de sessão vale. Com o segredo, GOTRUE_ISSUER e NUTROLAB_ORG_ID são obrigatórias
 * (o app não sobe sem elas). As claims seguem a mesma tabela do LN Evolution
 * (docs/seguranca/API.md P-36-3), para os dois receptores ficarem idênticos.
 *
 * Vínculo por `sub` ("bind on first use"): o usuário é achado primeiro pelo `sub`
 * gravado; por e-mail só enquanto ainda não tem `sub`, e aí o `sub` é gravado. Depois,
 * o mesmo e-mail com outro `sub` é recusado (SSO_SUB_MISMATCH).
 */
import crypto from 'node:crypto';
import { findUserById, type SessionUser } from './auth.js';
import { audit, getAsyncDb, num, str, strOrNull, type Row } from './db.js';

export interface GotrueConfig { secret: string; issuer: string; orgId: string; audience: string }

/**
 * Configuração do SSO a partir do ambiente. Sem segredo: SSO desligado (null). Com segredo e sem
 * GOTRUE_ISSUER/NUTROLAB_ORG_ID: erro, porque um token de outro emissor ou de outra organização
 * não pode ser aceito por omissão.
 */
export function readGotrueConfig(env: Record<string, string | undefined> = process.env): GotrueConfig | null {
  const secret = env.GOTRUE_JWT_SECRET?.trim() || '';
  if (!secret) return null;
  const issuer = env.GOTRUE_ISSUER?.trim().replace(/\/+$/, '') || '';
  const orgId = env.NUTROLAB_ORG_ID?.trim() || '';
  const missing = [!issuer && 'GOTRUE_ISSUER', !orgId && 'NUTROLAB_ORG_ID'].filter((v): v is string => !!v);
  if (missing.length) throw new Error(`Configuração do SSO incompleta: com GOTRUE_JWT_SECRET definido, ${missing.join(' e ')} ${missing.length > 1 ? 'são obrigatórias' : 'é obrigatória'}.`);
  return { secret, issuer, orgId, audience: env.GOTRUE_JWT_AUD?.trim() || 'authenticated' };
}

export function ssoEnabled(): boolean {
  return !!process.env.GOTRUE_JWT_SECRET?.trim();
}

/**
 * Parede LGPD: só estes papéis do LN entram no NutroLab (exame é dado de saúde).
 * Recepção, financeiro, gestor e assistente ficam de fora (403, sem criar usuário).
 * Não há papel novo: equipe única, todos os clínicos veem todos os pacientes.
 */
const ROLE_MAP: Record<string, 'admin' | 'medico'> = { administrador: 'admin', medico: 'medico', nutricionista: 'medico' };

export interface GotrueClaims {
  sub?: string;
  email?: string;
  role?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  iss?: string;
  aud?: string | string[];
  is_anonymous?: boolean;
  app_metadata?: { role?: string; org_id?: string };
  user_metadata?: { name?: string; full_name?: string };
}

export type SsoResult = { ok: true; user: SessionUser } | { ok: false; status: 401 | 403; reason: string; code?: 'SSO_SUB_MISMATCH' };

const CLOCK_SKEW_SECONDS = 30;

function b64urlJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * Valida assinatura HS256 e as claims (exp, nbf, iat, iss, aud, role, is_anonymous, e-mail e
 * app_metadata.org_id). Devolve as claims ou o motivo da recusa. Sem config, nenhum token vale.
 */
export type VerifyResult = { claims: GotrueClaims } | { error: string; status: 401 | 403 };

/**
 * 401: token que não prova nada (malformado, assinatura, validade): um token novo pode resolver.
 * 403: token autêntico, mas de outro emissor, audiência, organização, anônimo ou sem e-mail.
 */
export function verifyGotrueJwt(token: string, config: GotrueConfig | null, nowSec = Math.floor(Date.now() / 1000)): VerifyResult {
  const deny = (error: string): VerifyResult => ({ error, status: 403 });
  const invalid = (error: string): VerifyResult => ({ error, status: 401 });
  if (!config) return invalid('SSO não configurado');
  const parts = token.split('.');
  if (parts.length !== 3) return invalid('token malformado');
  const [h, p, sig] = parts as [string, string, string];
  let header: { alg?: string };
  let claims: GotrueClaims;
  try {
    header = b64urlJson(h) as { alg?: string };
    claims = b64urlJson(p) as GotrueClaims;
  } catch {
    return invalid('token malformado');
  }
  if (!claims || typeof claims !== 'object') return invalid('token malformado');
  if (header.alg !== 'HS256') return invalid('algoritmo não aceito');
  const expected = crypto.createHmac('sha256', config.secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return invalid('assinatura inválida');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < nowSec) return invalid('token expirado');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - CLOCK_SKEW_SECONDS > nowSec)) return invalid('token ainda não válido');
  // O GoTrue sempre emite iat; no futuro, além da folga, é token forjado ou relógio quebrado.
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > nowSec) return invalid('token com emissão inválida');
  if (typeof claims.iss !== 'string' || claims.iss.replace(/\/+$/, '') !== config.issuer) return deny('emissor não aceito');
  const aud = claims.aud;
  if (!(typeof aud === 'string' ? aud === config.audience : Array.isArray(aud) && aud.includes(config.audience))) return deny('audiência não aceita');
  if (claims.role !== 'authenticated') return deny('papel do token não autenticado');
  if (claims.is_anonymous === true) return deny('usuário anônimo');
  if (typeof claims.email !== 'string' || !claims.email.trim()) return deny('token sem e-mail');
  // Só a organização da clínica entra (mesmo segredo poderia assinar token de outra org).
  if (claims.app_metadata?.org_id !== config.orgId) return deny('organização não aceita');
  return { claims };
}

export async function userFromBearer(authorization: string | undefined): Promise<SsoResult | null> {
  const config = readGotrueConfig();
  if (!config || !authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m || !m[1]) return null;
  const v = verifyGotrueJwt(m[1], config);
  if ('error' in v) return { ok: false, status: v.status, reason: v.error };
  return userFromClaims(v.claims);
}

/**
 * Sessão vinda do GoTrue vale até o `exp` do token (1 h), não as 12 h da senha local: quem é
 * rebaixado ou desativado no sistema integrado perde o acesso aqui no máximo nesse prazo.
 */
export function ssoSessionExpiry(claims: GotrueClaims): number {
  return (claims.exp ?? 0) * 1000;
}

function noAccess(lnRole: string): SsoResult {
  return { ok: false, status: 403, reason: `papel "${lnRole || 'vazio'}" sem acesso ao NutroLab` };
}

/**
 * Usuário do NutroLab para claims GoTrue JÁ VALIDADAS (Bearer, senha única e passagem de sessão).
 * Acha por `sub`; senão por e-mail (sem distinção de caixa) enquanto o usuário não tem `sub`, e
 * grava o vínculo. Cria no primeiro acesso com o papel do app_metadata.role. Usuário existente
 * cujo claim caiu de administrador para médico é rebaixado aqui (promoção só pelo administrador).
 */
export async function userFromClaims(claims: GotrueClaims): Promise<SsoResult> {
  const email = (claims.email ?? '').trim().toLowerCase();
  const sub = typeof claims.sub === 'string' && claims.sub.trim() ? claims.sub.trim() : null;
  const lnRole = (claims.app_metadata?.role ?? '').toLowerCase();
  const mapped = ROLE_MAP[lnRole];
  const adb = getAsyncDb();
  let row = sub ? ((await adb.prepare('SELECT id, role, disabled_at, gotrue_sub FROM users WHERE gotrue_sub = ?').get(sub)) as Row | undefined) : undefined;
  if (!row) {
    row = (await adb.prepare('SELECT id, role, disabled_at, gotrue_sub FROM users WHERE lower(email) = ?').get(email)) as Row | undefined;
    const bound = row ? strOrNull(row, 'gotrue_sub') : null;
    if (row && bound && bound !== sub) return { ok: false, status: 403, reason: 'conta central diferente da vinculada a este e-mail', code: 'SSO_SUB_MISMATCH' };
  }
  if (row) {
    const id = num(row, 'id');
    if (row.disabled_at) return { ok: false, status: 403, reason: 'usuário desativado' };
    if (!mapped) return noAccess(lnRole);
    if (sub && !strOrNull(row, 'gotrue_sub')) {
      await adb.prepare('UPDATE users SET gotrue_sub = ? WHERE id = ?').run(sub, id);
      await audit(id, 'sso_vincular', 'user', id, { sub });
    }
    if (str(row, 'role') === 'admin' && mapped === 'medico') {
      await adb.prepare("UPDATE users SET role = 'medico' WHERE id = ?").run(id);
      await audit(id, 'sso_rebaixar_papel', 'user', id, { de: 'admin', para: 'medico', ln_role: lnRole });
    }
    const user = await findUserById(id);
    return user ? { ok: true, user } : { ok: false, status: 403, reason: 'usuário indisponível' };
  }
  if (!mapped) return noAccess(lnRole);
  const name = (claims.user_metadata?.full_name ?? claims.user_metadata?.name ?? email).slice(0, 120);
  // Senha inutilizável: quem entra por SSO não usa senha local até definir uma.
  const unusable = `sso:${crypto.randomBytes(16).toString('hex')}`;
  const id = Number((await adb.prepare('INSERT INTO users(email, name, password_hash, role, gotrue_sub) VALUES (?, ?, ?, ?, ?)').run(email, name, unusable, mapped, sub)).lastInsertRowid);
  await audit(id, 'sso_criar_usuario', 'user', id, { email, ln_role: lnRole, role: mapped, sub });
  const user = await findUserById(id);
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
export type PasswordLoginResult = { kind: 'ok'; user: SessionUser; expiresAtMs: number } | { kind: 'denied'; reason: string; message: string } | { kind: 'unavailable'; reason: string };

export function gotruePasswordConfigured(): boolean {
  return !!(process.env.GOTRUE_URL?.trim() && process.env.GOTRUE_ANON_KEY?.trim() && readGotrueConfig());
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
  const config = readGotrueConfig();
  const anon = process.env.GOTRUE_ANON_KEY?.trim();
  const base = gotrueBase();
  if (!config || !anon || !base) return { kind: 'unavailable', reason: 'senha única não configurada' };
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
  const v = verifyGotrueJwt(token, config);
  if ('error' in v) return { kind: 'denied', reason: `token do GoTrue recusado: ${v.error}`, message: 'Não foi possível confirmar o acesso. Tente de novo.' };
  if ((v.claims.email ?? '').trim().toLowerCase() !== email) return { kind: 'denied', reason: 'token de outro e-mail', message: 'Não foi possível confirmar o acesso. Tente de novo.' };
  const mapped = await userFromClaims(v.claims);
  if (!mapped.ok) return { kind: 'denied', reason: mapped.reason, message: mapped.reason === 'usuário desativado' ? 'Usuário desativado.' : 'Seu perfil não tem acesso ao NutroLab.' };
  return { kind: 'ok', user: mapped.user, expiresAtMs: ssoSessionExpiry(v.claims) };
}

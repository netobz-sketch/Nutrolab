/**
 * SSO do LN Medicina Integrada: aceita `Authorization: Bearer <JWT>` emitido pelo
 * GoTrue (HS256, segredo em GOTRUE_JWT_SECRET). Sem a env, nada muda: só o cookie
 * de sessão vale. O usuário é mapeado por e-mail (sem distinção de caixa); se não
 * existir, é criado no primeiro acesso com o papel do app_metadata.role.
 */
import crypto from 'node:crypto';
import { findUserByEmail, findUserById, type SessionUser } from './auth.js';
import { audit, getDb, num, type Row } from './db.js';

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

export function userFromBearer(authorization: string | undefined): SsoResult | null {
  const secret = process.env.GOTRUE_JWT_SECRET?.trim();
  if (!secret || !authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m || !m[1]) return null;
  const v = verifyGotrueJwt(m[1], secret);
  if ('error' in v) return { ok: false, status: 401, reason: v.error };
  const email = (v.claims.email ?? '').trim().toLowerCase();
  const lnRole = (v.claims.app_metadata?.role ?? '').toLowerCase();
  const mapped = ROLE_MAP[lnRole];
  // Usuário existente (ativo ou não) por e-mail, sem distinção de caixa.
  const row = getDb().prepare('SELECT id, disabled_at FROM users WHERE lower(email) = ?').get(email) as Row | undefined;
  if (row) {
    if (row.disabled_at) return { ok: false, status: 403, reason: 'usuário desativado' };
    if (!mapped) return { ok: false, status: 403, reason: `papel "${lnRole || 'vazio'}" sem acesso ao NutroLab` };
    const user = findUserById(num(row, 'id'));
    return user ? { ok: true, user } : { ok: false, status: 403, reason: 'usuário indisponível' };
  }
  if (!mapped) return { ok: false, status: 403, reason: `papel "${lnRole || 'vazio'}" sem acesso ao NutroLab` };
  const name = (v.claims.user_metadata?.full_name ?? v.claims.user_metadata?.name ?? email).slice(0, 120);
  // Senha inutilizável: quem entra por SSO não usa senha local até definir uma.
  const unusable = `sso:${crypto.randomBytes(16).toString('hex')}`;
  const id = Number(getDb().prepare('INSERT INTO users(email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(email, name, unusable, mapped).lastInsertRowid);
  audit(id, 'sso_criar_usuario', 'user', id, { email, ln_role: lnRole, role: mapped, sub: v.claims.sub ?? null });
  const user = findUserByEmail(email);
  return user ? { ok: true, user } : { ok: false, status: 403, reason: 'falha ao criar usuário' };
}

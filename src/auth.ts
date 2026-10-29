import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb, num, str, strOrNull, type Row } from './db.js';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'medico';
  cpf: string | null;
  council: string | null;
  council_number: string | null;
  council_state: string | null;
  profession: string | null;
  /** versão da senha: muda quando a senha muda, invalidando sessões antigas */
  pwv: string;
}

export function passwordVersion(passwordHash: string): string {
  return crypto.createHash('sha256').update(passwordHash).digest('hex').slice(0, 12);
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const COOKIE_NAME = 'nl_session';
const SESSION_HOURS = 12;
const secret = (() => {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET (>= 32 caracteres) é obrigatório em produção');
  return crypto.randomBytes(32).toString('hex');
})();

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split(':');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSessionToken(user: SessionUser): string {
  const payload = Buffer.from(JSON.stringify({ u: user.id, v: user.pwv, e: Date.now() + SESSION_HOURS * 3600 * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readSessionToken(token: string | undefined): { userId: number; pwv: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: number; v?: string; e?: number };
    if (!data.u || !data.e || !data.v || data.e < Date.now()) return null;
    return { userId: data.u, pwv: data.v };
  } catch {
    return null;
  }
}

const USER_COLS = 'id, email, name, role, password_hash, cpf, council, council_number, council_state, profession';

function rowToUser(row: Row): SessionUser {
  return {
    id: num(row, 'id'), email: str(row, 'email'), name: str(row, 'name'), role: str(row, 'role') as SessionUser['role'],
    cpf: strOrNull(row, 'cpf'), council: strOrNull(row, 'council'), council_number: strOrNull(row, 'council_number'), council_state: strOrNull(row, 'council_state'), profession: strOrNull(row, 'profession'),
    pwv: passwordVersion(str(row, 'password_hash')),
  };
}

export function findUserById(id: number): SessionUser | null {
  const row = getDb().prepare(`SELECT ${USER_COLS} FROM users WHERE id = ? AND disabled_at IS NULL`).get(id) as Row | undefined;
  return row ? rowToUser(row) : null;
}

/** Login profissional: CPF + número do conselho identificam; a senha autentica. */
export function authenticateProfessional(cpf: string, councilNumber: string, password: string): SessionUser | null {
  const row = getDb().prepare(`SELECT ${USER_COLS} FROM users WHERE cpf = ? AND council_number = ? AND disabled_at IS NULL`).get(cpf, councilNumber) as Row | undefined;
  if (!row) {
    verifyPassword(password, 'scrypt:00:00');
    return null;
  }
  if (!verifyPassword(password, str(row, 'password_hash'))) return null;
  return rowToUser(row);
}

export function updateProfile(userId: number, data: { name: string; email: string; cpf: string | null; council: string | null; council_number: string | null; council_state: string | null; profession: string | null }): void {
  getDb()
    .prepare('UPDATE users SET name = ?, email = ?, cpf = ?, council = ?, council_number = ?, council_state = ?, profession = ? WHERE id = ?')
    .run(data.name, data.email, data.cpf, data.council, data.council_number, data.council_state, data.profession, userId);
}

/** Usuário da sessão: só vale se a versão da senha ainda for a mesma. */
export function sessionUser(token: string | undefined): SessionUser | null {
  const session = readSessionToken(token);
  if (!session) return null;
  const user = findUserById(session.userId);
  return user && user.pwv === session.pwv ? user : null;
}

export function findUserByEmail(email: string): SessionUser | null {
  const row = getDb().prepare(`SELECT ${USER_COLS} FROM users WHERE email = ? AND disabled_at IS NULL`).get(email.trim().toLowerCase()) as Row | undefined;
  return row ? rowToUser(row) : null;
}

export function setPassword(userId: number, password: string): void {
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
}

/* ------------------------------------------------- redefinição de senha */
const RESET_HOURS = { admin: 24, email: 1, cli: 24 } as const;
export type ResetChannel = keyof typeof RESET_HOURS;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Cria token de uso único; devolve o token em claro (só aparece uma vez). */
export function createResetToken(userId: number, channel: ResetChannel, createdBy: number | null): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_HOURS[channel] * 3600 * 1000).toISOString();
  getDb().prepare("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(userId);
  getDb().prepare('INSERT INTO password_resets(user_id, token_hash, expires_at, created_by, channel) VALUES (?, ?, ?, ?, ?)').run(userId, hashToken(token), expiresAt, createdBy, channel);
  return { token, expiresAt };
}

export function findValidReset(token: string): { id: number; userId: number } | null {
  if (!token || token.length < 20) return null;
  const row = getDb().prepare("SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')").get(hashToken(token)) as Row | undefined;
  return row ? { id: num(row, 'id'), userId: num(row, 'user_id') } : null;
}

export function consumeReset(id: number): void {
  getDb().prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?").run(id);
}

export function authenticate(email: string, password: string): SessionUser | null {
  const row = getDb().prepare(`SELECT ${USER_COLS} FROM users WHERE email = ? AND disabled_at IS NULL`).get(email.trim().toLowerCase()) as Row | undefined;
  if (!row) {
    // custo constante mesmo sem usuário
    verifyPassword(password, 'scrypt:00:00');
    return null;
  }
  if (!verifyPassword(password, str(row, 'password_hash'))) return null;
  return rowToUser(row);
}

/** Cria o primeiro administrador a partir do ambiente quando não há usuários. */
export function bootstrapAdmin(log: (msg: string) => void): void {
  const count = num(getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as Row, 'n');
  if (count > 0) return;
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    log('Nenhum usuário cadastrado e ADMIN_EMAIL/ADMIN_PASSWORD ausentes: ninguém conseguirá entrar.');
    return;
  }
  getDb()
    .prepare("INSERT INTO users(email, name, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run(email, process.env.ADMIN_NAME?.trim() || 'Administrador', hashPassword(password));
  log(`Administrador inicial criado: ${email}`);
}

export function userExists(email: string): boolean {
  return !!(getDb().prepare('SELECT 1 FROM users WHERE email = ?').get(email) as Row | undefined);
}

export function lastLoginAt(userId: number): string | null {
  const row = getDb().prepare("SELECT created_at FROM audit_log WHERE user_id = ? AND action = 'login' ORDER BY id DESC LIMIT 1 OFFSET 1").get(userId) as Row | undefined;
  return row ? strOrNull(row, 'created_at') : null;
}

/* ------------------------------------------------------------ rate limit */
const attempts = new Map<string, { count: number; resetAt: number }>();
function allow(key: string, max: number): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}
export function loginAllowed(ip: string): boolean {
  return allow(`login:${ip}`, 10);
}
export function resetAllowed(ip: string): boolean {
  return allow(`reset:${ip}`, 5);
}
export function loginSucceeded(ip: string): void {
  attempts.delete(`login:${ip}`);
}

/* --------------------------------------------------------------- guards */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    const next = encodeURIComponent(request.url);
    await reply.redirect(`/login?next=${next}`);
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.redirect('/login');
    return;
  }
  if (request.user.role !== 'admin') {
    await reply.code(403).type('text/html; charset=utf-8').send('<p>Acesso restrito ao administrador.</p>');
  }
}

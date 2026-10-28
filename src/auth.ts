import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb, num, str, strOrNull, type Row } from './db.js';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'medico';
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

export function createSessionToken(userId: number): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + SESSION_HOURS * 3600 * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readSessionToken(token: string | undefined): number | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: number; e?: number };
    if (!data.u || !data.e || data.e < Date.now()) return null;
    return data.u;
  } catch {
    return null;
  }
}

export function findUserById(id: number): SessionUser | null {
  const row = getDb().prepare('SELECT id, email, name, role FROM users WHERE id = ? AND disabled_at IS NULL').get(id) as Row | undefined;
  return row ? { id: num(row, 'id'), email: str(row, 'email'), name: str(row, 'name'), role: str(row, 'role') as SessionUser['role'] } : null;
}

export function authenticate(email: string, password: string): SessionUser | null {
  const row = getDb().prepare('SELECT id, email, name, role, password_hash FROM users WHERE email = ? AND disabled_at IS NULL').get(email.trim().toLowerCase()) as Row | undefined;
  if (!row) {
    // custo constante mesmo sem usuário
    verifyPassword(password, 'scrypt:00:00');
    return null;
  }
  if (!verifyPassword(password, str(row, 'password_hash'))) return null;
  return { id: num(row, 'id'), email: str(row, 'email'), name: str(row, 'name'), role: str(row, 'role') as SessionUser['role'] };
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
export function loginAllowed(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}
export function loginSucceeded(ip: string): void {
  attempts.delete(ip);
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

/**
 * Gera um link de redefinição de senha para um usuário (uso: administrador trancado fora).
 *   node dist/scripts/reset-password.js email@exemplo.com
 * Imprime o link; vale 24 h, uso único. Requer DATA_DIR e APP_URL do ambiente.
 */
import { openDb, getDb, num, str, type Row } from '../src/db.js';
import { createResetToken } from '../src/auth.js';

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email) {
  console.error('uso: reset-password.js <email>');
  process.exit(2);
}
openDb();
const row = getDb().prepare('SELECT id, email FROM users WHERE email = ?').get(email) as Row | undefined;
if (!row) {
  console.error(`usuário não encontrado: ${email}`);
  process.exit(1);
}
getDb().prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(num(row, 'id'));
const { token, expiresAt } = createResetToken(num(row, 'id'), 'cli', null);
getDb().prepare("INSERT INTO audit_log(user_id, action, entity, entity_id, details) VALUES (NULL, 'gerar_link_redefinicao_cli', 'user', ?, ?)").run(String(num(row, 'id')), JSON.stringify({ expiresAt }));
const base = (process.env.APP_URL ?? 'http://localhost:8090').replace(/\/$/, '');
console.log(`${base}/redefinir/${token}`);
console.log(`válido até ${expiresAt} para ${str(row, 'email')}`);

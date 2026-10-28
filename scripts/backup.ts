/** Cópia consistente do SQLite (API de backup online) com retenção de 14 dias. */
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
const src = path.join(DATA_DIR, 'nutrolab.sqlite');
const dir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const dest = path.join(dir, `nutrolab-${stamp}.sqlite`);
const db = new DatabaseSync(src, { readOnly: true });
await backup(db, dest);
db.close();
const check = new DatabaseSync(dest, { readOnly: true });
const row = check.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
check.close();
for (const side of ['-wal', '-shm']) fs.rmSync(dest + side, { force: true });
if (row?.integrity_check !== 'ok') {
  fs.rmSync(dest, { force: true });
  throw new Error(`backup falhou na verificação de integridade: ${row?.integrity_check}`);
}
const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
for (const f of fs.readdirSync(dir)) {
  const p = path.join(dir, f);
  if (f.startsWith('nutrolab-') && (f.endsWith('-wal') || f.endsWith('-shm') || fs.statSync(p).mtimeMs < cutoff)) fs.rmSync(p);
}
console.log(`backup ok: ${dest}`);

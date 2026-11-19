/**
 * Copia o banco SQLite do NutroLab para o Postgres (banco vazio), numa transação única.
 *
 *   DATABASE_URL=postgres://… node dist/scripts/migrate-to-postgres.js --sqlite /caminho/copia.sqlite [--dry]
 *
 * - Lê o SQLite em modo somente leitura (use uma CÓPIA, não o arquivo vivo).
 * - Cria o schema (gerado do schema SQLite) e copia tabela a tabela na ordem das FKs,
 *   preservando os ids (OVERRIDING SYSTEM VALUE) e reposicionando as sequências.
 * - Valida antes do COMMIT: contagem e sha256 de cada tabela (linhas em ordem de id),
 *   e sha256 de cada relatório final. Qualquer diferença → ROLLBACK e saída 1.
 * - --dry: faz tudo e valida, mas termina em ROLLBACK.
 * Imprime um relatório JSON (sem dados de paciente: só contagens e hashes).
 */
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { schemaReference } from '../src/db.js';
import { pgSchemaStatements, tableOrder } from '../src/pg/schema.js';

pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

type Row = Record<string, unknown>;
const args = process.argv.slice(2);
const sqlitePath = args[args.indexOf('--sqlite') + 1];
const dry = args.includes('--dry');
const url = process.env.DATABASE_URL;
if (!sqlitePath || args.indexOf('--sqlite') < 0 || !url) {
  console.error('uso: DATABASE_URL=… migrate-to-postgres.js --sqlite <arquivo> [--dry]');
  process.exit(2);
}

const norm = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v === undefined ? null : v);
function digest(rows: Row[], cols: string[]): string {
  const h = crypto.createHash('sha256');
  for (const r of rows) h.update(JSON.stringify(cols.map((c) => norm(r[c]))) + '\n');
  return h.digest('hex');
}

const src = new DatabaseSync(sqlitePath, { readOnly: true });
const integrity = (src.prepare('PRAGMA integrity_check').get() as Row).integrity_check;
if (integrity !== 'ok') {
  console.error(`SQLite de origem com integrity_check = ${String(integrity)}; abortado.`);
  process.exit(1);
}
const mem = schemaReference();
const order = tableOrder(mem);
const client = new pg.Client({ connectionString: url, application_name: 'nutrolab-migracao' });
await client.connect();

const report: { dry: boolean; integrity: string; tables: Array<{ table: string; sqlite: number; postgres: number; sha256: string; equal: boolean }>; finalReports: Array<{ analysisId: number; equal: boolean }>; ok: boolean } = { dry, integrity: String(integrity), tables: [], finalReports: [], ok: false };

try {
  await client.query('BEGIN');
  for (const t of order) {
    const exists = (await client.query('SELECT to_regclass($1) AS r', [t])).rows[0]?.r;
    if (exists) {
      const n = Number((await client.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]?.n ?? 0);
      if (n > 0) throw new Error(`destino não está vazio: ${t} tem ${n} linha(s)`);
    }
  }
  for (const stmt of pgSchemaStatements(mem)) await client.query(stmt);

  const sourceTables = new Set((src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]).map((r) => String(r.name)));
  for (const t of order) {
    const targetCols = (mem.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((c) => String(c.name));
    const hasId = targetCols.includes('id');
    const orderBy = hasId ? 'id' : targetCols[0] ?? 'rowid';
    let rows: Row[] = [];
    let cols = targetCols;
    if (sourceTables.has(t)) {
      const srcCols = new Set((src.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((c) => String(c.name)));
      cols = targetCols.filter((c) => srcCols.has(c));
      rows = src.prepare(`SELECT ${cols.join(', ')} FROM ${t} ORDER BY ${orderBy}`).all() as Row[];
    }
    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const params: unknown[] = [];
      const values = chunk.map((r) => `(${cols.map((c) => {
        params.push(norm(r[c]));
        return `$${params.length}`;
      }).join(', ')})`);
      await client.query(`INSERT INTO ${t} (${cols.join(', ')})${hasId ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES ${values.join(', ')}`, params);
    }
    if (hasId) await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), (SELECT MAX(id) FROM ${t}) IS NOT NULL)`);
    const back = (await client.query(`SELECT ${cols.join(', ')} FROM ${t} ORDER BY ${orderBy}`)).rows as Row[];
    const a = digest(rows, cols);
    const b = digest(back, cols);
    report.tables.push({ table: t, sqlite: rows.length, postgres: back.length, sha256: a.slice(0, 16), equal: rows.length === back.length && a === b });
  }
  for (const r of src.prepare('SELECT id, final_patient, final_technical FROM analyses WHERE finalized_at IS NOT NULL ORDER BY id').all() as Row[]) {
    const p = (await client.query('SELECT final_patient, final_technical FROM analyses WHERE id = $1', [Number(r.id)])).rows[0] as Row | undefined;
    const sha = (x: unknown) => crypto.createHash('sha256').update(String(x ?? '')).digest('hex');
    report.finalReports.push({ analysisId: Number(r.id), equal: !!p && sha(p.final_patient) === sha(r.final_patient) && sha(p.final_technical) === sha(r.final_technical) });
  }
  report.ok = report.tables.every((t) => t.equal) && report.finalReports.every((f) => f.equal);
  if (!report.ok || dry) {
    await client.query('ROLLBACK');
  } else {
    await client.query('COMMIT');
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error(`falhou, nada foi gravado: ${error instanceof Error ? error.message : String(error)}`);
  console.log(JSON.stringify(report, null, 1));
  process.exit(1);
} finally {
  await client.end();
}
console.log(JSON.stringify(report, null, 1));
console.log(report.ok ? (dry ? 'VALIDAÇÃO OK (simulação, nada gravado)' : 'MIGRAÇÃO OK (gravada)') : 'DIVERGÊNCIA: nada foi gravado');
process.exit(report.ok ? 0 : 1);

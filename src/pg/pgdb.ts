/**
 * Acesso assíncrono ao Postgres com a API do NutroLab (`AsyncDb`).
 *
 * Uma conexão só, e as consultas rodam estritamente na ordem em que foram
 * emitidas (fila única). Assim BEGIN/COMMIT emitidos pelo código valem para as
 * consultas seguintes, como no SQLite. Se a conexão cair no meio de uma
 * transação, TxState faz toda consulta seguinte falhar com NUTROLAB_TX_LOST
 * até o ROLLBACK: nada continua silenciosamente em autocommit.
 */
import pg from 'pg';
import type { AsyncDb, Row, SqlValue } from './api.js';
import { translate } from './translate.js';
import { TxState } from './txstate.js';

// bigint (COUNT, ids) e numeric (SUM) chegam como texto por padrão: o SQLite devolvia número.
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

const TIMEOUT_MS = Number(process.env.PG_QUERY_TIMEOUT_MS ?? 30000);

type Result = { rows: Row[]; rowCount: number };

function pgError(message: string, code: string | null): Error {
  const err = new Error(message) as Error & { code?: string };
  if (code) err.code = code;
  return err;
}

const norm = (params: SqlValue[]) => params.map((p) => (typeof p === 'bigint' ? Number(p) : p));

export class PgDb implements AsyncDb {
  private client: pg.Client | null = null;
  private readonly tx = new TxState();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly url: string) {}

  private async connection(): Promise<pg.Client> {
    if (this.client) return this.client;
    const c = new pg.Client({ connectionString: this.url, application_name: 'nutrolab', query_timeout: TIMEOUT_MS, connectionTimeoutMillis: TIMEOUT_MS });
    c.on('error', () => {
      // Conexão caiu: se havia transação aberta, ela está perdida (TxState responde erro até o ROLLBACK).
      if (this.client === c) this.client = null;
      this.tx.connectionLost();
    });
    await c.connect();
    this.client = c;
    return c;
  }

  private async run(text: string, params: unknown[], mode: 'query' | 'exec'): Promise<Result> {
    const verdict = this.tx.before(text);
    if (!verdict.run) {
      if (verdict.reply === 'ok') return { rows: [], rowCount: 0 };
      throw pgError(verdict.message, 'NUTROLAB_TX_LOST');
    }
    try {
      const c = await this.connection();
      const res: pg.QueryResult | pg.QueryResult[] = mode === 'exec' ? await c.query(text) : await c.query(text, params);
      const last = Array.isArray(res) ? res[res.length - 1] : res;
      this.tx.after(text);
      return { rows: (last?.rows ?? []) as Row[], rowCount: last?.rowCount ?? 0 };
    } catch (error) {
      const e = error as { message?: string; code?: string };
      // Erro de conexão (não de SQL): descarta o cliente e, se em transação, marca como perdida.
      const connectionError = !e.code || /^(08|57P0)/.test(e.code) || /terminat|Connection|ECONN|EPIPE|timeout/i.test(e.message ?? '');
      if (connectionError) {
        const c = this.client;
        this.client = null;
        if (c) void c.end().catch(() => undefined);
        this.tx.connectionLost();
      }
      throw pgError(e.message ?? String(error), e.code ?? null);
    }
  }

  /** Fila única: cada consulta começa só depois da anterior terminar (com sucesso ou erro). */
  private enqueue(text: string, params: unknown[], mode: 'query' | 'exec'): Promise<Result> {
    const job = () => this.run(text, params, mode);
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Falha cedo se o banco não responder (credencial, rede). */
  async connect(): Promise<void> {
    await this.enqueue('select 1', [], 'query');
  }

  prepare(sql: string) {
    const t = translate(sql);
    return {
      get: async (...params: SqlValue[]) => (await this.enqueue(t.text, norm(params), 'query')).rows[0],
      all: async (...params: SqlValue[]) => (await this.enqueue(t.text, norm(params), 'query')).rows,
      run: async (...params: SqlValue[]) => {
        const res = await this.enqueue(t.text, norm(params), 'query');
        const id = t.isInsert ? Number((res.rows[0] as Row | undefined)?.id ?? 0) : 0;
        return { changes: res.rowCount, lastInsertRowid: id };
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.enqueue(sql, [], 'exec');
  }

  async close(): Promise<void> {
    await this.queue;
    const c = this.client;
    this.client = null;
    if (c) await c.end();
  }
}

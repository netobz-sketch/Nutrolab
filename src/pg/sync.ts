/**
 * Ponte síncrona para o Postgres, com a mesma API do `node:sqlite` usada no
 * NutroLab (`prepare(sql).get/all/run` e `exec`). O processo principal envia a
 * consulta a um worker e espera com Atomics.wait; o worker responde por um
 * MessagePort e acorda o principal. Assim, nenhuma das ~170 consultas síncronas
 * do código precisa virar async para o banco mudar.
 */
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { translate } from './translate.js';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

export interface Statement {
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
}
export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

const TIMEOUT_MS = Number(process.env.PG_QUERY_TIMEOUT_MS ?? 30000);

export class PgSyncDb implements Db {
  private readonly worker: Worker;
  private readonly port;
  private readonly flag: Int32Array;

  constructor(url: string) {
    const sab = new SharedArrayBuffer(4);
    this.flag = new Int32Array(sab);
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { url, sab, port: port2 }, transferList: [port2] });
    this.worker.unref();
    // Falha cedo se o banco não responder (credencial, rede).
    this.call('select 1', [], 'query');
  }

  private call(text: string, params: unknown[], mode: 'query' | 'exec'): { rows: Row[]; rowCount: number } {
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage({ text, params, mode });
    const r = Atomics.wait(this.flag, 0, 0, TIMEOUT_MS);
    if (r === 'timed-out') throw new Error(`Postgres não respondeu em ${TIMEOUT_MS} ms`);
    const msg = receiveMessageOnPort(this.port)?.message as { ok: boolean; rows?: Row[]; rowCount?: number; message?: string; code?: string } | undefined;
    if (!msg) throw new Error('resposta do Postgres perdida');
    if (!msg.ok) {
      const err = new Error(msg.message ?? 'erro no Postgres') as Error & { code?: string };
      if (msg.code) err.code = msg.code;
      throw err;
    }
    return { rows: msg.rows ?? [], rowCount: msg.rowCount ?? 0 };
  }

  prepare(sql: string): Statement {
    const t = translate(sql);
    const norm = (params: SqlValue[]) => params.map((p) => (typeof p === 'bigint' ? Number(p) : p));
    return {
      get: (...params) => this.call(t.text, norm(params), 'query').rows[0],
      all: (...params) => this.call(t.text, norm(params), 'query').rows,
      run: (...params) => {
        const res = this.call(t.text, norm(params), 'query');
        const id = t.isInsert ? Number((res.rows[0] as Row | undefined)?.id ?? 0) : 0;
        return { changes: res.rowCount, lastInsertRowid: id };
      },
    };
  }

  exec(sql: string): void {
    this.call(sql, [], 'exec');
  }

  close(): void {
    void this.worker.terminate();
  }
}

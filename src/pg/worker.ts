/**
 * Worker que mantém a conexão com o Postgres e atende as consultas da ponte
 * síncrona (src/pg/sync.ts). Uma conexão só, em série: as consultas chegam uma
 * de cada vez porque o processo principal espera cada resposta.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import pg from 'pg';
import { TxState } from './txstate.js';

// bigint (COUNT, ids) e numeric (SUM) chegam como texto por padrão: o SQLite devolvia número.
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

const { url, sab, port, asyncPort } = workerData as { url: string; sab: SharedArrayBuffer; port: MessagePort; asyncPort: MessagePort };
const flag = new Int32Array(sab);
let client: pg.Client | null = null;
const tx = new TxState();

async function connection(): Promise<pg.Client> {
  if (client) return client;
  const c = new pg.Client({ connectionString: url, application_name: 'nutrolab' });
  c.on('error', () => {
    // Conexão caiu: se havia transação aberta, ela está perdida (TxState responde erro até o ROLLBACK).
    if (client === c) client = null;
    tx.connectionLost();
  });
  await c.connect();
  client = c;
  return c;
}

function replySync(message: unknown): void {
  port.postMessage(message);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

type Msg = { seq: number; id?: number; text: string; params: unknown[]; mode: 'query' | 'exec' };
type Reply = { ok: true; rows: unknown[]; rowCount: number } | { ok: false; message: string; code: string | null };

async function run(msg: Msg): Promise<Reply> {
  const verdict = tx.before(msg.text);
  if (!verdict.run) return verdict.reply === 'ok' ? { ok: true, rows: [], rowCount: 0 } : { ok: false, message: verdict.message, code: 'NUTROLAB_TX_LOST' };
  try {
    const c = await connection();
    const res = msg.mode === 'exec' ? await c.query(msg.text) : await c.query(msg.text, msg.params);
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    tx.after(msg.text);
    return { ok: true, rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 };
  } catch (error) {
    const e = error as { message?: string; code?: string };
    // Erro de conexão (não de SQL): descarta o cliente e, se em transação, marca como perdida.
    const connectionError = !e.code || /^(08|57P0)/.test(e.code) || /terminat|Connection|ECONN|EPIPE/i.test(e.message ?? '');
    if (connectionError) {
      client = null;
      tx.connectionLost();
    }
    return { ok: false, message: e.message ?? String(error), code: e.code ?? null };
  }
}

// Fila única para os dois canais, na ORDEM EM QUE O PROCESSO PRINCIPAL EMITIU (seq):
// mensagens de portas diferentes podem chegar trocadas; aqui ficam em espera até a vez delas.
// A conexão é uma só; BEGIN/COMMIT e a ordem ficam iguais às do SQLite.
let queue: Promise<unknown> = Promise.resolve();
let expected = 1;
const waiting = new Map<number, () => Promise<void>>();
function arrive(seq: number, job: () => Promise<void>): void {
  waiting.set(seq, job);
  while (waiting.has(expected)) {
    const next = waiting.get(expected) as () => Promise<void>;
    waiting.delete(expected);
    expected += 1;
    queue = queue.then(next, next);
  }
}

port.on('message', (msg: Msg) => arrive(msg.seq, async () => replySync(await run(msg))));
asyncPort.on('message', (msg: Msg) => arrive(msg.seq, async () => {
  const r = await run(msg);
  asyncPort.postMessage({ id: msg.id, ...r });
}));

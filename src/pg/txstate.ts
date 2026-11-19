/**
 * Estado de transação da conexão única do worker. Se a conexão cair com uma
 * transação aberta, a transação está PERDIDA: tudo o que vier depois, até um
 * ROLLBACK (ou COMMIT, que também falha), responde erro — nunca reconecta em
 * silêncio e continua fora da transação. Isolado aqui para ser testável.
 */
export type TxVerdict = { run: true } | { run: false; reply: 'ok' | 'error'; message: string };

const BEGIN_RE = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const END_RE = /^\s*(COMMIT|END|ROLLBACK|ABORT)\b/i;
const ROLLBACK_RE = /^\s*(ROLLBACK|ABORT)\b/i;

/** Divide o texto em comandos (ignora `;` dentro de aspas). */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of sql) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export class TxState {
  inTx = false;
  lost = false;

  /** Antes de executar: decide se roda, ou se responde sem tocar no banco. */
  before(sql: string): TxVerdict {
    if (!this.lost) return { run: true };
    const first = statements(sql)[0] ?? '';
    if (ROLLBACK_RE.test(first)) {
      this.lost = false;
      this.inTx = false;
      return { run: false, reply: 'ok', message: 'transação perdida descartada' };
    }
    if (END_RE.test(first)) {
      this.lost = false;
      this.inTx = false;
      return { run: false, reply: 'error', message: 'conexão com o Postgres caiu durante a transação; nada foi confirmado' };
    }
    return { run: false, reply: 'error', message: 'conexão com o Postgres caiu durante a transação; faça ROLLBACK' };
  }

  /** Depois de executar com sucesso: acompanha BEGIN/COMMIT/ROLLBACK. */
  after(sql: string): void {
    for (const s of statements(sql)) {
      if (BEGIN_RE.test(s)) this.inTx = true;
      else if (END_RE.test(s)) this.inTx = false;
    }
  }

  /** Conexão perdida (evento de erro ou falha de rede): marca a transação aberta como perdida. */
  connectionLost(): void {
    if (this.inTx) this.lost = true;
    this.inTx = false;
  }
}

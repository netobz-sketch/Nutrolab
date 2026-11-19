/**
 * Contrato de acesso ao banco usado pelo NutroLab: mesmo SQL (dialeto SQLite,
 * traduzido para o Postgres em src/pg/translate.ts) e mesmos resultados nos dois
 * bancos. Toda consulta da aplicação é assíncrona (`AsyncDb`).
 */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

/** Forma síncrona do `node:sqlite`: só o SQLite local a implementa. */
export interface Statement {
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

export interface AsyncStatement {
  get(...params: SqlValue[]): Promise<Row | undefined>;
  all(...params: SqlValue[]): Promise<Row[]>;
  run(...params: SqlValue[]): Promise<{ changes: number; lastInsertRowid: number }>;
}
export interface AsyncDb {
  prepare(sql: string): AsyncStatement;
  exec(sql: string): Promise<void>;
}

/** Adapta o SQLite (síncrono, local) à API assíncrona, sem mudar o resultado. */
export function asyncOf(db: Db): AsyncDb {
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      return {
        get: async (...p) => st.get(...p),
        all: async (...p) => st.all(...p),
        run: async (...p) => {
          const r = st.run(...p);
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
      };
    },
    exec: async (sql) => db.exec(sql),
  };
}

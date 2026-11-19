/**
 * Tradução do dialeto SQLite usado no NutroLab para Postgres. O código continua
 * escrevendo o SQL de sempre; esta camada ajusta só o que difere:
 *   ?                      → $1, $2…   (fora de literais)
 *   datetime('now')        → texto UTC 'AAAA-MM-DD HH:MM:SS' (mesmo formato do SQLite)
 *   date('now')            → 'AAAA-MM-DD' (UTC)
 *   strftime('%Y-%m-%dT%H:%M:%fZ','now') → ISO com milissegundos e Z
 *   IFNULL(                → COALESCE(
 *   LIKE                   → ILIKE (SQLite compara sem caixa em ASCII)
 * O schema espelha os tipos do SQLite (datas em texto), então os valores
 * gravados e lidos são idênticos nos dois bancos.
 */
const NOW_TS = "to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')";
const NOW_DATE = "to_char(now() at time zone 'UTC', 'YYYY-MM-DD')";
const NOW_ISO = "to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";

export function translateFunctions(sql: string): string {
  return sql
    .replace(/datetime\(\s*'now'\s*\)/gi, NOW_TS)
    .replace(/(?<![a-z_])date\(\s*'now'\s*\)/gi, NOW_DATE)
    .replace(/strftime\(\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*'now'\s*\)/gi, NOW_ISO)
    .replace(/\bIFNULL\s*\(/gi, 'COALESCE(')
    .replace(/\bNOT\s+LIKE\b/gi, 'NOT ILIKE')
    .replace(/(?<!NOT\s)\bLIKE\b/gi, 'ILIKE');
}

/** Troca `?` por `$n`, ignorando o que estiver dentro de literais '…' ou "…". */
export function numberPlaceholders(sql: string): { text: string; count: number } {
  let out = '';
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] as string;
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[i + 1];
          i += 1;
        } else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '?') {
      n += 1;
      out += `$${n}`;
      continue;
    }
    out += ch;
  }
  return { text: out, count: n };
}

/** Tabelas sem coluna `id` (não recebem RETURNING id). */
const NO_ID_TABLES = new Set(['settings']);

export interface Translated {
  text: string;
  isInsert: boolean;
}

export function translate(sql: string): Translated {
  // As funções vêm antes dos placeholders: o formato do to_char tem aspas duplas.
  const fn = translateFunctions(sql.trim().replace(/;\s*$/, ''));
  const { text } = numberPlaceholders(fn);
  const ins = /^\s*INSERT\s+INTO\s+([a-z_]+)/i.exec(text);
  if (ins && ins[1] && !NO_ID_TABLES.has(ins[1].toLowerCase()) && !/\bRETURNING\b/i.test(text)) {
    return { text: `${text} RETURNING id`, isInsert: true };
  }
  return { text, isInsert: !!ins };
}

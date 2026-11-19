/**
 * Validação única dos ids numéricos das rotas (`:id`, `:aid`, `:cid`, `:fid`, `:rid`).
 * Id que não é inteiro positivo vira 404 ANTES de chegar ao banco: no Postgres,
 * `Number('undefined')` = NaN em coluna BIGINT dava erro 22P02 (500); no SQLite só
 * não achava a linha. Ids cabem em 15 dígitos (Number.MAX_SAFE_INTEGER tem 16).
 */
export const NUMERIC_ID_PARAMS = ['id', 'aid', 'cid', 'fid', 'rid'] as const;

const POSITIVE_ID = /^[1-9]\d{0,14}$/;

export function isValidId(value: unknown): boolean {
  return typeof value === 'string' && POSITIVE_ID.test(value);
}

/** Nome do primeiro parâmetro numérico inválido da rota, ou null se todos forem válidos. */
export function invalidIdParam(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const record = params as Record<string, unknown>;
  for (const name of NUMERIC_ID_PARAMS) {
    if (name in record && !isValidId(record[name])) return name;
  }
  return null;
}

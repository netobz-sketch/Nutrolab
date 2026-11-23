/**
 * Serializador `req` do pino: a query string sai com os valores mascarados, menos os parâmetros
 * desta lista (ids, enums, paginação). Busca por nome (`?q=`), mensagem de tela (`?msg=`) e
 * destino (`?next=`) nunca vão para o log; parâmetro novo nasce mascarado. O token de
 * `/redefinir/:token` sai do caminho. Mesmo desenho do log-redact do LN Evolution.
 */
import type { FastifyRequest } from 'fastify';

const SAFE_QUERY: ReadonlySet<string> = new Set(['kind', 'pendentes', 'sistema', 'paciente', 'format', 'type', 'tipo', 'modo', 'from', 'sso', 'retry', 'v']);

export function redactQuery(url: string, safe: ReadonlySet<string> = SAFE_QUERY): string {
  const i = url.indexOf('?');
  if (i < 0) return url;
  const parts = url.slice(i + 1).split('&').filter(Boolean).map((kv) => {
    const eq = kv.indexOf('=');
    const key = eq < 0 ? kv : kv.slice(0, eq);
    let name = key;
    try {
      name = decodeURIComponent(key);
    } catch {
      name = key;
    }
    return safe.has(name) ? kv : `${key}=[redigido]`;
  });
  return `${url.slice(0, i)}?${parts.join('&')}`;
}

export function redactUrl(url: string): string {
  return redactQuery(url.replace(/^\/redefinir\/[^/?#]+/, '/redefinir/[token]'));
}

export function serializeRequest(req: FastifyRequest): Record<string, unknown> {
  return { method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort };
}

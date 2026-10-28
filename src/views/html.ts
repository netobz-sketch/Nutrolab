import type { SessionUser } from '../auth.js';

export function h(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function attr(value: unknown): string {
  return h(value);
}

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1c2430;--muted:#5d6b7b;--line:#e3e7ec;--brand:#0f6e56;--brand-ink:#fff;--warn:#b45309;--danger:#b91c1c;--ok:#15803d;--soft:#eef6f3}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--brand)}header{background:#0b3d30;color:#fff;padding:0 20px}header .bar{max-width:1180px;margin:0 auto;display:flex;align-items:center;gap:18px;height:54px}
header a{color:#d9efe7;text-decoration:none;font-weight:500}header a.brand{color:#fff;font-weight:700;font-size:17px}header .sp{flex:1}header .u{color:#b7d8cc;font-size:13px}
main{max-width:1180px;margin:22px auto;padding:0 20px}h1{font-size:22px;margin:0 0 14px}h2{font-size:17px;margin:22px 0 8px}h3{font-size:15px;margin:16px 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{border-bottom:1px solid var(--line);padding:7px 8px;text-align:left;vertical-align:top}th{background:#f1f4f7;font-weight:600}
td.num,th.num{text-align:right}.muted{color:var(--muted)}.small{font-size:12.5px}
.btn{display:inline-block;background:var(--brand);color:var(--brand-ink);border:0;border-radius:7px;padding:8px 14px;font-weight:600;cursor:pointer;text-decoration:none;font-size:14px}
.btn.sec{background:#fff;color:var(--brand);border:1px solid var(--brand)}.btn.danger{background:var(--danger)}.btn.sm{padding:4px 9px;font-size:12.5px}
form.inline{display:inline}label{display:block;font-weight:600;font-size:13px;margin:10px 0 4px}input,select,textarea{width:100%;padding:8px;border:1px solid #c9d1da;border-radius:7px;font:inherit;background:#fff}
textarea{min-height:90px}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.grid.wide{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:14px}.flash.ok{background:#e8f6ee;color:var(--ok)}.flash.err{background:#fdecec;color:var(--danger)}.flash.warn{background:#fff4e5;color:var(--warn)}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}.tag.ativo{background:#e8f6ee;color:var(--ok)}.tag.rascunho{background:#fff4e5;color:var(--warn)}.tag.inativo{background:#eee;color:#666}
.tag.c-dentro_do_alvo,.tag.c-qualitativo_compativel{background:#e8f6ee;color:var(--ok)}.tag.c-abaixo_do_alvo,.tag.c-acima_do_alvo,.tag.c-qualitativo_nao_compativel{background:#fff4e5;color:var(--warn)}
.tag.c-regra_ambigua,.tag.crit{background:#fdecec;color:var(--danger)}.tag.c-sem_alvo,.tag.c-nao_comparavel{background:#eef1f4;color:#555}
.chips label{display:inline-block;font-weight:500;margin:4px 10px 4px 0}.chips input{width:auto;margin-right:4px}
.report h1{font-size:20px}.report h2{border-bottom:1px solid var(--line);padding-bottom:4px}.report blockquote{border-left:4px solid var(--warn);background:#fff8ec;margin:0;padding:8px 12px}.report table{font-size:12.5px}.report li.cont{list-style:none;margin-left:-16px}
.login{max-width:380px;margin:60px auto}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
@media(max-width:700px){header .bar{gap:10px;overflow-x:auto}main{padding:0 12px}.card{padding:12px}}
`;

export function layout(opts: { title: string; user: SessionUser | null; body: string; flash?: { kind: 'ok' | 'err' | 'warn'; text: string } | null; aiOn?: boolean }): string {
  const nav = opts.user
    ? `<a href="/casos">Casos</a><a href="/regras">Regras</a><a href="/orientacoes">Orientações</a>${opts.user.role === 'admin' ? '<a href="/configuracoes">Configurações</a><a href="/auditoria">Auditoria</a>' : ''}<span class="sp"></span><a class="u" href="/senha" title="Alterar senha">${h(opts.user.name)}${opts.aiOn === false ? ' · IA desligada' : ''}</a><form method="post" action="/logout" class="inline"><button class="btn sec sm" type="submit">Sair</button></form>`
    : '<span class="sp"></span>';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(opts.title)} · NutroLab</title><style>${CSS}</style></head><body>
<header><div class="bar"><a class="brand" href="/casos">NutroLab</a>${nav}</div></header>
<main>${opts.flash ? `<div class="flash ${opts.flash.kind}">${h(opts.flash.text)}</div>` : ''}${opts.body}</main>
</body></html>`;
}

export function statusTag(status: string): string {
  return `<span class="tag ${h(status)}">${h(status)}</span>`;
}

export function option(value: string, label: string, selected: string | null | undefined): string {
  return `<option value="${attr(value)}"${selected === value ? ' selected' : ''}>${h(label)}</option>`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return h(iso);
  const time = iso.length > 10 ? ' ' + iso.slice(11, 16) : '';
  return `${m[3]}/${m[2]}/${m[1]}${time}`;
}

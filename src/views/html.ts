import type { SessionUser } from '../auth.js';
import { getSetting } from '../db.js';

function logoVersion(): string {
  try {
    return getSetting('report.logo', '');
  } catch {
    return '';
  }
}

/** Marca: logo da clínica quando houver, senão o símbolo padrão. */
export function brandMark(size: 'nav' | 'login' = 'nav'): string {
  const v = logoVersion();
  if (!v) return `<span class="logo">${icon('logo')}</span><span>LN Medicina Integrada<small>Exames</small></span>`;
  const h = size === 'login' ? 110 : 54;
  return `<span style="display:flex;flex-direction:column;gap:6px;width:100%"><span class="brandimg" style="height:${h}px"><img src="/branding/logo?v=${v}" alt="Logo da clínica" style="max-height:${h - 10}px;max-width:${size === 'login' ? 260 : 190}px"></span><span style="font-size:12px;font-weight:600;color:var(--muted);text-align:center">LN Medicina Integrada · Exames</span></span>`;
}

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

/*
 * Design System LN Medicina Integrada — tokens LN v1.0.0, ln-evolution-web 61b072f
 * (src/design/tokens.json). Só tema claro (decisão do Dr. Leônidas em 19/11/2026).
 * Inter servida localmente (/assets/fonts), sem chamada a terceiros nas telas com dado de saúde.
 */
const CSS = `
@font-face{font-family:'Inter';font-style:normal;font-weight:400 700;font-display:swap;src:url(/assets/fonts/inter-latin-400-700.woff2) format('woff2')}
:root{
  color-scheme:light;
  --white:#ffffff;--ink-900:#111111;--ink-800:#1f1f1f;--ink-700:#333333;
  --g50:#fafafa;--g100:#f4f4f5;--g200:#e5e5e7;--g300:#d4d4d8;--g400:#a1a1aa;--g500:#71717a;--g600:#52525b;--g700:#3f3f46;
  --positive:#2f7d4f;--positive-soft:#e8f3ec;--positive-strong:#1f5d3a;
  --attention:#8a6d1f;--attention-soft:#f7f1dc;
  --negative:#8b2f2f;--negative-soft:#f6e7e7;
  --bg:var(--g50);--card:var(--white);--ink:var(--ink-900);--muted:var(--g500);--line:var(--g200);--line2:var(--g100);--thead:var(--g50);
  --brand:var(--ink-900);--brand-soft:var(--g100);--brand-ink:var(--white);
  --ok:var(--positive);--ok-soft:var(--positive-soft);--warn:var(--attention);--warn-soft:var(--attention-soft);--danger:var(--negative);--danger-soft:var(--negative-soft);
  --neutral:var(--g700);--neutral-soft:var(--g100);
  --nav-bg:var(--white);--nav-ink:var(--g600);--nav-active:var(--white);--nav-active-bg:var(--ink-900);--nav-hover-bg:var(--g100);
  --field:var(--white);--field-line:var(--g300);
  --radius:1.125rem;--radius-sm:0.875rem;
  --shadow:0 1px 2px rgba(17,17,17,0.04), 0 4px 16px rgba(17,17,17,0.04);
  --focus:rgba(17,17,17,0.10);--focus-strong:rgba(17,17,17,0.20);
  --font:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --num:inherit;
}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;font:14px/1.5 var(--font);background:var(--bg);color:var(--ink)}
a{color:var(--brand)}
h1{font-size:24px;font-weight:700;letter-spacing:-.015em;margin:0 0 4px}
h2{font-size:16px;font-weight:700;margin:22px 0 10px}
h3{font-size:14px;font-weight:700;margin:16px 0 6px}
.muted{color:var(--muted)}.small{font-size:12.5px}.num{font-family:var(--num);font-variant-numeric:tabular-nums}
.shell{display:flex;min-height:100vh}
.sidenav{flex:0 0 256px;background:var(--nav-bg);border-right:1px solid var(--line);padding:20px 14px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:10px;padding:6px 8px 18px;color:var(--ink);text-decoration:none;font-weight:700;font-size:15px;letter-spacing:-.01em;line-height:1.2}
.brand small{display:block;font-weight:500;font-size:12px;color:var(--muted)}
.brandimg{display:flex;align-items:center;justify-content:center;background:var(--white);border-radius:var(--radius-sm);padding:5px 10px;border:1px solid var(--line);width:100%}
.brand .logo{width:32px;height:32px;flex:0 0 32px;border-radius:10px;background:var(--brand);display:flex;align-items:center;justify-content:center;color:var(--brand-ink)}
.sidenav a.item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius-sm);color:var(--nav-ink);font-weight:500;text-decoration:none;min-height:44px}
.sidenav a.item:hover{background:var(--nav-hover-bg);color:var(--ink)}
.sidenav a.item.active{background:var(--nav-active-bg);color:var(--nav-active);font-weight:600}
.sidenav a.item.active:hover{background:var(--nav-active-bg);color:var(--nav-active)}
.sidenav .foot{margin-top:auto;border-top:1px solid var(--line);padding:14px 8px 0;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.sidenav .foot a{color:var(--muted);text-decoration:none}
.sidenav .foot .name{font-weight:600;color:var(--ink);font-size:13px;text-decoration:none}
main{flex:1 1 auto;min-width:0;padding:28px 36px 56px;max-width:80rem}
.topbar{display:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px 22px;margin-bottom:16px;box-shadow:var(--shadow)}
.card.flush{padding:0;overflow:hidden}
.card.flush .card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:16px 20px;border-bottom:1px solid var(--line)}
.card.flush .card-head h2{margin:0}
.card.flush .card-body{padding:14px 22px}
.card.flush table th:first-child,.card.flush table td:first-child{padding-left:22px}
.card.flush table th:last-child,.card.flush table td:last-child{padding-right:22px}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{border-top:1px solid var(--line2);padding:10px 10px;text-align:left;vertical-align:top}
thead th{border-top:0;background:var(--thead);color:var(--muted);font-weight:600;font-size:12px}
td.num,th.num{text-align:right}
tr.attention{background:var(--warn-soft)}
.crumbs{font-size:12.5px;color:var(--muted);font-weight:500;margin-bottom:4px}
.crumbs a{color:var(--muted);text-decoration:none}
.pagehead{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;justify-content:space-between;margin-bottom:18px}
.pagehead .sub{color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--brand);color:var(--brand-ink);border:0;border-radius:var(--radius-sm);min-height:38px;padding:0 15px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover{background:var(--ink-800)}
.btn:focus-visible,a.item:focus-visible{outline:none;box-shadow:0 0 0 2px var(--focus-strong)}
.btn.sec{background:var(--card);color:var(--ink);border:1px solid var(--field-line)}
.btn.sec:hover,.btn.danger:hover{background:var(--g100)}
.btn.soft{background:var(--positive-soft);color:var(--positive-strong);border:1px solid var(--positive)}
.btn.soft:hover{background:#dcefe3}
.btn.danger{background:var(--card);color:var(--danger);border:1px solid var(--field-line)}
.btn.sm{min-height:32px;padding:0 11px;font-size:12.5px}
.btn:disabled{opacity:.5;cursor:default}
form.inline{display:inline}
label{display:block;font-weight:500;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.025em;margin:10px 0 4px;color:var(--muted)}
.chips label,label.plain{text-transform:none;letter-spacing:0;font-size:13.5px}
input,select,textarea{width:100%;padding:0.5rem 0.75rem;border:1px solid var(--field-line);border-radius:var(--radius-sm);font:inherit;font-size:0.875rem;background:var(--field);color:var(--ink);min-height:40px}
input::placeholder,textarea::placeholder{color:var(--g400)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--g500);box-shadow:0 0 0 2px var(--focus)}
input:disabled,select:disabled,textarea:disabled,input[readonly],textarea[readonly]{background:var(--g50);color:var(--g500)}
input[type=file]{min-height:0;padding:0;border:0;background:none}
input[type=checkbox]{width:auto;min-height:0}
textarea{min-height:90px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.grid.wide{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.refrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 14px;border-top:1px solid var(--line2)}
.refrow:first-child{border-top:0}
.refname{flex:1 1 220px;min-width:0}
.refband{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.refactions{display:flex;align-items:center;gap:6px;flex:0 0 auto;margin-left:auto}
@media (max-width:720px){.refactions{margin-left:0;width:100%}}
.bands6{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
@media (max-width:720px){.bands6{grid-template-columns:repeat(3,minmax(0,1fr))}}
.kpis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px;display:flex;flex-direction:column;gap:3px}
.kpi .k{font-size:0.75rem;color:var(--muted);font-weight:500;letter-spacing:.025em;text-transform:uppercase}
.kpi .v{font-size:26px;font-weight:700;letter-spacing:-.02em;font-family:var(--num);line-height:1.1}
.kpi .d{font-size:12px;color:var(--muted)}
.kpi.ok .v{color:var(--ok)}.kpi.warn .v{color:var(--warn)}.kpi.danger .v{color:var(--danger)}.kpi.danger{border-color:var(--danger)}
.facts{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.facts .k{font-size:12px;color:var(--muted);font-weight:500}.facts .v{font-weight:600}
.flash{padding:10px 14px;border-radius:var(--radius-sm);margin-bottom:14px;border:1px solid transparent}
.flash.ok{background:var(--ok-soft);color:var(--ok)}.flash.err{background:var(--danger-soft);color:var(--danger)}.flash.warn{background:var(--warn-soft);color:var(--warn)}
.flash a{color:inherit}
.tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.tag.ativo,.tag.revisado{background:var(--ok-soft);color:var(--ok)}.tag.rascunho,.tag.aberto{background:var(--warn-soft);color:var(--warn)}.tag.inativo,.tag.arquivado{background:var(--neutral-soft);color:var(--neutral)}
.tag.c-dentro_do_alvo,.tag.c-qualitativo_compativel{background:var(--ok-soft);color:var(--ok)}
.tag.c-abaixo_do_alvo,.tag.c-acima_do_alvo,.tag.c-qualitativo_nao_compativel{background:var(--warn-soft);color:var(--warn)}
.tag.c-regra_ambigua,.tag.crit{background:var(--danger-soft);color:var(--danger)}
.tag.c-sem_alvo,.tag.c-nao_comparavel{background:var(--neutral-soft);color:var(--neutral)}
.lab{font-size:11px;font-weight:600;padding:1px 6px;border-radius:6px;background:var(--danger-soft);color:var(--danger)}
.chips label{display:inline-flex;align-items:center;gap:6px;font-weight:500;margin:4px 12px 4px 0;color:var(--ink)}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.two{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line2)}
.row:first-of-type{border-top:0}
.note{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:var(--radius-sm);background:var(--thead);font-size:13px;color:var(--muted)}
.note svg{flex:0 0 auto;color:var(--warn)}
.fileicon{width:40px;height:40px;border-radius:10px;background:var(--danger-soft);display:flex;align-items:center;justify-content:center;color:var(--danger);flex:0 0 auto}
.report h1{font-size:20px}.report h2{border-bottom:1px solid var(--line);padding-bottom:4px}
.report blockquote{border-left:4px solid var(--warn);background:var(--warn-soft);color:var(--ink);margin:0;padding:8px 12px;border-radius:0 8px 8px 0}
.report table{font-size:12.5px}.report li.cont{list-style:none;margin-left:-16px}.report code{background:var(--neutral-soft);padding:1px 5px;border-radius:4px}
details summary{cursor:pointer;font-weight:600}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.login{width:100%;max-width:400px}
.login .brand{justify-content:center;padding-bottom:10px}
@media (max-width: 860px){
  .shell{display:block}
  .sidenav{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:4px;padding:10px 12px;border-right:0;border-bottom:1px solid var(--line)}
  .brand{padding:4px 8px}
  .sidenav a.item{padding:8px 10px;min-height:40px}
  .sidenav a.item span{display:none}
  .sidenav .foot{margin-top:0;margin-left:auto;border-top:0;padding:0;flex-direction:row;align-items:center;gap:8px}
  .sidenav .foot .role{display:none}
  main{padding:18px 16px 40px}
  .card{padding:14px 16px}
  .card.flush .card-head,.card.flush .card-body{padding-left:16px;padding-right:16px}
}
`;

const ICONS: Record<string, string> = {
  cases: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/></svg>',
  rules: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  guidance: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  settings: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
  audit: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>',
  report: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>',
  external: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/></svg>',
  pill: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7z"/><path d="m8.5 8.5 7 7"/></svg>',
  patients: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  template: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  logo: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v6l4 9a2 2 0 0 1-2 3H7a2 2 0 0 1-2-3l4-9z"/><path d="M8 15h8"/></svg>',
  theme: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9c0-.5 0-.9-.1-1.4A5.5 5.5 0 0 1 12 3z"/></svg>',
  warn: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  file: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
};

export function icon(name: keyof typeof ICONS): string {
  return ICONS[name] ?? '';
}

const PRINT_CSS = `
@font-face{font-family:'Inter';font-weight:400 700;src:url(/assets/fonts/inter-latin-400-700.woff2) format('woff2')}
*{box-sizing:border-box}body{margin:0;background:#fff;color:#111111;font:11pt/1.55 Inter,ui-sans-serif,system-ui,sans-serif}
.toolbar{display:flex;gap:12px;align-items:center;padding:12px 20px;border-bottom:1px solid #ddd;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f6f6}
.toolbar button{font:inherit;font-weight:600;padding:8px 14px;border-radius:8px;border:1px solid #333;background:#fff;cursor:pointer}
main.report{max-width:820px;margin:0 auto;padding:32px 24px 60px}
.report h1{font-size:20pt;margin:0 0 6px}.report h2{font-size:14pt;margin:22px 0 8px;border-bottom:1px solid #333;padding-bottom:3px}.report h3{font-size:12.5pt;margin:14px 0 4px}
.report blockquote{margin:0 0 12px;padding:8px 12px;border-left:3px solid #999;background:#f3f3f3;font-style:italic}
.report table{width:100%;border-collapse:collapse;font-size:9.5pt;margin:8px 0}.report th,.report td{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}.report th{background:#eee}
.report code{font-family:Menlo,Consolas,monospace;font-size:10pt}
@media print{.toolbar{display:none}main.report{max-width:none;padding:0}@page{margin:18mm 16mm}}
`;


export function layout(opts: { title: string; user: SessionUser | null; body: string; flash?: { kind: 'ok' | 'err' | 'warn'; text: string } | null; aiOn?: boolean; active?: string; bare?: boolean; print?: boolean }): string {
  if (opts.print) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(opts.title)}</title><style>${PRINT_CSS}</style></head><body><div class="toolbar"><button type="button" onclick="window.print()">Imprimir / salvar em PDF</button><a href="javascript:history.back()">Voltar</a></div><main class="report">${opts.body}</main></body></html>`;
  }
  const head = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${h(opts.title)} · LN Medicina Integrada · Exames</title><style>${CSS}</style></head>`;
  const flash = opts.flash ? `<div class="flash ${opts.flash.kind}">${h(opts.flash.text)}</div>` : '';
  if (!opts.user || opts.bare) {
    return `${head}<body><div class="login-wrap"><div class="login">${flash}${opts.body}</div></div></body></html>`;
  }
  const item = (href: string, key: string, label: string, ic: keyof typeof ICONS) => `<a class="item${opts.active === key ? ' active' : ''}" href="${href}">${icon(ic)}<span>${label}</span></a>`;
  const admin = opts.user.role === 'admin';
  return `${head}<body><div class="shell">
<nav class="sidenav" aria-label="Principal">
<a class="brand" href="/casos" style="flex-wrap:wrap">${brandMark('nav')}</a>
${item('/pacientes', 'pacientes', 'Pacientes', 'patients')}
${item('/casos', 'casos', 'Casos', 'cases')}
${item('/regras', 'regras', 'Referências dos exames', 'rules')}
${item('/orientacoes', 'orientacoes', 'Orientações', 'guidance')}
${item('/formulas', 'formulas', 'Fórmulas', 'pill')}
${item('/modelos', 'modelos', 'Modelos de conduta', 'template')}
${item('/relatorios', 'relatorios', 'Relatórios', 'report')}
<a class="item" href="https://www.openevidence.com/" target="_blank" rel="noopener">${icon('external')}<span>OpenEvidence</span></a>
${admin ? item('/configuracoes', 'configuracoes', 'Configurações', 'settings') : ''}
${admin ? item('/auditoria', 'auditoria', 'Auditoria', 'audit') : ''}
<div class="foot">
<a class="name" href="/perfil" title="Meu cadastro">${h(opts.user.name)}</a>
<span class="role muted">${admin ? 'Administrador' : 'Médico'} · IA ${opts.aiOn === false ? 'desligada' : 'ligada'}</span>
<form method="post" action="/logout" class="inline"><button class="btn sec sm" type="submit">Sair</button></form>
</div>
</nav>
<main>${flash}${opts.body}</main>
</div></body></html>`;
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

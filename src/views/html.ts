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

/*
 * Tema claro = "Clínico sereno" (opção 1); tema escuro = "Cockpit" (opção 3).
 * Tokens em :root; o escuro vale por preferência do sistema ou por escolha
 * explícita (data-theme), guardada em localStorage pelo botão do menu.
 */
const CSS = `
:root{
  --bg:#f4f6f8;--card:#fff;--ink:#16202a;--muted:#5b6977;--line:#e4e9ee;--line2:#edf1f4;--thead:#f8fafb;
  --brand:#0d6b55;--brand-soft:#e6f4ef;--brand-ink:#fff;
  --ok:#0d6b55;--ok-soft:#e6f4ef;--warn:#9a5b00;--warn-soft:#fff3df;--danger:#b42318;--danger-soft:#fdecec;
  --neutral:#3d4b58;--neutral-soft:#eef1f4;
  --nav-bg:#fff;--nav-ink:#3d4b58;--nav-active:#0d6b55;--nav-active-bg:#e6f4ef;
  --field:#fff;--field-line:#c9d1da;--radius:14px;--radius-sm:9px;
  --font:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --num:inherit;--shadow:none;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#0d1420;--card:#121b28;--ink:#e6ecf3;--muted:#7c8da3;--line:#1c2736;--line2:#1c2736;--thead:#0f1824;
  --brand:#14b8a6;--brand-soft:#0f2a26;--brand-ink:#06231f;
  --ok:#5eead4;--ok-soft:#0f2a26;--warn:#fbbf24;--warn-soft:#2a2210;--danger:#fca5a5;--danger-soft:#3a1518;
  --neutral:#a8b5c6;--neutral-soft:#1a2230;
  --nav-bg:#0a1019;--nav-ink:#7c8da3;--nav-active:#5eead4;--nav-active-bg:#15202e;
  --field:#0f1824;--field-line:#2a3647;--radius:12px;--radius-sm:8px;
  --num:ui-monospace,"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;
}}
:root[data-theme="dark"]{
  --bg:#0d1420;--card:#121b28;--ink:#e6ecf3;--muted:#7c8da3;--line:#1c2736;--line2:#1c2736;--thead:#0f1824;
  --brand:#14b8a6;--brand-soft:#0f2a26;--brand-ink:#06231f;
  --ok:#5eead4;--ok-soft:#0f2a26;--warn:#fbbf24;--warn-soft:#2a2210;--danger:#fca5a5;--danger-soft:#3a1518;
  --neutral:#a8b5c6;--neutral-soft:#1a2230;
  --nav-bg:#0a1019;--nav-ink:#7c8da3;--nav-active:#5eead4;--nav-active-bg:#15202e;
  --field:#0f1824;--field-line:#2a3647;--radius:12px;--radius-sm:8px;
  --num:ui-monospace,"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;
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
.sidenav{flex:0 0 232px;background:var(--nav-bg);border-right:1px solid var(--line);padding:20px 14px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:10px;padding:6px 8px 18px;color:var(--ink);text-decoration:none;font-weight:700;font-size:16px;letter-spacing:-.01em}
.brand .logo{width:32px;height:32px;border-radius:9px;background:var(--brand);display:flex;align-items:center;justify-content:center;color:var(--brand-ink)}
.sidenav a.item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius-sm);color:var(--nav-ink);font-weight:500;text-decoration:none;min-height:44px}
.sidenav a.item:hover{background:var(--nav-active-bg)}
.sidenav a.item.active{background:var(--nav-active-bg);color:var(--nav-active);font-weight:600}
.sidenav .foot{margin-top:auto;border-top:1px solid var(--line);padding:14px 8px 0;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.sidenav .foot a{color:var(--muted);text-decoration:none}
.sidenav .foot .name{font-weight:600;color:var(--ink);font-size:13px;text-decoration:none}
.theme-btn{display:inline-flex;align-items:center;gap:8px;background:none;border:1px solid var(--line);border-radius:var(--radius-sm);padding:7px 10px;color:var(--muted);font:inherit;font-size:12.5px;cursor:pointer;min-height:36px}
.theme-btn:hover{color:var(--ink)}
main{flex:1 1 auto;min-width:0;padding:28px 36px 56px;max-width:1240px}
.topbar{display:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px 22px;margin-bottom:16px;box-shadow:var(--shadow)}
.card.flush{padding:0;overflow:hidden}
.card.flush .card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:14px 22px;border-bottom:1px solid var(--line)}
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
.btn:hover{filter:brightness(.95)}
.btn.sec{background:var(--card);color:var(--ink);border:1px solid var(--field-line)}
.btn.soft{background:var(--brand-soft);color:var(--brand);border:1px solid var(--brand)}
.btn.danger{background:var(--card);color:var(--danger);border:1px solid var(--field-line)}
.btn.sm{min-height:32px;padding:0 11px;font-size:12.5px}
.btn:disabled{opacity:.5;cursor:default}
form.inline{display:inline}
label{display:block;font-weight:600;font-size:12.5px;margin:10px 0 4px;color:var(--muted)}
input,select,textarea{width:100%;padding:9px 10px;border:1px solid var(--field-line);border-radius:var(--radius-sm);font:inherit;background:var(--field);color:var(--ink);min-height:40px}
input[type=file]{min-height:0;padding:0;border:0;background:none}
input[type=checkbox]{width:auto;min-height:0}
textarea{min-height:90px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.grid.wide{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.kpis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;display:flex;flex-direction:column;gap:3px}
.kpi .k{font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.02em}
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
  logo: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v6l4 9a2 2 0 0 1-2 3H7a2 2 0 0 1-2-3l4-9z"/><path d="M8 15h8"/></svg>',
  theme: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9c0-.5 0-.9-.1-1.4A5.5 5.5 0 0 1 12 3z"/></svg>',
  warn: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  file: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
};

export function icon(name: keyof typeof ICONS): string {
  return ICONS[name] ?? '';
}

const PRINT_CSS = `
*{box-sizing:border-box}body{margin:0;background:#fff;color:#111;font:12.5pt/1.5 Georgia,"Times New Roman",serif}
.toolbar{display:flex;gap:12px;align-items:center;padding:12px 20px;border-bottom:1px solid #ddd;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f6f6}
.toolbar button{font:inherit;font-weight:600;padding:8px 14px;border-radius:8px;border:1px solid #333;background:#fff;cursor:pointer}
main.report{max-width:820px;margin:0 auto;padding:32px 24px 60px}
.report h1{font-size:20pt;margin:0 0 6px}.report h2{font-size:14pt;margin:22px 0 8px;border-bottom:1px solid #333;padding-bottom:3px}.report h3{font-size:12.5pt;margin:14px 0 4px}
.report blockquote{margin:0 0 12px;padding:8px 12px;border-left:3px solid #999;background:#f3f3f3;font-style:italic}
.report table{width:100%;border-collapse:collapse;font-size:9.5pt;margin:8px 0}.report th,.report td{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}.report th{background:#eee}
.report code{font-family:Menlo,Consolas,monospace;font-size:10pt}
@media print{.toolbar{display:none}main.report{max-width:none;padding:0}@page{margin:18mm 16mm}}
`;

const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('nl-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})();
function nlToggleTheme(){var h=document.documentElement;var cur=h.getAttribute('data-theme');var sysDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;var eff=cur||(sysDark?'dark':'light');var next=eff==='dark'?'light':'dark';h.setAttribute('data-theme',next);try{localStorage.setItem('nl-theme',next)}catch(e){}}`;

export function layout(opts: { title: string; user: SessionUser | null; body: string; flash?: { kind: 'ok' | 'err' | 'warn'; text: string } | null; aiOn?: boolean; active?: string; bare?: boolean; print?: boolean }): string {
  if (opts.print) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(opts.title)}</title><style>${PRINT_CSS}</style></head><body><div class="toolbar"><button type="button" onclick="window.print()">Imprimir / salvar em PDF</button><a href="javascript:history.back()">Voltar</a></div><main class="report">${opts.body}</main></body></html>`;
  }
  const head = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${h(opts.title)} · NutroLab</title><script>${THEME_SCRIPT}</script><style>${CSS}</style></head>`;
  const flash = opts.flash ? `<div class="flash ${opts.flash.kind}">${h(opts.flash.text)}</div>` : '';
  if (!opts.user || opts.bare) {
    return `${head}<body><div class="login-wrap"><div class="login">${flash}${opts.body}</div></div></body></html>`;
  }
  const item = (href: string, key: string, label: string, ic: keyof typeof ICONS) => `<a class="item${opts.active === key ? ' active' : ''}" href="${href}">${icon(ic)}<span>${label}</span></a>`;
  const admin = opts.user.role === 'admin';
  return `${head}<body><div class="shell">
<nav class="sidenav" aria-label="Principal">
<a class="brand" href="/casos"><span class="logo">${icon('logo')}</span>NutroLab</a>
${item('/casos', 'casos', 'Casos', 'cases')}
${item('/regras', 'regras', 'Exames e referências', 'rules')}
${item('/orientacoes', 'orientacoes', 'Orientações', 'guidance')}
${admin ? item('/configuracoes', 'configuracoes', 'Configurações', 'settings') : ''}
${admin ? item('/auditoria', 'auditoria', 'Auditoria', 'audit') : ''}
<div class="foot">
<a class="name" href="/perfil" title="Meu cadastro">${h(opts.user.name)}</a>
<span class="role muted">${admin ? 'Administrador' : 'Médico'} · IA ${opts.aiOn === false ? 'desligada' : 'ligada'}</span>
<button type="button" class="theme-btn" onclick="nlToggleTheme()" aria-label="Alternar tema claro e escuro">${icon('theme')}Tema</button>
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

/**
 * Painel visual do relatório resumido (tela e PDF). Cores fixas para imprimir
 * igual nos dois temas. Só usa o que o motor já classificou; nada é calculado aqui.
 */
import { CLASSIFICATION_LABEL, gaugeSvg, SYSTEMS } from './engine/index.js';
import type { Evaluation, Score } from './engine/index.js';
import { h } from './views/html.js';

const C = { red: '#ef4444', amber: '#f59e0b', green: '#22c55e', ink: '#1f2937', muted: '#6b7280', line: '#e5e7eb', soft: '#f3f4f6' };

function miniGauge(score: number, size = 96): string {
  const r = size / 2 - 8;
  const cx = size / 2;
  const cy = size / 2 + 2;
  const arc = (from: number, to: number, color: string) => {
    const a1 = Math.PI * (1 - from);
    const a2 = Math.PI * (1 - to);
    return `<path d="M ${(cx + r * Math.cos(a1)).toFixed(1)} ${(cy - r * Math.sin(a1)).toFixed(1)} A ${r} ${r} 0 0 1 ${(cx + r * Math.cos(a2)).toFixed(1)} ${(cy - r * Math.sin(a2)).toFixed(1)}" fill="none" stroke="${color}" stroke-width="9"/>`;
  };
  const a = Math.PI * (1 - score / 100);
  const color = score >= 80 ? '#15803d' : score >= 60 ? '#b45309' : '#b91c1c';
  return `<svg role="img" aria-label="Score ${score} de 100" viewBox="0 0 ${size} ${size / 2 + 22}" width="${size}" height="${size / 2 + 22}" style="max-width:100%;height:auto">${arc(0, 0.6, C.red)}${arc(0.6, 0.8, C.amber)}${arc(0.8, 1, C.green)}<line x1="${cx}" y1="${cy}" x2="${(cx + (r - 1) * Math.cos(a)).toFixed(1)}" y2="${(cy - (r - 1) * Math.sin(a)).toFixed(1)}" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="4" fill="${C.ink}"/><text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="16" font-weight="700" fill="${color}">${score}</text></svg>`;
}

function bandLabel(score: number): string {
  return score >= 80 ? 'Ótimo' : score >= 60 ? 'Bom, com ajustes' : 'Merece atenção';
}

/** Posição do valor numa barra com as faixas da regra (crítico/normal/ótimo). */
function examBar(ev: Evaluation): string {
  const r = ev.rule;
  const value = ev.converted ? ev.converted.value : ev.parsed.number;
  if (!r || value === null || ev.parsed.kind !== 'numeric') return '';
  const n = ev.normal;
  const tl = r.target_min ?? n?.min ?? null;
  const th = r.target_max ?? n?.max ?? null;
  const nl = n?.min ?? r.normal_min;
  const nh = n?.max ?? r.normal_max;
  const pts = [r.critical_low, nl, tl, th, nh, r.critical_high, value].filter((v): v is number => v !== null && Number.isFinite(v));
  if (pts.length < 2) return '';
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || Math.abs(hi) || 1;
  const left = lo - span * 0.12;
  const total = span * 1.24;
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - left) / total) * 100));
  const gL = tl !== null ? pct(tl) : nl !== null ? pct(nl) : 0;
  const gR = th !== null ? pct(th) : nh !== null ? pct(nh) : 100;
  const aL = nl !== null ? pct(nl) : gL;
  const aR = nh !== null ? pct(nh) : gR;
  const seg = (a: number, b: number, color: string) => `<div style="width:${Math.max(0, b - a).toFixed(2)}%;background:${color}"></div>`;
  const marker = pct(value);
  return `<div style="position:relative;height:22px;margin-top:6px"><div style="display:flex;height:10px;border-radius:5px;overflow:hidden">${seg(0, aL, C.red)}${seg(aL, gL, C.amber)}${seg(gL, gR, C.green)}${seg(gR, aR, C.amber)}${seg(aR, 100, C.red)}</div><div aria-hidden="true" style="position:absolute;left:${marker.toFixed(2)}%;top:-4px;width:4px;height:18px;margin-left:-2px;border-radius:2px;background:${C.ink};border:1px solid #fff"></div></div>`;
}

function friendly(ev: Evaluation): { text: string; color: string } {
  if (ev.critical) return { text: ev.critical === 'baixo' ? 'muito abaixo: atenção' : 'muito acima: atenção', color: '#b91c1c' };
  switch (ev.classification) {
    case 'dentro_do_alvo':
    case 'qualitativo_compativel':
      return { text: 'no ideal', color: '#15803d' };
    case 'abaixo_do_alvo':
      return { text: ev.normality === 'dentro' ? 'um pouco abaixo do ideal' : 'abaixo do esperado', color: ev.normality === 'dentro' ? '#b45309' : '#b91c1c' };
    case 'acima_do_alvo':
      return { text: ev.normality === 'dentro' ? 'um pouco acima do ideal' : 'acima do esperado', color: ev.normality === 'dentro' ? '#b45309' : '#b91c1c' };
    case 'qualitativo_nao_compativel':
      return { text: 'resultado a conversar', color: '#b45309' };
    default:
      return { text: 'sem meta definida', color: C.muted };
  }
}

export function patientVisualPanel(score: Score, evals: Evaluation[]): string {
  const comparable = evals.filter((e) => e.rule && e.classification !== 'sem_alvo' && e.classification !== 'nao_comparavel' && e.classification !== 'regra_ambigua');
  const ok = comparable.filter((e) => e.classification === 'dentro_do_alvo' || e.classification === 'qualitativo_compativel').length;
  const near = comparable.filter((e) => (e.classification === 'abaixo_do_alvo' || e.classification === 'acima_do_alvo') && e.normality === 'dentro' && !e.critical).length;
  const far = comparable.length - ok - near;
  const style = `font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${C.ink}`;
  const tile = (n: number, label: string, color: string) => `<div style="flex:1 1 120px;min-width:0;background:${C.soft};border-radius:10px;padding:10px 12px;text-align:center"><div style="font-size:26px;font-weight:700;color:${color};line-height:1.1">${n}</div><div style="font-size:12px;color:${C.muted}">${label}</div></div>`;
  const head = `<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:center;margin-bottom:14px"><div>${gaugeSvg(score.total, 220)}</div><div style="display:flex;gap:10px;flex-wrap:wrap;flex:1 1 280px">${tile(ok, 'no ideal', '#15803d')}${tile(near, 'perto do ideal', '#b45309')}${tile(far, 'fora do esperado', '#b91c1c')}</div></div>`;
  const legend = `<div style="font-size:12px;color:${C.muted};display:flex;gap:14px;flex-wrap:wrap;justify-content:center;margin-bottom:16px"><span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${C.green};vertical-align:-2px"></span> faixa ideal</span><span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${C.amber};vertical-align:-2px"></span> normal, mas fora do ideal</span><span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${C.red};vertical-align:-2px"></span> fora do esperado</span><span><span style="display:inline-block;width:4px;height:14px;border-radius:2px;background:${C.ink};vertical-align:-3px"></span> seu resultado</span></div>`;
  const systems = score.bySystem.map((s) => {
    const items = comparable.filter((e) => (e.rule?.system ?? 'outros') === s.system);
    const rows = items.map((e) => {
      const f = friendly(e);
      const name = e.result.exam_raw;
      const val = `${e.result.value_raw}${e.result.unit_raw ? ` ${e.result.unit_raw}` : ''}`;
      return `<div style="padding:8px 0;border-top:1px solid ${C.line}"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><span style="font-weight:600;font-size:13.5px">${h(name)}</span><span style="font-size:13px;white-space:nowrap"><b>${h(val)}</b> · <span style="color:${f.color}">${f.text}</span></span></div>${examBar(e)}</div>`;
    }).join('');
    return `<div style="break-inside:avoid;background:#fff;border:1px solid ${C.line};border-radius:12px;padding:12px 14px;min-width:0"><div style="display:flex;gap:12px;align-items:center"><div>${miniGauge(s.score)}</div><div style="min-width:0"><div style="font-weight:700;font-size:15px">${h(s.label)}</div><div style="font-size:12.5px;color:${s.score >= 80 ? '#15803d' : s.score >= 60 ? '#b45309' : '#b91c1c'};font-weight:600">${bandLabel(s.score)}</div><div style="font-size:12px;color:${C.muted}">${s.n} exame${s.n === 1 ? '' : 's'}</div></div></div>${rows}</div>`;
  }).join('');
  return `<section aria-label="Painel visual" style="${style}">${head}${legend}<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:22px">${systems}</div></section>`;
}

export function classificationWord(ev: Evaluation): string {
  return CLASSIFICATION_LABEL[ev.classification];
}
export const SYSTEM_LABELS = SYSTEMS;

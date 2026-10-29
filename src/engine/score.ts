import { SYSTEMS } from './types.js';
import type { Evaluation, Score, ScoreItem } from './types.js';

/**
 * Score 0–100 determinístico. Cada resultado comparável vale de 0 a 1:
 *   dentro do alvo ótimo .......... 1,00
 *   fora do ótimo, dentro do normal  0,60
 *   fora do normal ................ 0,25
 *   além de limite crítico ........ 0,00
 * Resultados sem alvo, não comparáveis ou ambíguos não entram. Sem itens → null.
 */
export function pointsFor(ev: Evaluation): ScoreItem | null {
  if (!ev.exam_canonical || !ev.rule) return null;
  const system = ev.rule.system || 'outros';
  const base = { exam: ev.exam_canonical, system };
  if (ev.critical) return { ...base, points: 0, reason: `além do limite crítico (${ev.critical})` };
  switch (ev.classification) {
    case 'dentro_do_alvo':
    case 'qualitativo_compativel':
      return { ...base, points: 1, reason: 'dentro do alvo ótimo' };
    case 'qualitativo_nao_compativel':
      return { ...base, points: 0.25, reason: 'resultado qualitativo não compatível' };
    case 'abaixo_do_alvo':
    case 'acima_do_alvo':
      if (ev.normality === 'dentro') return { ...base, points: 0.6, reason: 'fora do ótimo, dentro da normalidade' };
      if (ev.normality === 'abaixo' || ev.normality === 'acima') return { ...base, points: 0.25, reason: 'fora da normalidade' };
      return { ...base, points: 0.5, reason: 'fora do ótimo; normalidade não avaliável' };
    default:
      return null;
  }
}

export function computeScore(evals: Evaluation[]): Score {
  const items = evals.map(pointsFor).filter((i): i is ScoreItem => i !== null);
  const bySystemMap = new Map<string, { sum: number; n: number }>();
  for (const it of items) {
    const cur = bySystemMap.get(it.system) ?? { sum: 0, n: 0 };
    cur.sum += it.points;
    cur.n += 1;
    bySystemMap.set(it.system, cur);
  }
  const bySystem = [...bySystemMap.entries()]
    .map(([system, { sum, n }]) => ({ system, label: SYSTEMS[system] ?? system, score: Math.round((sum / n) * 100), n }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  const total = items.length ? Math.round((items.reduce((a, i) => a + i.points, 0) / items.length) * 100) : null;
  return { total, counted: items.length, bySystem, items };
}

export function scoreBand(score: number): { label: string; color: string } {
  if (score >= 80) return { label: 'Ótimo', color: 'var(--ok)' };
  if (score >= 60) return { label: 'Bom, com pontos a ajustar', color: 'var(--warn)' };
  return { label: 'Merece atenção', color: 'var(--danger)' };
}

/** Velocímetro em SVG inline (cores fixas para funcionar também na impressão). */
export function gaugeSvg(score: number | null, size = 220): string {
  const r = size / 2 - 14;
  const cx = size / 2;
  const cy = size / 2 + 6;
  const arc = (from: number, to: number, color: string) => {
    const a1 = Math.PI * (1 - from);
    const a2 = Math.PI * (1 - to);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy - r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy - r * Math.sin(a2);
    return `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${color}" stroke-width="18" stroke-linecap="butt"/>`;
  };
  const needle = score === null ? '' : (() => {
    const a = Math.PI * (1 - score / 100);
    const x = cx + (r - 2) * Math.cos(a);
    const y = cy - (r - 2) * Math.sin(a);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#16202a" stroke-width="4" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="7" fill="#16202a"/>`;
  })();
  const color = score === null ? '#9aa6b2' : score >= 80 ? '#15803d' : score >= 60 ? '#b45309' : '#b91c1c';
  const label = score === null ? 'sem score' : String(score);
  return `<svg role="img" aria-label="Score ${label} de 100" viewBox="0 0 ${size} ${size / 2 + 40}" width="${size}" height="${size / 2 + 40}" style="max-width:100%;height:auto">
${arc(0, 0.6, '#ef4444')}${arc(0.6, 0.8, '#f59e0b')}${arc(0.8, 1, '#22c55e')}
${needle}
<text x="${cx}" y="${cy + 34}" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="30" font-weight="700" fill="${color}">${label}</text>
<text x="${cx}" y="${cy + 52}" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="11" fill="#6b7280">de 100</text>
</svg>`;
}

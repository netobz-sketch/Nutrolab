/**
 * Evolução do paciente entre coletas (todos os casos): séries por exame com a
 * faixa normal/ótima da regra ativa ao fundo, e a linha do tempo do score.
 * Só desenha: valores vêm do motor (parseValue) e das análises gravadas.
 */
import { allRules, getAsyncDb, num, str, strOrNull, type Row } from './db.js';
import { matchExam, parseValue, SYSTEMS, selectRule } from './engine/index.js';
import type { PatientProfile, Rule } from './engine/index.js';
import { h } from './views/html.js';

export interface SeriesPoint { date: string; value: number; raw: string; caseId: number }
export interface Series { key: string; label: string; unit: string; system: string; points: SeriesPoint[]; rule: Rule | null }

export async function patientSeries(patientId: number, profile: PatientProfile): Promise<Series[]> {
  const rows = (await getAsyncDb()
    .prepare(`SELECT r.*, c.id AS case_id FROM results r JOIN cases c ON c.id = r.case_id WHERE c.patient_id = ? AND c.deleted_at IS NULL AND r.excluded = 0 AND r.collection_date IS NOT NULL ORDER BY r.collection_date, r.id`)
    .all(patientId)) as Row[];
  const rules = allRules();
  const map = new Map<string, Series>();
  for (const r of rows) {
    const parsed = parseValue(str(r, 'value_raw'));
    if (parsed.kind !== 'numeric' || parsed.number === null || parsed.comparator) continue;
    const canonical = strOrNull(r, 'exam_canonical') ?? matchExam(str(r, 'exam_raw'), rules);
    const key = canonical ?? str(r, 'exam_raw').toLowerCase();
    const unit = str(r, 'unit_raw');
    const existing = map.get(key);
    if (existing && existing.unit && unit && existing.unit.toLowerCase() !== unit.toLowerCase()) continue; // unidade mudou: não misturar
    if (!existing) {
      const sel = canonical ? selectRule(canonical, rules, profile, null) : null;
      map.set(key, { key, label: canonical ?? str(r, 'exam_raw'), unit, system: sel?.rule?.system ?? rules.find((x) => x.exam_canonical === canonical)?.system ?? 'outros', points: [], rule: sel?.rule ?? null });
    }
    const s = map.get(key) as Series;
    const date = str(r, 'collection_date');
    if (!s.points.some((p) => p.date === date)) s.points.push({ date, value: parsed.number, raw: str(r, 'value_raw'), caseId: num(r, 'case_id') });
  }
  return [...map.values()].filter((s) => s.points.length >= 2).sort((a, b) => (SYSTEMS[a.system] ?? a.system).localeCompare(SYSTEMS[b.system] ?? b.system, 'pt-BR') || a.label.localeCompare(b.label));
}

export async function scoreTimeline(patientId: number): Promise<Array<{ date: string; score: number; caseId: number; analysisId: number }>> {
  const rows = (await getAsyncDb()
    .prepare(`SELECT a.id, a.case_id, a.score, a.created_at FROM analyses a JOIN cases c ON c.id = a.case_id WHERE c.patient_id = ? AND c.deleted_at IS NULL AND a.score IS NOT NULL AND a.id = (SELECT MAX(id) FROM analyses a2 WHERE a2.case_id = a.case_id AND a2.score IS NOT NULL) ORDER BY a.created_at`)
    .all(patientId)) as Row[];
  return rows.map((r) => ({ date: str(r, 'created_at').slice(0, 10), score: num(r, 'score'), caseId: num(r, 'case_id'), analysisId: num(r, 'id') }));
}

const fmt = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;

/** Gráfico de linha SVG com faixas de fundo (normal em âmbar claro, ótimo em verde claro). */
export function lineChart(points: Array<{ date: string; value: number; raw?: string }>, opts: { unit?: string; normal?: [number | null, number | null]; optimal?: [number | null, number | null]; width?: number; height?: number; yMin?: number; yMax?: number; color?: string }): string {
  const W = opts.width ?? 340;
  const H = opts.height ?? 130;
  const padL = 44;
  const padR = 12;
  const padT = 10;
  const padB = 24;
  const vals = points.map((p) => p.value);
  const bandVals = [opts.normal?.[0], opts.normal?.[1], opts.optimal?.[0], opts.optimal?.[1]].filter((v): v is number => v !== null && v !== undefined);
  let lo = Math.min(...vals, ...(opts.yMin !== undefined ? [opts.yMin] : bandVals));
  let hi = Math.max(...vals, ...(opts.yMax !== undefined ? [opts.yMax] : bandVals));
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const span = hi - lo;
  lo -= span * 0.1;
  hi += span * 0.1;
  const x = (i: number) => padL + (points.length === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (points.length - 1));
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const band = (b: [number | null, number | null] | undefined, color: string) => {
    if (!b || (b[0] === null && b[1] === null)) return '';
    const top = y(b[1] ?? hi);
    const bottom = y(b[0] ?? lo);
    return `<rect x="${padL}" y="${Math.min(top, bottom).toFixed(1)}" width="${W - padL - padR}" height="${Math.abs(bottom - top).toFixed(1)}" fill="${color}"/>`;
  };
  const color = opts.color ?? '#111111';
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5"><title>${h(fmt(p.date))}: ${h(p.raw ?? String(p.value))} ${h(opts.unit ?? '')}</title></circle>`).join('');
  const labels = points.map((p, i) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#71717a">${fmt(p.date)}</text>`).join('');
  const ticks = [lo + span * 0.1, (lo + hi) / 2, hi - span * 0.1].map((v) => `<text x="${padL - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#71717a">${Number.isInteger(v) ? v : v.toFixed(Math.abs(v) < 10 ? 1 : 0)}</text>`).join('');
  const last = points[points.length - 1];
  const lastLabel = last ? `<text x="${(x(points.length - 1) + 6).toFixed(1)}" y="${(y(last.value) - 6).toFixed(1)}" font-size="11" font-weight="700" fill="${color}">${h(last.raw ?? String(last.value))}</text>` : '';
  return `<svg role="img" aria-label="Evolução" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:100%;height:auto;font-family:Inter,system-ui,sans-serif">${band(opts.normal, 'rgba(138,109,31,0.12)')}${band(opts.optimal, 'rgba(47,125,79,0.16)')}<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#e5e5e7"/>${ticks}<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>${dots}${labels}${lastLabel}</svg>`;
}

export function evolutionHtml(series: Series[], scores: Awaited<ReturnType<typeof scoreTimeline>>): string {
  const scoreBlock = scores.length >= 1
    ? `<div class="card"><h2 style="margin-top:0">Score ao longo do tempo</h2>${scores.length >= 2 ? lineChart(scores.map((s) => ({ date: s.date, value: s.score, raw: String(s.score) })), { yMin: 0, yMax: 100, optimal: [80, 100], normal: [60, 80], width: 520, height: 150 }) : `<div class="muted small">Um único score registrado (${scores[0]?.score}); a linha aparece a partir da segunda análise.</div>`}</div>`
    : '';
  if (!series.length) return scoreBlock + '<div class="card muted">A evolução aparece quando houver o mesmo exame em duas coletas de datas diferentes (no mesmo caso ou em casos anteriores do paciente).</div>';
  const groups = new Map<string, Series[]>();
  for (const s of series) groups.set(s.system, [...(groups.get(s.system) ?? []), s]);
  const cards = [...groups.entries()].map(([sys, list]) => `<h2>${h(SYSTEMS[sys] ?? sys)}</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;margin-bottom:12px">${list.map((s) => {
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    const delta = first && last ? last.value - first.value : 0;
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '=';
    return `<div class="card" style="margin:0"><div class="actions" style="justify-content:space-between"><div><b>${h(s.label)}</b> <span class="muted small">${h(s.unit)}</span></div><span class="small"><b>${h(last?.raw ?? '')}</b> <span class="muted">${arrow} desde ${fmt(first?.date ?? '')}</span></span></div>${lineChart(s.points, { unit: s.unit, normal: s.rule ? [s.rule.normal_min, s.rule.normal_max] : undefined, optimal: s.rule ? [s.rule.target_min ?? s.rule.normal_min, s.rule.target_max ?? s.rule.normal_max] : undefined })}</div>`;
  }).join('')}</div>`).join('');
  return scoreBlock + `<p class="muted small">Fundo verde = faixa ótima da sua regra; âmbar = faixa normal. Passe o mouse nos pontos para ver o valor exato.</p>` + cards;
}

/** Último valor anterior de cada exame do paciente antes da coleta mais antiga deste caso. */
export async function previousValues(patientId: number | null, caseId: number): Promise<Map<string, { raw: string; unit: string; date: string }>> {
  const out = new Map<string, { raw: string; unit: string; date: string }>();
  if (!patientId) return out;
  const rows = (await getAsyncDb()
    .prepare(`SELECT r.exam_canonical, r.exam_raw, r.value_raw, r.unit_raw, r.collection_date FROM results r JOIN cases c ON c.id = r.case_id WHERE c.patient_id = ? AND c.id != ? AND c.deleted_at IS NULL AND r.excluded = 0 AND r.collection_date IS NOT NULL ORDER BY r.collection_date DESC`)
    .all(patientId, caseId)) as Row[];
  const rules = allRules();
  for (const r of rows) {
    const k = strOrNull(r, 'exam_canonical') ?? matchExam(str(r, 'exam_raw'), rules);
    if (k && !out.has(k)) out.set(k, { raw: str(r, 'value_raw'), unit: str(r, 'unit_raw'), date: str(r, 'collection_date') });
  }
  return out;
}

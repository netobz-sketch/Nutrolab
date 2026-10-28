import { convert } from './units.js';
import { roundTo } from './normalize.js';
import type { DerivedInput, DerivedResult, Evaluation, PatientProfile } from './types.js';

export interface CalcDef {
  id: string;
  name: string;
  formula: string;
  unit: string;
  inputs: Array<{ exam: string; unit: string }>;
  decimals: number;
  compute: (v: Record<string, number>) => number | null;
  condition?: (v: Record<string, number>, profile: PatientProfile) => string | null;
}

export const CALCS: CalcDef[] = [
  {
    id: 'colesterol_nao_hdl',
    name: 'Colesterol não-HDL',
    formula: 'colesterol_total − hdl',
    unit: 'mg/dL',
    inputs: [{ exam: 'colesterol_total', unit: 'mg/dL' }, { exam: 'hdl', unit: 'mg/dL' }],
    decimals: 0,
    compute: (v) => (v.colesterol_total ?? 0) - (v.hdl ?? 0),
  },
  {
    id: 'ldl_friedewald',
    name: 'LDL estimado (Friedewald)',
    formula: 'colesterol_total − hdl − triglicerideos ÷ 5',
    unit: 'mg/dL',
    inputs: [
      { exam: 'colesterol_total', unit: 'mg/dL' },
      { exam: 'hdl', unit: 'mg/dL' },
      { exam: 'triglicerideos', unit: 'mg/dL' },
    ],
    decimals: 0,
    compute: (v) => (v.colesterol_total ?? 0) - (v.hdl ?? 0) - (v.triglicerideos ?? 0) / 5,
    condition: (v, p) => {
      if ((v.triglicerideos ?? 0) >= 400) return 'triglicerídeos ≥ 400 mg/dL: Friedewald não se aplica';
      if (!p.contexts.has('jejum')) return 'jejum não confirmado';
      return null;
    },
  },
  {
    id: 'razao_tg_hdl',
    name: 'Razão TG/HDL',
    formula: 'triglicerideos ÷ hdl',
    unit: 'adimensional',
    inputs: [{ exam: 'triglicerideos', unit: 'mg/dL' }, { exam: 'hdl', unit: 'mg/dL' }],
    decimals: 2,
    compute: (v) => ((v.hdl ?? 0) > 0 ? (v.triglicerideos ?? 0) / (v.hdl ?? 1) : null),
  },
  {
    id: 'razao_ct_hdl',
    name: 'Razão colesterol total/HDL',
    formula: 'colesterol_total ÷ hdl',
    unit: 'adimensional',
    inputs: [{ exam: 'colesterol_total', unit: 'mg/dL' }, { exam: 'hdl', unit: 'mg/dL' }],
    decimals: 2,
    compute: (v) => ((v.hdl ?? 0) > 0 ? (v.colesterol_total ?? 0) / (v.hdl ?? 1) : null),
  },
  {
    id: 'homa_ir',
    name: 'HOMA-IR',
    formula: '(glicose_jejum × insulina_jejum) ÷ 405',
    unit: 'adimensional',
    inputs: [{ exam: 'glicose_jejum', unit: 'mg/dL' }, { exam: 'insulina_jejum', unit: 'µUI/mL' }],
    decimals: 2,
    compute: (v) => ((v.glicose_jejum ?? 0) * (v.insulina_jejum ?? 0)) / 405,
    condition: (_v, p) => (p.contexts.has('jejum') ? null : 'jejum ≥ 8 h não confirmado'),
  },
  {
    id: 'tyg',
    name: 'Índice TyG',
    formula: 'ln(triglicerideos × glicose_jejum ÷ 2)',
    unit: 'adimensional',
    inputs: [{ exam: 'triglicerideos', unit: 'mg/dL' }, { exam: 'glicose_jejum', unit: 'mg/dL' }],
    decimals: 2,
    compute: (v) => {
      const x = ((v.triglicerideos ?? 0) * (v.glicose_jejum ?? 0)) / 2;
      return x > 0 ? Math.log(x) : null;
    },
    condition: (_v, p) => (p.contexts.has('jejum') ? null : 'jejum não confirmado'),
  },
];

function usable(ev: Evaluation): boolean {
  return (
    ev.parsed.kind === 'numeric' &&
    ev.parsed.comparator === null &&
    ev.parsed.number !== null &&
    ev.result.confidence !== 'baixa' &&
    !ev.result.derived
  );
}

/** Calcula os índices habilitados, por data de coleta, só com insumos da mesma coleta. */
export function computeDerived(evals: Evaluation[], enabledIds: Set<string>, profile: PatientProfile): DerivedResult[] {
  const dates = [...new Set(evals.map((e) => e.result.collection_date ?? ''))];
  const out: DerivedResult[] = [];
  for (const calc of CALCS) {
    if (!enabledIds.has(calc.id)) continue;
    for (const date of dates) {
      const sameDate = evals.filter((e) => (e.result.collection_date ?? '') === date && e.exam_canonical);
      const values: Record<string, number> = {};
      const inputs: DerivedInput[] = [];
      let reason: string | null = null;
      for (const need of calc.inputs) {
        const ev = sameDate.find((e) => e.exam_canonical === need.exam);
        if (!ev) {
          reason = `insumo ausente nesta coleta: ${need.exam}`;
          break;
        }
        if (!usable(ev)) {
          reason = `insumo ${need.exam} com confiança baixa, sinal de desigualdade ou não numérico`;
          break;
        }
        const unit = ev.unit ?? '';
        const conv = convert(need.exam, ev.parsed.number ?? 0, unit, need.unit, ev.result.value_raw);
        if (conv === null) {
          reason = `insumo ${need.exam} em ${unit || 'unidade ausente'}, não conversível para ${need.unit}`;
          break;
        }
        const value = conv === 'same' ? (ev.parsed.number ?? 0) : conv.value;
        values[need.exam] = value;
        inputs.push({
          exam: need.exam,
          value,
          unit: need.unit,
          source: [ev.result.source_file, ev.result.page ? `p. ${ev.result.page}` : null].filter(Boolean).join(', ') || 'lançamento manual',
        });
      }
      if (inputs.length === 0 && reason && !reason.startsWith('insumo ausente')) {
        out.push({ id: calc.id, name: calc.name, formula: calc.formula, unit: calc.unit, collection_date: date || null, inputs, value: null, reason });
        continue;
      }
      if (reason) {
        if (reason.startsWith('insumo ausente') && inputs.length === 0) continue;
        out.push({ id: calc.id, name: calc.name, formula: calc.formula, unit: calc.unit, collection_date: date || null, inputs, value: null, reason });
        continue;
      }
      const cond = calc.condition ? calc.condition(values, profile) : null;
      if (cond) {
        out.push({ id: calc.id, name: calc.name, formula: calc.formula, unit: calc.unit, collection_date: date || null, inputs, value: null, reason: cond });
        continue;
      }
      const raw = calc.compute(values);
      out.push({
        id: calc.id,
        name: calc.name,
        formula: calc.formula,
        unit: calc.unit,
        collection_date: date || null,
        inputs,
        value: raw === null ? null : roundTo(raw, calc.decimals),
        reason: raw === null ? 'divisão por zero' : null,
      });
    }
  }
  return out;
}

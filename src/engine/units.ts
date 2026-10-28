import { normalizeUnit, decimalsOf, roundTo } from './normalize.js';
import type { Conversion } from './types.js';

interface Factor {
  from: string;
  to: string;
  factor: number;
}

/** Fatores permitidos (skill/references/conversoes-unidades.md). Direção inversa é derivada. */
const FACTORS: Record<string, Factor[]> = {
  glicose: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.0555 }],
  glicose_jejum: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.0555 }],
  colesterol_total: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.02586 }],
  hdl: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.02586 }],
  ldl: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.02586 }],
  colesterol_nao_hdl: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.02586 }],
  triglicerideos: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.01129 }],
  creatinina: [{ from: 'mg/dL', to: 'µmol/L', factor: 88.4 }],
  ureia: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.1665 }],
  acido_urico: [{ from: 'mg/dL', to: 'µmol/L', factor: 59.48 }],
  bilirrubina_total: [{ from: 'mg/dL', to: 'µmol/L', factor: 17.1 }],
  bilirrubina_direta: [{ from: 'mg/dL', to: 'µmol/L', factor: 17.1 }],
  bilirrubina_indireta: [{ from: 'mg/dL', to: 'µmol/L', factor: 17.1 }],
  calcio_total: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.2495 }],
  calcio_ionico: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.2495 }],
  magnesio: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.4114 }],
  fosforo: [{ from: 'mg/dL', to: 'mmol/L', factor: 0.3229 }],
  ferro_serico: [{ from: 'µg/dL', to: 'µmol/L', factor: 0.179 }],
  zinco: [{ from: 'µg/dL', to: 'µmol/L', factor: 0.153 }],
  vitamina_d_25oh: [{ from: 'ng/mL', to: 'nmol/L', factor: 2.496 }],
  vitamina_b12: [{ from: 'pg/mL', to: 'pmol/L', factor: 0.7378 }],
  folato: [{ from: 'ng/mL', to: 'nmol/L', factor: 2.266 }],
  hemoglobina: [{ from: 'g/dL', to: 'g/L', factor: 10 }],
  albumina: [{ from: 'g/dL', to: 'g/L', factor: 10 }],
  proteinas_totais: [{ from: 'g/dL', to: 'g/L', factor: 10 }],
  t4_livre: [{ from: 'ng/dL', to: 'pmol/L', factor: 12.87 }],
  t3_livre: [{ from: 'pg/mL', to: 'pmol/L', factor: 1.536 }],
  t3_total: [{ from: 'ng/dL', to: 'nmol/L', factor: 0.01536 }],
  testosterona_total: [{ from: 'ng/dL', to: 'nmol/L', factor: 0.03467 }],
  estradiol: [{ from: 'pg/mL', to: 'pmol/L', factor: 3.671 }],
  cortisol: [{ from: 'µg/dL', to: 'nmol/L', factor: 27.59 }],
  pcr: [{ from: 'mg/dL', to: 'mg/L', factor: 10 }],
  homocisteina: [{ from: 'mg/L', to: 'µmol/L', factor: 7.397 }],
};

export function listConversions(): Array<{ exam: string } & Factor> {
  return Object.entries(FACTORS).flatMap(([exam, list]) => list.map((f) => ({ exam, ...f })));
}

/**
 * Converte um valor para a unidade pedida. Devolve null quando a conversão não
 * está na tabela permitida. Unidades iguais (após normalização) não convertem.
 */
export function convert(
  exam: string,
  value: number,
  fromUnitRaw: string,
  toUnitRaw: string,
  originalText: string,
): Conversion | null | 'same' {
  const from = normalizeUnit(fromUnitRaw);
  const to = normalizeUnit(toUnitRaw);
  if (!from || !to) return null;
  if (from === to) return 'same';
  const decimals = Math.min(decimalsOf(originalText) + 1, 3);
  if (exam === 'hba1c') {
    if (from === '%' && to === 'mmol/mol') {
      return { value: roundTo((value - 2.15) * 10.929, decimals), unit: to, factor: '(valor − 2,15) × 10,929' };
    }
    if (from === 'mmol/mol' && to === '%') {
      return { value: roundTo(value / 10.929 + 2.15, decimals), unit: to, factor: 'valor ÷ 10,929 + 2,15' };
    }
    return null;
  }
  const list = FACTORS[exam] ?? [];
  for (const f of list) {
    if (f.from === from && f.to === to) {
      return { value: roundTo(value * f.factor, decimals), unit: to, factor: `× ${f.factor}` };
    }
    if (f.from === to && f.to === from) {
      return { value: roundTo(value / f.factor, decimals), unit: to, factor: `÷ ${f.factor}` };
    }
  }
  return null;
}

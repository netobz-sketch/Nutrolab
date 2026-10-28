import type { ParsedValue } from './types.js';

export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const UNIT_SYNONYMS: Array<[RegExp, string]> = [
  [/^mg\s*\/\s*dl$/i, 'mg/dL'],
  [/^mg\s*\/\s*l$/i, 'mg/L'],
  [/^(µ|u|mc)g\s*\/\s*ml$/i, 'mg/L'],
  [/^g\s*\/\s*dl$/i, 'g/dL'],
  [/^g\s*\/\s*l$/i, 'g/L'],
  [/^ng\s*\/\s*ml$/i, 'ng/mL'],
  [/^(µ|u|mc)g\s*\/\s*l$/i, 'ng/mL'],
  [/^ng\s*\/\s*dl$/i, 'ng/dL'],
  [/^pg\s*\/\s*ml$/i, 'pg/mL'],
  [/^(µ|u|mc)g\s*\/\s*dl$/i, 'µg/dL'],
  [/^(µ|u)mol\s*\/\s*l$/i, 'µmol/L'],
  [/^mmol\s*\/\s*l$/i, 'mmol/L'],
  [/^nmol\s*\/\s*l$/i, 'nmol/L'],
  [/^pmol\s*\/\s*l$/i, 'pmol/L'],
  [/^mmol\s*\/\s*mol$/i, 'mmol/mol'],
  [/^(m|µ|u)?(ui|iu|u)\s*\/\s*(ml|l)$/i, 'µUI/mL'],
  [/^%$/, '%'],
  [/^(\/|por\s*)?(mm3|mm³|µl|ul)$/i, '/µL'],
  [/^mil(hares)?\s*\/\s*(mm3|mm³|µl|ul)$/i, 'mil/µL'],
  [/^milh(o|õ)es\s*\/\s*(mm3|mm³|µl|ul)$/i, 'milhões/µL'],
  [/^fl$/i, 'fL'],
  [/^pg$/i, 'pg'],
  [/^seg(undos)?$/i, 'seg'],
  [/^ml\s*\/\s*min(\s*\/\s*1[.,]73\s*m[²2])?$/i, 'mL/min/1.73m²'],
  [/^adimensional$/i, 'adimensional'],
  [/^qualitativo$/i, 'qualitativo'],
];

/** Unifica grafias de unidade; grafia diferente não é conversão. */
export function normalizeUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  const trimmed = unit.trim();
  if (!trimmed) return null;
  for (const [re, canonical] of UNIT_SYNONYMS) {
    if (re.test(trimmed)) return canonical;
  }
  return trimmed;
}

const NUMERIC_RE = /^([<>]=?)?\s*(-?\d+(?:[.,]\d+)?)$/;

/** Lê o valor exatamente como está no laudo, sem inferir dígitos. */
export function parseValue(raw: string): ParsedValue {
  const text = raw.trim();
  if (!text) {
    return { kind: 'unparseable', comparator: null, number: null, text: null, note: 'valor vazio' };
  }
  const compact = text.replace(/\s+/g, '');
  const m = NUMERIC_RE.exec(compact);
  if (m) {
    const numberText = m[2] ?? '';
    const dotThousands = /^-?\d+\.\d{3}$/.test(numberText);
    if (dotThousands) {
      return {
        kind: 'unparseable',
        comparator: null,
        number: null,
        text,
        note: 'separador "." seguido de 3 dígitos é ambíguo (decimal ou milhar); confirmar no laudo',
      };
    }
    const comparator = (m[1] ?? null) as ParsedValue['comparator'];
    const value = Number(numberText.replace(',', '.'));
    if (!Number.isFinite(value)) {
      return { kind: 'unparseable', comparator: null, number: null, text, note: 'número inválido' };
    }
    return { kind: 'numeric', comparator, number: value, text: null, note: null };
  }
  return { kind: 'qualitative', comparator: null, number: null, text: normalizeText(text), note: null };
}

export function decimalsOf(raw: string): number {
  const m = /[.,](\d+)\s*$/.exec(raw.trim());
  return m && m[1] ? m[1].length : 0;
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor + Number.EPSILON) / factor;
}

export function formatNumber(value: number, decimals = 2): string {
  return roundTo(value, decimals).toFixed(decimals).replace('.', ',');
}

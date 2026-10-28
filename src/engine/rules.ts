import { normalizeText, normalizeUnit, parseValue } from './normalize.js';
import { convert } from './units.js';
import type {
  Classification,
  Evaluation,
  Guidance,
  ParsedValue,
  PatientProfile,
  ResultInput,
  Rule,
} from './types.js';

export function ageAt(birthDate: string | null, onDate: string | null): number | null {
  if (!birthDate || !onDate) return null;
  const b = new Date(birthDate + 'T00:00:00Z');
  const d = new Date(onDate + 'T00:00:00Z');
  if (Number.isNaN(b.getTime()) || Number.isNaN(d.getTime()) || d < b) return null;
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    d.getUTCMonth() < b.getUTCMonth() ||
    (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** Resolve o nome canônico só com correspondência exata de alias ou id. */
export function matchExam(examRaw: string, rules: Rule[]): string | null {
  const key = normalizeText(examRaw);
  if (!key) return null;
  for (const rule of rules) {
    if (normalizeText(rule.exam_canonical) === key) return rule.exam_canonical;
    if (rule.aliases.some((a) => normalizeText(a) === key)) return rule.exam_canonical;
  }
  return null;
}

export function specificity(rule: Rule): number {
  let n = 0;
  if (rule.sex !== 'todos') n += 1;
  if (rule.age_min !== null) n += 1;
  if (rule.age_max !== null) n += 1;
  n += rule.contexts.filter((c) => c !== 'geral').length;
  return n;
}

interface Compat {
  ok: boolean;
  missing: string[];
}

export function isCompatible(rule: Rule, profile: PatientProfile, age: number | null): Compat {
  const missing: string[] = [];
  if (rule.sex !== 'todos') {
    if (!profile.sex) missing.push('sexo biológico não informado');
    else if (profile.sex !== rule.sex) return { ok: false, missing };
  }
  if (rule.age_min !== null || rule.age_max !== null) {
    if (age === null) missing.push('idade na coleta não calculável (data de nascimento ou coleta ausente)');
    else {
      if (rule.age_min !== null && age < rule.age_min) return { ok: false, missing };
      if (rule.age_max !== null && age > rule.age_max) return { ok: false, missing };
    }
  }
  for (const ctx of rule.contexts) {
    if (ctx === 'geral') continue;
    if (!profile.contexts.has(ctx)) missing.push(`contexto "${ctx}" não confirmado`);
  }
  return { ok: missing.length === 0, missing };
}

function sameTarget(a: Rule, b: Rule): boolean {
  return (
    a.target_min === b.target_min &&
    a.target_max === b.target_max &&
    (a.target_text ?? '') === (b.target_text ?? '') &&
    a.unit === b.unit
  );
}

export interface Selection {
  rule: Rule | null;
  candidates: Rule[];
  ambiguous: boolean;
  missing: string[];
}

export function selectRule(exam: string, rules: Rule[], profile: PatientProfile, age: number | null): Selection {
  const active = rules.filter((r) => r.status === 'ativo' && r.exam_canonical === exam);
  if (active.length === 0) return { rule: null, candidates: [], ambiguous: false, missing: [] };
  const missing = new Set<string>();
  const compatible: Rule[] = [];
  for (const rule of active) {
    const c = isCompatible(rule, profile, age);
    if (c.ok) compatible.push(rule);
    else c.missing.forEach((m) => missing.add(m));
  }
  if (compatible.length === 0) return { rule: null, candidates: active, ambiguous: false, missing: [...missing] };
  const best = Math.max(...compatible.map(specificity));
  const top = compatible.filter((r) => specificity(r) === best);
  const first = top[0];
  if (!first) return { rule: null, candidates: active, ambiguous: false, missing: [...missing] };
  const ambiguous = top.some((r) => !sameTarget(r, first));
  return { rule: ambiguous ? null : first, candidates: top, ambiguous, missing: [...missing] };
}

export function classifyNumeric(parsed: ParsedValue, value: number, rule: Rule): Classification {
  const { target_min: min, target_max: max } = rule;
  if (min === null && max === null) return 'nao_comparavel';
  const cmp = parsed.comparator;
  if (cmp === '<' || cmp === '<=') {
    if (min !== null && value <= min) return 'abaixo_do_alvo';
    if (min === null && max !== null && value <= max) return 'dentro_do_alvo';
    return 'nao_comparavel';
  }
  if (cmp === '>' || cmp === '>=') {
    if (max !== null && value >= max) return 'acima_do_alvo';
    if (max === null && min !== null && value >= min) return 'dentro_do_alvo';
    return 'nao_comparavel';
  }
  if (min !== null && value < min) return 'abaixo_do_alvo';
  if (max !== null && value > max) return 'acima_do_alvo';
  return 'dentro_do_alvo';
}

export function criticalFlag(parsed: ParsedValue, value: number, rule: Rule): 'baixo' | 'alto' | null {
  const cmp = parsed.comparator;
  if (rule.critical_low !== null && value < rule.critical_low && cmp !== '>' && cmp !== '>=') return 'baixo';
  if (rule.critical_high !== null && value > rule.critical_high && cmp !== '<' && cmp !== '<=') return 'alto';
  return null;
}

export function evaluateResult(result: ResultInput, rules: Rule[], profile: PatientProfile): Evaluation {
  const notes: string[] = [];
  const parsed = parseValue(result.value_raw);
  if (parsed.note) notes.push(parsed.note);
  const exam = result.exam_canonical ?? matchExam(result.exam_raw, rules);
  const unit = normalizeUnit(result.unit_raw);
  const age = ageAt(profile.birthDate, result.collection_date);
  const base: Evaluation = {
    result,
    exam_canonical: exam,
    parsed,
    unit,
    converted: null,
    ageAtCollection: age,
    rule: null,
    candidates: [],
    classification: 'sem_alvo',
    critical: null,
    notes,
  };
  if (!exam) {
    notes.push('nome do exame sem correspondência segura com a tabela');
    return base;
  }
  const sel = selectRule(exam, rules, profile, age);
  base.candidates = sel.candidates;
  sel.missing.forEach((m) => notes.push(m));
  if (sel.ambiguous) {
    notes.push(`${sel.candidates.length} regras ativas de mesma especificidade com alvos diferentes`);
    return { ...base, classification: 'regra_ambigua' };
  }
  if (!sel.rule) {
    if (sel.candidates.length > 0) {
      notes.push('existe regra ativa, mas as condições dela não puderam ser confirmadas');
      return { ...base, classification: 'nao_comparavel' };
    }
    return base;
  }
  const rule = sel.rule;
  base.rule = rule;
  if (parsed.kind === 'unparseable') {
    notes.push('revisão manual necessária');
    return { ...base, classification: 'nao_comparavel' };
  }
  const qualitativeRule = rule.target_min === null && rule.target_max === null && !!rule.target_text;
  if (qualitativeRule) {
    if (parsed.kind !== 'qualitative' || !parsed.text) {
      notes.push('regra qualitativa aplicada a resultado numérico');
      return { ...base, classification: 'nao_comparavel' };
    }
    const ok = normalizeText(rule.target_text ?? '') === parsed.text;
    return { ...base, classification: ok ? 'qualitativo_compativel' : 'qualitativo_nao_compativel' };
  }
  if (parsed.kind !== 'numeric' || parsed.number === null) {
    notes.push('resultado qualitativo para regra numérica');
    return { ...base, classification: 'nao_comparavel' };
  }
  let value = parsed.number;
  if (!unit) {
    notes.push('unidade ausente no resultado');
    return { ...base, classification: 'nao_comparavel' };
  }
  const conv = convert(exam, value, unit, rule.unit, result.value_raw);
  if (conv === null) {
    notes.push(`unidade ${unit} não conversível para ${rule.unit} pela tabela permitida`);
    return { ...base, classification: 'nao_comparavel' };
  }
  if (conv !== 'same') {
    base.converted = conv;
    value = conv.value;
  }
  const classification = classifyNumeric(parsed, value, rule);
  const critical = criticalFlag(parsed, value, rule);
  return { ...base, classification, critical };
}

export function evaluateAll(results: ResultInput[], rules: Rule[], profile: PatientProfile): Evaluation[] {
  return results.map((r) => evaluateResult(r, rules, profile));
}

/** Orientações aplicáveis: gatilho estruturado (exame + classificação), nunca texto livre. */
export function applicableGuidances(evals: Evaluation[], guidances: Guidance[], profile: PatientProfile): Array<{ guidance: Guidance; evaluation: Evaluation }> {
  const out: Array<{ guidance: Guidance; evaluation: Evaluation }> = [];
  const seen = new Set<string>();
  for (const g of guidances) {
    if (g.status !== 'ativo' || g.trigger === 'manual') continue;
    if (g.contexts_required.some((c) => !profile.contexts.has(c))) continue;
    if (g.contexts_excluded.some((c) => profile.contexts.has(c))) continue;
    for (const ev of evals) {
      const examOk = g.exam_canonical === null || g.exam_canonical === ev.exam_canonical;
      if (!examOk) continue;
      const ruleAllows = ev.rule ? ev.rule.guidance_ids.length === 0 || ev.rule.guidance_ids.includes(g.code) : g.exam_canonical === null;
      if (!ruleAllows) continue;
      const hit = g.trigger === 'critico' ? ev.critical !== null : ev.classification === g.trigger;
      if (!hit) continue;
      if (seen.has(g.code)) continue;
      seen.add(g.code);
      out.push({ guidance: g, evaluation: ev });
      break;
    }
  }
  return out;
}

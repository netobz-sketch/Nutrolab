import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageAt,
  applicableGuidances,
  computeDerived,
  convert,
  evaluateResult,
  normalizeUnit,
  parseValue,
  selectRule,
} from '../src/engine/index.js';
import type { Guidance, PatientProfile, ResultInput, Rule } from '../src/engine/index.js';

function rule(partial: Partial<Rule>): Rule {
  return {
    id: 1,
    exam_canonical: 'vitamina_d_25oh',
    aliases: ['25(OH)D', 'Vitamina D 25-OH'],
    sex: 'todos',
    age_min: null,
    age_max: null,
    contexts: ['geral'],
    unit: 'ng/mL',
    target_min: 40,
    target_max: 80,
    target_text: null,
    critical_low: 10,
    critical_high: 150,
    guidance_ids: [],
    clinical_source: 'teste',
    version: '1.0',
    reviewed_at: '2026-10-28',
    status: 'ativo',
    ...partial,
  };
}

function result(partial: Partial<ResultInput>): ResultInput {
  return {
    id: 1,
    exam_raw: '25(OH)D',
    exam_canonical: null,
    value_raw: '28,4',
    unit_raw: 'ng/ml',
    lab_reference: '30-100',
    lab_flag: null,
    collection_date: '2026-10-15',
    source_file: 'exames.pdf',
    page: 3,
    confidence: 'alta',
    derived: false,
    ...partial,
  };
}

const profile: PatientProfile = { sex: 'F', birthDate: '1985-03-10', contexts: new Set(['pre_menopausa', 'jejum']) };

test('parseValue: vírgula decimal, desigualdade, qualitativo e ponto ambíguo', () => {
  assert.deepEqual(parseValue('28,4').number, 28.4);
  assert.equal(parseValue('<0,5').comparator, '<');
  assert.equal(parseValue('< 0,5').number, 0.5);
  assert.equal(parseValue('Não Reagente').kind, 'qualitative');
  assert.equal(parseValue('Não Reagente').text, 'nao reagente');
  assert.equal(parseValue('1.250').kind, 'unparseable');
  assert.equal(parseValue('1.25').number, 1.25);
});

test('normalizeUnit: grafias diferentes não são conversão', () => {
  assert.equal(normalizeUnit('mg/dl'), 'mg/dL');
  assert.equal(normalizeUnit('ug/L'), 'ng/mL');
  assert.equal(normalizeUnit('mUI/L'), 'µUI/mL');
  assert.equal(normalizeUnit('uUI/mL'), 'µUI/mL');
});

test('convert: só pela tabela, nas duas direções, com arredondamento', () => {
  const c = convert('vitamina_d_25oh', 28.4, 'ng/mL', 'nmol/L', '28,4');
  assert.ok(c && c !== 'same');
  assert.equal(c.value, 70.89);
  const back = convert("vitamina_d_25oh", 70.89, "nmol/L", "ng/mL", "70,89");
  assert.ok(back && back !== 'same');
  assert.equal(back.value, 28.401);
  assert.equal(convert('insulina_jejum', 10, 'µUI/mL', 'pmol/L', '10'), null);
  assert.equal(convert('glicose', 90, 'mg/dl', 'mg/dL', '90'), 'same');
  const a1c = convert('hba1c', 5.6, '%', 'mmol/mol', '5,6');
  assert.ok(a1c && a1c !== 'same');
  assert.equal(a1c.value, 37.71);
});

test('ageAt: idade na data da coleta', () => {
  assert.equal(ageAt('1985-03-10', '2026-03-09'), 40);
  assert.equal(ageAt('1985-03-10', '2026-03-10'), 41);
  assert.equal(ageAt(null, '2026-03-10'), null);
});

test('classificação numérica com alias e unidade equivalente', () => {
  const ev = evaluateResult(result({}), [rule({})], profile);
  assert.equal(ev.exam_canonical, 'vitamina_d_25oh');
  assert.equal(ev.classification, 'abaixo_do_alvo');
  assert.equal(ev.critical, null);
  assert.equal(ev.converted, null);
});

test('limite crítico vira alerta', () => {
  const ev = evaluateResult(result({ value_raw: '8' }), [rule({})], profile);
  assert.equal(ev.classification, 'abaixo_do_alvo');
  assert.equal(ev.critical, 'baixo');
});

test('conversão de unidade antes de comparar', () => {
  const ev = evaluateResult(result({ value_raw: '70,9', unit_raw: 'nmol/L' }), [rule({})], profile);
  assert.ok(ev.converted);
  assert.equal(ev.classification, 'abaixo_do_alvo');
});

test('unidade não conversível → não comparável', () => {
  const ev = evaluateResult(result({ unit_raw: 'pmol/L' }), [rule({})], profile);
  assert.equal(ev.classification, 'nao_comparavel');
});

test('desigualdade só classifica quando a conclusão independe do valor exato', () => {
  const r = rule({ target_min: 1, target_max: null });
  assert.equal(evaluateResult(result({ value_raw: '<0,5' }), [r], profile).classification, 'abaixo_do_alvo');
  const r2 = rule({ target_min: 0.2, target_max: 1 });
  assert.equal(evaluateResult(result({ value_raw: '<0,5' }), [r2], profile).classification, 'nao_comparavel');
  const r3 = rule({ target_min: null, target_max: 5.6 });
  assert.equal(evaluateResult(result({ value_raw: '<5' }), [r3], profile).classification, 'dentro_do_alvo');
});

test('regra mais específica vence; contexto não confirmado cai na geral', () => {
  const geral = rule({ id: 1, exam_canonical: 'ferritina', aliases: ['Ferritina'], unit: 'ng/mL', target_min: 50, target_max: 200, critical_low: null, critical_high: null });
  const fem = rule({ id: 2, exam_canonical: 'ferritina', aliases: ['Ferritina'], unit: 'ng/mL', sex: 'F', contexts: ['pre_menopausa'], target_min: 40, target_max: 150, critical_low: null, critical_high: null });
  const sel = selectRule('ferritina', [geral, fem], profile, 41);
  assert.equal(sel.rule?.id, 2);
  const noCtx: PatientProfile = { ...profile, contexts: new Set() };
  const sel2 = selectRule('ferritina', [geral, fem], noCtx, 41);
  assert.equal(sel2.rule?.id, 1);
  assert.ok(sel2.missing.some((m) => m.includes('pre_menopausa')));
});

test('empate de especificidade com alvos diferentes → regra ambígua', () => {
  const a = rule({ id: 1, target_min: 40, target_max: 80 });
  const b = rule({ id: 2, target_min: 50, target_max: 90 });
  const ev = evaluateResult(result({}), [a, b], profile);
  assert.equal(ev.classification, 'regra_ambigua');
  assert.equal(ev.candidates.length, 2);
});

test('regra em rascunho não classifica', () => {
  const ev = evaluateResult(result({}), [rule({ status: 'rascunho' })], profile);
  assert.equal(ev.classification, 'sem_alvo');
});

test('qualitativo', () => {
  const r = rule({ exam_canonical: 'hbsag', aliases: ['HBsAg'], unit: 'qualitativo', target_min: null, target_max: null, target_text: 'não reagente', critical_low: null, critical_high: null });
  const ok = evaluateResult(result({ exam_raw: 'HBsAg', value_raw: 'NAO REAGENTE', unit_raw: null }), [r], profile);
  assert.equal(ok.classification, 'qualitativo_compativel');
  const bad = evaluateResult(result({ exam_raw: 'HBsAg', value_raw: 'Reagente', unit_raw: null }), [r], profile);
  assert.equal(bad.classification, 'qualitativo_nao_compativel');
});

test('cálculos derivados: HOMA-IR e Friedewald com condições', () => {
  const rules: Rule[] = [
    rule({ id: 1, exam_canonical: 'glicose_jejum', aliases: ['Glicose'], unit: 'mg/dL', target_min: 70, target_max: 99, critical_low: null, critical_high: null }),
    rule({ id: 2, exam_canonical: 'insulina_jejum', aliases: ['Insulina'], unit: 'µUI/mL', target_min: 2, target_max: 10, critical_low: null, critical_high: null }),
    rule({ id: 3, exam_canonical: 'colesterol_total', aliases: ['Colesterol total'], unit: 'mg/dL', target_min: null, target_max: 190, critical_low: null, critical_high: null }),
    rule({ id: 4, exam_canonical: 'hdl', aliases: ['HDL'], unit: 'mg/dL', target_min: 50, target_max: null, critical_low: null, critical_high: null }),
    rule({ id: 5, exam_canonical: 'triglicerideos', aliases: ['Triglicerídeos'], unit: 'mg/dL', target_min: null, target_max: 150, critical_low: null, critical_high: null }),
  ];
  const results: ResultInput[] = [
    result({ id: 1, exam_raw: 'Glicose', value_raw: '90', unit_raw: 'mg/dL' }),
    result({ id: 2, exam_raw: 'Insulina', value_raw: '9', unit_raw: 'uUI/mL' }),
    result({ id: 3, exam_raw: 'Colesterol total', value_raw: '200', unit_raw: 'mg/dL' }),
    result({ id: 4, exam_raw: 'HDL', value_raw: '50', unit_raw: 'mg/dL' }),
    result({ id: 5, exam_raw: 'Triglicerídeos', value_raw: '100', unit_raw: 'mg/dL' }),
  ];
  const evals = results.map((r) => evaluateResult(r, rules, profile));
  const derived = computeDerived(evals, new Set(['homa_ir', 'ldl_friedewald', 'colesterol_nao_hdl']), profile);
  const homa = derived.find((d) => d.id === 'homa_ir');
  assert.equal(homa?.value, 2);
  const ldl = derived.find((d) => d.id === 'ldl_friedewald');
  assert.equal(ldl?.value, 130);
  const nonHdl = derived.find((d) => d.id === 'colesterol_nao_hdl');
  assert.equal(nonHdl?.value, 150);
  const semJejum: PatientProfile = { ...profile, contexts: new Set() };
  const d2 = computeDerived(evals, new Set(['homa_ir']), semJejum);
  assert.equal(d2[0]?.value, null);
  assert.match(d2[0]?.reason ?? '', /jejum/);
});

test('orientação só com gatilho estruturado, status ativo e contexto permitido', () => {
  const g: Guidance = {
    id: 1,
    code: 'ORIENT-VITD-BAIXA',
    title: 'Vit D baixa',
    exam_canonical: 'vitamina_d_25oh',
    trigger: 'abaixo_do_alvo',
    contexts_required: [],
    contexts_excluded: ['gestacao'],
    not_apply_note: '',
    patient_text: 'Texto aprovado.',
    requires_alert: false,
    clinical_source: 'teste',
    version: '1.0',
    reviewed_at: '2026-10-28',
    status: 'ativo',
  };
  const ev = evaluateResult(result({}), [rule({ guidance_ids: ['ORIENT-VITD-BAIXA'] })], profile);
  assert.equal(applicableGuidances([ev], [g], profile).length, 1);
  assert.equal(applicableGuidances([ev], [{ ...g, status: 'rascunho' }], profile).length, 0);
  const gest: PatientProfile = { ...profile, contexts: new Set(['gestacao']) };
  assert.equal(applicableGuidances([ev], [g], gest).length, 0);
});

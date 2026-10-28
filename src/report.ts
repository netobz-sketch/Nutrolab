import { CLASSIFICATION_LABEL, CONTEXTS, formatNumber } from './engine/index.js';
import type { DerivedResult, Evaluation, Guidance, PatientProfile } from './engine/index.js';
import type { Narrative } from './ai.js';

export interface CaseInfo {
  id: number;
  patient_code: string;
  sex: 'M' | 'F' | null;
  birth_date: string | null;
  medications: string;
  supplements: string;
  comorbidities: string;
  goal: string;
  notes: string;
  files: string[];
}

export interface ReportInput {
  caseInfo: CaseInfo;
  profile: PatientProfile;
  evals: Evaluation[];
  derived: DerivedResult[];
  derivedEvals: Evaluation[];
  guidances: Array<{ guidance: Guidance; evaluation: Evaluation }>;
  tableVersion: string;
  narrative: Narrative | null;
  aiModel: string | null;
  generatedAt: string;
}

const esc = (s: string | null | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function fmtValue(ev: Evaluation): string {
  const unit = ev.result.unit_raw ? ` ${ev.result.unit_raw}` : '';
  return `${ev.result.value_raw}${unit}`;
}

function fmtTarget(ev: Evaluation): string {
  const r = ev.rule;
  if (!r) return ev.candidates.length ? `${ev.candidates.length} regras candidatas` : '—';
  const cond = [r.sex !== 'todos' ? r.sex : null, r.age_min !== null || r.age_max !== null ? `${r.age_min ?? ''}–${r.age_max ?? ''} anos` : null, ...r.contexts.filter((c) => c !== 'geral')]
    .filter(Boolean)
    .join('/');
  const range = r.target_text ? r.target_text : `${r.target_min ?? '…'}–${r.target_max ?? '…'} ${r.unit}`;
  return `${range}${cond ? ` (${cond})` : ''}`;
}

function origin(ev: Evaluation): string {
  const parts = [ev.result.source_file, ev.result.page ? `p. ${ev.result.page}` : null, ev.result.collection_date ? `coleta ${ev.result.collection_date}` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : 'lançamento manual';
}

export function buildReport(input: ReportInput): string {
  const { caseInfo, profile, evals, derived, derivedEvals, guidances, tableVersion, narrative } = input;
  const dates = [...new Set(evals.map((e) => e.result.collection_date).filter((d): d is string => !!d))].sort();
  const lines: string[] = [];
  const L = (s = '') => lines.push(s);

  L('# Análise de exames — MINUTA PARA REVISÃO MÉDICA');
  L();
  L('> Documento de apoio à decisão. Não enviar ao paciente antes da revisão e aprovação do médico responsável.');
  L();
  L('## Identificação mínima');
  L();
  L(`- Código do paciente: ${caseInfo.patient_code}`);
  L(`- Data da análise: ${input.generatedAt}`);
  L(`- Data(s) da(s) coleta(s): ${dates.length ? dates.join(', ') : 'não informada'}`);
  const ages = [...new Set(evals.map((e) => e.ageAtCollection).filter((a): a is number => a !== null))];
  L(`- Idade na coleta / sexo biológico: ${ages.length ? ages.join(' / ') + ' anos' : 'não calculável'} / ${caseInfo.sex ?? 'não informado'}`);
  L(`- Arquivo(s) analisado(s): ${caseInfo.files.length ? caseInfo.files.join(', ') : 'nenhum (lançamento manual)'}`);
  const ctx = [...profile.contexts].map((c) => CONTEXTS[c] ?? c);
  L(`- Contexto clínico disponível: ${ctx.length ? ctx.join('; ') : 'nenhum contexto confirmado'}${caseInfo.medications ? `; medicamentos: ${caseInfo.medications}` : ''}${caseInfo.supplements ? `; suplementos: ${caseInfo.supplements}` : ''}${caseInfo.comorbidities ? `; comorbidades: ${caseInfo.comorbidities}` : ''}${caseInfo.goal ? `; objetivo: ${caseInfo.goal}` : ''}`);
  const missing = new Set<string>();
  if (!caseInfo.sex) missing.add('sexo biológico');
  if (!caseInfo.birth_date) missing.add('data de nascimento');
  evals.forEach((e) => e.notes.filter((n) => n.includes('não informado') || n.includes('não confirmado') || n.includes('não calculável')).forEach((n) => missing.add(n)));
  L(`- Informações relevantes ausentes: ${missing.size ? [...missing].join('; ') : 'nenhuma identificada'}`);
  L();

  L('## Alertas prioritários');
  L();
  const criticals = evals.filter((e) => e.critical);
  const labFlags = evals.filter((e) => e.result.lab_flag && /cr[ií]tic|p[aâ]nic|urgente/i.test(e.result.lab_flag));
  const alertGuidances = guidances.filter((g) => g.guidance.requires_alert);
  const manual = [...evals, ...derivedEvals].filter((e) => e.parsed.kind === 'unparseable' || e.result.confidence === 'baixa');
  if (!criticals.length && !labFlags.length && !alertGuidances.length && !manual.length) {
    L('`Nenhum alerta crítico identificado pelos critérios cadastrados; isso não exclui risco clínico.`');
  } else {
    criticals.forEach((e) => L(`- **Limite crítico cadastrado (${e.critical})**: ${e.exam_canonical} = ${fmtValue(e)} — regra ${e.rule?.exam_canonical} v${e.rule?.version} (${origin(e)}).`));
    labFlags.forEach((e) => L(`- **Sinalização do laboratório**: ${e.result.exam_raw} = ${fmtValue(e)}, marcado "${e.result.lab_flag}" (${origin(e)}).`));
    alertGuidances.forEach((g) => L(`- **Orientação com alerta** ${g.guidance.code}: ${g.guidance.title}.`));
    manual.forEach((e) => L(`- Conferência manual: ${e.result.exam_raw} = ${e.result.value_raw} (${e.notes.join('; ') || 'confiança baixa'}; ${origin(e)}).`));
  }
  L();

  L('## Qualidade e limitações da leitura');
  L();
  const limitations: string[] = [];
  evals.filter((e) => e.classification === 'nao_comparavel' || e.classification === 'regra_ambigua').forEach((e) => limitations.push(`${e.result.exam_raw}: ${CLASSIFICATION_LABEL[e.classification]} (${e.notes.join('; ')}).`));
  evals.filter((e) => !e.exam_canonical).forEach((e) => limitations.push(`${e.result.exam_raw}: sem correspondência segura na tabela; não classificado.`));
  evals.filter((e) => e.result.confidence !== 'alta').forEach((e) => limitations.push(`${e.result.exam_raw}: confiança de extração ${e.result.confidence} (${origin(e)}).`));
  if (tableVersion === 'sem regras ativas') limitations.push('A tabela clínica não tem regras ativas: nenhum resultado foi classificado em relação a alvo otimizado. Configuração clínica incompleta.');
  if (!limitations.length) L('Nenhuma limitação identificada na leitura dos resultados lançados.');
  limitations.forEach((l) => L(`- ${l}`));
  L();

  L('## Resultados estruturados');
  L();
  L('| Exame (canônico / como no laudo) | Resultado original | Convertido | Referência do laboratório | Alvo clínico cadastrado | Classificação | Origem | Confiança |');
  L('|---|---:|---:|---|---|---|---|---|');
  if (!evals.length) L('| (nenhum resultado lançado) | | | | | | | |');
  for (const e of evals) {
    const conv = e.converted ? `${formatNumber(e.converted.value, 3).replace(/,?0+$/, '')} ${e.converted.unit}` : '—';
    L(`| ${esc(e.exam_canonical ?? '—')} / "${esc(e.result.exam_raw)}" | ${esc(fmtValue(e))} | ${esc(conv)} | ${esc(e.result.lab_reference ?? '—')}${e.result.lab_flag ? ` (lab: ${esc(e.result.lab_flag)})` : ''} | ${esc(fmtTarget(e))} | ${CLASSIFICATION_LABEL[e.classification]}${e.critical ? ` · **crítico ${e.critical}**` : ''} | ${esc(origin(e))} | ${e.result.confidence} |`);
  }
  L();

  L('## Cálculos derivados');
  L();
  if (!derived.length) L('Nenhum cálculo derivado habilitado ou possível com os resultados lançados.');
  else {
    L('| Índice | Fórmula | Insumos (valor, origem) | Resultado | Alvo cadastrado | Classificação |');
    L('|---|---|---|---:|---|---|');
    for (const d of derived) {
      const ev = derivedEvals.find((x) => x.result.exam_canonical === d.id && (x.result.collection_date ?? null) === d.collection_date);
      const inputs = d.inputs.map((i) => `${i.exam} = ${formatNumber(i.value, 2)} ${i.unit} (${i.source})`).join('; ');
      const value = d.value === null ? `não calculado: ${d.reason}` : `${formatNumber(d.value, 2)} ${d.unit}${d.collection_date ? ` (coleta ${d.collection_date})` : ''}`;
      L(`| ${d.name} | ${esc(d.formula)} | ${esc(inputs || '—')} | ${esc(value)} | ${ev ? esc(fmtTarget(ev)) : '—'} | ${ev ? CLASSIFICATION_LABEL[ev.classification] : '—'} |`);
    }
  }
  L();

  if (dates.length > 1) {
    L('## Evolução entre coletas');
    L();
    L(`| Exame | ${dates.map((d) => `Coleta ${d}`).join(' | ')} | Observação |`);
    L(`|---|${dates.map(() => '---:').join('|')}|---|`);
    const exams = [...new Set(evals.map((e) => e.exam_canonical ?? e.result.exam_raw))];
    for (const exam of exams) {
      const byDate = dates.map((d) => evals.find((e) => (e.exam_canonical ?? e.result.exam_raw) === exam && e.result.collection_date === d));
      if (byDate.filter(Boolean).length < 2) continue;
      const units = new Set(byDate.filter((e): e is Evaluation => !!e).map((e) => e.unit ?? ''));
      const obs = units.size > 1 ? 'unidade mudou entre coletas; não comparar diretamente' : '';
      L(`| ${esc(exam)} | ${byDate.map((e) => (e ? esc(fmtValue(e)) : '—')).join(' | ')} | ${obs} |`);
    }
    L();
  }

  L('## Síntese para o médico');
  L();
  L('1. **Achados factuais relevantes.**');
  const relevant = evals.filter((e) => ['abaixo_do_alvo', 'acima_do_alvo', 'qualitativo_nao_compativel'].includes(e.classification));
  if (narrative) L(`   ${narrative.achados_factuais}`);
  else if (!relevant.length) L('   Nenhum resultado classificado fora do alvo cadastrado.');
  else relevant.forEach((e) => L(`   - ${e.exam_canonical}: ${fmtValue(e)} — ${CLASSIFICATION_LABEL[e.classification]} (alvo ${fmtTarget(e)}).`));
  L('2. **Padrões que merecem correlação clínica, sem fechar diagnóstico.**');
  L(`   ${narrative ? narrative.padroes_para_correlacao : 'Redação automática desligada: preencher na revisão.'}`);
  L('3. **Divergências entre datas, laboratórios ou unidades.**');
  L(`   ${narrative ? narrative.divergencias : dates.length > 1 ? 'Ver tabela de evolução acima.' : 'Coleta única; sem divergências entre datas.'}`);
  L('4. **Regras ambíguas e informações de contexto ausentes.**');
  const amb = evals.filter((e) => e.classification === 'regra_ambigua');
  if (!amb.length && !missing.size) L('   Nenhuma.');
  amb.forEach((e) => L(`   - ${e.exam_canonical}: candidatas ${e.candidates.map((c) => `#${c.id} (${c.target_min ?? '…'}–${c.target_max ?? '…'} ${c.unit}, v${c.version})`).join('; ')}. Decisão do médico.`));
  if (missing.size) L(`   - Dados ausentes: ${[...missing].join('; ')}.`);
  L('5. **Perguntas e decisões pendentes do médico.**');
  L('   - Validar cada classificação e a seleção de regra antes de qualquer uso.');
  L();

  L('## Minuta de orientações ao paciente');
  L();
  L('### Visão geral');
  L();
  L(narrative ? narrative.visao_geral_paciente : 'Avaliamos os seus exames laboratoriais em conjunto com as informações do seu acompanhamento. Os resultados precisam ser interpretados junto com a sua história clínica, sintomas e tratamento atual, e isso será feito na consulta.');
  L();
  L('### Pontos favoráveis');
  L();
  const good = evals.filter((e) => e.classification === 'dentro_do_alvo' || e.classification === 'qualitativo_compativel');
  if (narrative) L(narrative.pontos_favoraveis_paciente);
  else if (good.length) L(`${good.length} resultado(s) ficaram dentro do que consideramos adequado para o seu acompanhamento.`);
  else L('Nenhum ponto favorável sustentado pelas regras cadastradas nesta análise.');
  L();
  L('### Pontos que merecem atenção');
  L();
  if (narrative) L(narrative.pontos_atencao_paciente);
  else if (relevant.length) L(`${relevant.length} resultado(s) ficaram fora do que consideramos ideal e serão contextualizados na consulta. Uma alteração isolada não significa, por si só, um diagnóstico.`);
  else L('Nenhum ponto de atenção identificado pelos critérios cadastrados.');
  L();
  L('### Orientações aprovadas');
  L();
  if (!guidances.length) L('Nenhuma orientação aprovada se aplica a estes resultados. Os achados serão contextualizados na consulta.');
  guidances.forEach((g) => L(`- ${g.guidance.patient_text}`));
  L();
  L('### Próximos passos');
  L();
  L('Conversaremos sobre estes resultados na consulta. Se você tiver qualquer sintoma novo ou dúvida antes disso, entre em contato com a clínica.');
  L();

  L('## Nota de auditoria — uso médico');
  L();
  L(`- Versão da tabela clínica: ${tableVersion}`);
  const applied = evals.filter((e) => e.rule).map((e) => `${e.exam_canonical} → regra #${e.rule?.id} v${e.rule?.version} (${e.rule?.clinical_source})`);
  L(`- Regras clínicas aplicadas: ${applied.length ? applied.join('; ') : 'nenhuma'}`);
  L(`- Regras ambíguas não resolvidas: ${amb.length ? amb.map((e) => e.exam_canonical).join(', ') : 'nenhuma'}`);
  L(`- IDs de orientações utilizadas: ${guidances.length ? guidances.map((g) => `${g.guidance.code} v${g.guidance.version}`).join(', ') : 'nenhuma'}`);
  const convs = evals.filter((e) => e.converted).map((e) => `${e.exam_canonical}: ${e.result.value_raw} ${e.unit} → ${formatNumber(e.converted?.value ?? 0, 3)} ${e.converted?.unit} (${e.converted?.factor})`);
  L(`- Conversões de unidade realizadas: ${convs.length ? convs.join('; ') : 'nenhuma'}`);
  const calcs = derived.filter((d) => d.value !== null).map((d) => `${d.name} = ${formatNumber(d.value ?? 0, 2)} [${d.formula}; ${d.inputs.map((i) => `${i.exam}=${formatNumber(i.value, 2)}`).join(', ')}]`);
  L(`- Cálculos derivados realizados: ${calcs.length ? calcs.join('; ') : 'nenhum'}`);
  L(`- Itens que exigem validação manual: ${manual.length ? manual.map((e) => e.result.exam_raw).join(', ') : 'nenhum'}`);
  L(`- Dados de contexto ausentes: ${missing.size ? [...missing].join('; ') : 'nenhum'}`);
  L(`- Redação automática: ${narrative ? `sim (${input.aiModel})` : 'não'}`);
  L();
  return lines.join('\n');
}

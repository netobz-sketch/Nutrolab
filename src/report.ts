import { CLASSIFICATION_LABEL, COMPLAINTS, CONTEXTS, formatNumber, scoreBand, SYSTEMS } from './engine/index.js';
import type { DerivedResult, Evaluation, Guidance, PatientProfile, Score } from './engine/index.js';
import type { Reports } from './ai.js';

export interface CaseInfo {
  id: number;
  patient_code: string;
  patient_name: string;
  sex: 'M' | 'F' | null;
  birth_date: string | null;
  medications: string;
  supplements: string;
  comorbidities: string;
  goal: string;
  complaints: string[];
  menopause: string;
  ai_notes: string;
  files: string[];
}

export interface ConductItem {
  kind: string;
  title: string;
  rationale: string;
  exams: string[];
  sources: string[];
  origin: string;
}

export interface ReportInput {
  caseInfo: CaseInfo;
  profile: PatientProfile;
  evals: Evaluation[];
  derived: DerivedResult[];
  derivedEvals: Evaluation[];
  guidances: Array<{ guidance: Guidance; evaluation: Evaluation }>;
  score: Score;
  tableVersion: string;
  narrative: Reports | null;
  aiModel: string | null;
  generatedAt: string;
  /** só no relatório final */
  conduct?: ConductItem[];
  doctorNotes?: string;
  authorName?: string;
}

export const CONDUCT_KIND_LABEL: Record<string, string> = {
  suplementacao: 'Suplementação',
  estilo_de_vida: 'Estilo de vida',
  seguimento: 'Seguimento',
  exame: 'Exames complementares',
  encaminhamento: 'Encaminhamento',
  medicamentoso: 'Medicamentoso',
  outro: 'Outros',
};

const esc = (s: string | null | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function fmtValue(ev: Evaluation): string {
  const unit = ev.result.unit_raw ? ` ${ev.result.unit_raw}` : '';
  return `${ev.result.value_raw}${unit}`;
}

function fmtTarget(ev: Evaluation): string {
  const r = ev.rule;
  if (!r) return ev.candidates.length ? `${ev.candidates.length} regras candidatas` : '—';
  const cond = [r.sex !== 'todos' ? r.sex : null, r.age_min !== null || r.age_max !== null ? `${r.age_min ?? ''}–${r.age_max ?? ''} anos` : null, ...r.contexts.filter((c) => c !== 'geral')].filter(Boolean).join('/');
  const hasTarget = r.target_min !== null || r.target_max !== null || !!r.target_text;
  const range = r.target_text ? r.target_text : hasTarget ? `${r.target_min ?? '…'}–${r.target_max ?? '…'} ${r.unit}` : `normalidade ${r.normal_min ?? '…'}–${r.normal_max ?? '…'} ${r.unit}`;
  return `${range}${cond ? ` (${cond})` : ''}`;
}

function fmtNormal(ev: Evaluation): string {
  if (!ev.normal) return '—';
  return `${ev.normal.min ?? '…'}–${ev.normal.max ?? '…'} (${ev.normal.source})${ev.normality ? ` · ${ev.normality}` : ''}`;
}

function origin(ev: Evaluation): string {
  const parts = [ev.result.source_file, ev.result.page ? `p. ${ev.result.page}` : null, ev.result.collection_date ? `coleta ${ev.result.collection_date}` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : 'lançamento manual';
}

function systemOf(ev: Evaluation): string {
  return ev.rule?.system ?? 'outros';
}

function groupBySystem(evals: Evaluation[]): Array<{ system: string; label: string; items: Evaluation[] }> {
  const map = new Map<string, Evaluation[]>();
  for (const e of evals) {
    const s = systemOf(e);
    map.set(s, [...(map.get(s) ?? []), e]);
  }
  return [...map.entries()].map(([system, items]) => ({ system, label: SYSTEMS[system] ?? system, items })).sort((a, b) => (a.system === 'outros' ? 1 : b.system === 'outros' ? -1 : a.label.localeCompare(b.label, 'pt-BR')));
}

function scoreLines(score: Score): string[] {
  const out: string[] = [];
  if (score.total === null) {
    out.push('Score não calculado: nenhum resultado comparável com regra ativa.');
    return out;
  }
  const band = scoreBand(score.total);
  out.push(`**Score geral: ${score.total}/100 — ${band.label}** (${score.counted} resultado(s) considerados).`);
  out.push('');
  out.push('| Sistema | Score | Exames |');
  out.push('|---|---:|---:|');
  for (const s of score.bySystem) out.push(`| ${s.label} | ${s.score} | ${s.n} |`);
  return out;
}

function conductLines(items: ConductItem[] | undefined, doctorNotes: string | undefined, forPatient: boolean): string[] {
  const out: string[] = [];
  if (items && items.length) {
    out.push(forPatient ? '## Orientações e próximos passos' : '## Conduta aprovada pelo médico');
    out.push('');
    const kinds = [...new Set(items.map((i) => i.kind))];
    for (const k of kinds) {
      out.push(`### ${CONDUCT_KIND_LABEL[k] ?? k}`);
      out.push('');
      for (const i of items.filter((x) => x.kind === k)) {
        out.push(`- **${i.title}**${forPatient ? '' : ` — ${i.rationale}`}${!forPatient && i.exams.length ? ` (${i.exams.join(', ')})` : ''}`);
        if (!forPatient && i.sources.length) out.push(`  - Fontes: ${i.sources.join('; ')}`);
      }
      out.push('');
    }
  }
  if (doctorNotes && doctorNotes.trim()) {
    out.push(forPatient ? '## Observações do seu médico' : '## Observações do médico');
    out.push('');
    out.push(doctorNotes.trim());
    out.push('');
  }
  return out;
}

export function buildPatientReport(input: ReportInput): string {
  const { caseInfo, evals, score, narrative } = input;
  const dates = [...new Set(evals.map((e) => e.result.collection_date).filter((d): d is string => !!d))].sort();
  const L: string[] = [];
  L.push('# Relatório dos seus exames');
  L.push('');
  L.push(`${caseInfo.patient_name ? `**Paciente:** ${caseInfo.patient_name} · ` : ''}**Coleta:** ${dates.length ? dates.join(', ') : 'não informada'} · **Emitido em:** ${input.generatedAt}`);
  L.push('');
  if (!input.conduct) L.push('> Minuta para revisão médica. Este documento só é válido depois de revisado e assinado pelo seu médico.');
  else L.push(`> Revisado por ${input.authorName ?? 'seu médico'}. Este relatório complementa a consulta e não substitui a avaliação clínica.`);
  L.push('');
  L.push('## Seu score de saúde laboratorial');
  L.push('');
  L.push(...scoreLines(score));
  L.push('');
  L.push('O score resume quantos exames estão na faixa que consideramos ideal para você; 100 é o melhor resultado. Um score mais baixo não é um diagnóstico: mostra onde vale a pena olhar com mais atenção.');
  L.push('');
  L.push('## Visão geral');
  L.push('');
  L.push(narrative ? narrative.resumido.visao_geral : 'Avaliamos os seus exames em conjunto com as informações do seu acompanhamento. Os resultados precisam ser interpretados junto com a sua história clínica, sintomas e tratamento atual, e isso será feito na consulta.');
  L.push('');
  L.push('## Por sistema');
  L.push('');
  if (narrative) {
    for (const s of narrative.resumido.por_sistema) {
      L.push(`### ${s.sistema}`);
      L.push('');
      L.push(s.texto);
      L.push('');
    }
  } else {
    for (const g of groupBySystem(evals)) {
      const ok = g.items.filter((e) => e.classification === 'dentro_do_alvo' || e.classification === 'qualitativo_compativel').length;
      const att = g.items.filter((e) => ['abaixo_do_alvo', 'acima_do_alvo', 'qualitativo_nao_compativel'].includes(e.classification)).length;
      L.push(`### ${g.label}`);
      L.push('');
      L.push(`${g.items.length} exame(s): ${ok} dentro do ideal, ${att} merecendo atenção.`);
      L.push('');
    }
  }
  L.push('## Pontos favoráveis');
  L.push('');
  const good = evals.filter((e) => e.classification === 'dentro_do_alvo' || e.classification === 'qualitativo_compativel');
  L.push(narrative ? narrative.resumido.pontos_favoraveis : good.length ? `${good.length} resultado(s) ficaram dentro do que consideramos ideal para o seu acompanhamento.` : 'Nenhum ponto favorável sustentado pelas regras cadastradas nesta análise.');
  L.push('');
  L.push('## Pontos que merecem atenção');
  L.push('');
  const relevant = evals.filter((e) => ['abaixo_do_alvo', 'acima_do_alvo', 'qualitativo_nao_compativel'].includes(e.classification));
  L.push(narrative ? narrative.resumido.pontos_atencao : relevant.length ? `${relevant.length} resultado(s) ficaram fora do que consideramos ideal e serão contextualizados na consulta. Uma alteração isolada não significa, por si só, um diagnóstico.` : 'Nenhum ponto de atenção identificado pelos critérios cadastrados.');
  L.push('');
  if (input.guidances.length) {
    L.push('## Orientações');
    L.push('');
    for (const g of input.guidances) L.push(`- ${g.guidance.patient_text}`);
    L.push('');
  }
  L.push(...conductLines(input.conduct, input.doctorNotes, true));
  L.push('## Mensagem final');
  L.push('');
  L.push(narrative ? narrative.resumido.mensagem_final : 'Conversaremos sobre estes resultados na consulta. Se você tiver qualquer sintoma novo ou dúvida antes disso, entre em contato com a clínica.');
  L.push('');
  return L.join('\n');
}

export function buildTechnicalReport(input: ReportInput): string {
  const { caseInfo, profile, evals, derived, derivedEvals, guidances, tableVersion, narrative, score } = input;
  const dates = [...new Set(evals.map((e) => e.result.collection_date).filter((d): d is string => !!d))].sort();
  const L: string[] = [];
  L.push('# Relatório técnico de exames');
  L.push('');
  L.push(input.conduct ? `> Revisado e aprovado por ${input.authorName ?? 'médico responsável'} em ${input.generatedAt}.` : '> MINUTA para revisão médica. Documento de apoio à decisão; não enviar antes da revisão e aprovação do médico responsável.');
  L.push('');
  L.push('## Identificação e contexto');
  L.push('');
  L.push(`- Paciente: ${caseInfo.patient_name || '—'} (código ${caseInfo.patient_code})`);
  L.push(`- Data da análise: ${input.generatedAt}`);
  L.push(`- Coleta(s): ${dates.length ? dates.join(', ') : 'não informada'}`);
  const ages = [...new Set(evals.map((e) => e.ageAtCollection).filter((a): a is number => a !== null))];
  L.push(`- Idade na coleta / sexo biológico: ${ages.length ? ages.join(' / ') + ' anos' : 'não calculável'} / ${caseInfo.sex ?? 'não informado'}${caseInfo.menopause ? ` · menopausa: ${caseInfo.menopause}` : ''}`);
  L.push(`- Contextos confirmados: ${[...profile.contexts].map((c) => CONTEXTS[c] ?? c).join('; ') || 'nenhum'}`);
  L.push(`- Comorbidades: ${caseInfo.comorbidities || '—'}`);
  L.push(`- Medicamentos: ${caseInfo.medications || '—'} · Suplementos: ${caseInfo.supplements || '—'}`);
  L.push(`- Queixas: ${caseInfo.complaints.map((c) => COMPLAINTS[c] ?? c).join(', ') || 'nenhuma marcada'}`);
  L.push(`- Objetivo terapêutico: ${caseInfo.goal || '—'}`);
  if (caseInfo.ai_notes) L.push(`- Observações do médico para a interpretação: ${caseInfo.ai_notes}`);
  L.push(`- Arquivo(s): ${caseInfo.files.length ? caseInfo.files.join(', ') : 'lançamento manual'}`);
  L.push('');
  L.push('## Score');
  L.push('');
  L.push(...scoreLines(score));
  L.push('');
  L.push('Critério: dentro do alvo ótimo = 1; fora do ótimo e dentro da normalidade = 0,6; fora da normalidade = 0,25; além de limite crítico = 0. Média × 100.');
  L.push('');

  L.push('## Alertas prioritários');
  L.push('');
  const criticals = evals.filter((e) => e.critical);
  const labFlags = evals.filter((e) => e.result.lab_flag && /cr[ií]tic|p[aâ]nic|urgente/i.test(e.result.lab_flag));
  const alertGuidances = guidances.filter((g) => g.guidance.requires_alert);
  const manual = [...evals, ...derivedEvals].filter((e) => e.parsed.kind === 'unparseable' || e.result.confidence === 'baixa');
  if (!criticals.length && !labFlags.length && !alertGuidances.length && !manual.length) L.push('`Nenhum alerta crítico identificado pelos critérios cadastrados; isso não exclui risco clínico.`');
  criticals.forEach((e) => L.push(`- **Limite crítico cadastrado (${e.critical})**: ${e.exam_canonical} = ${fmtValue(e)} (${origin(e)}).`));
  labFlags.forEach((e) => L.push(`- **Sinalização do laboratório**: ${e.result.exam_raw} = ${fmtValue(e)}, marcado "${e.result.lab_flag}" (${origin(e)}).`));
  alertGuidances.forEach((g) => L.push(`- **Orientação com alerta** ${g.guidance.code}: ${g.guidance.title}.`));
  manual.forEach((e) => L.push(`- Conferência manual: ${e.result.exam_raw} = ${e.result.value_raw} (${e.notes.join('; ') || 'confiança baixa'}; ${origin(e)}).`));
  L.push('');

  L.push('## Síntese');
  L.push('');
  L.push(narrative ? narrative.tecnico.sintese : 'Redação automática não utilizada: preencher na revisão.');
  L.push('');

  L.push('## Resultados por sistema');
  L.push('');
  for (const g of groupBySystem(evals)) {
    const sys = score.bySystem.find((s) => s.system === g.system);
    L.push(`### ${g.label}${sys ? ` — score ${sys.score}` : ''}`);
    L.push('');
    L.push('| Exame | Resultado | Convertido | Ref. laboratório | Normalidade | Alvo cadastrado | Classificação | Origem | Confiança |');
    L.push('|---|---:|---:|---|---|---|---|---|---|');
    for (const e of g.items) {
      const conv = e.converted ? `${formatNumber(e.converted.value, 3).replace(/,?0+$/, '')} ${e.converted.unit}` : '—';
      L.push(`| ${esc(e.exam_canonical ?? '—')} / "${esc(e.result.exam_raw)}" | ${esc(fmtValue(e))} | ${esc(conv)} | ${esc(e.result.lab_reference ?? '—')}${e.result.lab_flag ? ` (lab: ${esc(e.result.lab_flag)})` : ''} | ${esc(fmtNormal(e))} | ${esc(fmtTarget(e))} | ${CLASSIFICATION_LABEL[e.classification]}${e.critical ? ` · **crítico ${e.critical}**` : ''} | ${esc(origin(e))} | ${e.result.confidence} |`);
    }
    L.push('');
    const n = narrative?.tecnico.por_sistema.find((s) => s.sistema.toLowerCase().includes(g.label.toLowerCase().split(' ')[0] ?? '') || g.label.toLowerCase().includes(s.sistema.toLowerCase().split(' ')[0] ?? ''));
    if (n) {
      L.push(`**Achados.** ${n.achados}`);
      L.push('');
      L.push(`**Correlação clínica.** ${n.correlacao_clinica}`);
      L.push('');
    }
  }

  L.push('## Cálculos derivados');
  L.push('');
  if (!derived.length) L.push('Nenhum cálculo derivado habilitado ou possível com os resultados lançados.');
  else {
    L.push('| Índice | Fórmula | Insumos | Resultado | Alvo | Classificação |');
    L.push('|---|---|---|---:|---|---|');
    for (const d of derived) {
      const ev = derivedEvals.find((x) => x.result.exam_canonical === d.id && (x.result.collection_date ?? null) === d.collection_date);
      const inputs = d.inputs.map((i) => `${i.exam} = ${formatNumber(i.value, 2)} ${i.unit}`).join('; ');
      const value = d.value === null ? `não calculado: ${d.reason}` : `${formatNumber(d.value, 2)} ${d.unit}`;
      L.push(`| ${d.name} | ${esc(d.formula)} | ${esc(inputs || '—')} | ${esc(value)} | ${ev ? esc(fmtTarget(ev)) : '—'} | ${ev ? CLASSIFICATION_LABEL[ev.classification] : '—'} |`);
    }
  }
  L.push('');

  if (dates.length > 1) {
    L.push('## Evolução entre coletas');
    L.push('');
    L.push(`| Exame | ${dates.map((d) => `Coleta ${d}`).join(' | ')} | Observação |`);
    L.push(`|---|${dates.map(() => '---:').join('|')}|---|`);
    for (const exam of [...new Set(evals.map((e) => e.exam_canonical ?? e.result.exam_raw))]) {
      const byDate = dates.map((d) => evals.find((e) => (e.exam_canonical ?? e.result.exam_raw) === exam && e.result.collection_date === d));
      if (byDate.filter(Boolean).length < 2) continue;
      const units = new Set(byDate.filter((e): e is Evaluation => !!e).map((e) => e.unit ?? ''));
      L.push(`| ${esc(exam)} | ${byDate.map((e) => (e ? esc(fmtValue(e)) : '—')).join(' | ')} | ${units.size > 1 ? 'unidade mudou entre coletas; não comparar diretamente' : ''} |`);
    }
    L.push('');
  }

  L.push('## Leitura integrada');
  L.push('');
  L.push(narrative ? narrative.tecnico.leitura_integrada : 'Redação automática não utilizada.');
  L.push('');
  L.push('## Limitações da leitura');
  L.push('');
  const limitations: string[] = [];
  evals.filter((e) => e.classification === 'nao_comparavel' || e.classification === 'regra_ambigua').forEach((e) => limitations.push(`${e.result.exam_raw}: ${CLASSIFICATION_LABEL[e.classification]} (${e.notes.join('; ')}).`));
  evals.filter((e) => !e.exam_canonical).forEach((e) => limitations.push(`${e.result.exam_raw}: sem correspondência na tabela; não classificado.`));
  evals.filter((e) => e.result.confidence !== 'alta').forEach((e) => limitations.push(`${e.result.exam_raw}: confiança de extração ${e.result.confidence} (${origin(e)}).`));
  if (tableVersion === 'sem regras ativas') limitations.push('A tabela clínica não tem regras ativas: nenhum resultado foi classificado.');
  if (narrative) limitations.push(narrative.tecnico.limitacoes);
  if (!limitations.length) L.push('Nenhuma limitação identificada.');
  limitations.forEach((l) => L.push(`- ${l}`));
  L.push('');

  L.push(...conductLines(input.conduct, input.doctorNotes, false));

  L.push('## Nota de auditoria');
  L.push('');
  L.push(`- Versão da tabela clínica: ${tableVersion}`);
  const applied = evals.filter((e) => e.rule).map((e) => `${e.exam_canonical} → regra #${e.rule?.id} v${e.rule?.version}`);
  L.push(`- Regras aplicadas: ${applied.length ? applied.join('; ') : 'nenhuma'}`);
  L.push(`- Orientações da biblioteca: ${guidances.length ? guidances.map((g) => `${g.guidance.code} v${g.guidance.version}`).join(', ') : 'nenhuma'}`);
  const convs = evals.filter((e) => e.converted).map((e) => `${e.exam_canonical}: ${e.result.value_raw} ${e.unit} → ${formatNumber(e.converted?.value ?? 0, 3)} ${e.converted?.unit} (${e.converted?.factor})`);
  L.push(`- Conversões de unidade: ${convs.length ? convs.join('; ') : 'nenhuma'}`);
  L.push(`- Itens com validação manual: ${manual.length ? manual.map((e) => e.result.exam_raw).join(', ') : 'nenhum'}`);
  L.push(`- Redação automática: ${narrative ? `sim (${input.aiModel})` : 'não'}`);
  L.push('');
  return L.join('\n');
}

/** Compatibilidade com o fluxo antigo. */
export const buildReport = buildTechnicalReport;

export type Sex = 'M' | 'F';
export type RuleSex = 'M' | 'F' | 'todos';
export type Status = 'ativo' | 'rascunho' | 'inativo';
export type Confidence = 'alta' | 'media' | 'baixa';

export type Classification =
  | 'dentro_do_alvo'
  | 'abaixo_do_alvo'
  | 'acima_do_alvo'
  | 'qualitativo_compativel'
  | 'qualitativo_nao_compativel'
  | 'sem_alvo'
  | 'nao_comparavel'
  | 'regra_ambigua';

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  dentro_do_alvo: 'dentro do alvo cadastrado',
  abaixo_do_alvo: 'abaixo do alvo cadastrado',
  acima_do_alvo: 'acima do alvo cadastrado',
  qualitativo_compativel: 'resultado qualitativo compatível',
  qualitativo_nao_compativel: 'resultado qualitativo não compatível',
  sem_alvo: 'sem alvo cadastrado',
  nao_comparavel: 'não comparável por unidade ou contexto',
  regra_ambigua: 'regra ambígua',
};

export const CLASSIFICATIONS = Object.keys(CLASSIFICATION_LABEL) as Classification[];

/** Vocabulário de contexto (fonte única; espelha skill/references/esquema-tabela.md). */
export const CONTEXTS: Record<string, string> = {
  geral: 'Geral (sem condição)',
  gestacao: 'Gestação',
  lactacao: 'Lactação',
  pre_menopausa: 'Pré-menopausa',
  pos_menopausa: 'Pós-menopausa',
  fase_folicular: 'Fase folicular',
  fase_lutea: 'Fase lútea',
  jejum: 'Jejum ≥ 8 h confirmado',
  sem_jejum: 'Sem jejum / não confirmado',
  trh: 'Terapia de reposição hormonal',
  uso_anticoncepcional: 'Anticoncepcional hormonal',
  atleta: 'Atleta / treino intenso',
};

/** Sistemas/órgãos para a leitura integrada e o score por sistema. */
export const SYSTEMS: Record<string, string> = {
  metabolico: 'Metabolismo glicídico',
  lipidico: 'Perfil lipídico',
  tireoide: 'Tireoide',
  hematologico: 'Hematologia',
  ferro: 'Ferro e reservas',
  vitaminas: 'Vitaminas',
  minerais: 'Minerais e eletrólitos',
  renal: 'Função renal',
  hepatico: 'Função hepática',
  inflamacao: 'Inflamação',
  hormonal: 'Hormônios',
  cardiovascular: 'Risco cardiovascular',
  osseo: 'Metabolismo ósseo',
  saliva: 'Exames de saliva',
  urina: 'Urina',
  outros: 'Outros',
};

/** Queixas do pré-questionário (marcação). */
export const COMPLAINTS: Record<string, string> = {
  fadiga: 'Fadiga / cansaço',
  sono: 'Sono ruim',
  memoria: 'Memória / concentração',
  libido: 'Libido baixa',
  humor: 'Humor / ansiedade',
  peso: 'Ganho de peso / dificuldade de perder',
  queda_cabelo: 'Queda de cabelo',
  unhas_pele: 'Unhas / pele',
  intestino: 'Intestino (constipação, distensão)',
  dor_articular: 'Dores articulares / musculares',
  desempenho: 'Desempenho físico',
  caibras: 'Cãibras / formigamento',
  frio: 'Intolerância ao frio',
  cefaleia: 'Dor de cabeça',
};

export interface Rule {
  id: number;
  exam_canonical: string;
  aliases: string[];
  system: string;
  normal_min: number | null;
  normal_max: number | null;
  sex: RuleSex;
  age_min: number | null;
  age_max: number | null;
  contexts: string[];
  unit: string;
  target_min: number | null;
  target_max: number | null;
  target_text: string | null;
  critical_low: number | null;
  critical_high: number | null;
  guidance_ids: string[];
  clinical_source: string;
  version: string;
  reviewed_at: string;
  status: Status;
}

export interface Guidance {
  id: number;
  code: string;
  title: string;
  exam_canonical: string | null;
  trigger: Classification | 'critico' | 'manual';
  contexts_required: string[];
  contexts_excluded: string[];
  not_apply_note: string;
  patient_text: string;
  requires_alert: boolean;
  clinical_source: string;
  version: string;
  reviewed_at: string;
  status: Status;
}

export interface PatientProfile {
  sex: Sex | null;
  birthDate: string | null;
  contexts: Set<string>;
}

export interface ResultInput {
  id: number;
  exam_raw: string;
  exam_canonical: string | null;
  value_raw: string;
  unit_raw: string | null;
  lab_reference: string | null;
  lab_flag: string | null;
  collection_date: string | null;
  source_file: string | null;
  page: number | null;
  confidence: Confidence;
  derived: boolean;
}

export interface ParsedValue {
  kind: 'numeric' | 'qualitative' | 'unparseable';
  comparator: '<' | '>' | '<=' | '>=' | null;
  number: number | null;
  text: string | null;
  note: string | null;
}

export interface Conversion {
  value: number;
  unit: string;
  factor: string;
}

export interface Evaluation {
  result: ResultInput;
  exam_canonical: string | null;
  parsed: ParsedValue;
  unit: string | null;
  converted: Conversion | null;
  ageAtCollection: number | null;
  rule: Rule | null;
  candidates: Rule[];
  classification: Classification;
  critical: 'baixo' | 'alto' | null;
  /** Faixa de normalidade: regra do médico ou referência do laudo. */
  normal: { min: number | null; max: number | null; source: 'regra' | 'laudo' } | null;
  normality: 'dentro' | 'abaixo' | 'acima' | null;
  notes: string[];
}

export interface ScoreItem {
  exam: string;
  system: string;
  points: number;
  reason: string;
}

export interface Score {
  total: number | null;
  counted: number;
  bySystem: Array<{ system: string; label: string; score: number; n: number }>;
  items: ScoreItem[];
}

export interface DerivedInput {
  exam: string;
  value: number;
  unit: string;
  source: string;
}

export interface DerivedResult {
  id: string;
  name: string;
  formula: string;
  unit: string;
  collection_date: string | null;
  inputs: DerivedInput[];
  value: number | null;
  reason: string | null;
}

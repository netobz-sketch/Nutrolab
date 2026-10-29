import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Guidance, Rule, Status } from './engine/types.js';
import { CALCS } from './engine/derived.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = path.join(DATA_DIR, 'nutrolab.sqlite');

export type Row = Record<string, unknown>;

export function str(row: Row, key: string): string {
  const v = row[key];
  return v === null || v === undefined ? '' : String(v);
}
export function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined || v === '' ? null : String(v);
}
export function num(row: Row, key: string): number {
  const v = row[key];
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
}
export function numOrNull(row: Row, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'number' ? v : Number(v);
}
export function list(value: string): string[] {
  return value
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','medico')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_at TEXT
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  exam_canonical TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '',
  sex TEXT NOT NULL DEFAULT 'todos' CHECK (sex IN ('M','F','todos')),
  age_min INTEGER,
  age_max INTEGER,
  contexts TEXT NOT NULL DEFAULT 'geral',
  unit TEXT NOT NULL,
  target_min REAL,
  target_max REAL,
  target_text TEXT,
  critical_low REAL,
  critical_high REAL,
  guidance_ids TEXT NOT NULL DEFAULT '',
  clinical_source TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0',
  reviewed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('ativo','rascunho','inativo')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER
);
CREATE TABLE IF NOT EXISTS guidances (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  exam_canonical TEXT,
  trigger TEXT NOT NULL,
  contexts_required TEXT NOT NULL DEFAULT '',
  contexts_excluded TEXT NOT NULL DEFAULT '',
  not_apply_note TEXT NOT NULL DEFAULT '',
  patient_text TEXT NOT NULL,
  requires_alert INTEGER NOT NULL DEFAULT 0,
  clinical_source TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0',
  reviewed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('ativo','rascunho','inativo')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY,
  patient_code TEXT NOT NULL,
  sex TEXT CHECK (sex IN ('M','F') OR sex IS NULL),
  birth_date TEXT,
  contexts TEXT NOT NULL DEFAULT '',
  medications TEXT NOT NULL DEFAULT '',
  supplements TEXT NOT NULL DEFAULT '',
  comorbidities TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','revisado','arquivado')),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS case_files (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  exam_raw TEXT NOT NULL,
  exam_canonical TEXT,
  value_raw TEXT NOT NULL,
  unit_raw TEXT,
  lab_reference TEXT,
  lab_flag TEXT,
  collection_date TEXT,
  source_file TEXT,
  page INTEGER,
  confidence TEXT NOT NULL DEFAULT 'alta' CHECK (confidence IN ('alta','media','baixa')),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','ia')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  markdown TEXT NOT NULL,
  table_version TEXT NOT NULL,
  ai_used INTEGER NOT NULL DEFAULT 0,
  ai_model TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  case_id INTEGER,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by INTEGER,
  channel TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_results_case ON results(case_id);
CREATE INDEX IF NOT EXISTS idx_analyses_case ON analyses(case_id);
CREATE INDEX IF NOT EXISTS idx_rules_exam ON rules(exam_canonical, status);
`;

/** Colunas acrescentadas depois do schema inicial (SQLite: ADD COLUMN idempotente). */
const MIGRATIONS: Array<[table: string, column: string, ddl: string]> = [
  ['users', 'cpf', 'TEXT'],
  ['users', 'council', 'TEXT'],
  ['users', 'council_number', 'TEXT'],
  ['users', 'council_state', 'TEXT'],
  ['users', 'profession', 'TEXT'],
  ['cases', 'patient_name', 'TEXT'],
  ['cases', 'complaints', "TEXT NOT NULL DEFAULT ''"],
  ['cases', 'menopause', "TEXT NOT NULL DEFAULT ''"],
  ['cases', 'ai_notes', "TEXT NOT NULL DEFAULT ''"],
  ['cases', 'doctor_notes', "TEXT NOT NULL DEFAULT ''"],
  ['results', 'checked', 'INTEGER NOT NULL DEFAULT 0'],
  ['results', 'excluded', 'INTEGER NOT NULL DEFAULT 0'],
  ['rules', 'normal_min', 'REAL'],
  ['rules', 'normal_max', 'REAL'],
  ['rules', 'system', "TEXT NOT NULL DEFAULT 'outros'"],
  ['analyses', 'markdown_patient', 'TEXT'],
  ['analyses', 'markdown_technical', 'TEXT'],
  ['analyses', 'score', 'INTEGER'],
  ['analyses', 'score_json', 'TEXT'],
  ['analyses', 'final_patient', 'TEXT'],
  ['analyses', 'final_technical', 'TEXT'],
  ['analyses', 'finalized_at', 'TEXT'],
  ['case_files', 'mime', "TEXT NOT NULL DEFAULT 'application/pdf'"],
];

const EXTRA_SCHEMA = `
CREATE TABLE IF NOT EXISTS conduct_items (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  analysis_id INTEGER REFERENCES analyses(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  exams TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'ia' CHECK (origin IN ('ia','medico','biblioteca')),
  status TEXT NOT NULL DEFAULT 'sugerida' CHECK (status IN ('sugerida','aprovada','rejeitada')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conduct_case ON conduct_items(case_id);
`;

function migrate(database: DatabaseSync): void {
  for (const [table, column, ddl] of MIGRATIONS) {
    const cols = (database.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => str(c, 'name'));
    if (!cols.includes(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  database.exec(EXTRA_SCHEMA);
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error('banco não inicializado');
  return db;
}

export function openDb(): DatabaseSync {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  seedDefaults(db);
  seedCatalog(db);
  return db;
}

export function rowToRule(row: Row): Rule {
  return {
    id: num(row, 'id'),
    exam_canonical: str(row, 'exam_canonical'),
    aliases: list(str(row, 'aliases')),
    system: str(row, 'system') || 'outros',
    normal_min: numOrNull(row, 'normal_min'),
    normal_max: numOrNull(row, 'normal_max'),
    sex: str(row, 'sex') as Rule['sex'],
    age_min: numOrNull(row, 'age_min'),
    age_max: numOrNull(row, 'age_max'),
    contexts: list(str(row, 'contexts')).length ? list(str(row, 'contexts')) : ['geral'],
    unit: str(row, 'unit'),
    target_min: numOrNull(row, 'target_min'),
    target_max: numOrNull(row, 'target_max'),
    target_text: strOrNull(row, 'target_text'),
    critical_low: numOrNull(row, 'critical_low'),
    critical_high: numOrNull(row, 'critical_high'),
    guidance_ids: list(str(row, 'guidance_ids')),
    clinical_source: str(row, 'clinical_source'),
    version: str(row, 'version'),
    reviewed_at: str(row, 'reviewed_at'),
    status: str(row, 'status') as Status,
  };
}

export function rowToGuidance(row: Row): Guidance {
  return {
    id: num(row, 'id'),
    code: str(row, 'code'),
    title: str(row, 'title'),
    exam_canonical: strOrNull(row, 'exam_canonical'),
    trigger: str(row, 'trigger') as Guidance['trigger'],
    contexts_required: list(str(row, 'contexts_required')),
    contexts_excluded: list(str(row, 'contexts_excluded')),
    not_apply_note: str(row, 'not_apply_note'),
    patient_text: str(row, 'patient_text'),
    requires_alert: num(row, 'requires_alert') === 1,
    clinical_source: str(row, 'clinical_source'),
    version: str(row, 'version'),
    reviewed_at: str(row, 'reviewed_at'),
    status: str(row, 'status') as Status,
  };
}

export function allRules(): Rule[] {
  return (getDb().prepare('SELECT * FROM rules ORDER BY exam_canonical, status, id').all() as Row[]).map(rowToRule);
}
export function allGuidances(): Guidance[] {
  return (getDb().prepare('SELECT * FROM guidances ORDER BY code').all() as Row[]).map(rowToGuidance);
}

export function getSetting(key: string, fallback: string): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
  return row ? str(row, 'value') : fallback;
}
export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
export function enabledCalcIds(): Set<string> {
  return new Set(CALCS.filter((c) => getSetting(`calc.${c.id}`, c.id === 'tyg' ? '0' : '1') === '1').map((c) => c.id));
}

/** Versão da tabela clínica: maior data de revisão entre regras ativas + contagem. */
export function tableVersion(): string {
  const row = getDb()
    .prepare("SELECT MAX(reviewed_at) AS d, COUNT(*) AS n FROM rules WHERE status = 'ativo'")
    .get() as Row;
  const n = num(row, 'n');
  return n === 0 ? 'sem regras ativas' : `${str(row, 'd')} (${n} regras ativas)`;
}

export function audit(userId: number | null, action: string, entity: string, entityId: string | number | null, details: unknown, requestId?: string): void {
  try {
    getDb()
      .prepare('INSERT INTO audit_log(user_id, action, entity, entity_id, details, request_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, action, entity, entityId === null ? null : String(entityId), details === undefined ? null : JSON.stringify(details), requestId ?? null);
  } catch {
    // auditoria nunca derruba a operação
  }
}

/* ------------------------------------------------------------------ seed */

export function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = (lines.shift() ?? '').split(',');
  return lines.map((line) => {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    const row: Row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ''));
    return row;
  });
}

function seedDefaults(database: DatabaseSync): void {
  const rulesCount = num(database.prepare('SELECT COUNT(*) AS n FROM rules').get() as Row, 'n');
  if (rulesCount === 0) {
    const seedPath = path.resolve('seed/valores-otimizados.csv');
    let seedText: string | null = null;
    try {
      seedText = fs.existsSync(seedPath) ? fs.readFileSync(seedPath, 'utf8') : null;
    } catch (error) {
      console.error(`seed de regras não pôde ser lido (${seedPath}): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (seedText !== null) {
      const insert = database.prepare(
        `INSERT INTO rules(exam_canonical, aliases, sex, age_min, age_max, contexts, unit, target_min, target_max, target_text,
          critical_low, critical_high, guidance_ids, clinical_source, version, reviewed_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rascunho')`,
      );
      for (const r of parseCsv(seedText)) {
        const n = (k: string) => (str(r, k) === '' ? null : Number(str(r, k)));
        insert.run(
          str(r, 'exame_canonico'), str(r, 'aliases'), str(r, 'sexo') || 'todos', n('idade_min'), n('idade_max'),
          str(r, 'contexto') || 'geral', str(r, 'unidade'), n('alvo_min'), n('alvo_max'), strOrNull(r, 'alvo_texto'),
          n('limite_critico_inferior'), n('limite_critico_superior'), str(r, 'orientacao_id'),
          str(r, 'fonte_clinica') || 'EXEMPLO DE FORMATO', str(r, 'versao') || '1.0', str(r, 'data_revisao') || '2026-10-28',
        );
      }
    }
  }
  const guidanceCount = num(database.prepare('SELECT COUNT(*) AS n FROM guidances').get() as Row, 'n');
  if (guidanceCount === 0) {
    const insert = database.prepare(
      `INSERT INTO guidances(code, title, exam_canonical, trigger, contexts_excluded, not_apply_note, patient_text, requires_alert, clinical_source, version, reviewed_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0', '2026-10-28', 'rascunho')`,
    );
    insert.run(
      'ORIENT-VITD-BAIXA', 'Vitamina D abaixo do alvo (exemplo de formato)', 'vitamina_d_25oh', 'abaixo_do_alvo', 'gestacao',
      'Uso atual de suplemento de vitamina D não informado; resultado com confiança baixa.',
      'Seu nível de vitamina D ficou abaixo do que consideramos ideal para o seu acompanhamento. Isso é comum e, na maioria das vezes, ajustável. Vamos conversar na consulta sobre a melhor forma de corrigir no seu caso.',
      0, 'EXEMPLO DE FORMATO - substituir pela decisão do médico',
    );
    insert.run(
      'ORIENT-ALERTA-CRITICO', 'Resultado fora de limite crítico cadastrado (exemplo de formato)', null, 'critico', '',
      'Resultado com confiança baixa ou marcado para revisão manual sem confirmação visual da página.',
      'Um dos seus exames apresentou um valor que precisa ser avaliado com prioridade. Por favor, entre em contato com a clínica hoje para que possamos orientar os próximos passos.',
      1, 'EXEMPLO DE FORMATO - definir canal de contato e critério de urgência',
    );
  }
}

export const RULE_CSV_COLUMNS = ['exame_canonico', 'aliases', 'sexo', 'idade_min', 'idade_max', 'contexto', 'unidade', 'alvo_min', 'alvo_max', 'alvo_texto', 'limite_critico_inferior', 'limite_critico_superior', 'orientacao_id', 'fonte_clinica', 'versao', 'data_revisao', 'status', 'sistema', 'normal_min', 'normal_max'] as const;

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Exporta as regras no mesmo formato de skill/references/valores-otimizados.csv. */
export function rulesToCsv(rules: Rule[]): string {
  const lines = [RULE_CSV_COLUMNS.join(',')];
  for (const r of rules) {
    lines.push([r.exam_canonical, r.aliases.join('|'), r.sex, r.age_min, r.age_max, r.contexts.join('|'), r.unit, r.target_min, r.target_max, r.target_text, r.critical_low, r.critical_high, r.guidance_ids.join('|'), r.clinical_source, r.version, r.reviewed_at, r.status, r.system, r.normal_min, r.normal_max].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Catálogo de exames usuais em nutrologia: aliases, unidade, sistema e faixa de
 * normalidade laboratorial habitual (adultos). Entra como RASCUNHO, sem alvo
 * ótimo: o médico revisa, define o ótimo e ativa. Só é inserido para exames que
 * ainda não existem na tabela.
 */
const CATALOG: Array<[exam: string, aliases: string, system: string, unit: string, nmin: number | null, nmax: number | null]> = [
  ['glicose_jejum', 'Glicose|Glicemia de jejum|Glicose em jejum', 'metabolico', 'mg/dL', 70, 99],
  ['insulina_jejum', 'Insulina|Insulina basal|Insulina de jejum', 'metabolico', 'µUI/mL', 2.6, 24.9],
  ['hba1c', 'Hemoglobina glicada|A1c|HbA1c', 'metabolico', '%', null, 5.6],
  ['homa_ir', 'HOMA-IR|HOMA', 'metabolico', 'adimensional', null, 2.7],
  ['colesterol_total', 'Colesterol total', 'lipidico', 'mg/dL', null, 190],
  ['hdl', 'HDL|HDL colesterol|HDL-c', 'lipidico', 'mg/dL', 40, null],
  ['ldl', 'LDL|LDL colesterol|LDL-c', 'lipidico', 'mg/dL', null, 130],
  ['colesterol_nao_hdl', 'Não-HDL|Colesterol não HDL', 'lipidico', 'mg/dL', null, 160],
  ['triglicerideos', 'Triglicerídeos|Triglicérides|TG', 'lipidico', 'mg/dL', null, 150],
  ['apolipoproteina_b', 'Apolipoproteína B|ApoB', 'cardiovascular', 'mg/dL', null, 130],
  ['lipoproteina_a', 'Lipoproteína (a)|Lp(a)', 'cardiovascular', 'mg/dL', null, 30],
  ['tsh', 'TSH|Hormônio tireoestimulante', 'tireoide', 'µUI/mL', 0.4, 4.5],
  ['t4_livre', 'T4 livre|Tiroxina livre', 'tireoide', 'ng/dL', 0.8, 1.8],
  ['t3_livre', 'T3 livre|Triiodotironina livre', 'tireoide', 'pg/mL', 2.3, 4.2],
  ['anti_tpo', 'Anti-TPO|Anticorpo antitireoperoxidase', 'tireoide', 'UI/mL', null, 34],
  ['hemoglobina', 'Hemoglobina|Hb', 'hematologico', 'g/dL', 12, 17.5],
  ['hematocrito', 'Hematócrito|Ht', 'hematologico', '%', 36, 52],
  ['vcm', 'VCM|Volume corpuscular médio', 'hematologico', 'fL', 80, 100],
  ['leucocitos', 'Leucócitos|Leucócitos totais', 'hematologico', '/µL', 4000, 11000],
  ['plaquetas', 'Plaquetas', 'hematologico', '/µL', 150000, 450000],
  ['ferritina', 'Ferritina|Ferritina sérica', 'ferro', 'ng/mL', 30, 400],
  ['ferro_serico', 'Ferro sérico|Ferro', 'ferro', 'µg/dL', 50, 170],
  ['saturacao_transferrina', 'Saturação de transferrina|IST', 'ferro', '%', 20, 45],
  ['vitamina_d_25oh', '25-hidroxivitamina D|25(OH)D|Vitamina D 25-OH|Vitamina D|25-Hidroxi Vitamina D', 'vitaminas', 'ng/mL', 30, 100],
  ['vitamina_b12', 'Vitamina B12|Cobalamina', 'vitaminas', 'pg/mL', 200, 900],
  ['folato', 'Ácido fólico|Folato', 'vitaminas', 'ng/mL', 4, 20],
  ['homocisteina', 'Homocisteína', 'cardiovascular', 'µmol/L', 5, 15],
  ['magnesio', 'Magnésio', 'minerais', 'mg/dL', 1.7, 2.4],
  ['calcio_total', 'Cálcio|Cálcio total', 'minerais', 'mg/dL', 8.5, 10.5],
  ['zinco', 'Zinco|Zinco sérico', 'minerais', 'µg/dL', 70, 120],
  ['sodio', 'Sódio|Na', 'minerais', 'mmol/L', 135, 145],
  ['potassio', 'Potássio|K|K+', 'minerais', 'mmol/L', 3.5, 5.1],
  ['creatinina', 'Creatinina', 'renal', 'mg/dL', 0.6, 1.2],
  ['ureia', 'Ureia', 'renal', 'mg/dL', 15, 45],
  ['acido_urico', 'Ácido úrico', 'renal', 'mg/dL', 2.5, 7],
  ['tfg_estimada', 'TFG|Taxa de filtração glomerular|eGFR|CKD-EPI', 'renal', 'mL/min/1.73m²', 90, null],
  ['tgo', 'TGO|AST|Aspartato aminotransferase', 'hepatico', 'U/L', null, 40],
  ['tgp', 'TGP|ALT|Alanina aminotransferase', 'hepatico', 'U/L', null, 41],
  ['ggt', 'Gama GT|GGT|Gama glutamil transferase', 'hepatico', 'U/L', null, 60],
  ['fosfatase_alcalina', 'Fosfatase alcalina|FA', 'hepatico', 'U/L', 40, 130],
  ['bilirrubina_total', 'Bilirrubina total', 'hepatico', 'mg/dL', null, 1.2],
  ['albumina', 'Albumina', 'hepatico', 'g/dL', 3.5, 5.2],
  ['pcr', 'PCR|Proteína C reativa|PCR ultrassensível|PCR-us', 'inflamacao', 'mg/L', null, 3],
  ['vhs', 'VHS|Velocidade de hemossedimentação', 'inflamacao', 'mm/h', null, 20],
  ['testosterona_total', 'Testosterona total', 'hormonal', 'ng/dL', 300, 1000],
  ['estradiol', 'Estradiol|E2', 'hormonal', 'pg/mL', null, null],
  ['cortisol', 'Cortisol|Cortisol matinal', 'hormonal', 'µg/dL', 5, 25],
  ['dhea_s', 'DHEA-S|Sulfato de DHEA', 'hormonal', 'µg/dL', null, null],
  ['prolactina', 'Prolactina', 'hormonal', 'ng/mL', null, 25],
];

function seedCatalog(database: DatabaseSync): void {
  const existing = new Set((database.prepare('SELECT DISTINCT exam_canonical FROM rules').all() as Row[]).map((r) => str(r, 'exam_canonical')));
  const insert = database.prepare(
    `INSERT INTO rules(exam_canonical, aliases, sex, contexts, unit, system, normal_min, normal_max, clinical_source, version, reviewed_at, status)
     VALUES (?, ?, 'todos', 'geral', ?, ?, ?, ?, 'CATÁLOGO INICIAL: faixa de normalidade laboratorial usual em adultos; conferir com o laboratório e definir o alvo ótimo antes de ativar', '1.0', '2026-10-29', 'rascunho')`,
  );
  for (const [exam, aliases, system, unit, nmin, nmax] of CATALOG) {
    if (existing.has(exam)) {
      database.prepare("UPDATE rules SET system = ? WHERE exam_canonical = ? AND system = 'outros'").run(system, exam);
      continue;
    }
    insert.run(exam, aliases, unit, system, nmin, nmax);
  }
}

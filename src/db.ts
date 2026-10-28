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
CREATE INDEX IF NOT EXISTS idx_results_case ON results(case_id);
CREATE INDEX IF NOT EXISTS idx_analyses_case ON analyses(case_id);
CREATE INDEX IF NOT EXISTS idx_rules_exam ON rules(exam_canonical, status);
`;

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
  seedDefaults(db);
  return db;
}

export function rowToRule(row: Row): Rule {
  return {
    id: num(row, 'id'),
    exam_canonical: str(row, 'exam_canonical'),
    aliases: list(str(row, 'aliases')),
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

function parseCsv(text: string): Row[] {
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
    if (fs.existsSync(seedPath)) {
      const insert = database.prepare(
        `INSERT INTO rules(exam_canonical, aliases, sex, age_min, age_max, contexts, unit, target_min, target_max, target_text,
          critical_low, critical_high, guidance_ids, clinical_source, version, reviewed_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rascunho')`,
      );
      for (const r of parseCsv(fs.readFileSync(seedPath, 'utf8'))) {
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

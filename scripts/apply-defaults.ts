/**
 * Aplica as faixas padrão (reference-defaults.ts) às regras que ainda não foram
 * editadas pelo médico (fonte começando por CATÁLOGO ou EXEMPLO ou já desta pesquisa).
 * Cria linhas por sexo quando houver, ativa o que tem faixa e deixa em rascunho o resto.
 *   node dist/scripts/apply-defaults.js [--dry]
 */
import { openDb, getDb, str, num, type Row } from '../src/db.js';
import { REFERENCE_DEFAULTS, REFERENCE_SOURCE, type Band } from '../src/engine/reference-defaults.js';

const dry = process.argv.includes('--dry');
openDb();
const db = getDb();
const today = new Date().toISOString().slice(0, 10);
const untouched = (source: string) => /^(CATÁLOGO|CATALOGO|EXEMPLO|Pesquisa NutroLab)/i.test(source);

let updated = 0;
let inserted = 0;
let skipped = 0;
const upd = db.prepare("UPDATE rules SET normal_min=?, normal_max=?, target_min=?, target_max=?, critical_low=?, critical_high=?, target_text=?, clinical_source=?, reviewed_at=?, status=?, updated_at=datetime('now') WHERE id=?");
const ins = db.prepare("INSERT INTO rules(exam_canonical, aliases, sex, contexts, unit, system, normal_min, normal_max, target_min, target_max, critical_low, critical_high, target_text, clinical_source, version, reviewed_at, status) VALUES (?, ?, ?, 'geral', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0', ?, ?)");

const hasBand = (b: Band | undefined) => !!b && b.some((v) => v !== null);
const apply = (row: Row, band: Band | undefined, text: string | null, status: string) => {
  if (dry) return;
  const b = band ?? [null, null, null, null, null, null];
  upd.run(b[0], b[1], b[2], b[3], b[4], b[5], text, REFERENCE_SOURCE, today, status, num(row, 'id'));
};

for (const [exam, d] of Object.entries(REFERENCE_DEFAULTS)) {
  const rows = db.prepare("SELECT * FROM rules WHERE exam_canonical = ? AND contexts = 'geral' AND age_min IS NULL AND age_max IS NULL").all(exam) as Row[];
  const base = rows.find((r) => str(r, 'sex') === 'todos');
  if (!base) {
    skipped += 1;
    continue;
  }
  if (!untouched(str(base, 'clinical_source'))) {
    skipped += 1;
    continue;
  }
  if (d.text) {
    apply(base, undefined, d.text, 'ativo');
    updated += 1;
    continue;
  }
  if (d.sexOnly) {
    apply(base, undefined, null, 'inativo');
  } else {
    apply(base, d.all, null, hasBand(d.all) ? 'ativo' : 'rascunho');
  }
  updated += 1;
  for (const sex of ['F', 'M'] as const) {
    const band = d[sex];
    if (!hasBand(band)) continue;
    const existing = rows.find((r) => str(r, 'sex') === sex);
    if (existing) {
      if (untouched(str(existing, 'clinical_source'))) {
        apply(existing, band, null, 'ativo');
        updated += 1;
      }
      continue;
    }
    if (!dry) ins.run(exam, str(base, 'aliases'), sex, str(base, 'unit'), str(base, 'system'), band?.[0] ?? null, band?.[1] ?? null, band?.[2] ?? null, band?.[3] ?? null, band?.[4] ?? null, band?.[5] ?? null, null, REFERENCE_SOURCE, today, 'ativo');
    inserted += 1;
  }
}
const counts = db.prepare("SELECT status, COUNT(*) n FROM rules GROUP BY status").all() as Row[];
console.log(`${dry ? '[simulação] ' : ''}atualizadas: ${updated}, inseridas por sexo: ${inserted}, puladas (editadas pelo médico ou ausentes): ${skipped}`);
console.log('status:', counts.map((c) => `${str(c, 'status')}=${num(c, 'n')}`).join(', '));
if (!dry) {
  db.prepare("INSERT INTO audit_log(user_id, action, entity, entity_id, details) VALUES (NULL, 'aplicar_faixas_padrao', 'rule', NULL, ?)").run(JSON.stringify({ updated, inserted, skipped, source: REFERENCE_SOURCE }));
}

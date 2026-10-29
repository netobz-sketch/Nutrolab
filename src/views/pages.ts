import { CALCS, CLASSIFICATIONS, CLASSIFICATION_LABEL, CONTEXTS, formatNumber } from '../engine/index.js';
import type { Evaluation, Guidance, Rule } from '../engine/index.js';
import { attr, fmtDate, h, icon, option, statusTag } from './html.js';

export interface CaseRow {
  id: number;
  patient_code: string;
  sex: string | null;
  birth_date: string | null;
  contexts: string[];
  medications: string;
  supplements: string;
  comorbidities: string;
  goal: string;
  notes: string;
  status: string;
  created_at: string;
  results_count?: number;
  analyses_count?: number;
  last_collection?: string | null;
}
export interface FileRow { id: number; original_name: string; size: number; created_at: string }
export interface ResultRow { id: number; exam_raw: string; exam_canonical: string | null; value_raw: string; unit_raw: string | null; lab_reference: string | null; lab_flag: string | null; collection_date: string | null; source_file: string | null; page: number | null; confidence: string; origin: string }
export interface AnalysisRow { id: number; created_at: string; table_version: string; ai_used: boolean; ai_model: string | null }

export function loginPage(error: string | null, next: string): string {
  return `<div class="card"><a class="brand" href="/login"><span class="logo">${icon('logo')}</span>NutroLab</a>
<h1 style="text-align:center;font-size:20px">Entrar</h1>${error ? `<div class="flash err">${h(error)}</div>` : ''}
<form method="post" action="/login"><input type="hidden" name="next" value="${attr(next)}">
<label>E-mail</label><input name="email" type="email" autocomplete="username" required autofocus>
<label>Senha</label><input name="password" type="password" autocomplete="current-password" required>
<p><button class="btn" type="submit" style="width:100%">Entrar</button></p></form>
<p class="muted small" style="text-align:center;margin:0">Apoio à decisão clínica. Acesso restrito à equipe médica.</p></div>`;
}

export function casesPage(cases: CaseRow[], tableVersion: string, aiOn: boolean): string {
  const rows = cases.map((c) => `<tr><td><a href="/casos/${c.id}" style="font-weight:600;text-decoration:none">${h(c.patient_code)}</a></td><td>${h(c.sex ?? '—')}</td><td>${fmtDate(c.last_collection)}</td><td class="num">${c.results_count ?? 0}</td><td class="num">${c.analyses_count ?? 0}</td><td>${statusTag(c.status)}</td><td class="muted">${fmtDate(c.created_at)}</td></tr>`).join('');
  const open = cases.filter((c) => c.status === 'aberto').length;
  const reviewed = cases.filter((c) => c.status === 'revisado').length;
  return `<div class="pagehead"><div><div class="crumbs">NutroLab</div><h1>Casos</h1><div class="sub">Tabela clínica: ${h(tableVersion)}</div></div><a class="btn" href="/casos/novo">Novo caso</a></div>
${tableVersion === 'sem regras ativas' ? '<div class="flash warn">A tabela clínica não tem regras ativas: os exames serão organizados, mas nenhum resultado será classificado. Ative regras em <a href="/regras">Regras</a>.</div>' : ''}
${aiOn ? '' : '<div class="flash warn">IA desligada (sem ANTHROPIC_API_KEY): leitura automática de PDF e redação ficam indisponíveis; o lançamento manual e o motor de regras funcionam normalmente.</div>'}
<div class="kpis"><div class="kpi"><span class="k">Casos</span><span class="v">${cases.length}</span><span class="d">últimos 200</span></div><div class="kpi warn"><span class="k">Em aberto</span><span class="v">${open}</span><span class="d">aguardando revisão</span></div><div class="kpi ok"><span class="k">Revisados</span><span class="v">${reviewed}</span><span class="d">pelo médico</span></div></div>
<div class="card flush">${cases.length ? `<div class="tablewrap"><table><thead><tr><th>Código</th><th>Sexo</th><th>Última coleta</th><th class="num">Resultados</th><th class="num">Análises</th><th>Status</th><th>Criado</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="card-body muted">Nenhum caso ainda. Crie o primeiro.</div>'}</div>`;
}

function contextChips(selected: string[], name = 'contexts'): string {
  return `<div class="chips">${Object.entries(CONTEXTS).filter(([k]) => k !== 'geral').map(([k, label]) => `<label><input type="checkbox" name="${name}" value="${k}"${selected.includes(k) ? ' checked' : ''}>${h(label)}</label>`).join('')}</div>`;
}

export function caseFormPage(c: CaseRow | null, error: string | null): string {
  const v = (k: keyof CaseRow) => (c ? attr(c[k] ?? '') : '');
  return `<h1>${c ? 'Editar caso' : 'Novo caso'}</h1>${error ? `<div class="flash err">${h(error)}</div>` : ''}
<form method="post" action="${c ? `/casos/${c.id}/editar` : '/casos'}" class="card">
<div class="grid">
<div><label>Código do paciente (pseudônimo)</label><input name="patient_code" required maxlength="40" value="${v('patient_code')}" placeholder="ex.: P-0042"><p class="muted small">Nunca nome completo, CPF, telefone ou e-mail.</p></div>
<div><label>Sexo biológico</label><select name="sex">${option('', 'não informado', c?.sex ?? '')}${option('F', 'Feminino', c?.sex ?? '')}${option('M', 'Masculino', c?.sex ?? '')}</select></div>
<div><label>Data de nascimento</label><input name="birth_date" type="date" value="${v('birth_date')}"></div>
</div>
<label>Contextos confirmados (só o que estiver confirmado)</label>${contextChips(c?.contexts ?? [])}
<div class="grid">
<div><label>Medicamentos</label><textarea name="medications">${h(c?.medications ?? '')}</textarea></div>
<div><label>Suplementos</label><textarea name="supplements">${h(c?.supplements ?? '')}</textarea></div>
<div><label>Comorbidades</label><textarea name="comorbidities">${h(c?.comorbidities ?? '')}</textarea></div>
<div><label>Objetivo terapêutico</label><textarea name="goal">${h(c?.goal ?? '')}</textarea></div>
</div>
<label>Observações do médico</label><textarea name="notes">${h(c?.notes ?? '')}</textarea>
<p><button class="btn" type="submit">${c ? 'Salvar' : 'Criar caso'}</button> <a class="btn sec" href="${c ? `/casos/${c.id}` : '/casos'}">Cancelar</a></p></form>`;
}

export function casePage(opts: { c: CaseRow; files: FileRow[]; results: ResultRow[]; evals: Evaluation[]; analyses: AnalysisRow[]; aiOn: boolean; isAdmin: boolean; tableVersion: string; examOptions: string[] }): string {
  const { c, files, results, evals, analyses, aiOn } = opts;
  const linkForm = (r: ResultRow, current: string | null) => `<form method="post" action="/casos/${c.id}/resultados/${r.id}/vincular" class="actions" style="gap:4px;margin-top:4px"><select name="exam_canonical" aria-label="Vincular a exame da tabela" style="min-height:30px;padding:2px 6px;font-size:12px;width:auto"><option value="">${current ? 'desvincular' : 'vincular a…'}</option>${opts.examOptions.map((x) => option(x, x, current)).join('')}</select><button class="btn sec sm" type="submit">OK</button></form>`;
  const evalOf = (id: number) => evals.find((e) => e.result.id === id);
  const ctx = c.contexts.map((k) => CONTEXTS[k] ?? k).join(', ') || 'nenhum confirmado';
  const inTarget = evals.filter((e) => e.classification === 'dentro_do_alvo' || e.classification === 'qualitativo_compativel').length;
  const outTarget = evals.filter((e) => ['abaixo_do_alvo', 'acima_do_alvo', 'qualitativo_nao_compativel'].includes(e.classification)).length;
  const critical = evals.filter((e) => e.critical).length;
  const manual = evals.filter((e) => e.parsed.kind === 'unparseable' || e.result.confidence === 'baixa' || e.classification === 'regra_ambigua').length;
  const dates = [...new Set(results.map((r) => r.collection_date).filter(Boolean))].sort();
  const age = evals.find((e) => e.ageAtCollection !== null)?.ageAtCollection ?? null;
  const sub = [c.sex === 'F' ? 'Feminino' : c.sex === 'M' ? 'Masculino' : 'sexo não informado', age !== null ? `${age} anos na coleta` : null, ...c.contexts.map((k) => CONTEXTS[k] ?? k), c.medications || null].filter(Boolean).join(' · ');
  const fileRows = files.map((f) => `<div class="row"><div style="display:flex;align-items:center;gap:12px;min-width:0"><span class="fileicon">${icon('file')}</span><div style="min-width:0"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="/casos/${c.id}/arquivos/${f.id}" style="color:inherit;text-decoration:none">${h(f.original_name)}</a></div><div class="muted small">${(f.size / 1024).toFixed(0)} KB · enviado ${fmtDate(f.created_at)}</div></div></div><div class="actions">${aiOn ? `<form method="post" action="/casos/${c.id}/arquivos/${f.id}/extrair" class="inline"><button class="btn soft sm" type="submit" onclick="this.disabled=true;this.textContent='Lendo o PDF...';this.form.submit()">Extrair com IA</button></form>` : '<span class="muted small">IA desligada</span>'}<form method="post" action="/casos/${c.id}/arquivos/${f.id}/excluir" class="inline" onsubmit="return confirm('Excluir o arquivo?')"><button class="btn danger sm" type="submit">Excluir</button></form></div></div>`).join('');
  const resultRows = results.map((r) => {
    const ev = evalOf(r.id);
    const cls = ev ? `<span class="tag c-${ev.classification}">${h(CLASSIFICATION_LABEL[ev.classification])}</span>${ev.critical ? ` <span class="tag crit">crítico ${ev.critical}</span>` : ''}` : '';
    const notes = ev?.notes.length ? `<div class="muted small">${h(ev.notes.join('; '))}</div>` : '';
    const conv = ev?.converted ? `<div class="muted small">= ${formatNumber(ev.converted.value, 3)} ${h(ev.converted.unit)}</div>` : '';
    const attention = ev && (ev.parsed.kind === 'unparseable' || r.confidence === 'baixa' || ev.classification === 'regra_ambigua');
    const target = ev?.rule ? (ev.rule.target_text ? h(ev.rule.target_text) : `${ev.rule.target_min ?? '…'}–${ev.rule.target_max ?? '…'} ${h(ev.rule.unit)}`) : '—';
    return `<tr${attention ? ' class="attention"' : ''}><td><div style="font-weight:600">${h(r.exam_raw)}</div><div class="muted small">${h(ev?.exam_canonical ?? r.exam_canonical ?? 'sem correspondência na tabela')}</div>${!ev?.exam_canonical || r.exam_canonical ? linkForm(r, r.exam_canonical) : ''}</td><td class="num" style="font-weight:600">${h(r.value_raw)} <span class="muted small">${h(r.unit_raw ?? '')}</span>${conv}</td><td class="muted">${h(r.lab_reference ?? '—')}${r.lab_flag ? ` <span class="lab">${h(r.lab_flag)}</span>` : ''}</td><td class="muted">${target}</td><td>${cls}${notes}</td><td class="small muted">${h(r.source_file ?? 'manual')}${r.page ? `, p. ${r.page}` : ''}${r.collection_date ? ` · ${fmtDate(r.collection_date)}` : ''}<br>${h(r.origin === 'ia' ? 'IA' : 'manual')} · ${h(r.confidence)}</td><td><form method="post" action="/casos/${c.id}/resultados/${r.id}/excluir" class="inline"><button class="btn sec sm" type="submit" aria-label="Remover resultado">×</button></form></td></tr>`;
  }).join('');
  const analysisRows = analyses.map((a) => `<div class="row"><div><a href="/casos/${c.id}/analises/${a.id}" style="font-weight:600;text-decoration:none">Análise #${a.id}</a><div class="muted small">${fmtDate(a.created_at)} · tabela ${h(a.table_version)} · ${a.ai_used ? `redação ${h(a.ai_model ?? 'IA')}` : 'motor de regras'}</div></div><a class="btn sec sm" href="/casos/${c.id}/analises/${a.id}/download">Baixar .md</a></div>`).join('');
  const confidenceOpts = ['alta', 'media', 'baixa'].map((v) => option(v, v, 'alta')).join('');
  const statusForm = c.status === 'revisado' ? `<form method="post" action="/casos/${c.id}/status" class="inline"><input type="hidden" name="status" value="aberto"><button class="btn sec" type="submit">Reabrir</button></form>` : `<form method="post" action="/casos/${c.id}/status" class="inline"><input type="hidden" name="status" value="revisado"><button class="btn sec" type="submit">Marcar como revisado</button></form>`;
  return `<div class="pagehead"><div><div class="crumbs"><a href="/casos">Casos</a> / ${h(c.patient_code)}</div><h1 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">Caso ${h(c.patient_code)} ${statusTag(c.status)}</h1><div class="sub">${h(sub)}</div></div><div class="actions"><a class="btn sec" href="/casos/${c.id}/editar">Editar</a>${statusForm}${opts.isAdmin ? `<form method="post" action="/casos/${c.id}/excluir" class="inline" onsubmit="return confirm('Excluir o caso, os PDFs e as análises? Esta ação não pode ser desfeita.')"><button class="btn danger" type="submit">Excluir caso</button></form>` : ''}</div></div>

<div class="kpis">
<div class="kpi"><span class="k">Resultados lançados</span><span class="v">${results.length}</span><span class="d">${files.length} PDF${files.length === 1 ? '' : 's'}${dates.length ? ` · coleta ${dates.map((d) => fmtDate(d)).join(', ')}` : ''}</span></div>
<div class="kpi ok"><span class="k">Dentro do alvo</span><span class="v">${inTarget}</span><span class="d">pelas regras ativas</span></div>
<div class="kpi warn"><span class="k">Fora do alvo</span><span class="v">${outTarget}</span><span class="d">${evals.filter((e) => ['abaixo_do_alvo', 'acima_do_alvo', 'qualitativo_nao_compativel'].includes(e.classification)).map((e) => e.exam_canonical).filter(Boolean).slice(0, 3).join(', ') || 'nenhum'}</span></div>
<div class="kpi${critical ? ' danger' : ''}"><span class="k">Crítico</span><span class="v">${critical}</span><span class="d">limites cadastrados</span></div>
<div class="kpi${manual ? ' danger' : ''}"><span class="k">Conferência manual</span><span class="v">${manual}</span><span class="d">${manual ? 'ver linhas destacadas' : 'nada pendente'}</span></div>
</div>

<div class="card"><div class="facts"><div><div class="k">Sexo biológico</div><div class="v">${h(c.sex === 'F' ? 'Feminino' : c.sex === 'M' ? 'Masculino' : 'não informado')}</div></div><div><div class="k">Nascimento</div><div class="v">${fmtDate(c.birth_date)}</div></div><div><div class="k">Contextos confirmados</div><div class="v">${h(ctx)}</div></div><div><div class="k">Medicamentos</div><div class="v">${h(c.medications || '—')}</div></div><div><div class="k">Suplementos</div><div class="v">${h(c.supplements || '—')}</div></div><div><div class="k">Comorbidades</div><div class="v">${h(c.comorbidities || '—')}</div></div><div><div class="k">Objetivo</div><div class="v">${h(c.goal || '—')}</div></div></div>${c.notes ? `<p style="margin:14px 0 0"><span class="k muted small">Observações do médico</span><br>${h(c.notes)}</p>` : ''}</div>

<div class="card flush"><div class="card-head"><h2>Resultados</h2><div class="actions"><a class="btn sec sm" href="#lancar">Lançar manualmente</a>${aiOn && files.length ? `<form method="post" action="/casos/${c.id}/arquivos/${files[0]?.id}/extrair" class="inline"><button class="btn soft sm" type="submit" onclick="this.disabled=true;this.textContent='Lendo o PDF...';this.form.submit()">Extrair do PDF com IA</button></form>` : ''}</div></div>
${results.length ? `<div class="tablewrap"><table><thead><tr><th>Exame</th><th class="num">Resultado</th><th>Ref. laboratório</th><th>Alvo cadastrado</th><th>Classificação</th><th>Origem</th><th></th></tr></thead><tbody>${resultRows}</tbody></table></div>` : '<div class="card-body muted">Nenhum resultado lançado. Envie um PDF e extraia com IA, ou lance manualmente abaixo.</div>'}
<div class="card-body" id="lancar"><details><summary>Lançar resultado manualmente</summary>
<form method="post" action="/casos/${c.id}/resultados"><div class="grid">
<div><label>Exame (como no laudo)</label><input name="exam_raw" required placeholder="ex.: 25-Hidroxi Vitamina D"></div>
<div><label>Resultado (como no laudo)</label><input name="value_raw" required placeholder="ex.: 28,4 ou <0,5 ou Não reagente"></div>
<div><label>Unidade</label><input name="unit_raw" placeholder="ex.: ng/mL"></div>
<div><label>Referência do laboratório</label><input name="lab_reference" placeholder="ex.: 30 a 100"></div>
<div><label>Sinalização do laboratório</label><input name="lab_flag" placeholder="ex.: ↓, alto, crítico"></div>
<div><label>Data da coleta</label><input name="collection_date" type="date"></div>
<div><label>Arquivo de origem</label><input name="source_file" placeholder="opcional"></div>
<div><label>Página</label><input name="page" type="number" min="1"></div>
<div><label>Confiança</label><select name="confidence">${confidenceOpts}</select></div>
</div><p><button class="btn" type="submit">Lançar</button></p></form></details></div></div>

<div class="two">
<div class="card"><h2 style="margin-top:0">Cálculos derivados</h2>${derivedList(evals, opts)}</div>
<div class="card"><h2 style="margin-top:0">Análises</h2>
<form method="post" action="/casos/${c.id}/analisar" class="actions" style="margin-bottom:10px"><button class="btn" type="submit" ${results.length ? '' : 'disabled'} onclick="this.disabled=true;this.textContent='Gerando...';this.form.submit()">Gerar análise</button>${aiOn ? `<label style="display:inline-flex;align-items:center;gap:6px;margin:0;font-weight:500;color:var(--ink)"><input type="checkbox" name="narrative" value="1" checked> redigir síntese e minuta com IA</label>` : '<span class="muted small">Redação automática indisponível (IA desligada).</span>'}</form>
${analysisRows || '<div class="muted small">Nenhuma análise gerada ainda.</div>'}
<div class="note" style="margin-top:12px">${icon('warn')}Minuta para revisão médica. Nada vai ao paciente sem a sua aprovação.</div></div>
</div>

<div class="card"><h2 style="margin-top:0">Arquivos (PDF)</h2>${fileRows || '<div class="muted small">Nenhum PDF enviado.</div>'}
<form method="post" action="/casos/${c.id}/arquivos" enctype="multipart/form-data" class="actions" style="margin-top:12px"><input type="file" name="pdf" accept="application/pdf" multiple required style="width:auto"><button class="btn sec" type="submit">Enviar PDF</button><span class="muted small">Máximo 25 MB por arquivo. O PDF fica neste servidor para rastreabilidade (página de origem) até o caso ser excluído.</span></form></div>`;
}

function derivedList(evals: Evaluation[], opts: { c: CaseRow }): string {
  void opts;
  const derivedEvals = evals.filter((e) => e.result.derived);
  if (!derivedEvals.length) return '<div class="muted small">Os índices (HOMA-IR, não-HDL, Friedewald, razões) aparecem no relatório quando os insumos da mesma coleta estiverem lançados e as condições forem atendidas.</div>';
  return derivedEvals.map((e) => `<div class="row"><div><div style="font-weight:600">${h(e.result.exam_raw)}</div></div><div class="actions"><span class="num" style="font-weight:700">${h(e.result.value_raw)}</span><span class="tag c-${e.classification}">${h(CLASSIFICATION_LABEL[e.classification])}</span></div></div>`).join('');
}

export function analysisPage(caseId: number, analysisId: number, html: string): string {
  return `<div class="pagehead"><div><div class="crumbs"><a href="/casos">Casos</a> / <a href="/casos/${caseId}">caso</a> / análise</div><h1>Análise #${analysisId}</h1><div class="sub">Minuta para revisão médica</div></div><div class="actions"><a class="btn sec" href="/casos/${caseId}">Voltar ao caso</a><a class="btn sec" href="/casos/${caseId}/analises/${analysisId}/imprimir">Imprimir / PDF</a><a class="btn" href="/casos/${caseId}/analises/${analysisId}/download">Baixar .md</a></div></div><div class="card report">${html}</div>`;
}

export function rulesPage(rules: Rule[], guidances: Guidance[]): string {
  const rows = rules.map((r) => {
    const target = r.target_text ? h(r.target_text) : `${r.target_min ?? '…'} – ${r.target_max ?? '…'}`;
    const cond = [r.sex !== 'todos' ? r.sex : null, r.age_min !== null || r.age_max !== null ? `${r.age_min ?? ''}–${r.age_max ?? ''} a` : null, ...r.contexts.filter((c) => c !== 'geral')].filter(Boolean).join(' · ') || 'geral';
    return `<tr><td><a href="/regras/${r.id}">${h(r.exam_canonical)}</a><div class="muted small">${h(r.aliases.join(' | '))}</div></td><td>${h(cond)}</td><td class="num">${target} ${h(r.unit)}</td><td class="num">${r.critical_low ?? '—'} / ${r.critical_high ?? '—'}</td><td class="small">${h(r.guidance_ids.join(', ') || '—')}</td><td class="small">${h(r.clinical_source)}<div class="muted">v${h(r.version)} · ${fmtDate(r.reviewed_at)}</div></td><td>${statusTag(r.status)}</td></tr>`;
  }).join('');
  return `<div class="pagehead"><div><div class="crumbs">Configuração clínica</div><h1>Regras clínicas (alvos)</h1></div><div class="actions"><a class="btn sec" href="/regras/exportar.csv">Exportar CSV</a><form method="post" action="/regras/importar" enctype="multipart/form-data" class="actions inline"><input type="file" name="csv" accept=".csv,text/csv" required style="width:auto"><button class="btn sec" type="submit">Importar CSV</button></form><a class="btn" href="/regras/nova">Nova regra</a></div></div>
<p class="muted small">O CSV usa o mesmo formato de <code>skill/references/valores-otimizados.csv</code>; cada linha importada vira uma regra nova (edite ou exclua as antigas antes se for substituir).</p>
<p class="muted">Só regras <b>ativas</b> classificam. Linhas com fonte "EXEMPLO" são modelo de formato e não podem ser ativadas. ${guidances.length} orientações cadastradas.</p>
<div class="card flush"><div class="tablewrap"><table><thead><tr><th>Exame / aliases</th><th>Condições</th><th class="num">Alvo</th><th class="num">Crítico inf./sup.</th><th>Orientações</th><th>Fonte</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">Nenhuma regra.</td></tr>'}</tbody></table></div></div>`;
}

export function ruleFormPage(r: Rule | null, guidances: Guidance[], error: string | null, calcIds: string[]): string {
  const v = (x: number | string | null | undefined) => (x === null || x === undefined ? '' : attr(String(x)));
  const statusOpts = ['rascunho', 'ativo', 'inativo'].map((s) => option(s, s, r?.status ?? 'rascunho')).join('');
  return `<h1>${r ? `Regra #${r.id}` : 'Nova regra'}</h1>${error ? `<div class="flash err">${h(error)}</div>` : ''}
<form method="post" action="${r ? `/regras/${r.id}` : '/regras'}" class="card"><div class="grid">
<div><label>Exame canônico (snake_case)</label><input name="exam_canonical" required pattern="[a-z0-9_]+" value="${v(r?.exam_canonical)}" list="calcs"><datalist id="calcs">${calcIds.map((c) => `<option value="${c}">`).join('')}</datalist><p class="muted small">Para classificar um cálculo derivado, use o id dele (ex.: homa_ir).</p></div>
<div><label>Aliases (separados por |)</label><input name="aliases" value="${v(r?.aliases.join(' | '))}" placeholder="25(OH)D | Vitamina D 25-OH"></div>
<div><label>Sexo</label><select name="sex">${option('todos', 'todos', r?.sex ?? 'todos')}${option('F', 'F', r?.sex ?? '')}${option('M', 'M', r?.sex ?? '')}</select></div>
<div><label>Idade mínima (anos)</label><input name="age_min" type="number" min="0" value="${v(r?.age_min)}"></div>
<div><label>Idade máxima (anos)</label><input name="age_max" type="number" min="0" value="${v(r?.age_max)}"></div>
<div><label>Unidade do alvo</label><input name="unit" required value="${v(r?.unit)}" placeholder="ng/mL"></div>
<div><label>Alvo mínimo</label><input name="target_min" type="number" step="any" value="${v(r?.target_min)}"></div>
<div><label>Alvo máximo</label><input name="target_max" type="number" step="any" value="${v(r?.target_max)}"></div>
<div><label>Alvo textual (qualitativo)</label><input name="target_text" value="${v(r?.target_text)}" placeholder="não reagente"></div>
<div><label>Limite crítico inferior</label><input name="critical_low" type="number" step="any" value="${v(r?.critical_low)}"></div>
<div><label>Limite crítico superior</label><input name="critical_high" type="number" step="any" value="${v(r?.critical_high)}"></div>
<div><label>Versão</label><input name="version" required value="${v(r?.version ?? '1.0')}"></div>
<div><label>Data da revisão médica</label><input name="reviewed_at" type="date" required value="${v(r?.reviewed_at ?? new Date().toISOString().slice(0, 10))}"></div>
<div><label>Status</label><select name="status">${statusOpts}</select></div>
</div>
<label>Contextos exigidos (todos precisam valer; nenhum = geral)</label>${contextChips(r?.contexts ?? [])}
<label>Orientações candidatas (entram só se o gatilho delas disparar)</label><div class="chips">${guidances.map((g) => `<label><input type="checkbox" name="guidance_ids" value="${attr(g.code)}"${r?.guidance_ids.includes(g.code) ? ' checked' : ''}>${h(g.code)} <span class="muted small">(${h(g.status)})</span></label>`).join('') || '<span class="muted">nenhuma cadastrada</span>'}</div>
<label>Fonte clínica</label><input name="clinical_source" required value="${v(r?.clinical_source)}" placeholder="Diretriz X 2024 / decisão do Dr. Y em 2026-10-28">
<p><button class="btn" type="submit">Salvar</button> <a class="btn sec" href="/regras">Cancelar</a>${r ? ` <button class="btn danger" type="submit" formaction="/regras/${r.id}/excluir" formnovalidate onclick="return confirm('Excluir a regra?')">Excluir</button>` : ''}</p></form>`;
}

export function guidancesPage(guidances: Guidance[]): string {
  const rows = guidances.map((g) => `<tr><td><a href="/orientacoes/${g.id}">${h(g.code)}</a><div class="muted small">${h(g.title)}</div></td><td>${h(g.exam_canonical ?? 'qualquer exame')} · ${h(g.trigger === 'critico' ? 'limite crítico' : g.trigger === 'manual' ? 'manual' : CLASSIFICATION_LABEL[g.trigger])}</td><td class="small">${h(g.patient_text.slice(0, 140))}${g.patient_text.length > 140 ? '…' : ''}</td><td>${g.requires_alert ? '<span class="tag crit">alerta</span>' : ''}</td><td class="small">${h(g.clinical_source)}<div class="muted">v${h(g.version)} · ${fmtDate(g.reviewed_at)}</div></td><td>${statusTag(g.status)}</td></tr>`).join('');
  return `<div class="pagehead"><div><div class="crumbs">Configuração clínica</div><h1>Orientações ao paciente</h1></div><a class="btn" href="/orientacoes/nova">Nova orientação</a></div>
<p class="muted">Só orientações <b>ativas</b> entram na minuta, e só quando o gatilho (exame + classificação) dispara numa regra que as lista.</p>
<div class="card flush"><div class="tablewrap"><table><thead><tr><th>Código</th><th>Gatilho</th><th>Texto ao paciente</th><th></th><th>Fonte</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">Nenhuma orientação.</td></tr>'}</tbody></table></div></div>`;
}

export function guidanceFormPage(g: Guidance | null, error: string | null): string {
  const v = (x: string | null | undefined) => attr(x ?? '');
  const triggers = [...CLASSIFICATIONS.map((c) => [c, CLASSIFICATION_LABEL[c]] as const), ['critico', 'fora de limite crítico'] as const, ['manual', 'manual (nunca automática)'] as const];
  return `<h1>${g ? `Orientação ${h(g.code)}` : 'Nova orientação'}</h1>${error ? `<div class="flash err">${h(error)}</div>` : ''}
<form method="post" action="${g ? `/orientacoes/${g.id}` : '/orientacoes'}" class="card"><div class="grid">
<div><label>Código (MAIÚSCULAS-E-HÍFENS)</label><input name="code" required pattern="[A-Z0-9][A-Z0-9-]*" value="${v(g?.code)}"></div>
<div><label>Título (para o médico)</label><input name="title" required value="${v(g?.title)}"></div>
<div><label>Exame canônico (vazio = qualquer)</label><input name="exam_canonical" pattern="[a-z0-9_]*" value="${v(g?.exam_canonical)}"></div>
<div><label>Gatilho</label><select name="trigger">${triggers.map(([k, label]) => option(k, label, g?.trigger ?? 'abaixo_do_alvo')).join('')}</select></div>
<div><label>Versão</label><input name="version" required value="${v(g?.version ?? '1.0')}"></div>
<div><label>Data da revisão médica</label><input name="reviewed_at" type="date" required value="${v(g?.reviewed_at ?? new Date().toISOString().slice(0, 10))}"></div>
<div><label>Status</label><select name="status">${['rascunho', 'ativo', 'inativo'].map((s) => option(s, s, g?.status ?? 'rascunho')).join('')}</select></div>
<div><label>Exige alerta prioritário</label><select name="requires_alert">${option('0', 'não', g?.requires_alert ? '1' : '0')}${option('1', 'sim', g?.requires_alert ? '1' : '0')}</select></div>
</div>
<label>Contextos exigidos</label>${contextChips(g?.contexts_required ?? [], 'contexts_required')}
<label>Contextos que impedem</label>${contextChips(g?.contexts_excluded ?? [], 'contexts_excluded')}
<label>Quando NÃO aplicar (nota para o médico)</label><textarea name="not_apply_note">${h(g?.not_apply_note ?? '')}</textarea>
<label>Texto exato ao paciente</label><textarea name="patient_text" required>${h(g?.patient_text ?? '')}</textarea>
<label>Fonte clínica</label><input name="clinical_source" required value="${v(g?.clinical_source)}">
<p><button class="btn" type="submit">Salvar</button> <a class="btn sec" href="/orientacoes">Cancelar</a>${g ? ` <button class="btn danger" type="submit" formaction="/orientacoes/${g.id}/excluir" formnovalidate onclick="return confirm('Excluir a orientação?')">Excluir</button>` : ''}</p></form>`;
}

export interface UserRow { id: number; email: string; name: string; role: string; created_at: string; disabled_at: string | null }

export function settingsPage(opts: { enabled: Set<string>; users: UserRow[]; aiOn: boolean; aiModel: string; error: string | null; usage: { calls: number; input: number; output: number } }): string {
  const calcRows = CALCS.map((c) => `<tr><td><label style="display:inline;font-weight:500"><input type="checkbox" name="calc" value="${c.id}"${opts.enabled.has(c.id) ? ' checked' : ''} style="width:auto"> ${h(c.name)}</label></td><td><code>${h(c.formula)}</code></td><td>${h(c.inputs.map((i) => `${i.exam} (${i.unit})`).join(', '))}</td></tr>`).join('');
  const userRows = opts.users.map((u) => `<tr><td>${h(u.name)}</td><td>${h(u.email)}</td><td>${h(u.role)}</td><td>${u.disabled_at ? 'desativado' : 'ativo'}</td><td class="actions"><form method="post" action="/configuracoes/usuarios/${u.id}/${u.disabled_at ? 'ativar' : 'desativar'}" class="inline"><button class="btn sec sm" type="submit">${u.disabled_at ? 'Reativar' : 'Desativar'}</button></form></td></tr>`).join('');
  return `<div class="pagehead"><div><div class="crumbs">Administração</div><h1>Configurações</h1></div></div>${opts.error ? `<div class="flash err">${h(opts.error)}</div>` : ''}
<div class="card"><h2 style="margin-top:0">IA</h2><p>${opts.aiOn ? `Ligada · modelo <code>${h(opts.aiModel)}</code>. Uso acumulado: ${opts.usage.calls} chamadas, ${opts.usage.input.toLocaleString('pt-BR')} tokens de entrada, ${opts.usage.output.toLocaleString('pt-BR')} de saída.` : 'Desligada. Defina <code>ANTHROPIC_API_KEY</code> no ambiente do servidor para habilitar leitura de PDF e redação.'}</p><p class="muted small">A IA só extrai texto do PDF e redige; nunca classifica nem decide. A classificação é sempre do motor de regras.</p></div>
<form method="post" action="/configuracoes/calculos" class="card"><h2 style="margin-top:0">Cálculos derivados habilitados</h2><table><thead><tr><th>Índice</th><th>Fórmula</th><th>Insumos</th></tr></thead><tbody>${calcRows}</tbody></table><p><button class="btn" type="submit">Salvar</button></p></form>
<div class="card"><h2 style="margin-top:0">Usuários</h2><table><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Situação</th><th></th></tr></thead><tbody>${userRows}</tbody></table>
<h3>Novo usuário</h3><form method="post" action="/configuracoes/usuarios"><div class="grid"><div><label>Nome</label><input name="name" required></div><div><label>E-mail</label><input name="email" type="email" required></div><div><label>Senha (mín. 10)</label><input name="password" type="password" minlength="10" required></div><div><label>Papel</label><select name="role">${option('medico', 'médico', 'medico')}${option('admin', 'administrador', 'medico')}</select></div></div><p><button class="btn" type="submit">Criar</button></p></form></div>`;
}

export interface AuditRow { id: number; created_at: string; user: string; action: string; entity: string; entity_id: string | null; details: string | null }

export function auditPage(rows: AuditRow[]): string {
  return `<div class="pagehead"><div><div class="crumbs">Administração</div><h1>Auditoria</h1><div class="sub">Últimos 300 eventos</div></div></div><div class="card flush"><div class="tablewrap"><table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Entidade</th><th>Detalhes</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtDate(r.created_at)}</td><td>${h(r.user)}</td><td>${h(r.action)}</td><td>${h(r.entity)} ${h(r.entity_id ?? '')}</td><td class="small muted">${h((r.details ?? '').slice(0, 200))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nada registrado.</td></tr>'}</tbody></table></div></div>`;
}

import { CALCS, CLASSIFICATIONS, CLASSIFICATION_LABEL, CONTEXTS, formatNumber } from '../engine/index.js';
import type { Evaluation, Guidance, Rule } from '../engine/index.js';
import { attr, fmtDate, h, option, statusTag } from './html.js';

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
  return `<div class="card login"><h1>Entrar</h1>${error ? `<div class="flash err">${h(error)}</div>` : ''}
<form method="post" action="/login"><input type="hidden" name="next" value="${attr(next)}">
<label>E-mail</label><input name="email" type="email" autocomplete="username" required autofocus>
<label>Senha</label><input name="password" type="password" autocomplete="current-password" required>
<p><button class="btn" type="submit">Entrar</button></p></form>
<p class="muted small">Sistema de apoio à decisão clínica. Acesso restrito à equipe médica.</p></div>`;
}

export function casesPage(cases: CaseRow[], tableVersion: string, aiOn: boolean): string {
  const rows = cases.map((c) => `<tr><td><a href="/casos/${c.id}">${h(c.patient_code)}</a></td><td>${h(c.sex ?? '—')}</td><td>${fmtDate(c.last_collection)}</td><td class="num">${c.results_count ?? 0}</td><td class="num">${c.analyses_count ?? 0}</td><td>${statusTag(c.status)}</td><td>${fmtDate(c.created_at)}</td></tr>`).join('');
  return `<div class="actions" style="justify-content:space-between"><h1>Casos</h1><a class="btn" href="/casos/novo">Novo caso</a></div>
${tableVersion === 'sem regras ativas' ? '<div class="flash warn">A tabela clínica não tem regras ativas: os exames serão organizados, mas nenhum resultado será classificado. Ative regras em <a href="/regras">Regras</a>.</div>' : ''}
${aiOn ? '' : '<div class="flash warn">IA desligada (sem ANTHROPIC_API_KEY): leitura automática de PDF e redação ficam indisponíveis; o lançamento manual e o motor de regras funcionam normalmente.</div>'}
<div class="card">${cases.length ? `<table><thead><tr><th>Código</th><th>Sexo</th><th>Última coleta</th><th class="num">Resultados</th><th class="num">Análises</th><th>Status</th><th>Criado</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">Nenhum caso ainda. Crie o primeiro.</p>'}</div>
<p class="muted small">Versão da tabela clínica: ${h(tableVersion)}</p>`;
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

export function casePage(opts: { c: CaseRow; files: FileRow[]; results: ResultRow[]; evals: Evaluation[]; analyses: AnalysisRow[]; aiOn: boolean; isAdmin: boolean; tableVersion: string }): string {
  const { c, files, results, evals, analyses, aiOn } = opts;
  const evalOf = (id: number) => evals.find((e) => e.result.id === id);
  const ctx = c.contexts.map((k) => CONTEXTS[k] ?? k).join(', ') || 'nenhum';
  const fileRows = files.map((f) => `<tr><td>${h(f.original_name)}</td><td class="num">${(f.size / 1024).toFixed(0)} KB</td><td>${fmtDate(f.created_at)}</td><td class="actions">${aiOn ? `<form method="post" action="/casos/${c.id}/arquivos/${f.id}/extrair" class="inline"><button class="btn sm" type="submit" onclick="this.disabled=true;this.textContent='Lendo...';this.form.submit()">Extrair com IA</button></form>` : '<span class="muted small">IA desligada</span>'}<form method="post" action="/casos/${c.id}/arquivos/${f.id}/excluir" class="inline" onsubmit="return confirm('Excluir o arquivo?')"><button class="btn sec sm" type="submit">Excluir</button></form></td></tr>`).join('');
  const resultRows = results.map((r) => {
    const ev = evalOf(r.id);
    const cls = ev ? `<span class="tag c-${ev.classification}">${h(CLASSIFICATION_LABEL[ev.classification])}</span>${ev.critical ? ` <span class="tag crit">crítico ${ev.critical}</span>` : ''}` : '';
    const notes = ev?.notes.length ? `<div class="muted small">${h(ev.notes.join('; '))}</div>` : '';
    const conv = ev?.converted ? `<div class="muted small">= ${formatNumber(ev.converted.value, 3)} ${h(ev.converted.unit)}</div>` : '';
    return `<tr><td>${h(r.exam_raw)}<div class="muted small">${h(ev?.exam_canonical ?? r.exam_canonical ?? 'sem correspondência')}</div></td><td class="num">${h(r.value_raw)} ${h(r.unit_raw ?? '')}${conv}</td><td>${h(r.lab_reference ?? '—')}${r.lab_flag ? ` <span class="tag crit">${h(r.lab_flag)}</span>` : ''}</td><td>${cls}${notes}</td><td>${fmtDate(r.collection_date)}</td><td class="small">${h(r.source_file ?? 'manual')}${r.page ? ` p.${r.page}` : ''}<br><span class="muted">${h(r.confidence)} · ${h(r.origin)}</span></td><td><form method="post" action="/casos/${c.id}/resultados/${r.id}/excluir" class="inline"><button class="btn sec sm" type="submit">×</button></form></td></tr>`;
  }).join('');
  const analysisRows = analyses.map((a) => `<tr><td><a href="/casos/${c.id}/analises/${a.id}">Análise #${a.id}</a></td><td>${fmtDate(a.created_at)}</td><td>${h(a.table_version)}</td><td>${a.ai_used ? h(a.ai_model ?? 'IA') : 'motor de regras'}</td><td><a class="btn sec sm" href="/casos/${c.id}/analises/${a.id}/download">Baixar .md</a></td></tr>`).join('');
  const confidenceOpts = ['alta', 'media', 'baixa'].map((v) => option(v, v, 'alta')).join('');
  return `<div class="actions" style="justify-content:space-between"><h1>Caso ${h(c.patient_code)} ${statusTag(c.status)}</h1><div class="actions"><a class="btn sec" href="/casos/${c.id}/editar">Editar</a>${opts.isAdmin ? `<form method="post" action="/casos/${c.id}/excluir" class="inline" onsubmit="return confirm('Excluir o caso, os PDFs e as análises? Esta ação não pode ser desfeita.')"><button class="btn danger" type="submit">Excluir caso</button></form>` : ''}</div></div>
<div class="card"><div class="grid"><div><b>Sexo</b><br>${h(c.sex ?? 'não informado')}</div><div><b>Nascimento</b><br>${fmtDate(c.birth_date)}</div><div><b>Contextos confirmados</b><br>${h(ctx)}</div><div><b>Medicamentos</b><br>${h(c.medications || '—')}</div><div><b>Suplementos</b><br>${h(c.supplements || '—')}</div><div><b>Comorbidades</b><br>${h(c.comorbidities || '—')}</div><div><b>Objetivo</b><br>${h(c.goal || '—')}</div></div>${c.notes ? `<p><b>Observações</b><br>${h(c.notes)}</p>` : ''}</div>

<h2>Arquivos (PDF)</h2><div class="card">
${files.length ? `<table><thead><tr><th>Arquivo</th><th class="num">Tamanho</th><th>Enviado</th><th></th></tr></thead><tbody>${fileRows}</tbody></table>` : '<p class="muted">Nenhum PDF enviado.</p>'}
<form method="post" action="/casos/${c.id}/arquivos" enctype="multipart/form-data" class="actions" style="margin-top:10px"><input type="file" name="pdf" accept="application/pdf" multiple required style="width:auto"><button class="btn sec" type="submit">Enviar PDF</button></form>
<p class="muted small">Máximo 25 MB por arquivo. O PDF fica guardado neste servidor para rastreabilidade (página de origem) até o caso ser excluído.</p></div>

<h2>Resultados</h2><div class="card">
${results.length ? `<table><thead><tr><th>Exame</th><th class="num">Resultado</th><th>Ref. laboratório</th><th>Classificação</th><th>Coleta</th><th>Origem</th><th></th></tr></thead><tbody>${resultRows}</tbody></table>` : '<p class="muted">Nenhum resultado lançado. Envie um PDF e extraia com IA, ou lance manualmente abaixo.</p>'}
<details style="margin-top:12px"><summary><b>Lançar resultado manualmente</b></summary>
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
</div><p><button class="btn" type="submit">Lançar</button></p></form></details></div>

<h2>Análises</h2><div class="card">
<form method="post" action="/casos/${c.id}/analisar" class="actions"><button class="btn" type="submit" ${results.length ? '' : 'disabled'} onclick="this.disabled=true;this.textContent='Gerando...';this.form.submit()">Gerar análise</button>${aiOn ? `<label style="display:inline;font-weight:500"><input type="checkbox" name="narrative" value="1" checked style="width:auto"> redigir síntese e minuta com IA</label>` : '<span class="muted small">Redação automática indisponível (IA desligada); o relatório sai com o motor de regras.</span>'}<span class="muted small">Tabela clínica: ${h(opts.tableVersion)}</span></form>
${analyses.length ? `<table style="margin-top:12px"><thead><tr><th>Análise</th><th>Gerada em</th><th>Tabela clínica</th><th>Redação</th><th></th></tr></thead><tbody>${analysisRows}</tbody></table>` : ''}</div>`;
}

export function analysisPage(caseId: number, analysisId: number, html: string): string {
  return `<div class="actions" style="justify-content:space-between"><h1>Análise #${analysisId}</h1><div class="actions"><a class="btn sec" href="/casos/${caseId}">Voltar ao caso</a><a class="btn" href="/casos/${caseId}/analises/${analysisId}/download">Baixar .md</a></div></div><div class="card report">${html}</div>`;
}

export function rulesPage(rules: Rule[], guidances: Guidance[]): string {
  const rows = rules.map((r) => {
    const target = r.target_text ? h(r.target_text) : `${r.target_min ?? '…'} – ${r.target_max ?? '…'}`;
    const cond = [r.sex !== 'todos' ? r.sex : null, r.age_min !== null || r.age_max !== null ? `${r.age_min ?? ''}–${r.age_max ?? ''} a` : null, ...r.contexts.filter((c) => c !== 'geral')].filter(Boolean).join(' · ') || 'geral';
    return `<tr><td><a href="/regras/${r.id}">${h(r.exam_canonical)}</a><div class="muted small">${h(r.aliases.join(' | '))}</div></td><td>${h(cond)}</td><td class="num">${target} ${h(r.unit)}</td><td class="num">${r.critical_low ?? '—'} / ${r.critical_high ?? '—'}</td><td class="small">${h(r.guidance_ids.join(', ') || '—')}</td><td class="small">${h(r.clinical_source)}<div class="muted">v${h(r.version)} · ${fmtDate(r.reviewed_at)}</div></td><td>${statusTag(r.status)}</td></tr>`;
  }).join('');
  return `<div class="actions" style="justify-content:space-between"><h1>Regras clínicas (alvos)</h1><a class="btn" href="/regras/nova">Nova regra</a></div>
<p class="muted">Só regras <b>ativas</b> classificam. Linhas com fonte "EXEMPLO" são modelo de formato e não podem ser ativadas. ${guidances.length} orientações cadastradas.</p>
<div class="card"><table><thead><tr><th>Exame / aliases</th><th>Condições</th><th class="num">Alvo</th><th class="num">Crítico inf./sup.</th><th>Orientações</th><th>Fonte</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">Nenhuma regra.</td></tr>'}</tbody></table></div>`;
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
  return `<div class="actions" style="justify-content:space-between"><h1>Orientações ao paciente</h1><a class="btn" href="/orientacoes/nova">Nova orientação</a></div>
<p class="muted">Só orientações <b>ativas</b> entram na minuta, e só quando o gatilho (exame + classificação) dispara numa regra que as lista.</p>
<div class="card"><table><thead><tr><th>Código</th><th>Gatilho</th><th>Texto ao paciente</th><th></th><th>Fonte</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">Nenhuma orientação.</td></tr>'}</tbody></table></div>`;
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
  return `<h1>Configurações</h1>${opts.error ? `<div class="flash err">${h(opts.error)}</div>` : ''}
<div class="card"><h2 style="margin-top:0">IA</h2><p>${opts.aiOn ? `Ligada · modelo <code>${h(opts.aiModel)}</code>. Uso acumulado: ${opts.usage.calls} chamadas, ${opts.usage.input.toLocaleString('pt-BR')} tokens de entrada, ${opts.usage.output.toLocaleString('pt-BR')} de saída.` : 'Desligada. Defina <code>ANTHROPIC_API_KEY</code> no ambiente do servidor para habilitar leitura de PDF e redação.'}</p><p class="muted small">A IA só extrai texto do PDF e redige; nunca classifica nem decide. A classificação é sempre do motor de regras.</p></div>
<form method="post" action="/configuracoes/calculos" class="card"><h2 style="margin-top:0">Cálculos derivados habilitados</h2><table><thead><tr><th>Índice</th><th>Fórmula</th><th>Insumos</th></tr></thead><tbody>${calcRows}</tbody></table><p><button class="btn" type="submit">Salvar</button></p></form>
<div class="card"><h2 style="margin-top:0">Usuários</h2><table><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Situação</th><th></th></tr></thead><tbody>${userRows}</tbody></table>
<h3>Novo usuário</h3><form method="post" action="/configuracoes/usuarios"><div class="grid"><div><label>Nome</label><input name="name" required></div><div><label>E-mail</label><input name="email" type="email" required></div><div><label>Senha (mín. 10)</label><input name="password" type="password" minlength="10" required></div><div><label>Papel</label><select name="role">${option('medico', 'médico', 'medico')}${option('admin', 'administrador', 'medico')}</select></div></div><p><button class="btn" type="submit">Criar</button></p></form></div>`;
}

export interface AuditRow { id: number; created_at: string; user: string; action: string; entity: string; entity_id: string | null; details: string | null }

export function auditPage(rows: AuditRow[]): string {
  return `<h1>Auditoria</h1><div class="card"><table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Entidade</th><th>Detalhes</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtDate(r.created_at)}</td><td>${h(r.user)}</td><td>${h(r.action)}</td><td>${h(r.entity)} ${h(r.entity_id ?? '')}</td><td class="small muted">${h((r.details ?? '').slice(0, 200))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nada registrado.</td></tr>'}</tbody></table></div>`;
}

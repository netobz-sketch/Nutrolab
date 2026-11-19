# Integração NutroLab ↔ LN Evolution (API servidor a servidor)

Objetivo: o LN Evolution (plataforma de acompanhamento) mostra ao médico os exames laboratoriais
analisados no NutroLab do mesmo paciente, abre casos novos já preenchidos e usa séries de marcadores
em gráficos e no Relatório de Evolução. O navegador nunca fala com o NutroLab; só a API do
LN Evolution, pela rede interna do Docker (`http://nutrolab:8090`).

## Identidade do paciente
O `code` do paciente é o **id canônico do LN Medicina Integrada: `patients.id` (uuid) do clinica-api**.
No NutroLab ele vive em `patients.code` e é copiado para `cases.patient_code`. `POST /cases` liga o caso ao
paciente com esse `code` (cria o cadastro pseudônimo, com nome = code, se ainda não existir).
Casos antigos com outro código podem ser religados informando esse código.

## Versões
- **v1** (nov/2026): leitura de casos, análises e marcadores; criação de caso.
- **v2** (19/11/2026): `code` canônico documentado, envio de anexos e exportação do relatório final.
  Tudo da v1 continua igual; v2 só acrescenta rotas.

## Nome do paciente
`cases.patient_name` existe no NutroLab e aparece nos relatórios. A integração **nunca o devolve**: o DTO não tem o campo e
`redactPatientName()` substitui o nome nos dois Markdowns pelo código. A ligação entre os sistemas é só o `patient_code`.
`markers.classification` é recalculada com as regras ATIVAS do NutroLab no momento da consulta (o score por sistema é o congelado).

## Autenticação
- Header `X-Integration-Token: <token>`; token em `INTEGRATION_TOKEN` (env). Comparação em tempo constante.
- Sem `INTEGRATION_TOKEN` configurado, as rotas respondem 404 (integração desligada).
- Rotas sob `/api/integration/*` ficam **isentas** da checagem de `ALLOWED_HOSTS` (chegam com host `nutrolab:8090`),
  mas exigem o token. No Caddy público, `/api/integration/*` é bloqueado (404), para o token nunca ser aceito
  pela internet. Cada chamada vai para `audit_log` com `user_id` null e `action` prefixada `integ_`.

## Envelope
Sucesso: `{ data }`. Erro: `{ error: { code, message } }` com 400/401/404/429/500. JSON, UTF-8. Datas `AAAA-MM-DD`;
timestamps ISO. Limite: 120 req/min por token.

## Rotas
- `GET /api/integration/health` → `{ ok: true, app: 'nutrolab', version }`
- `GET /api/integration/patients/:code/cases` → `IntegrationCase[]` (desc por `updatedAt`; só não apagados)
- `GET /api/integration/cases/:id` → `IntegrationCase & { analyses: IntegrationAnalysisSummary[] }`
- `POST /api/integration/cases` `{ patientCode, sex?: 'M'|'F', birthDate?, goal?, contexts?, comorbidities?, medications?, supplements?, notes? }`
  → `{ id, url }` (caso `aberto`, `created_by` null; `notes` recebe o prefixo "Criado pelo LN Evolution em <data>").
- `GET /api/integration/analyses/:id` → `IntegrationAnalysis`
- `GET /api/integration/patients/:code/markers?exams=a,b,c&limit=12` → `IntegrationMarkerSeries[]` (só análises finalizadas;
  sem `exams`, devolve os marcadores com ≥ 2 pontos, até 12 mais frequentes)
- **v2** `POST /api/integration/cases/:id/files` (multipart/form-data, um arquivo PDF/JPG/PNG/WebP até 25 MB; o tipo é
  detectado pelos bytes, não pela extensão) → `201 { data: { fileId } }`. Mesmo pipeline de anexos da tela (`case_files`);
  a extração por IA continua sendo disparada no NutroLab. Erros: 400 sem arquivo/não multipart, 404 caso inexistente,
  415 `UNSUPPORTED_FILE`. Auditoria `integ_upload_file`.
- **v2** `GET /api/integration/analyses/:id/export?format=md|html&type=resumido|tecnico` (padrão `md` e `resumido`)
  → o relatório **final** em `text/markdown` ou o HTML de impressão (o mesmo do botão "Imprimir / PDF", com logo e painel).
  Só para análises finalizadas: minuta → `409 NOT_FINALIZED`. O nome do paciente é substituído pelo código
  (`redactPatientName`). Parâmetro inválido → 400. Auditoria `integ_export_analysis`.

```
IntegrationCase = { id, patientCode, status: 'aberto'|'revisado'|'arquivado', sex, birthDate, goal, createdAt, updatedAt,
  filesCount, resultsCount, latestAnalysis: IntegrationAnalysisSummary|null, url }
IntegrationAnalysisSummary = { id, caseId, createdAt, finalizedAt: string|null, score: number|null, aiUsed: boolean, url }
IntegrationAnalysis = IntegrationAnalysisSummary & {
  patientCode,
  scoreBySystem: { system, label, score: number|null, status: 'otimo'|'adequado'|'atencao'|'alterado'|'sem_dados' }[],
  markers: { exam, label, system, value: number|null, valueRaw, unit, collectionDate, classification: string|null, labFlag: string|null, confidence }[],
  highlights: { favorable: string[], attention: string[] },   // frases curtas extraídas do relatório final (sem dados identificadores)
  approvedConductCount: number,
  patientReportMarkdown: string|null,    // final_patient (só quando finalizada)
  technicalReportMarkdown: string|null   // final_technical (só quando finalizada)
}
IntegrationMarkerSeries = { exam, label, unit, system, points: { date, value, classification: string|null, analysisId, caseId }[] }
```
`url` = `${APP_URL}/casos/<id>` ou `/casos/<id>/analises/<aid>` (link para abrir no NutroLab, com login do NutroLab).
Classificações e scores vêm do motor de regras do NutroLab; a integração não recalcula nada.

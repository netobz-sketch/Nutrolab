# Integração NutroLab ↔ LN Evolution (API servidor a servidor)

Objetivo: o LN Evolution (plataforma de acompanhamento) mostra ao médico os exames laboratoriais
analisados no NutroLab do mesmo paciente, abre casos novos já preenchidos e usa séries de marcadores
em gráficos e no Relatório de Evolução. O navegador nunca fala com o NutroLab; só a API do
LN Evolution, pela rede interna do Docker (`http://nutrolab:8090`).

## Identidade do paciente
O NutroLab continua pseudônimo: `cases.patient_code` recebe o **UUID do paciente no LN Evolution**.
Casos antigos com outro código podem ser ligados informando esse código no LN Evolution.

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

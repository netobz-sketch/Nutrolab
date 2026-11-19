# NutroLab · LN Medicina Integrada · Exames

Serviço de registro e análise de exames (regras, análises, conduta) dentro do sistema **LN Medicina Integrada**.
Na interface: "LN Medicina Integrada · Exames". Login único via GoTrue (Bearer JWT) além da sessão local.

Sistema web para análise de exames em nutrologia. O médico cadastra **exames e referências**
(normalidade, alvo ótimo, limites críticos), **orientações** e um **banco de fórmulas e
medicamentos**; o sistema lê os laudos (PDF ou foto, com IA), exige **conferência**, classifica
cada resultado por um **motor de regras determinístico**, gera **relatório resumido (paciente) e
técnico (médicos)** com **score 0–100** e leitura por sistema, e conduz a etapa de **conduta**
(IA sugere, médico aprova) até o **relatório final em PDF**.

Em produção: https://nutrolab.srv2086528.hstgr.cloud · Código: github.com/netobz-sketch/Nutrolab

## Princípios

- **A IA nunca classifica nem pontua.** Ela transcreve laudos, redige texto e sugere conduta;
  o score e as classificações vêm só das regras do médico. Sem `ANTHROPIC_API_KEY` ela desliga.
- **Nada chega ao paciente sem aprovação.** Conduta, fórmulas e observações entram no relatório
  final só depois de aprovadas na tela.
- **Só regras ativas valem.** O catálogo de 159 exames nasce em rascunho; o médico define o
  ótimo e ativa. Linhas de exemplo não podem ser ativadas.
- **Rastreabilidade e auditoria** de cada resultado (arquivo, página, data, confiança) e de cada
  escrita (quem, quando, antes/depois).

## Fluxo (5 etapas)

1. **Pré-questionário**: identificação, sexo, nascimento, menopausa, contextos, comorbidades,
   medicamentos, suplementos, queixas, observações para a IA.
2. **Anexos**: PDF, JPG, PNG ou WebP; extração por IA por arquivo.
3. **Conferência**: cada exame editável; "OK em todos"; excluir da análise; vincular exame.
4. **Relatório + score**: resumido e técnico, painel visual (velocímetro geral, por sistema,
   barra por exame), impressão/PDF e `.md`.
5. **Conduta**: sugestões da IA (busca na literatura) e do banco de fórmulas; aprovar/rejeitar/
   editar; observações ao paciente; relatório final. Botão para o OpenEvidence com a pergunta pronta.

## Telas

| Menu | O que faz |
|---|---|
| Casos | lista e fluxo do caso |
| Exames e referências | barras coloridas com 6 faixas por exame (crítico/normal/ótimo), tabela completa e CSV |
| Orientações | textos ao paciente com gatilho (exame + classificação) |
| Fórmulas e medicamentos | banco do médico; rascunho por IA; sugestão por caso |
| Relatórios | todos os relatórios gerados; cabeçalho, assinatura, textos padrão, seções |
| OpenEvidence | link externo |
| Configurações (admin) | cálculos derivados, usuários (CPF, conselho), links de redefinição de senha |
| Auditoria (admin) | últimos eventos |

Acesso: tela profissional (nome, CPF, número do conselho, senha) ou e-mail e senha. Recuperação:
link gerado pelo administrador, e-mail (se SMTP configurado) ou `node dist/scripts/reset-password.js`.

## Score

Por resultado comparável: dentro do ótimo 1,0 · fora do ótimo e dentro do normal 0,6 · fora do
normal 0,25 · além de limite crítico 0. Score = média × 100, geral e por sistema. Normalidade:
a da regra ou, se vazia, a lida da referência do laudo.

## Estrutura

```
src/engine/   motor puro: normalize, units, rules, derived, score (testado)
src/ai.ts     Anthropic: extração (PDF/imagem), relatórios, conduta (2 passos), fórmulas
src/report.ts relatórios resumido e técnico (Markdown)   src/visuals.ts painel visual
src/routes/   auth, casos, config (exames, orientações, fórmulas, relatórios, usuários)
src/views/    HTML renderizado no servidor (design LN, só tema claro)
src/sso.ts    login único: Bearer JWT do GoTrue (GOTRUE_JWT_SECRET)
src/integration.ts  API servidor a servidor (v1 + v2), ver docs/INTEGRACAO-LN-EVOLUTION.md
scripts/      backup do SQLite, reset de senha
seed/ skill/  regras de exemplo e a skill original      deploy/  compose, Caddy, script da VPS
```

Stack: Node 22, TypeScript strict, Fastify 5, SQLite nativo, Zod 4, `@anthropic-ai/sdk`, nodemailer.

## Rodar local e testar

```bash
npm install && cp .env.example .env     # ADMIN_EMAIL/ADMIN_PASSWORD criam o 1º admin
npm run build && npm start               # http://localhost:8090
npm test                                 # motor, HTTP, SSO e integração (58 testes)
```

## Integração com o LN Evolution

API servidor a servidor em `/api/integration/*` (contrato em `docs/INTEGRACAO-LN-EVOLUTION.md`):
casos por paciente, análise com score por sistema, marcadores e destaques, séries de marcadores
e criação de caso já preenchido. Exige o header `X-Integration-Token` igual a `INTEGRATION_TOKEN`
(comparação em tempo constante, 120 req/min); sem a variável, as rotas respondem 404. O prefixo é
isento de `ALLOWED_HOSTS` porque chega pela rede interna do Docker (`http://nutrolab:8090`), e o
Caddy público bloqueia `/api/integration/*` para o token nunca ser aceito pela internet. Cada
chamada vai para a auditoria com ação `integ_*`; nenhuma rota devolve nome de paciente.

## Deploy

`./deploy/deploy-vps.sh` (rsync + build na VPS + up). Variáveis no `.env` da VPS:
`NUTROLAB_HOST`, `NUTROLAB_SESSION_SECRET`, `NUTROLAB_INTEGRATION_TOKEN` (gerado pelo script se
ausente), `ANTHROPIC_API_KEY`, `SMTP_*` (opcional).
Backup diário 03h15 em `/srv/clinica/nutrolab-data/backups/`, retenção 14 dias.

# NutroLab

Sistema web para análise de exames laboratoriais em nutrologia: o médico cadastra
**alvos clínicos** e **orientações aprovadas**; o sistema lê os PDFs (IA, opcional),
classifica cada resultado por um **motor de regras determinístico** e gera uma
**minuta** de análise técnica + orientações ao paciente, sempre para revisão médica.

Nasceu da skill `skill/` (SKILL.md + referências), que continua no repositório como
especificação do comportamento.

## Princípios (não negociáveis)

- **A IA nunca classifica nem decide.** Ela só transcreve o PDF e redige texto a partir
  de uma tabela já classificada. Sem `ANTHROPIC_API_KEY` ela desliga e tudo o mais funciona.
- **Nenhuma faixa clínica embutida.** Só regras `ativo` classificam. Linhas com fonte
  "EXEMPLO" são modelo de formato e o sistema recusa ativá-las.
- **Orientação ao paciente só com gatilho estruturado** (exame + classificação), nunca texto improvisado.
- **Rastreabilidade**: cada resultado guarda arquivo, página, data e confiança; cada
  análise guarda versão da tabela, regras e orientações usadas; tudo auditado.
- **Privacidade**: código de paciente pseudonimizado; a IA é instruída a não transcrever
  nome/CPF; PDFs ficam no volume do servidor e somem ao excluir o caso.

## Estrutura

```
src/engine/     motor puro: normalize, units, rules, derived (testado)
src/ai.ts       Anthropic: extração do PDF e redação (saída estruturada)
src/report.ts   relatório Markdown determinístico (assets/modelo-relatorio.md)
src/routes/     auth, casos, regras/orientações/configurações/auditoria
src/views/      HTML renderizado no servidor
scripts/        backup do SQLite
seed/           regras de exemplo (rascunho) importadas no primeiro boot
skill/          a skill original (especificação)
deploy/         compose/Caddy/script da VPS
```

Stack: Node 22, TypeScript strict, Fastify 5, SQLite nativo (`node:sqlite`), Zod, `@anthropic-ai/sdk`.

## Rodar local

```bash
npm install
cp .env.example .env        # ADMIN_EMAIL/ADMIN_PASSWORD criam o 1º admin
npm run build && npm start  # http://localhost:8090
npm test                    # motor de regras
```

## Deploy (VPS da clínica)

```bash
NUTROLAB_ADMIN_EMAIL=voce@exemplo.com NUTROLAB_ADMIN_PASSWORD='senha-forte' ./deploy/deploy-vps.sh
```

Primeira execução acrescenta o serviço ao `docker-compose.yml`, o host ao `Caddyfile`
e as variáveis ao `.env` da VPS; as seguintes só reconstroem a imagem. Para ligar a IA,
preencha `ANTHROPIC_API_KEY` no `.env` da VPS e `docker compose up -d nutrolab`.

Backup: `npm run backup` dentro do contêiner (cron diário configurado no deploy),
arquivos em `/srv/clinica/nutrolab-data/backups/`, retenção 14 dias.

## Fluxo de uso

1. **Regras**: cadastre alvos (exame, sexo, idade, contexto, unidade, alvo, limites críticos, fonte). Ative só o revisado.
2. **Orientações**: textos ao paciente com gatilho (exame + classificação). Ative só o aprovado.
3. **Caso**: código, sexo, nascimento, contextos confirmados; envie PDFs e extraia com IA ou lance à mão.
4. **Gerar análise**: relatório com classificação, cálculos derivados, evolução, minuta e nota de auditoria. Baixe o `.md`.

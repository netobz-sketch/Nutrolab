# Decisões de arquitetura — NutroLab

- 2026-10-28 — Sistema nasce da skill `analisar-exames-nutrologia`; a skill fica em `skill/` como especificação viva do comportamento.
- 2026-10-28 — A IA (Anthropic, `claude-opus-5-5`) só extrai resultados do PDF e redige texto; a classificação é sempre do motor determinístico em `src/engine/`. Sem chave, a IA desliga e o resto funciona.
- 2026-10-28 — Nenhum alvo clínico embutido: só regras `ativo` classificam; linhas com fonte "EXEMPLO" não podem ser ativadas (validação no servidor). Orientação ao paciente dispara por gatilho estruturado (exame + classificação), nunca por texto livre; texto com dose não pode ser ativado pela tela.
- 2026-10-28 — Monólito único (Fastify + HTML no servidor + `node:sqlite`) em vez de dois repositórios: um processo, sem dependência nativa, cabe no padrão do CRM legado na VPS. Dividir depois se crescer.
- 2026-10-28 — Pseudonimização por código de paciente; PDFs guardados no volume para rastreabilidade (página de origem) e apagados com o caso; a IA é instruída a não transcrever identificadores.
- 2026-10-28 — Deploy na VPS como serviço do mesmo compose da clínica (`nutrolab`), imagem construída na própria VPS, host provisório `sslip.io` até o DNS. Backup diário do SQLite com verificação de integridade e retenção de 14 dias.
- 2026-10-28 — CSV de regras no mesmo formato da skill (importar/exportar), para o médico editar em planilha e manter skill e sistema sincronizados.

# Decisões de arquitetura — NutroLab

- 2026-10-28 — Sistema nasce da skill `analisar-exames-nutrologia`; a skill fica em `skill/` como especificação viva do comportamento.
- 2026-10-28 — A IA (Anthropic, `claude-opus-5-5`) só extrai resultados do PDF e redige texto; a classificação é sempre do motor determinístico em `src/engine/`. Sem chave, a IA desliga e o resto funciona.
- 2026-10-28 — Nenhum alvo clínico embutido: só regras `ativo` classificam; linhas com fonte "EXEMPLO" não podem ser ativadas (validação no servidor). Orientação ao paciente dispara por gatilho estruturado (exame + classificação), nunca por texto livre; texto com dose não pode ser ativado pela tela.
- 2026-10-28 — Monólito único (Fastify + HTML no servidor + `node:sqlite`) em vez de dois repositórios: um processo, sem dependência nativa, cabe no padrão do CRM legado na VPS. Dividir depois se crescer.
- 2026-10-28 — Pseudonimização por código de paciente; PDFs guardados no volume para rastreabilidade (página de origem) e apagados com o caso; a IA é instruída a não transcrever identificadores.
- 2026-10-28 — Deploy na VPS como serviço do mesmo compose da clínica (`nutrolab`), imagem construída na própria VPS, host provisório `sslip.io` até o DNS. Backup diário do SQLite com verificação de integridade e retenção de 14 dias.
- 2026-10-28 — CSV de regras no mesmo formato da skill (importar/exportar), para o médico editar em planilha e manter skill e sistema sincronizados.
- 2026-10-29 — Fluxo em 5 etapas: pré-questionário → anexos (PDF ou imagem) → conferência obrigatória (OK em todos / excluir / editar) → relatório resumido + técnico com score 0–100 (velocímetro) e leitura por sistema → conduta (IA sugere, médico aprova) + observações → relatório final para PDF.
- 2026-10-29 — Score determinístico: ótimo=1, fora do ótimo e dentro do normal=0,6, fora do normal=0,25, crítico=0; média × 100; sem regra ativa não pontua. A IA nunca participa do score.
- 2026-10-29 — Faixa de normalidade: a do médico (regra) ou, se vazia, a lida automaticamente da referência do laudo (parser conservador). Catálogo inicial de ~50 exames em rascunho com faixas laboratoriais usuais; alvo ótimo fica para o médico.
- 2026-10-29 — Conduta: a IA sugere (nutrologia + biblioteca do médico + busca web restrita a openevidence.com via ferramenta da Anthropic); nada entra no relatório final sem aprovação explícita. OpenEvidence não tem API pública (403 a robôs, /api/ proibido no robots.txt): a integração é busca indexada + link direto `openevidence.com/ask?q=`.
- 2026-10-29 — Login profissional por nome + CPF (validação de dígitos) + número do conselho + senha; login por e-mail mantido para administração. Verificação automática no CRM/CRN fica como stub (`src/council.ts`) por decisão do médico.
- 2026-10-29 — Nome do paciente passa a ser armazenado (pedido do médico) e aparece nos relatórios; arquivos e nomes de download continuam com o código pseudonimizado. Ao excluir o caso, o nome é apagado junto com os PDFs.

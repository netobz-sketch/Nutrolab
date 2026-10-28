# analisar-exames-nutrologia

Skill de agente (Claude Code / Codex) que lê exames laboratoriais em PDF, compara cada
resultado com os alvos clínicos **que você cadastrou** e gera uma análise técnica mais
uma minuta de orientações ao paciente, sempre marcada como sujeita à sua revisão.

A skill não traz nenhum alvo clínico embutido: ela só classifica contra o que estiver
`ativo` na sua tabela. Sem configuração, ela apenas extrai e organiza os exames.

## Estrutura

| Arquivo | Quem edita | Para quê |
|---|---|---|
| `SKILL.md` | raramente | Instruções que o agente segue. |
| `references/valores-otimizados.csv` | **você** | Alvos clínicos por exame, sexo, idade e contexto. |
| `references/orientacoes-aprovadas.md` | **você** | Textos que podem ir para o paciente. |
| `references/esquema-tabela.md` | raramente | Significado das colunas, vocabulário e precedência. |
| `references/conversoes-unidades.md` | raramente | Fatores de conversão permitidos. |
| `references/calculos-derivados.md` | você, se quiser | HOMA-IR, não-HDL, Friedewald etc. |
| `references/contexto-paciente.md` | por caso | Dados do paciente que você informa ao agente. |
| `assets/modelo-relatorio.md` | raramente | Estrutura do relatório gerado. |
| `scripts/validar-config.py` | não | Confere a configuração antes do uso. |

## Como configurar

1. Abra `references/valores-otimizados.csv` e preencha uma linha por regra. As linhas
   atuais são **exemplos de formato em `rascunho`** e devem ser substituídas.
2. Abra `references/orientacoes-aprovadas.md` e cadastre os textos aprovados.
3. Troque `status` para `ativo` somente no que você revisou.
4. Rode o validador:

```bash
python3 scripts/validar-config.py
```

Ele aponta coluna faltando, status inválido, data fora do formato, `alvo_min` maior que
`alvo_max`, contexto fora do vocabulário, `orientacao_id` que não existe, regra duplicada
e orientação ativa que nenhuma regra usa.

## Como instalar

Copie (ou linke) esta pasta para o diretório de skills do agente:

```bash
# Claude Code
ln -s "$PWD" ~/.claude/skills/analisar-exames-nutrologia
# Codex
ln -s "$PWD" ~/.agents/skills/analisar-exames-nutrologia
```

Se a pasta ficar no iCloud, prefira copiar em vez de linkar: arquivos evictados pelo
iCloud aparecem vazios para o agente.

## Como usar

Com os PDFs na pasta do caso, peça por exemplo:

> Use a skill analisar-exames-nutrologia nestes PDFs. Paciente código P-0042, mulher,
> nascida em 1985-03-10, pré-menopausa, jejum de 12 h, usa metformina. Salvar em .md.

O relatório sai como `analise-exames_P-0042_<data-da-coleta>.md` na pasta dos PDFs.

## Privacidade

Os PDFs contêm nome, CPF e convênio. A skill é instruída a não copiar esses dados para
o relatório e a usar código de paciente no nome do arquivo. Mesmo assim, o relatório é
dado de saúde: guarde-o no mesmo lugar e com o mesmo cuidado dos PDFs.

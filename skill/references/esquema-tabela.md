# Esquema da tabela `valores-otimizados.csv`

Este arquivo define o significado exato de cada coluna, o vocabulário permitido e a
regra de precedência. O agente só pode interpretar a tabela conforme descrito aqui.
Rode `python3 scripts/validar-config.py` depois de qualquer edição.

## Colunas

| Coluna | Obrigatória | Formato | Significado |
|---|---|---|---|
| `exame_canonico` | sim | `snake_case`, sem acento | Identificador estável do exame. Ex.: `vitamina_d_25oh`, `ferritina`, `hba1c`. Um cálculo derivado usa o mesmo `id` de `calculos-derivados.md`. |
| `aliases` | não | nomes separados por `\|` | Como o exame costuma aparecer nos laudos. Comparação sem distinção de maiúsculas e acentos. Ex.: `25-hidroxivitamina D\|25(OH)D\|Vitamina D 25-OH` |
| `sexo` | sim | `M`, `F` ou `todos` | Sexo biológico ao qual a regra se aplica. |
| `idade_min` | não | inteiro, anos completos | Inclusivo. Vazio = sem limite inferior. Idade calculada **na data da coleta**. |
| `idade_max` | não | inteiro, anos completos | Inclusivo. Vazio = sem limite superior. |
| `contexto` | sim | um valor do vocabulário, ou vários unidos por `\|` (todos precisam valer) | `geral` quando a regra não depende de contexto. |
| `unidade` | sim | texto exato | Unidade em que `alvo_min`/`alvo_max` estão expressos. O resultado só é comparado nessa unidade, convertendo apenas pelo que está em `conversoes-unidades.md`. |
| `alvo_min` | condicional | decimal com ponto | Limite inferior do alvo, inclusivo. |
| `alvo_max` | condicional | decimal com ponto | Limite superior do alvo, inclusivo. |
| `alvo_texto` | condicional | texto | Para exames qualitativos (ex.: `não reagente`) ou nota de interpretação. Se `alvo_min` e `alvo_max` estiverem vazios, a comparação é qualitativa contra este texto. |
| `limite_critico_inferior` | não | decimal | Abaixo disso o achado entra em **Alertas prioritários**. |
| `limite_critico_superior` | não | decimal | Acima disso o achado entra em **Alertas prioritários**. |
| `orientacao_id` | não | ids separados por `\|` | Orientações candidatas de `orientacoes-aprovadas.md`. Cada uma só entra na minuta se o próprio `aplica_quando` dela for satisfeito. |
| `fonte_clinica` | sim | texto | Diretriz, protocolo ou "decisão do Dr. X em AAAA-MM-DD". |
| `versao` | sim | `"1.0"` | Incrementar a cada alteração da linha. |
| `data_revisao` | sim | `AAAA-MM-DD` | Data da última revisão médica da linha. |
| `status` | sim | `ativo`, `rascunho` ou `inativo` | Somente `ativo` é usado pelo agente. |

Pelo menos um entre `alvo_min`, `alvo_max` e `alvo_texto` precisa estar preenchido.

## Vocabulário de `contexto`

| Valor | Quando usar | Campo correspondente em `contexto-paciente.md` |
|---|---|---|
| `geral` | regra sem condição de contexto | — |
| `gestacao` | paciente gestante | `gestacao` |
| `lactacao` | paciente amamentando | `gestacao` (anotar lactação) |
| `pre_menopausa` | mulher com ciclo | `menopausa: nao` |
| `pos_menopausa` | mulher em pós-menopausa | `menopausa: sim` |
| `fase_folicular` | coleta na fase folicular | `fase_ciclo_menstrual` |
| `fase_lutea` | coleta na fase lútea | `fase_ciclo_menstrual` |
| `jejum` | coleta em jejum ≥ 8 h confirmado | `jejum_e_duracao` |
| `sem_jejum` | coleta sem jejum ou jejum não confirmado | `jejum_e_duracao` |
| `trh` | em terapia de reposição hormonal | `medicamentos` |
| `uso_anticoncepcional` | em uso de anticoncepcional hormonal | `medicamentos` |
| `atleta` | atleta ou treino intenso regular | `observacoes_do_medico` |

Para criar um contexto novo: acrescentar uma linha nesta tabela **e** o campo que o
alimenta em `contexto-paciente.md`. Um contexto que não está aqui é inválido.

Se o contexto exigido pela regra não puder ser confirmado nos dados do paciente, a
regra **não se aplica** e o resultado fica `não comparável por unidade ou contexto`,
com a informação ausente registrada.

## Precedência entre regras

1. Filtrar as linhas `ativo` cujo `exame_canonico` (ou alias) e `unidade` batem com o resultado.
2. Descartar as linhas cujas condições preenchidas (`sexo` ≠ `todos`, `idade_min`, `idade_max`, `contexto` ≠ `geral`) não são compatíveis com o paciente.
3. Entre as restantes, calcular a **especificidade** = número de condições preenchidas.
4. A linha de maior especificidade vence.
5. Empate de especificidade entre linhas com alvos diferentes → `regra ambígua`; mostrar todas as candidatas ao médico e não classificar.

Exemplo: `ferritina` com linhas (`todos`, `geral`) e (`F`, `pre_menopausa`). Para mulher
com ciclo vence a segunda; para homem a primeira; para mulher sem informação de
menopausa a segunda não pode ser confirmada, então vale a primeira e o relatório
registra "menopausa não informada".

## Versão da tabela clínica

Na nota de auditoria, escrever: `<maior data_revisao entre linhas ativas> (<n> regras ativas)`.
Se não houver linha ativa: `sem regras ativas`.

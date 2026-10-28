# Análise de exames — MINUTA PARA REVISÃO MÉDICA

> Documento de apoio à decisão. Não enviar ao paciente antes da revisão e aprovação do médico responsável.

## Identificação mínima

- Código do paciente:
- Data da análise:
- Data(s) da(s) coleta(s):
- Idade na coleta / sexo biológico:
- Arquivo(s) analisado(s):
- Contexto clínico disponível:
- Informações relevantes ausentes:

## Alertas prioritários

Indicar alertas críticos confirmados, possíveis urgências e itens que exigem conferência manual. Se não houver, escrever: `Nenhum alerta crítico identificado pelos critérios cadastrados; isso não exclui risco clínico.`

## Qualidade e limitações da leitura

Descrever páginas ilegíveis, OCR, unidade ambígua, dados conflitantes, exame incompleto e qualquer limitação que impeça comparação segura.

## Resultados estruturados

Uma linha por resultado e por data. Exames sem alvo cadastrado também entram.

| Exame (canônico / como no laudo) | Resultado original | Convertido | Referência do laboratório | Alvo clínico cadastrado | Classificação | Origem | Confiança |
|---|---:|---:|---|---|---|---|---|
| vitamina_d_25oh / "25-Hidroxi Vitamina D" | 28,4 ng/mL | — | 30–100 ng/mL (lab sinaliza ↓) | 40–80 ng/mL (regra todos/geral) | abaixo do alvo cadastrado | exames-2026-10.pdf, p. 3, coleta 2026-10-15 | alta |

A linha acima é apenas ilustração do preenchimento e deve ser removida.

## Cálculos derivados

Somente os cálculos `ativo` de `references/calculos-derivados.md`, com insumos e fórmula.

| Índice | Fórmula | Insumos (valor, origem) | Resultado | Valor do laudo (se houver) | Alvo cadastrado | Classificação |
|---|---|---|---:|---:|---|---|

Se nenhum cálculo for possível, escrever o motivo (insumo ausente, jejum não confirmado, confiança baixa).

## Evolução entre coletas

Preencher apenas quando houver mais de uma data. Comparar o mesmo exame na mesma unidade; se o laboratório ou a unidade mudou, dizer isso em vez de comparar.

| Exame | Coleta 1 (data) | Coleta 2 (data) | Coleta 3 (data) | Variação observada | Observação |
|---|---:|---:|---:|---|---|

Descrever a variação como fato ("subiu de X para Y"), sem atribuir causa.

## Síntese para o médico

Separar em:

1. Achados factuais relevantes.
2. Padrões que merecem correlação clínica, sem fechar diagnóstico.
3. Divergências entre datas, laboratórios ou unidades.
4. Regras ambíguas e informações de contexto ausentes que limitaram a comparação.
5. Perguntas e decisões pendentes do médico.

## Minuta de orientações ao paciente

### Visão geral

Explicar de modo simples o que foi avaliado e lembrar que os exames precisam ser interpretados junto com história clínica, sintomas e tratamento.

### Pontos favoráveis

Registrar apenas pontos sustentados pelos resultados e pelas regras cadastradas.

### Pontos que merecem atenção

Usar linguagem não alarmista. Não transformar alteração isolada em diagnóstico.

### Orientações aprovadas

Incluir somente orientações com `orientacao_id` ativo e listar os IDs usados na nota de auditoria.

### Próximos passos

Usar apenas próximos passos aprovados. Quando não houver regra, orientar discussão na consulta.

## Nota de auditoria — uso médico

- Versão da tabela clínica:
- Regras clínicas aplicadas (exame → linha usada):
- Regras ambíguas não resolvidas:
- IDs de orientações utilizadas:
- Conversões de unidade realizadas (valor, fator):
- Cálculos derivados realizados (fórmula, insumos):
- Itens que exigem validação manual:
- Dados de contexto ausentes:

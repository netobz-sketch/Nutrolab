# Cálculos derivados

Índices que o agente pode calcular a partir de resultados extraídos. Cada cálculo é
aritmética determinística; **calcular não é classificar**. O valor derivado só recebe
classificação se houver linha `ativo` em `valores-otimizados.csv` com
`exame_canonico` igual ao `id` abaixo. Sem linha, o índice aparece como
`sem alvo cadastrado`.

Regras:

- Usar apenas resultados da **mesma coleta** (mesmo arquivo e data).
- Mostrar sempre fórmula, insumos com origem e resultado na nota de auditoria.
- Se o laboratório já informar o índice, exibir o valor do laudo e o calculado lado a lado; divergência acima de 5 % vira item de validação manual.
- Arredondar a 2 casas decimais.
- Se qualquer insumo tiver confiança `baixa`, `<`/`>` ou `revisão manual necessária`, não calcular.
- Cálculo com `status: rascunho` ou `inativo` não é executado.

```yaml
- id: colesterol_nao_hdl
  nome: Colesterol não-HDL
  formula: colesterol_total - hdl
  unidade: mg/dL
  insumos: [colesterol_total, hdl]
  condicoes: mesma unidade nos dois insumos
  status: ativo

- id: ldl_friedewald
  nome: LDL estimado (Friedewald)
  formula: colesterol_total - hdl - (triglicerideos / 5)
  unidade: mg/dL
  insumos: [colesterol_total, hdl, triglicerideos]
  condicoes: triglicerídeos < 400 mg/dL e jejum confirmado; se o laudo trouxer LDL direto, exibir ambos e usar o do laudo na tabela principal
  status: ativo

- id: razao_tg_hdl
  nome: Razão TG/HDL
  formula: triglicerideos / hdl
  unidade: adimensional
  insumos: [triglicerideos, hdl]
  condicoes: ambos em mg/dL
  status: ativo

- id: razao_ct_hdl
  nome: Razão colesterol total/HDL
  formula: colesterol_total / hdl
  unidade: adimensional
  insumos: [colesterol_total, hdl]
  condicoes: ambos na mesma unidade
  status: ativo

- id: homa_ir
  nome: HOMA-IR
  formula: (glicose_jejum * insulina_jejum) / 405
  unidade: adimensional
  insumos: [glicose_jejum, insulina_jejum]
  condicoes: glicose em mg/dL, insulina em µU/mL, jejum ≥ 8 h confirmado em contexto-paciente, mesma coleta
  status: ativo

- id: tyg
  nome: Índice TyG
  formula: ln((triglicerideos * glicose_jejum) / 2)
  unidade: adimensional
  insumos: [triglicerideos, glicose_jejum]
  condicoes: ambos em mg/dL, jejum confirmado
  status: rascunho

- id: tfg_estimada
  nome: Taxa de filtração glomerular estimada
  formula: usar o valor informado pelo laboratório; não recalcular
  unidade: mL/min/1.73m²
  insumos: [creatinina]
  condicoes: equação (CKD-EPI 2021, com ou sem cistatina) definida pelo médico antes de ativar
  status: rascunho
```

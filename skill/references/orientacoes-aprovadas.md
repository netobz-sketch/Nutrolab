# Orientações aprovadas

Biblioteca de orientações que podem aparecer na minuta destinada ao paciente. O agente
usa **somente** itens com `status: ativo` cujo `aplica_quando` esteja satisfeito e cujo
`nao_aplicar_quando` não esteja. Na versão atual **nenhuma orientação está ativa**: os
blocos abaixo são exemplos de formato em `rascunho`.

Rode `python3 scripts/validar-config.py` depois de qualquer edição.

## Campos

| Campo | Formato | Significado |
|---|---|---|
| `orientacao_id` | `MAIÚSCULAS-E-HÍFENS`, único e estável | Referenciado pela coluna `orientacao_id` da tabela de alvos. |
| `titulo` | texto curto | Para o médico localizar a orientação. |
| `aplica_quando` | critério objetivo | Usar `exame_canonico` + classificação, ex.: `vitamina_d_25oh abaixo do alvo cadastrado`. Pode combinar com contexto do paciente. |
| `nao_aplicar_quando` | critério objetivo | Contraindicações, exceções e dados ausentes que impedem o uso. |
| `texto_paciente` | texto exato | É o que entra na minuta, sem alteração de sentido. Pode conter `{campo}` só se o campo for um dado factual já extraído (ex.: `{data_coleta}`), nunca um valor clínico inventado. |
| `exige_alerta` | `true`/`false` | Se `true`, a orientação também aparece em **Alertas prioritários** da análise técnica. |
| `fonte_clinica` | texto | Diretriz, protocolo ou "decisão do Dr. X em AAAA-MM-DD". |
| `versao` | `"1.0"` | Incrementar a cada alteração. |
| `data_revisao` | `AAAA-MM-DD` | Última revisão médica. |
| `status` | `ativo`, `rascunho` ou `inativo` | Só `ativo` é usado. |

## Regras

- Manter `orientacao_id` estável e único; nunca reaproveitar um id para outro conteúdo.
- Usar `status: ativo` apenas em conteúdo aprovado pelo médico responsável.
- Não cadastrar prescrições ou doses sem critérios completos, contraindicações e processo explícito de validação médica.
- Atualizar `versao` e `data_revisao` quando o conteúdo mudar.
- O texto ao paciente não cita alvo numérico interno, nem nome de medicamento, salvo decisão explícita do médico registrada em `fonte_clinica`.

## Modelo de bloco

Duplicar, preencher todos os campos e trocar o status para `ativo` somente após revisão médica.

```yaml
- orientacao_id: ORIENTACAO-ID-UNICO
  titulo: Título curto para o médico
  aplica_quando: Critério clínico objetivo e verificável
  nao_aplicar_quando: Contraindicações, exceções e contextos ausentes
  texto_paciente: Texto exato ou limites claros para personalização
  exige_alerta: false
  fonte_clinica: Referência, protocolo ou decisão do médico
  versao: "1.0"
  data_revisao: AAAA-MM-DD
  status: rascunho
```

## Orientações cadastradas

```yaml
- orientacao_id: ORIENT-VITD-BAIXA
  titulo: Vitamina D abaixo do alvo (exemplo de formato)
  aplica_quando: vitamina_d_25oh abaixo do alvo cadastrado
  nao_aplicar_quando: gestacao; uso atual de suplemento de vitamina D nao informado em medicamentos ou suplementos; resultado com confianca baixa
  texto_paciente: Seu nível de vitamina D ficou abaixo do que consideramos ideal para o seu acompanhamento. Isso é comum e, na maioria das vezes, ajustável. Vamos conversar na consulta sobre a melhor forma de corrigir no seu caso.
  exige_alerta: false
  fonte_clinica: EXEMPLO DE FORMATO - substituir pela decisao do medico
  versao: "1.0"
  data_revisao: 2026-10-28
  status: rascunho

- orientacao_id: ORIENT-ALERTA-CRITICO
  titulo: Resultado fora de limite crítico cadastrado (exemplo de formato)
  aplica_quando: qualquer exame com valor fora de limite_critico_inferior ou limite_critico_superior ativo
  nao_aplicar_quando: resultado com confianca baixa ou marcado para revisao manual sem confirmacao visual da pagina
  texto_paciente: Um dos seus exames apresentou um valor que precisa ser avaliado com prioridade. Por favor, entre em contato com a clínica hoje para que possamos orientar os próximos passos.
  exige_alerta: true
  fonte_clinica: EXEMPLO DE FORMATO - definir canal de contato e criterio de urgencia
  versao: "1.0"
  data_revisao: 2026-10-28
  status: rascunho
```

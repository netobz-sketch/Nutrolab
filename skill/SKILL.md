---
name: analisar-exames-nutrologia
description: Extrair e revisar resultados de exames laboratoriais em PDF, comparar cada resultado com alvos clínicos cadastrados pelo médico e produzir uma análise técnica e uma minuta de orientações ao paciente. Usar ao receber exames de pacientes de nutrologia, obesidade, emagrecimento, longevidade ou qualidade de vida, inclusive exames seriados, desde que a entrega seja submetida à revisão médica antes do envio ao paciente.
---

# Analisar exames de nutrologia

Tratar a saída como apoio à decisão clínica e minuta de comunicação. Nunca apresentá-la como diagnóstico autônomo, prescrição ou substituto da revisão do médico responsável.

## Carregar os recursos obrigatórios

1. Ler `references/esquema-tabela.md`: define colunas, vocabulário de contexto e precedência entre regras.
2. Ler `references/valores-otimizados.csv` por completo.
3. Ler `references/orientacoes-aprovadas.md` por completo.
4. Ler `references/conversoes-unidades.md` e `references/calculos-derivados.md`.
5. Ler `references/contexto-paciente.md` para conhecer os dados clínicos esperados.
6. Usar `assets/modelo-relatorio.md` como estrutura da entrega.
7. Considerar apenas linhas, orientações e cálculos com `status` igual a `ativo`.

Se houver `python3` disponível, rodar `python3 scripts/validar-config.py` antes de começar. Se o validador apontar **erros**, não usar a tabela para classificar: extrair e organizar os exames, listar os erros na seção de limitações e pedir correção ao médico. Avisos não bloqueiam.

Se a tabela não contiver alvos ativos, ainda extrair e organizar os exames, mas não classificar nenhum resultado em relação a um alvo otimizado. Informar que a configuração clínica está incompleta.

## Fluxo obrigatório

### 1. Confirmar os insumos

Identificar:

- PDFs e respectivas datas;
- código ou iniciais do paciente, evitando nome completo no arquivo de saída;
- idade ou data de nascimento, sexo biológico e contextos aplicáveis, usando o vocabulário de `esquema-tabela.md`;
- gestação, menopausa, ciclo menstrual, jejum, horário da coleta, medicamentos, suplementos, comorbidades e objetivo terapêutico, quando pertinentes;
- preferência de saída `.md` ou `.txt` e pasta de destino.

A idade usada nas regras é a idade **na data da coleta**, não na data da análise. Se só houver data de nascimento, calcular e registrar.

Não bloquear a extração por falta de contexto. Registrar cada dado ausente e limitar as comparações que dependam dele.

### 2. Ler e conferir o PDF

Usar a capacidade de leitura de PDF disponível. Extrair texto de todas as páginas e renderizar visualmente páginas com tabelas, resultados ilegíveis, OCR duvidoso, símbolos, expoentes ou unidades ambíguas.

Para cada resultado, registrar:

- nome exatamente como aparece;
- nome canônico, quando houver correspondência segura;
- valor, unidade e indicador textual, como reagente ou não reagente;
- intervalo de referência e sinalização do laboratório;
- data da coleta;
- página e arquivo de origem;
- confiança da extração: alta, média ou baixa.

Laudos brasileiros usam vírgula decimal (`1,25`): manter o original como está e usar ponto apenas no valor convertido. Preservar sinais `<` e `>` exatamente como no laudo.

Não inferir dígitos, casas decimais, unidade, sinal de desigualdade ou resultado ausente. Marcar como `revisão manual necessária` quando houver dúvida. Manter resultados repetidos separados por data.

### 3. Normalizar sem alterar a fonte

Preservar sempre o valor e a unidade originais. Converter unidade **somente** pelos fatores de `references/conversoes-unidades.md`; qualquer outra divergência de unidade torna o resultado `não comparável por unidade ou contexto`. Exibir lado a lado o original e o convertido e registrar o fator na nota de auditoria.

Resolver aliases somente quando houver correspondência clara com `aliases` na tabela. Não combinar exames biologicamente distintos que tenham nomes parecidos (ex.: vitamina D 25-OH ≠ 1,25-di-hidroxivitamina D; ferro sérico ≠ ferritina; T4 livre ≠ T4 total; BUN ≠ ureia).

### 4. Calcular índices derivados

Executar apenas os cálculos `ativo` de `references/calculos-derivados.md`, com insumos da mesma coleta e dentro das condições de cada um. Mostrar fórmula, insumos e origem. Calcular não é classificar: o índice só recebe classificação se existir linha ativa na tabela com o mesmo `exame_canonico`.

### 5. Selecionar o alvo aplicável

Aplicar a precedência de `esquema-tabela.md`: filtrar por nome canônico e unidade, descartar regras cujas condições não são compatíveis com o paciente, e escolher a de maior especificidade. Uma condição de contexto que não pode ser confirmada nos dados do paciente torna a regra inaplicável, e o dado ausente deve ser registrado.

Se mais de uma regra ativa de mesma especificidade puder ser aplicada com alvos diferentes, não escolher silenciosamente. Marcar `regra ambígua` e mostrar as regras candidatas ao médico.

Classificar o resultado apenas como:

- `dentro do alvo cadastrado`;
- `abaixo do alvo cadastrado`;
- `acima do alvo cadastrado`;
- `resultado qualitativo compatível`;
- `resultado qualitativo não compatível`;
- `sem alvo cadastrado`;
- `não comparável por unidade ou contexto`;
- `regra ambígua`.

Valores com `<` ou `>` só são classificados quando a conclusão independe do valor exato: `<0,5` com alvo mínimo 1,0 é `abaixo`; `<0,5` com alvo 0,2–1,0 é `não comparável por unidade ou contexto`, com a explicação.

Distinguir explicitamente o intervalo do laboratório do alvo clínico cadastrado. Nunca chamar o alvo cadastrado de intervalo de referência laboratorial ou de consenso universal.

### 6. Tratar exames seriados

Quando houver mais de uma data de coleta, preencher a seção **Evolução entre coletas** do modelo. Comparar o mesmo exame apenas na mesma unidade. Se o laboratório ou a unidade mudou entre coletas, registrar isso em vez de comparar. Descrever a variação como fato, sem atribuir causa nem chamar de melhora ou piora, salvo quando a direção em relação ao alvo cadastrado for inequívoca.

### 7. Tratar segurança e urgência

Destacar um achado como crítico ou urgente somente quando:

- o próprio laudo trouxer sinalização crítica; ou
- existir limite crítico ativo e aplicável na tabela clínica.

Não diagnosticar a partir de um valor isolado. Não recomendar início, suspensão ou ajuste de medicamento, hormônio, injetável ou suplemento, nem sugerir dose, salvo se o médico fornecer uma regra explícita e aprovada para esse uso. Mesmo nesse caso, apresentar como minuta para validação médica.

Se houver possível urgência, colocar o alerta no início da análise técnica e orientar contato imediato com o médico ou serviço de urgência conforme a regra cadastrada, sem minimizar nem exagerar o risco.

### 8. Produzir duas camadas de saída

Criar primeiro a `Análise para revisão médica`, contendo rastreabilidade completa, limitações, comparação estruturada e padrões que merecem correlação clínica. Separar fatos extraídos de interpretações.

Criar depois a `Minuta de orientações ao paciente`, em português claro, respeitoso e não alarmista. Usar somente textos e condutas de `references/orientacoes-aprovadas.md` que tenham `status: ativo`, `aplica_quando` satisfeito e `nao_aplicar_quando` não satisfeito. Não expor alvos internos ou raciocínio técnico desnecessário ao paciente.

Quando não existir orientação aprovada para um achado, dizer apenas que ele deve ser contextualizado na consulta. Não improvisar dieta, suplementação, tratamento ou periodicidade de repetição.

### 9. Salvar e revisar

Salvar por padrão em Markdown com o nome `analise-exames_<codigo-paciente>_<AAAA-MM-DD>.md`, em que a data é a **da coleta mais recente**. Salvar na pasta informada pelo médico ou, na falta dela, na mesma pasta dos PDFs. Usar `.txt` quando solicitado. Não incluir nome completo, CPF, telefone ou e-mail no nome do arquivo.

Antes de concluir, verificar:

- todas as páginas foram lidas;
- cada número da tabela final tem arquivo, página e data de origem;
- unidade original foi preservada e toda conversão consta da tabela permitida;
- nenhuma faixa clínica foi inventada;
- nenhum cálculo derivado foi feito fora das condições cadastradas;
- toda orientação ao paciente possui um `orientacao_id` ativo;
- incertezas, regras ambíguas e informações ausentes estão visíveis;
- a nota de auditoria traz a versão da tabela clínica;
- o documento está marcado como minuta sujeita à revisão médica.

## Regras de privacidade

Usar apenas os dados necessários para a análise. Não copiar o cabeçalho de identificação do laboratório (nome, CPF, convênio, endereço) para o relatório. Não enviar arquivos ou dados do paciente para serviços externos sem autorização expressa do médico e base adequada para o tratamento desses dados. Não reutilizar informações de um paciente em outro caso.

## Limites da entrega

Não emitir laudo definitivo, diagnóstico fechado, liberação para procedimento ou prescrição autônoma. Não ocultar divergências entre laboratórios, datas, unidades ou regras. Solicitar decisão do médico quando uma escolha clínica material não estiver definida nos recursos da skill.

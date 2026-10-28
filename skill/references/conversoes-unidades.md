# Conversões de unidade permitidas

O agente só converte unidades que constem nesta tabela. Qualquer outra divergência de
unidade gera `não comparável por unidade ou contexto`. O valor original é sempre
preservado e exibido ao lado do convertido, com o fator usado na nota de auditoria.

Regras gerais:

- Diferença só de grafia **não é conversão**: `mg/dl` = `mg/dL`, `ug/dL` = `µg/dL` = `mcg/dL`, `mUI/L` = `mIU/L` = `µUI/mL` = `uUI/mL`, `ng/mL` = `µg/L`, `mg/L` = `µg/mL`.
- Vírgula decimal do laudo brasileiro (`1,25`) vira ponto no valor convertido; o original é mantido como está.
- Valor com `<` ou `>` mantém o sinal após converter (`<0,5 ng/mL` → `<1.25 nmol/L`).
- Arredondar o convertido com uma casa decimal a mais que o original, no máximo 3.
- Quando a direção for SI → convencional, usar o inverso do fator.

| Analito | De | Para | Fator (multiplicar) |
|---|---|---|---|
| Glicose | mg/dL | mmol/L | 0.0555 |
| Colesterol total, HDL, LDL, não-HDL | mg/dL | mmol/L | 0.02586 |
| Triglicerídeos | mg/dL | mmol/L | 0.01129 |
| Creatinina | mg/dL | µmol/L | 88.4 |
| Ureia | mg/dL | mmol/L | 0.1665 |
| Ácido úrico | mg/dL | µmol/L | 59.48 |
| Bilirrubina (total, direta, indireta) | mg/dL | µmol/L | 17.1 |
| Cálcio total | mg/dL | mmol/L | 0.2495 |
| Cálcio iônico | mg/dL | mmol/L | 0.2495 |
| Magnésio | mg/dL | mmol/L | 0.4114 |
| Fósforo | mg/dL | mmol/L | 0.3229 |
| Ferro sérico | µg/dL | µmol/L | 0.179 |
| Zinco | µg/dL | µmol/L | 0.153 |
| Vitamina D 25-OH | ng/mL | nmol/L | 2.496 |
| Vitamina B12 | pg/mL | pmol/L | 0.7378 |
| Folato | ng/mL | nmol/L | 2.266 |
| Hemoglobina | g/dL | g/L | 10 |
| Albumina | g/dL | g/L | 10 |
| Proteínas totais | g/dL | g/L | 10 |
| T4 livre | ng/dL | pmol/L | 12.87 |
| T3 livre | pg/mL | pmol/L | 1.536 |
| T3 total | ng/dL | nmol/L | 0.01536 |
| Testosterona total | ng/dL | nmol/L | 0.03467 |
| Estradiol | pg/mL | pmol/L | 3.671 |
| Cortisol | µg/dL | nmol/L | 27.59 |
| Proteína C reativa | mg/dL | mg/L | 10 |
| Homocisteína | mg/L | µmol/L | 7.397 |
| HbA1c (NGSP → IFCC) | % | mmol/mol | fórmula: (valor − 2.15) × 10.929 |

**Não converter automaticamente** (padrões de calibração divergem entre laboratórios):
insulina para pmol/L, prolactina, PTH, SHBG, DHEA-S, IGF-1, vitamina A/E, hormônios
em unidades arbitrárias. Nesses casos registrar `não comparável por unidade ou contexto`
e sugerir ao médico cadastrar o alvo na unidade que o laboratório usa.

**Ureia × BUN**: BUN (nitrogênio ureico) não é ureia. Ureia (mg/dL) = BUN (mg/dL) × 2.14.
Só aplicar quando o laudo nomear explicitamente "BUN" ou "nitrogênio ureico".

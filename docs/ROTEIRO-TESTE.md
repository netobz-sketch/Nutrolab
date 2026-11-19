# Roteiro de teste do NutroLab (LN Medicina Integrada · Exames)

Para o Dr. Leônidas testar o sistema de ponta a ponta antes de usar com pacientes de verdade.
Leva cerca de 40 minutos. Marque cada item conforme for passando.

Endereço: https://nutrolab.srv2086528.hstgr.cloud

## Antes de começar

- Use um exame **seu** ou de um paciente que já assinou o termo de consentimento (LGPD). O sistema
  guarda o PDF e os resultados de verdade.
- Tenha em mãos um PDF de exame laboratorial com vários resultados (hemograma, glicose, vitamina D,
  ferritina, hormônios). Uma foto nítida do laudo também serve.
- Se algo der errado, não tente de novo várias vezes: veja a seção **"Se algo falhar"** no fim.

## 1. Entrar no sistema

- [ ] Abra o endereço e entre com seu e-mail e a **senha única**, a mesma do acesso inicial do
      LN Medicina Integrada. Uma senha errada é recusada, mesmo que seja a senha antiga do NutroLab.
- [ ] Entre também pelo login profissional: nome, CPF e número do conselho (se ainda não
      preencheu, faça isso em **seu nome → Meu cadastro**). Esse login usa a senha **local** do
      NutroLab e é a saída de emergência.
- [ ] A senha única se troca no acesso inicial da clínica, não no NutroLab. **Meu cadastro → Trocar
      senha** e "Esqueci a senha" mudam só a senha local, usada no login profissional e quando o
      acesso inicial estiver fora do ar. Mantenha essa senha local forte e guardada.
- [ ] **Logo depois da atualização da senha única:** quando o Claude avisar que publicou, entre no
      NutroLab com seu e-mail e a senha única e diga se entrou. Se aparecer "Seu perfil não tem
      acesso" ou "E-mail ou senha incorretos" com a senha certa, avise na hora: o Claude volta a
      versão anterior em segundos e você continua entrando com a senha antiga do NutroLab.
- [ ] **Login único com o LN Evolution:** quando o LN publicar o login único, entrar no LN deve
      bastar para abrir o NutroLab sem pedir senha de novo. Até lá, este item fica pendente.

## 2. Cadastrar o paciente

- [ ] **Pacientes → Novo paciente**: preencha nome, data de nascimento, sexo, comorbidades,
      medicações, suplementos e objetivo.
- [ ] Na ficha do paciente, gere o **termo de consentimento**, registre como assinado e anexe o termo
      assinado (PDF ou foto).
- [ ] Confira que a ficha mostra o consentimento como **assinado**.

## 3. Abrir o caso e enviar o exame

- [ ] Na ficha do paciente (ou em **Casos → Novo caso**), abra um caso novo.
- [ ] Preencha o pré-questionário. Para mulher: fase do ciclo, anticoncepcional, reposição hormonal
      e menopausa. Esses dados mudam as faixas dos hormônios.
- [ ] Em **Anexar**, envie o PDF (ou a foto) do exame.
- [ ] Clique em **Extrair do PDF com IA**. Os resultados devem aparecer na lista do caso.
- [ ] Confira se nenhum exame do laudo ficou de fora. Se faltar algum, lance à mão.

## 4. Conferência (obrigatória)

- [ ] Abra a **Conferência**: cada resultado aparece com valor, unidade e data de coleta.
- [ ] Compare **linha a linha com o laudo**. Corrija o que a leitura errou (vírgula, unidade, troca
      de exame).
- [ ] Exame que o sistema não reconheceu: vincule ao exame certo da tabela.
- [ ] Clique em **OK em todos** só depois de conferir. Sem isso o sistema não deixa gerar o relatório.

## 5. Análise

- [ ] Clique em **Gerar relatório + score**.
- [ ] Confira o **score de 0 a 100**, o **score por sistema** e as barras coloridas de cada exame
      (faixa normal e faixa ótima).
- [ ] Leia os dois relatórios: o **resumido** (para o paciente, linguagem simples) e o **técnico**.
- [ ] Veja se algum valor crítico apareceu destacado como alerta.

## 6. Conduta

- [ ] Abra **Conduta** e clique em **Sugerir conduta com IA**. A IA pesquisa e propõe itens com
      justificativa e fonte.
- [ ] Para cada item: **Aprovar**, **Rejeitar** ou editar. Acrescente itens seus.
- [ ] Use o botão **OpenEvidence** para consultar uma dúvida (abre o site com a pergunta pronta).
- [ ] Opcional: **Fórmulas → Sugerir com IA** (só funciona depois que o banco de fórmulas tiver
      fórmulas suas; hoje está vazio).
- [ ] Opcional: **Salvar como modelo** a conduta, para reusar em pacientes com o mesmo perfil.

## 7. Finalizar e exportar

- [ ] Clique em **Gerar relatório final (resumido + técnico)**. Depois de finalizado, o relatório não
      muda mais.
- [ ] **Imprimir / PDF resumido** e **Imprimir / PDF técnico**: confira logo, cabeçalho, gráficos e
      assinatura.
- [ ] Baixe o relatório técnico em texto (.md) e veja se abre.
- [ ] Em **Relatórios**, o caso aparece na lista com o score.
- [ ] Na ficha do paciente, a **Evolução** mostra este exame (com dois exames em datas diferentes,
      aparecem as séries lado a lado).

## 8. Integração com o LN Evolution

- [ ] No prontuário do paciente no **LN Evolution**, anexe o PDF do exame e clique em **Enviar ao
      NutroLab**.
- [ ] No NutroLab, em **Casos**, o caso novo aparece com origem **LN** e o PDF já anexado.
- [ ] Quando o LN publicar o envio do id do paciente, aparece ao lado o link **prontuário**, que
      volta para a ficha no LN. Até lá o link fica oculto; isso é esperado.
- [ ] Faça os passos 4 a 7 nesse caso.
- [ ] Depois de finalizado, gere no LN o **Relatório de Evolução em PDF**: ele deve trazer o score
      mais recente, a data e os destaques do exame, **sem o nome do paciente** vindo do NutroLab.
- [ ] Análise ainda não finalizada **não** entra no PDF do LN nem nos gráficos de evolução de lá.
      Isso é proposital: só vai o que você aprovou e finalizou.

## Se algo falhar

1. Anote **a hora**, **a tela** (o endereço que aparece no navegador) e **a mensagem** exibida.
2. Se tirar print, cubra nome e dados do paciente.
3. Mande para o Claude nesta conversa. Não precisa refazer o teste antes.
4. Nada se perde: o banco tem cópia cifrada automática todas as noites, e o sistema registra cada
   ação em **Auditoria**.
5. Esqueceu a senha e o e-mail não chegou? Peça ao Claude um link de redefinição.
6. "Página não encontrada" ao abrir um endereço digitado à mão é normal. Volte em **Casos**.

## O que ainda precisa da sua revisão clínica antes do uso real

O sistema calcula e classifica com base na tabela que **você** valida. Hoje:

- **Referências dos exames, 181 linhas ativas.** 142 foram preenchidas a partir de pesquisa
  (nov/2026, a fonte está anotada em cada linha). As outras são faixas por fase do ciclo, contraceptivo,
  reposição, menopausa e idade. **Todas precisam da sua conferência**, principalmente as faixas
  **ótimas**, que são decisão sua e não do laboratório.
- **Referências em rascunho, 42 linhas.** Exames de saliva e hormônios que dependem do kit do
  laboratório. Não classificam nada enquanto estiverem em rascunho. Ative uma a uma depois de definir
  a faixa.
- **Referências inativas, 4 linhas.** Desligadas de propósito, por exemplo a linha geral de exame que
  tem faixa por sexo.
- **Orientações ao paciente, 2 em rascunho.** São só exemplos de formato (vitamina D baixa e alerta
  de valor crítico). Reescreva com o seu texto ou exclua.
- **Banco de fórmulas vazio.** Envie seus formulários (Word ou PDF) em **Fórmulas**. A IA lê e propõe
  as fichas, e você revisa cada uma antes de usar.
- **Modelos de conduta vazios.** Crie os seus a partir de condutas aprovadas.
- **Cabeçalho dos relatórios.** Nome da clínica e logo já estão. Faltam a **linha de contato**, a
  **assinatura** e os textos de abertura e fechamento do relatório do paciente. Preencha em
  **Relatórios**.
- **Verificação no conselho.** O número do conselho é guardado, mas a consulta automática ao
  CRM/CRN ainda não existe.

Lembrete: a IA só transcreve o laudo e redige textos. Classificação, score e alertas vêm da tabela
de referências. Conduta só vale depois da sua aprovação, item por item.

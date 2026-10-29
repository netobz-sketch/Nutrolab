import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getDb } from './db.js';

export const AI_MODEL = process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5-5';

export function aiEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!aiEnabled()) throw new AiError('IA desligada: ANTHROPIC_API_KEY não configurada.');
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 10 * 60 * 1000, maxRetries: 2 });
  return client;
}

export class AiError extends Error {}

/* ------------------------------------------------------------ extração */

export const ExtractionSchema = z.object({
  lab_name: z.string().nullable(),
  pages_read: z.number().int(),
  results: z.array(
    z.object({
      exam_raw: z.string(),
      exam_canonical: z.string().nullable(),
      value_raw: z.string(),
      unit_raw: z.string().nullable(),
      lab_reference: z.string().nullable(),
      lab_flag: z.string().nullable(),
      collection_date: z.string().nullable(),
      page: z.number().int().nullable(),
      confidence: z.enum(['alta', 'media', 'baixa']),
    }),
  ),
  warnings: z.array(z.string()),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

const EXTRACTION_SYSTEM = `Você extrai resultados de exames laboratoriais de um laudo (PDF ou foto/imagem) de laboratório brasileiro para revisão médica.

Regras invioláveis:
- Transcreva cada resultado EXATAMENTE como está no laudo: valor com vírgula decimal, sinal < ou >, unidade e intervalo de referência do laboratório. Nunca converta, arredonde, complete dígitos ou "corrija" o laudo.
- Um resultado por linha do laudo. Resultados repetidos em datas diferentes viram linhas separadas, cada uma com a sua data de coleta (AAAA-MM-DD).
- Preencha "exam_canonical" SOMENTE quando o nome do laudo corresponder sem dúvida a um id ou alias do catálogo fornecido. Em dúvida, deixe null. Nunca combine exames biologicamente distintos com nomes parecidos (25-OH vitamina D ≠ 1,25-di-hidroxivitamina D; ferro ≠ ferritina; T4 livre ≠ T4 total; BUN ≠ ureia).
- "lab_flag" é a sinalização do próprio laboratório (ex.: "↑", "alto", "*", "crítico"); null se não houver.
- "confidence": "alta" só quando o texto é nítido e inequívoco; "media" para leitura por OCR, foto ou layout confuso; "baixa" quando houver qualquer dúvida de dígito, casa decimal, unidade ou de a qual exame o valor pertence.
- Em imagem/foto: se parte estiver cortada, borrada ou ilegível, registre em "warnings" e use confiança "baixa" nos itens afetados.
- NUNCA inclua nome, CPF, RG, telefone, endereço, convênio ou qualquer identificador do paciente em nenhum campo. Não interprete, não classifique, não sugira conduta.`;

export type FileMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

export async function extractFromFile(file: Buffer, mime: FileMime, catalog: Array<{ exam: string; aliases: string[] }>, caseId: number): Promise<Extraction> {
  const anthropic = getClient();
  const catalogText = catalog.map((c) => `- ${c.exam}: ${c.aliases.join(' | ') || '(sem aliases)'}`).join('\n');
  const data = file.toString('base64');
  const fileBlock: Anthropic.ContentBlockParam =
    mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mime, data } };
  try {
    const response = await anthropic.messages.parse({
      model: AI_MODEL,
      max_tokens: 16000,
      system: [{ type: 'text', text: EXTRACTION_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            fileBlock,
            { type: 'text', text: `Catálogo de exames canônicos (id: aliases):\n${catalogText}\n\nExtraia todos os resultados de todas as páginas do laudo acima.` },
          ],
        },
      ],
      output_config: { effort: 'high', format: zodOutputFormat(ExtractionSchema) },
    });
    recordUsage(caseId, 'extracao', response.usage.input_tokens, response.usage.output_tokens);
    if (response.stop_reason === 'refusal') throw new AiError('O modelo recusou processar este documento.');
    if (response.stop_reason === 'max_tokens') throw new AiError('Resposta truncada: arquivo grande demais para uma extração; divida o arquivo.');
    if (!response.parsed_output) throw new AiError('A resposta da IA não pôde ser interpretada.');
    return response.parsed_output;
  } catch (error) {
    throw translate(error);
  }
}

/* ------------------------------------------------------- relatórios */

const SystemBlock = z.object({ sistema: z.string(), texto: z.string() });

export const ReportsSchema = z.object({
  resumido: z.object({
    visao_geral: z.string(),
    por_sistema: z.array(SystemBlock),
    pontos_favoraveis: z.string(),
    pontos_atencao: z.string(),
    mensagem_final: z.string(),
  }),
  tecnico: z.object({
    sintese: z.string(),
    por_sistema: z.array(z.object({ sistema: z.string(), achados: z.string(), correlacao_clinica: z.string() })),
    leitura_integrada: z.string(),
    limitacoes: z.string(),
  }),
});
export type Reports = z.infer<typeof ReportsSchema>;

const REPORTS_SYSTEM = `Você redige, em português do Brasil, DOIS relatórios a partir de exames já classificados por um motor de regras do próprio médico nutrólogo, mais o pré-questionário do paciente (sexo, idade, queixas, comorbidades, medicamentos, observações do médico). Ambos são MINUTAS para revisão médica.

Regras:
- Use apenas os fatos fornecidos: valores, classificações (alvo ótimo e faixa de normalidade), score por sistema, queixas e contexto. Não invente valores, faixas, diagnósticos ou causas. Não recomende, não prescreva, não sugira suplemento, dose, dieta ou periodicidade: a conduta é uma etapa separada, do médico.
- Organize a leitura por sistemas/órgãos na ordem em que vierem nos dados; faça a leitura INTEGRADA correlacionando sistemas entre si e com as queixas (ex.: fadiga + ferritina baixa + vitamina D baixa), sempre como hipótese para correlação clínica.
- RESUMIDO (paciente): linguagem simples, acolhedora e não alarmista; sem números de alvo interno; sem jargão sem explicação; cada sistema em 1 a 3 frases; "pontos de atenção" diz que serão contextualizados na consulta; "mensagem_final" lembra que a interpretação depende da história clínica e da consulta.
- TÉCNICO (para outros médicos): objetivo e denso; cite exame, valor, unidade, referência e classificação; aponte padrões, limitações da leitura (confiança baixa, unidade não comparável, regra ambígua) e o que não foi avaliado.
- Se não houver classificações (tabela sem regras ativas), diga isso claramente nos dois.
Cada campo é texto corrido (sem markdown).`;

export async function writeReports(payload: unknown, caseId: number): Promise<Reports> {
  const anthropic = getClient();
  try {
    const response = await anthropic.messages.parse({
      model: AI_MODEL,
      max_tokens: 12000,
      system: [{ type: 'text', text: REPORTS_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Dados do caso (JSON):\n${JSON.stringify(payload, null, 1)}` }],
      output_config: { effort: 'high', format: zodOutputFormat(ReportsSchema) },
    });
    recordUsage(caseId, 'relatorios', response.usage.input_tokens, response.usage.output_tokens);
    if (response.stop_reason === 'refusal') throw new AiError('O modelo recusou redigir esta análise.');
    if (!response.parsed_output) throw new AiError('A resposta da IA não pôde ser interpretada.');
    return response.parsed_output;
  } catch (error) {
    throw translate(error);
  }
}

/* ---------------------------------------------------------- conduta */

export const ConductSchema = z.object({
  itens: z.array(
    z.object({
      tipo: z.enum(['suplementacao', 'estilo_de_vida', 'seguimento', 'exame', 'encaminhamento', 'medicamentoso', 'outro']),
      titulo: z.string(),
      justificativa: z.string(),
      exames: z.array(z.string()),
      fontes: z.array(z.string()),
    }),
  ),
  pesquisa_openevidence: z.string(),
});
export type Conduct = z.infer<typeof ConductSchema>;

const CONDUCT_SYSTEM = `Você é assistente de um médico nutrólogo. A partir de exames já classificados, do pré-questionário e da biblioteca de orientações do próprio médico, proponha uma lista de SUGESTÕES de conduta para ele revisar, aprovar, editar ou rejeitar. Nada do que você escrever chega ao paciente sem a aprovação explícita do médico.

Como trabalhar:
1. Primeiro use a ferramenta de busca na web para 2 a 5 consultas objetivas sobre os pontos críticos do caso (ex.: "vitamin D deficiency supplementation adults guideline", "hyperferritinemia evaluation"). Prefira diretrizes de sociedades, PubMed/PMC e revisões recentes. Registre em "pesquisa_openevidence" um resumo do que encontrou e do que não encontrou; em cada item, "fontes" lista as URLs usadas (vazio se nenhuma). O médico fará a consulta complementar no OpenEvidence por um botão do sistema; não tente acessar o OpenEvidence.
2. Baseie as sugestões em nutrologia e medicina baseada em evidências, priorizando a biblioteca do médico quando ela cobrir o achado (cite o código da orientação na justificativa).
3. Cada item: tipo (suplementacao, estilo_de_vida, seguimento, exame, encaminhamento, medicamentoso, outro), título curto, justificativa com o exame e o valor que a motiva, exames relacionados (ids canônicos), fontes. Para suplementação e medicamento, descreva a opção e a faixa usual citada pela fonte, deixando claro que dose e duração são decisão do médico. Para seguimento, proponha o intervalo de repetição (ex.: 3 ou 6 meses) com a razão.
4. Não repita a mesma sugestão para exames dentro do alvo. Não invente achados. Se os dados forem insuficientes, diga em "pesquisa_openevidence" e proponha apenas o que se sustenta.

Responda SOMENTE com um JSON válido no formato {"itens":[{"tipo","titulo","justificativa","exames":[],"fontes":[]}],"pesquisa_openevidence":""}, sem texto antes ou depois e sem cercas de código.`;

export async function suggestConduct(payload: unknown, caseId: number): Promise<{ conduct: Conduct; searches: number }> {
  const anthropic = getClient();
  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 10000,
      system: [{ type: 'text', text: CONDUCT_SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: `Dados do caso (JSON):\n${JSON.stringify(payload, null, 1)}` }],
      output_config: { effort: 'high' },
    });
    recordUsage(caseId, 'conduta', response.usage.input_tokens, response.usage.output_tokens);
    if (response.stop_reason === 'refusal') throw new AiError('O modelo recusou sugerir conduta para este caso.');
    const searches = response.content.filter((b) => b.type === 'server_tool_use' && b.name === 'web_search').length;
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
    const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = json.indexOf('{');
    const end = json.lastIndexOf('}');
    if (start < 0 || end < 0) throw new AiError('A IA não devolveu a lista de sugestões no formato esperado.');
    const parsed = ConductSchema.safeParse(JSON.parse(json.slice(start, end + 1)));
    if (!parsed.success) throw new AiError('A lista de sugestões veio incompleta; tente de novo.');
    return { conduct: parsed.data, searches };
  } catch (error) {
    throw translate(error);
  }
}

/* ------------------------------------------------- compat. e utilidades */

export const NarrativeSchema = ReportsSchema;
export type Narrative = Reports;
export const writeNarrative = writeReports;

function recordUsage(caseId: number, purpose: string, input: number, output: number): void {
  try {
    getDb().prepare('INSERT INTO ai_usage(case_id, purpose, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)').run(caseId, purpose, AI_MODEL, input, output);
  } catch {
    // registro de uso nunca derruba a operação
  }
}

function translate(error: unknown): Error {
  if (error instanceof AiError) return error;
  if (error instanceof SyntaxError) return new AiError('A IA devolveu um JSON inválido; tente de novo.');
  if (error instanceof Anthropic.AuthenticationError) return new AiError('Chave da Anthropic inválida.');
  if (error instanceof Anthropic.RateLimitError) return new AiError('Limite de uso da IA atingido; tente novamente em alguns minutos.');
  if (error instanceof Anthropic.BadRequestError) return new AiError(`Pedido rejeitado pela API da IA (${error.status}): ${error.message.slice(0, 160)}`);
  if (error instanceof Anthropic.APIConnectionError) return new AiError('Sem conexão com a API da IA.');
  if (error instanceof Anthropic.APIError) return new AiError(`Erro da API da IA (${error.status ?? 'sem status'}).`);
  return error instanceof Error ? error : new Error(String(error));
}

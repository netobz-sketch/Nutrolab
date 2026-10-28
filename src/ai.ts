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

const EXTRACTION_SYSTEM = `Você extrai resultados de exames laboratoriais de um PDF de laboratório brasileiro para revisão médica.

Regras invioláveis:
- Transcreva cada resultado EXATAMENTE como está no laudo: valor com vírgula decimal, sinal < ou >, unidade e intervalo de referência do laboratório. Nunca converta, arredonde, complete dígitos ou "corrija" o laudo.
- Um resultado por linha do laudo. Resultados repetidos em datas diferentes viram linhas separadas, cada uma com a sua data de coleta (AAAA-MM-DD).
- Preencha "exam_canonical" SOMENTE quando o nome do laudo corresponder sem dúvida a um id ou alias do catálogo fornecido. Em dúvida, deixe null. Nunca combine exames biologicamente distintos com nomes parecidos (25-OH vitamina D ≠ 1,25-di-hidroxivitamina D; ferro ≠ ferritina; T4 livre ≠ T4 total; BUN ≠ ureia).
- "lab_flag" é a sinalização do próprio laboratório (ex.: "↑", "alto", "*", "crítico"); null se não houver.
- "confidence": "alta" só quando o texto é nítido e inequívoco; "media" para leitura por OCR ou layout confuso; "baixa" quando houver qualquer dúvida de dígito, casa decimal, unidade ou de a qual exame o valor pertence.
- Registre em "warnings" páginas ilegíveis, tabelas cortadas, exames sem valor e qualquer ambiguidade.
- NUNCA inclua nome, CPF, RG, telefone, endereço, convênio ou qualquer identificador do paciente em nenhum campo. Não interprete, não classifique, não sugira conduta.`;

export async function extractFromPdf(pdf: Buffer, catalog: Array<{ exam: string; aliases: string[] }>, caseId: number): Promise<Extraction> {
  const anthropic = getClient();
  const catalogText = catalog.map((c) => `- ${c.exam}: ${c.aliases.join(' | ') || '(sem aliases)'}`).join('\n');
  try {
    const response = await anthropic.messages.parse({
      model: AI_MODEL,
      max_tokens: 16000,
      system: [{ type: 'text', text: EXTRACTION_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
            {
              type: 'text',
              text: `Catálogo de exames canônicos (id: aliases):\n${catalogText}\n\nExtraia todos os resultados de todas as páginas do PDF acima.`,
            },
          ],
        },
      ],
      output_config: { effort: 'high', format: zodOutputFormat(ExtractionSchema) },
    });
    recordUsage(caseId, 'extracao', response.usage.input_tokens, response.usage.output_tokens);
    if (response.stop_reason === 'refusal') throw new AiError('O modelo recusou processar este documento.');
    if (response.stop_reason === 'max_tokens') throw new AiError('Resposta truncada: PDF grande demais para uma extração; divida o arquivo.');
    if (!response.parsed_output) throw new AiError('A resposta da IA não pôde ser interpretada.');
    return response.parsed_output;
  } catch (error) {
    throw translate(error);
  }
}

export const NarrativeSchema = z.object({
  achados_factuais: z.string(),
  padroes_para_correlacao: z.string(),
  divergencias: z.string(),
  visao_geral_paciente: z.string(),
  pontos_favoraveis_paciente: z.string(),
  pontos_atencao_paciente: z.string(),
});
export type Narrative = z.infer<typeof NarrativeSchema>;

const NARRATIVE_SYSTEM = `Você redige, em português do Brasil, a parte textual de uma MINUTA de análise de exames que será revisada por um médico nutrólogo antes de qualquer uso.

Você recebe uma tabela já classificada por um motor de regras do próprio médico. Seu papel é descrever, não decidir:
- Use apenas os fatos da tabela. Não invente valores, faixas, alvos, diagnósticos ou causas.
- Nunca recomende iniciar, suspender ou ajustar medicamento, hormônio, suplemento ou dieta, nem sugira dose ou periodicidade de repetição.
- Na parte técnica (achados, padrões, divergências), seja objetivo e cite exame, valor e classificação. "Padrões" são hipóteses para correlação clínica, com linguagem de possibilidade.
- Na parte ao paciente, use linguagem simples, respeitosa, não alarmista; não exponha alvos numéricos internos; não transforme alteração isolada em diagnóstico; não adicione orientações (elas vêm de uma biblioteca aprovada, separada). Diga que os pontos de atenção serão contextualizados na consulta.
- Se a tabela estiver vazia ou sem classificações, diga isso em uma frase.
Cada campo é um ou mais parágrafos curtos em texto corrido (sem markdown).`;

export async function writeNarrative(payload: unknown, caseId: number): Promise<Narrative> {
  const anthropic = getClient();
  try {
    const response = await anthropic.messages.parse({
      model: AI_MODEL,
      max_tokens: 8000,
      system: [{ type: 'text', text: NARRATIVE_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Dados classificados (JSON):\n${JSON.stringify(payload, null, 1)}` }],
      output_config: { effort: 'medium', format: zodOutputFormat(NarrativeSchema) },
    });
    recordUsage(caseId, 'redacao', response.usage.input_tokens, response.usage.output_tokens);
    if (response.stop_reason === 'refusal') throw new AiError('O modelo recusou redigir esta análise.');
    if (!response.parsed_output) throw new AiError('A resposta da IA não pôde ser interpretada.');
    return response.parsed_output;
  } catch (error) {
    throw translate(error);
  }
}

function recordUsage(caseId: number, purpose: string, input: number, output: number): void {
  try {
    getDb().prepare('INSERT INTO ai_usage(case_id, purpose, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)').run(caseId, purpose, AI_MODEL, input, output);
  } catch {
    // registro de uso nunca derruba a operação
  }
}

function translate(error: unknown): Error {
  if (error instanceof AiError) return error;
  if (error instanceof Anthropic.AuthenticationError) return new AiError('Chave da Anthropic inválida.');
  if (error instanceof Anthropic.RateLimitError) return new AiError('Limite de uso da IA atingido; tente novamente em alguns minutos.');
  if (error instanceof Anthropic.BadRequestError) return new AiError(`Pedido rejeitado pela API da IA (${error.status}). Verifique o tamanho do PDF.`);
  if (error instanceof Anthropic.APIConnectionError) return new AiError('Sem conexão com a API da IA.');
  if (error instanceof Anthropic.APIError) return new AiError(`Erro da API da IA (${error.status ?? 'sem status'}).`);
  return error instanceof Error ? error : new Error(String(error));
}

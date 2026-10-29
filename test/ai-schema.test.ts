import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ExtractionSchema, NarrativeSchema } from '../src/ai.js';

test('schemas da IA geram JSON Schema para saída estruturada (exigem zod/v4)', () => {
  const extraction = zodOutputFormat(ExtractionSchema);
  assert.equal(extraction.type, 'json_schema');
  const schema = JSON.stringify(extraction.schema);
  assert.match(schema, /"results"/);
  assert.match(schema, /"confidence"/);
  const narrative = zodOutputFormat(NarrativeSchema);
  assert.match(JSON.stringify(narrative.schema), /"visao_geral_paciente"/);
});

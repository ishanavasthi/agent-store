import { OpenAIExtractionModel } from './openaiExtractionModel.js';
import { ExtractionError, type ExtractionModel } from './types.js';

/**
 * Which model does extraction — spec story 42's swap, and it is *configuration*.
 *
 * `EXTRACTION_MODEL` in the environment is the entire S3 step-up (PLAN §7):
 * every caller goes through `createExtractionModel()`, nothing else names a
 * model, and running gpt-5 instead of the default edits no source file at all
 * — `EXTRACTION_MODEL=gpt-5 npm run spike:extraction`. Unset means the default.
 *
 * Both this and `OPENAI_API_KEY` are read here rather than in `src/config.ts`
 * on purpose: the deployed storefront serves a catalog that ingestion already
 * produced and has no business failing to boot over knobs it never uses.
 * Ingestion is the only thing that needs them, so ingestion is where they live.
 */

/** The default. Cheaper and faster; the S3 spike exists to decide if it's enough. */
export const DEFAULT_EXTRACTION_MODEL = 'gpt-5-mini';

/** The configured model id, or the default when the variable is unset or blank. */
export function extractionModelId(): string {
  const configured = process.env['EXTRACTION_MODEL']?.trim() ?? '';
  return configured === '' ? DEFAULT_EXTRACTION_MODEL : configured;
}

export function createExtractionModel(): ExtractionModel {
  const apiKey = process.env['OPENAI_API_KEY']?.trim() ?? '';
  if (apiKey === '') {
    throw new ExtractionError(
      'Missing OPENAI_API_KEY. Ingestion calls the OpenAI Responses API directly; ' +
        'see .env.example.',
    );
  }
  return new OpenAIExtractionModel({ model: extractionModelId(), apiKey });
}

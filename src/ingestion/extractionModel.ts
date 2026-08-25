import { OpenAIExtractionModel } from './openaiExtractionModel.js';
import { ExtractionError, type ExtractionModel } from './types.js';

/**
 * Which model does extraction — the one line spec story 42 is about.
 *
 * Changing `EXTRACTION_MODEL` below is the entire S3 step-up (PLAN §7): every
 * caller goes through `createExtractionModel()`, nothing else names a model,
 * and no other file changes. `STEP_UP_EXTRACTION_MODEL` is kept beside it so
 * the swap is a one-token edit rather than a string someone has to remember.
 */

/** The default. Cheaper and faster; the S3 spike exists to decide if it's enough. */
export const DEFAULT_EXTRACTION_MODEL = 'gpt-5-mini';

/** The S3 step-up, used if gpt-5-mini misses the ~70% accuracy floor. */
export const STEP_UP_EXTRACTION_MODEL = 'gpt-5';

// ---- the one line ---------------------------------------------------------
export const EXTRACTION_MODEL: string = DEFAULT_EXTRACTION_MODEL;
// ---------------------------------------------------------------------------

/**
 * `OPENAI_API_KEY` is read here rather than in `src/config.ts` on purpose: the
 * deployed storefront serves a catalog that ingestion already produced and has
 * no business failing to boot over a key it never uses. Ingestion is the only
 * thing that needs it, so ingestion is where its absence is an error.
 */
export function createExtractionModel(
  model: string = EXTRACTION_MODEL,
  env: NodeJS.ProcessEnv = process.env,
): ExtractionModel {
  const apiKey = env['OPENAI_API_KEY']?.trim() ?? '';
  if (apiKey === '') {
    throw new ExtractionError(
      'Missing OPENAI_API_KEY. Ingestion calls the OpenAI Responses API directly; ' +
        'see .env.example.',
    );
  }
  return new OpenAIExtractionModel({ model, apiKey });
}

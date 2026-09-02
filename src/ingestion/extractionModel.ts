import { ChatCompletionsExtractionModel } from './extraction/chatCompletionsModel.js';
import {
  DEFAULT_OPENAI_MODEL,
  type ExtractionProviderConfig,
  readExtractionProviderConfig,
} from './extraction/config.js';
import { OpenAIExtractionModel } from './extraction/openaiResponsesModel.js';
import type { ExtractionModel } from './types.js';

/**
 * Which model does extraction — spec story 42's swap, and it is *configuration*.
 *
 * `EXTRACTION_PROVIDER` and `EXTRACTION_MODEL` in the environment are the whole
 * swap: every caller goes through `createExtractionModel()`, nothing else names
 * a provider or a model, and running GLM on OpenRouter instead of gpt-5-mini on
 * OpenAI edits no source file at all. The variables and their defaults live in
 * `extraction/config.ts`; this module only chooses the adapter that speaks the
 * chosen provider's wire format.
 *
 * These are read here rather than in `src/config.ts` on purpose: the deployed
 * storefront serves a catalog that ingestion already produced and has no
 * business failing to boot over knobs it never uses. Ingestion is the only
 * thing that needs them, so ingestion is where they live.
 */

/** The default, and the OpenAI path's alone. Cheaper and faster; S3 measured it. */
export const DEFAULT_EXTRACTION_MODEL = DEFAULT_OPENAI_MODEL;

/** The configured model id, or the default when the variable is unset or blank. */
export function extractionModelId(): string {
  const configured = process.env['EXTRACTION_MODEL']?.trim() ?? '';
  return configured === '' ? DEFAULT_EXTRACTION_MODEL : configured;
}

export function createExtractionModel(): ExtractionModel {
  return createExtractionModelFromConfig(readExtractionProviderConfig());
}

/**
 * The adapter for a resolved configuration. Split from the environment read so
 * a test states a provider by building the record, not by mutating `process.env`.
 */
export function createExtractionModelFromConfig(config: ExtractionProviderConfig): ExtractionModel {
  switch (config.provider) {
    case 'openai':
      // The Responses API, with Structured Outputs enforced provider-side. Its
      // request bytes are pinned by the golden fixture: with only
      // `OPENAI_API_KEY` set this is exactly the call the project always made.
      return new OpenAIExtractionModel({
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });
    case 'openrouter':
      return new ChatCompletionsExtractionModel({ config });
  }
}

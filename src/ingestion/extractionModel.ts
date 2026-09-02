import { ChatCompletionsExtractionModel } from './extraction/chatCompletionsModel.js';
import {
  DEFAULT_OPENAI_MODEL,
  type ExtractionProviderConfig,
  readExtractionProviderConfig,
} from './extraction/config.js';
import { OpenAIExtractionModel } from './extraction/openaiResponsesModel.js';
import { ExtractionError, type ExtractionModel } from './types.js';

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

/**
 * The model, or `null` when this deployment has not configured extraction (S1.3).
 *
 * The storefront must boot without an LLM key — it serves a catalog that
 * ingestion already produced, and refusing to start over a knob it never uses
 * would take the demo down for a reason that has nothing to do with the demo.
 * So `src/index.ts` calls this, logs which way it went, and
 * `submit_catalog_item` is the only surface that notices, answering
 * `EXTRACTION_NOT_CONFIGURED` rather than throwing at boot.
 *
 * "Configured" is whatever `readExtractionProviderConfig` says it is, asked by
 * running it — a missing key, and equally an OpenRouter provider with no
 * `EXTRACTION_MODEL`, are both "not configured". Reading the variables again
 * here would be a second, drifting answer to a question S2.2's config layer
 * already owns. Only that configuration error is swallowed; anything else the
 * adapters throw is a real fault and still reaches the composition root.
 */
export function createExtractionModelIfConfigured(): ExtractionModel | null {
  try {
    return createExtractionModel();
  } catch (error) {
    if (error instanceof ExtractionError) return null;
    throw error;
  }
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

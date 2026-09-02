/**
 * Re-export shim. The adapter moved to `extraction/openaiResponsesModel.ts`
 * when the OpenAI-specific request building was split from the prompt, the
 * payload schema and the domain coercions it shares with every other provider
 * (plan §5, S2.1). Importers and scripts keep this path; nothing observable
 * changed, and the golden request fixture is the evidence.
 */
export {
  OpenAIExtractionModel,
  type OpenAIExtractionModelOptions,
} from './extraction/openaiResponsesModel.js';

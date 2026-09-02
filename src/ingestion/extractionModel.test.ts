import { describe, expect, it } from 'vitest';
import { ChatCompletionsExtractionModel } from './extraction/chatCompletionsModel.js';
import { readExtractionProviderConfig } from './extraction/config.js';
import { OpenAIExtractionModel } from './extraction/openaiResponsesModel.js';
import { DEFAULT_EXTRACTION_MODEL, createExtractionModelFromConfig } from './extractionModel.js';

/** The factory is a switch and a promise: the default has not moved. */
describe('createExtractionModelFromConfig', () => {
  it('keeps gpt-5-mini as the default, which the committed run was scored on', () => {
    expect(DEFAULT_EXTRACTION_MODEL).toBe('gpt-5-mini');
  });

  it('builds the Responses adapter for openai', () => {
    const model = createExtractionModelFromConfig(
      readExtractionProviderConfig({ OPENAI_API_KEY: 'sk-test' }),
    );
    expect(model).toBeInstanceOf(OpenAIExtractionModel);
    expect(model.modelId).toBe('gpt-5-mini');
  });

  it('builds the Chat Completions adapter for openrouter', () => {
    const model = createExtractionModelFromConfig(
      readExtractionProviderConfig({
        EXTRACTION_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'or-key',
        EXTRACTION_MODEL: 'z-ai/glm-5.3-flash',
      }),
    );
    expect(model).toBeInstanceOf(ChatCompletionsExtractionModel);
    expect(model.modelId).toBe('z-ai/glm-5.3-flash');
  });
});

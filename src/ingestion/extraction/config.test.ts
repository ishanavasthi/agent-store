import { describe, expect, it } from 'vitest';
import { ExtractionError } from '../types.js';
import { readExtractionProviderConfig } from './config.js';

/**
 * The environment read, stated as a function of a plain record rather than of
 * `process.env` — so these cases are exhaustive and none of them can leak into
 * another test file.
 *
 * The first case is the regression guarantee (plan §5): a machine that only
 * ever had `OPENAI_API_KEY` resolves to today's call, unchanged.
 */

describe('with only OPENAI_API_KEY set', () => {
  const config = readExtractionProviderConfig({ OPENAI_API_KEY: 'sk-test' });

  it('is the OpenAI Responses call the project has always made', () => {
    expect(config).toEqual({
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5-mini',
      outputMode: 'json_schema',
      vision: true,
      timeoutMs: 60_000,
      extraHeaders: {},
    });
  });
});

describe('the provider', () => {
  it('defaults to openai and rejects anything it cannot speak', () => {
    expect(readExtractionProviderConfig({ OPENAI_API_KEY: 'k' }).provider).toBe('openai');
    expect(() =>
      readExtractionProviderConfig({
        EXTRACTION_PROVIDER: 'anthropic',
        EXTRACTION_API_KEY: 'k',
      }),
    ).toThrow(/EXTRACTION_PROVIDER must be `openai` or `openrouter`/);
  });

  it('gives openrouter its own base URL and tool_call default', () => {
    const config = readExtractionProviderConfig({
      EXTRACTION_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'or-key',
      EXTRACTION_MODEL: 'z-ai/glm-5.3-flash',
    });
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(config.outputMode).toBe('tool_call');
    expect(config.apiKey).toBe('or-key');
  });
});

describe('the API key', () => {
  it('prefers EXTRACTION_API_KEY over the provider-specific variable', () => {
    const config = readExtractionProviderConfig({
      EXTRACTION_API_KEY: 'shared',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(config.apiKey).toBe('shared');
  });

  it('names the variable the operator is missing', () => {
    expect(() => readExtractionProviderConfig({})).toThrow(/EXTRACTION_API_KEY or OPENAI_API_KEY/);
    expect(() => readExtractionProviderConfig({ EXTRACTION_PROVIDER: 'openrouter' })).toThrow(
      /EXTRACTION_API_KEY or OPENROUTER_API_KEY/,
    );
  });

  it('treats a blank variable as unset', () => {
    expect(() => readExtractionProviderConfig({ OPENAI_API_KEY: '  ' })).toThrow(ExtractionError);
  });
});

describe('the model', () => {
  it('defaults to gpt-5-mini for openai only', () => {
    expect(readExtractionProviderConfig({ OPENAI_API_KEY: 'k' }).model).toBe('gpt-5-mini');
  });

  it('makes openrouter name its model, since a wrong guess spends money', () => {
    expect(() =>
      readExtractionProviderConfig({
        EXTRACTION_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'k',
      }),
    ).toThrow(/EXTRACTION_MODEL is required when EXTRACTION_PROVIDER=openrouter/);
  });
});

describe('the remaining knobs', () => {
  it('honours output mode, vision, timeout and a custom base URL', () => {
    const config = readExtractionProviderConfig({
      EXTRACTION_PROVIDER: 'openrouter',
      EXTRACTION_API_KEY: 'k',
      EXTRACTION_MODEL: 'minimax/minimax-m3:free',
      EXTRACTION_OUTPUT_MODE: 'json_schema',
      EXTRACTION_VISION: 'false',
      EXTRACTION_TIMEOUT_MS: '15000',
      EXTRACTION_BASE_URL: 'https://gateway.example/v1/',
    });
    expect(config.outputMode).toBe('json_schema');
    expect(config.vision).toBe(false);
    expect(config.timeoutMs).toBe(15_000);
    // The trailing slash is stripped: adapters append their own path.
    expect(config.baseUrl).toBe('https://gateway.example/v1');
  });

  it('rejects a mode, a vision flag or a timeout it cannot act on', () => {
    const base = { OPENAI_API_KEY: 'k' };
    expect(() =>
      readExtractionProviderConfig({
        ...base,
        EXTRACTION_OUTPUT_MODE: 'strict',
      }),
    ).toThrow(/EXTRACTION_OUTPUT_MODE must be/);
    expect(() => readExtractionProviderConfig({ ...base, EXTRACTION_VISION: 'maybe' })).toThrow(
      /EXTRACTION_VISION must be/,
    );
    expect(() => readExtractionProviderConfig({ ...base, EXTRACTION_TIMEOUT_MS: '0' })).toThrow(
      /EXTRACTION_TIMEOUT_MS must be a positive integer/,
    );
  });

  it('carries OpenRouter attribution headers, and only for openrouter', () => {
    const attributed = readExtractionProviderConfig({
      EXTRACTION_PROVIDER: 'openrouter',
      EXTRACTION_API_KEY: 'k',
      EXTRACTION_MODEL: 'z-ai/glm-5.3-flash',
      OPENROUTER_SITE_URL: 'https://agent-store.example',
      OPENROUTER_APP_NAME: 'agent-store',
    });
    expect(attributed.extraHeaders).toEqual({
      'HTTP-Referer': 'https://agent-store.example',
      'X-Title': 'agent-store',
    });

    const openai = readExtractionProviderConfig({
      OPENAI_API_KEY: 'k',
      OPENROUTER_SITE_URL: 'https://agent-store.example',
    });
    expect(openai.extraHeaders).toEqual({});
  });
});

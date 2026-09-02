import { ExtractionError } from '../types.js';

/**
 * The extraction provider is *configuration*, not code (plan §5, S2.2).
 *
 * One flat record read from the environment answers every question the two
 * adapters ask: who to call, with which key, at which URL, for which model, in
 * which output mode, with or without the photo, and how long to wait. Nothing
 * below this module reads `process.env`, so a test states a provider by
 * building the record rather than by mutating the environment.
 *
 * The regression guarantee lives here: with only `OPENAI_API_KEY` set and
 * nothing else, this resolves to exactly the OpenAI Responses call the project
 * has been making all along, byte for byte
 * (`fixtures/extraction/openai-responses-request.golden.json`).
 */

export type ExtractionProvider = 'openai' | 'openrouter';

/**
 * How the provider is asked for JSON.
 *
 * `json_schema` is `response_format`; `tool_call` is a forced call to a
 * one-function tool whose parameters *are* the schema. OpenRouter accepts
 * `response_format` but does not enforce it (plan §1), and a forced tool call
 * is the closest thing to strict mode that survives the round trip — which is
 * why this is a knob and not a constant.
 */
export type ExtractionOutputMode = 'json_schema' | 'tool_call';

export interface ExtractionProviderConfig {
  readonly provider: ExtractionProvider;
  readonly apiKey: string;
  /** No trailing slash. The adapter appends its own path. */
  readonly baseUrl: string;
  readonly model: string;
  readonly outputMode: ExtractionOutputMode;
  /** False makes an image a loud error, never a silent drop. */
  readonly vision: boolean;
  readonly timeoutMs: number;
  /** Provider-specific extras, e.g. OpenRouter's `HTTP-Referer` / `X-Title`. */
  readonly extraHeaders: Readonly<Record<string, string>>;
}

/** The OpenAI default, and the only provider that gets to have one. */
export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';

const DEFAULT_BASE_URL: Readonly<Record<ExtractionProvider, string>> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/** OpenRouter does not enforce `response_format`, so it gets the tool call. */
const DEFAULT_OUTPUT_MODE: Readonly<Record<ExtractionProvider, ExtractionOutputMode>> = {
  openai: 'json_schema',
  openrouter: 'tool_call',
};

const DEFAULT_TIMEOUT_MS = 60_000;

export type Env = Readonly<Record<string, string | undefined>>;

export function readExtractionProviderConfig(env: Env = process.env): ExtractionProviderConfig {
  const provider = readProvider(env);
  return {
    provider,
    apiKey: readApiKey(env, provider),
    baseUrl: (read(env, 'EXTRACTION_BASE_URL') ?? DEFAULT_BASE_URL[provider]).replace(/\/+$/, ''),
    model: readModel(env, provider),
    outputMode: readOutputMode(env, provider),
    vision: readVision(env),
    timeoutMs: readTimeoutMs(env),
    extraHeaders: readExtraHeaders(env, provider),
  };
}

/** Blank is unset: an empty variable in a `.env` file means "I did not set it". */
function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim() ?? '';
  return value === '' ? undefined : value;
}

function readProvider(env: Env): ExtractionProvider {
  const configured = read(env, 'EXTRACTION_PROVIDER') ?? 'openai';
  if (configured !== 'openai' && configured !== 'openrouter') {
    throw new ExtractionError(
      `EXTRACTION_PROVIDER must be \`openai\` or \`openrouter\`, not \`${configured}\`.`,
    );
  }
  return configured;
}

/**
 * `EXTRACTION_API_KEY` wins; otherwise the provider's own conventional
 * variable, so a machine that only ever had `OPENAI_API_KEY` keeps working.
 */
function readApiKey(env: Env, provider: ExtractionProvider): string {
  const fallbackName = provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY';
  const apiKey = read(env, 'EXTRACTION_API_KEY') ?? read(env, fallbackName);
  if (apiKey === undefined) {
    throw new ExtractionError(
      `Missing extraction API key: set EXTRACTION_API_KEY or ${fallbackName}. ` +
        'Ingestion calls the provider directly; see .env.example.',
    );
  }
  return apiKey;
}

/**
 * Only OpenAI has a default. OpenRouter model ids are namespaced and priced
 * individually — guessing one would silently spend money on the wrong model.
 */
function readModel(env: Env, provider: ExtractionProvider): string {
  const configured = read(env, 'EXTRACTION_MODEL');
  if (configured !== undefined) return configured;
  if (provider === 'openai') return DEFAULT_OPENAI_MODEL;
  throw new ExtractionError(
    'EXTRACTION_MODEL is required when EXTRACTION_PROVIDER=openrouter ' +
      '(e.g. `z-ai/glm-5.3-flash`); there is no default model for OpenRouter.',
  );
}

function readOutputMode(env: Env, provider: ExtractionProvider): ExtractionOutputMode {
  const configured = read(env, 'EXTRACTION_OUTPUT_MODE') ?? DEFAULT_OUTPUT_MODE[provider];
  if (configured !== 'json_schema' && configured !== 'tool_call') {
    throw new ExtractionError(
      `EXTRACTION_OUTPUT_MODE must be \`json_schema\` or \`tool_call\`, not \`${configured}\`.`,
    );
  }
  return configured;
}

function readVision(env: Env): boolean {
  const configured = read(env, 'EXTRACTION_VISION');
  if (configured === undefined) return true;
  const normalised = configured.toLowerCase();
  if (normalised === 'true' || normalised === '1') return true;
  if (normalised === 'false' || normalised === '0') return false;
  throw new ExtractionError(
    `EXTRACTION_VISION must be \`true\` or \`false\`, not \`${configured}\`.`,
  );
}

function readTimeoutMs(env: Env): number {
  const configured = read(env, 'EXTRACTION_TIMEOUT_MS');
  if (configured === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ExtractionError(
      `EXTRACTION_TIMEOUT_MS must be a positive integer number of milliseconds, ` +
        `not \`${configured}\`.`,
    );
  }
  return parsed;
}

/** OpenRouter attributes traffic by these two headers; both are optional. */
function readExtraHeaders(env: Env, provider: ExtractionProvider): Record<string, string> {
  if (provider !== 'openrouter') return {};
  const headers: Record<string, string> = {};
  const siteUrl = read(env, 'OPENROUTER_SITE_URL');
  if (siteUrl !== undefined) headers['HTTP-Referer'] = siteUrl;
  const appName = read(env, 'OPENROUTER_APP_NAME');
  if (appName !== undefined) headers['X-Title'] = appName;
  return headers;
}

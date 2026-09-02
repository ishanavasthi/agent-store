import { Refusal, ValidationError } from '../domain/refusal.js';

/**
 * How a tool handler's outcome becomes an MCP result — shared by both faces
 * (S1.2). Moved out of `server.ts` verbatim when the merchant face arrived:
 * the buyer face's wire bytes are unchanged, and a second face inheriting the
 * mapping is the only way the two can never drift into different dialects of
 * "no".
 */

export function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Failures reach the buyer agent as `isError` results carrying a structured
 * body, never as prose. The two categories stay visibly distinct on the wire —
 * a Refusal has `recoverable`, a validation error does not — so an LLM buyer
 * can branch on which kind of "no" it received (CONTEXT.md → Failure vocabulary).
 */
export function refusalResult(refusal: Refusal) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: JSON.stringify({ refusal: refusal.toPayload() }, null, 2) },
    ],
  };
}

export function validationResult(error: ValidationError) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ validationError: error.toPayload() }, null, 2),
      },
    ],
  };
}

/**
 * The third kind of "no": neither policy nor malformed input, but the server
 * failing to do a thing it was willing to do — S1.3's unconfigured or
 * unreachable extraction model. Kept a distinct wire shape (`error`) so it
 * cannot be mistaken for a Refusal the caller could recover from by changing
 * its request, nor for a validation error about its arguments.
 */
export function errorResult(code: string, message: string) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: JSON.stringify({ error: { code, message } }, null, 2) },
    ],
  };
}

/**
 * The one place domain errors become wire results. Every tool that can refuse
 * or reject wraps its handler here, so a new tool (T4's next one included)
 * inherits the mapping instead of copying the catch.
 */
export function withToolErrors<Args extends unknown[], Result>(
  handler: (...args: Args) => Promise<Result>,
) {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof Refusal) return refusalResult(error);
      if (error instanceof ValidationError) return validationResult(error);
      throw error;
    }
  };
}

/**
 * In-band markers of `chatStream()`: besides text deltas the generator yields metadata as strings with a reserved
 * prefix, so every LLM provider keeps the plain `AsyncGenerator<string>` shape.
 *
 * - `__usage__:{json}` — token usage of the answer (OpenAI `stream_options.include_usage`).
 * - `__finish__:<reason>` — the upstream `finish_reason` (`stop`, `length`, `content_filter`…). The proxy forwards it
 *   in the final SSE chunk: a `length` reported as `stop` hides a cut answer from the client (fault bench 2026-10-06,
 *   item 4).
 *
 * A consumer that only wants text skips every marker with `isStreamMarker`.
 */
export const USAGE_MARKER = '__usage__:';
export const FINISH_MARKER = '__finish__:';

export function isStreamMarker(token: unknown): boolean {
  return typeof token === 'string' && (token.startsWith(USAGE_MARKER) || token.startsWith(FINISH_MARKER));
}

/** The finish reason carried by a `__finish__:` marker, or null for any other token. */
export function finishReasonOf(token: unknown): string | null {
  return typeof token === 'string' && token.startsWith(FINISH_MARKER) ? token.slice(FINISH_MARKER.length) || null : null;
}

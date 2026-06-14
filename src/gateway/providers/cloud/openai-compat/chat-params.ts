/**
 * Maps the output-affecting fields of a ChatRequest into the OpenAI
 * chat.completions wire format (snake_case).
 *
 * These fields (tools, tool_choice, top_p, seed, n, stop, penalties) used to
 * be parsed by the proxy and then silently dropped because ChatRequest did not
 * carry them. Centralising the mapping here lets every OpenAI-compatible
 * provider (openai-compat, self-hosted, ollama) forward them consistently and
 * keeps the translation unit-testable without a live client.
 *
 * Only defined fields are emitted, so the result can be spread directly into a
 * `chat.completions.create` payload without overriding unset values.
 */

import type { ChatRequest } from '../types';

export function buildSamplingParams(request: ChatRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (request.tools !== undefined) out.tools = request.tools;
  if (request.toolChoice !== undefined) out.tool_choice = request.toolChoice;
  if (request.topP !== undefined) out.top_p = request.topP;
  if (request.seed !== undefined) out.seed = request.seed;
  if (request.n !== undefined) out.n = request.n;
  if (request.stop !== undefined) out.stop = request.stop;
  if (request.frequencyPenalty !== undefined) out.frequency_penalty = request.frequencyPenalty;
  if (request.presencePenalty !== undefined) out.presence_penalty = request.presencePenalty;
  return out;
}

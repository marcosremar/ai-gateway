import type { ChatMessage } from './composite';

export const DEFAULT_SLOT_CTX = 2048;
const CONTEXT_MARGIN = 64;
const BYTES_PER_TOKEN = 3;
const MESSAGE_TOKENS = 8;
const DROP_PAIRS = 8;
const MIN_TURN_TOKENS = 64;
export const DEFAULT_MAX_TOKENS = 160;

export function estimateTokens(text?: string | null): number {
  return text ? MESSAGE_TOKENS + Math.ceil(Buffer.byteLength(String(text)) / BYTES_PER_TOKEN) : 0;
}

const sum = (messages: ChatMessage[]): number => messages.reduce((total, m) => total + estimateTokens(m.content), 0);

export function fitHistory(system: string | undefined, history: ChatMessage[], user: string, maxTokens: number, ctx: number, harder = false): ChatMessage[] {
  const pairs: ChatMessage[][] = [];
  for (const message of history) {
    if (message.role === 'system') continue;
    if (message.role === 'user' || !pairs.length) pairs.push([]);
    pairs[pairs.length - 1].push(message);
  }
  const pinned = sum(history.filter(m => m.role === 'system'));
  const room = Math.floor((ctx - maxTokens - CONTEXT_MARGIN - estimateTokens(system) - estimateTokens(user) - pinned) / (harder ? 2 : 1));
  let drop = 0;
  while (drop < pairs.length && sum(pairs.slice(drop).flat()) > room) drop += DROP_PAIRS;
  const kept = new Set(pairs.slice(drop).flat());
  return history.filter(m => m.role === 'system' || kept.has(m));
}

export function promptOverflow(
  config: { system?: unknown; messages?: unknown; user_template?: unknown; max_tokens?: unknown }, ctx: number,
): string | null {
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const pinned = Array.isArray(config.messages)
    ? sum((config.messages as ChatMessage[]).filter(m => m?.role === 'system' && typeof m.content === 'string')) : 0;
  const maxTokens = typeof config.max_tokens === 'number' && config.max_tokens > 0 ? config.max_tokens : DEFAULT_MAX_TOKENS;
  const before = maxTokens + CONTEXT_MARGIN + estimateTokens(text(config.system)) + pinned + estimateTokens(text(config.user_template));
  if (before + MIN_TURN_TOKENS <= ctx) return null;
  return `the session config takes about ${before} tokens before the learner speaks (system prompt, pinned messages, user_template, `
    + `max_tokens ${maxTokens}), leaving under ${MIN_TURN_TOKENS} of the LLM's ${ctx}-token context per session: every turn would fail; `
    + 'shorten the system prompt or lower max_tokens';
}

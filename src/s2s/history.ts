import type { ChatMessage } from './composite';

export const DEFAULT_SLOT_CTX = 2048;
const CONTEXT_MARGIN = 64;
const BYTES_PER_TOKEN = 3;
const MESSAGE_TOKENS = 8;
const DROP_PAIRS = 8;

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

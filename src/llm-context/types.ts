/**
 * Universal LLM context types.
 *
 * Provider-neutral message format. Per-provider adapters in ./adapters/
 * convert to/from this shape.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; url: string; mimeType?: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: 'tool_result'; toolUseId: string; content: string };

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export type Message = {
  role: Role;
  content: string | ContentBlock[];
  name?: string;
};

export type AggregationType = 'sentence' | 'token' | 'word' | string;

export type Aggregation = {
  text: string;
  type: AggregationType;
};

export type PatternMatch = Aggregation & {
  fullMatch: string;
};

export const SENTENCE_ENDING: ReadonlySet<string> = new Set([
  '.', '!', '?', ';', '…',
  '。', '？', '！', '；', '．', '｡',
  '।', '॥', '؟', '؛', '۔',
  '။', '។', '៕', '།',
  '։', '՜', '՞', '።', '፧',
]);

export function messageText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : ''))
    .join('');
}

/**
 * Parse a base64 data URL into { mediaType, data }. Returns null for any URL
 * that isn't a valid `data:<mime>;base64,<payload>` form (callers should
 * fall back to URL transport instead of generating empty base64).
 */
export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  if (!url.startsWith('data:')) return null;
  const commaIdx = url.indexOf(',');
  if (commaIdx < 0) return null;
  const header = url.slice(5, commaIdx); // strip "data:"
  const data = url.slice(commaIdx + 1);
  if (!data) return null;
  // Header is "<mime>;base64" or "<mime>" or ";base64"
  const isBase64 = /;base64$/i.test(header);
  if (!isBase64) return null;
  const mediaType = header.replace(/;base64$/i, '') || 'application/octet-stream';
  return { mediaType, data };
}

/**
 * Validate that a tool-role message carries a tool_result block (provider
 * adapters can't construct valid wire format from a plain string).
 */
export function assertToolMessageValid(msg: Message): void {
  if (msg.role !== 'tool') return;
  if (typeof msg.content === 'string') {
    throw new TypeError(
      `tool message must use ContentBlock array with tool_result block (got string). ` +
      `Use { role: 'tool', content: [{ type: 'tool_result', toolUseId, content }] }.`,
    );
  }
  const hasToolResult = msg.content.some((b) => b.type === 'tool_result');
  if (!hasToolResult) {
    throw new TypeError(`tool message must include at least one tool_result block`);
  }
}

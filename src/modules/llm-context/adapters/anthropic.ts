/**
 * Anthropic message format adapter.
 *
 * Wire format: { system: string, messages: [{ role, content }, ...] }
 * - system message → top-level `system` param (NOT in messages array)
 * - content can be string OR array of {type: text|image|tool_use|tool_result, ...}
 * - role only "user" or "assistant" allowed in messages
 */

import { type Message, type ContentBlock, assertToolMessageValid, parseDataUrl } from '../types';

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'url' | 'base64'; url?: string; media_type?: string; data?: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

export type AnthropicInvocationParams = {
  system: string | undefined;
  messages: AnthropicMessage[];
};

export function toAnthropic(messages: Message[]): AnthropicInvocationParams {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(typeof msg.content === 'string' ? msg.content : extractText(msg.content));
      continue;
    }

    if (msg.role === 'tool') {
      assertToolMessageValid(msg);
      // Anthropic models tool results as user messages with tool_result blocks
      const blocks: AnthropicContentBlock[] = [];
      const content = msg.content as ContentBlock[]; // validated above
      for (const b of content) {
        if (b.type === 'tool_result') {
          blocks.push({ type: 'tool_result', tool_use_id: b.toolUseId, content: b.content });
        } else if (b.type === 'text') {
          blocks.push({ type: 'text', text: b.text });
        }
      }
      out.push({ role: 'user', content: blocks });
      continue;
    }

    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user';
    if (typeof msg.content === 'string') {
      out.push({ role, content: msg.content });
    } else {
      out.push({ role, content: msg.content.map(blockToAnthropic) });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: mergeConsecutiveRoles(out),
  };
}

function mergeConsecutiveRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length < 2) return messages;
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role) {
      const prevBlocks: AnthropicContentBlock[] = typeof prev.content === 'string'
        ? [{ type: 'text', text: prev.content }]
        : prev.content;
      const nextBlocks: AnthropicContentBlock[] = typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : msg.content;
      prev.content = [...prevBlocks, ...nextBlocks];
    } else {
      out.push({ ...msg });
    }
  }
  return out;
}

function blockToAnthropic(b: ContentBlock): AnthropicContentBlock {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'image': {
      const parsed = parseDataUrl(b.url);
      if (parsed) {
        return {
          type: 'image',
          source: { type: 'base64', media_type: b.mimeType ?? parsed.mediaType, data: parsed.data },
        };
      }
      // Non-data URL or malformed data URL — pass as URL reference.
      return { type: 'image', source: { type: 'url', url: b.url } };
    }
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content };
  }
}

function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function fromAnthropic(params: AnthropicInvocationParams): Message[] {
  const result: Message[] = [];
  if (params.system) {
    result.push({ role: 'system', content: params.system });
  }
  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      result.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks: ContentBlock[] = m.content.map((b) => {
      switch (b.type) {
        case 'text':
          return { type: 'text', text: b.text };
        case 'image':
          return {
            type: 'image',
            url: b.source.type === 'url' ? (b.source.url ?? '') : `data:${b.source.media_type};base64,${b.source.data}`,
            mimeType: b.source.media_type,
          };
        case 'tool_use':
          return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        case 'tool_result':
          return { type: 'tool_result', toolUseId: b.tool_use_id, content: b.content };
      }
    });
    // Anthropic encodes tool results as user role with tool_result blocks.
    // Restore canonical 'tool' role on the way back.
    const isToolResult = m.role === 'user' && blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
    result.push({ role: isToolResult ? 'tool' : m.role, content: blocks });
  }
  return result;
}

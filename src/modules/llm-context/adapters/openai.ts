/**
 * OpenAI message format adapter.
 *
 * Wire format: { messages: [{ role, content }, ...] }
 * Content can be string OR array of {type: text|image_url, ...}
 * System messages stay in messages array.
 */

import { type Message, type ContentBlock, assertToolMessageValid } from '../types';

export type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type OpenAIInvocationParams = {
  messages: OpenAIMessage[];
};

export function toOpenAI(messages: Message[]): OpenAIInvocationParams {
  return { messages: messages.map(messageToOpenAI) };
}

function messageToOpenAI(msg: Message): OpenAIMessage {
  if (msg.role === 'tool') assertToolMessageValid(msg);
  if (typeof msg.content === 'string') {
    const out: OpenAIMessage = { role: msg.role, content: msg.content };
    if (msg.name) out.name = msg.name;
    return out;
  }

  const parts: OpenAIContentPart[] = [];
  const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = [];
  let toolUseId: string | undefined;
  const toolResultParts: string[] = [];

  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      parts.push({ type: 'image_url', image_url: { url: block.url } });
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    } else if (block.type === 'tool_result') {
      toolUseId = block.toolUseId;
      toolResultParts.push(block.content);
    }
  }

  if (msg.role === 'tool' || toolUseId) {
    return {
      role: 'tool',
      content: toolResultParts.join(''),
      tool_call_id: toolUseId ?? '',
    };
  }

  const result: OpenAIMessage = {
    role: msg.role,
    content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
  };
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  if (msg.name) result.name = msg.name;
  return result;
}

export function fromOpenAI(messages: OpenAIMessage[]): Message[] {
  return messages.map((m): Message => {
    // Tool result message: OpenAI uses role:'tool' + tool_call_id + string content.
    if (m.role === 'tool') {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('');
      return {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: m.tool_call_id ?? '', content }],
      };
    }

    const blocks: ContentBlock[] = [];
    if (typeof m.content === 'string') {
      if (m.content) blocks.push({ type: 'text', text: m.content });
    } else {
      for (const p of m.content) {
        if (p.type === 'text') blocks.push({ type: 'text', text: p.text });
        else blocks.push({ type: 'image', url: p.image_url.url });
      }
    }

    // Assistant tool_calls become tool_use blocks alongside text.
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(tc.function.arguments);
          if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
        } catch {
          // Leave input empty if arguments JSON is malformed — caller can decide.
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
    }

    if (blocks.length === 0) return { role: m.role, content: '', ...(m.name ? { name: m.name } : {}) };
    if (blocks.length === 1 && blocks[0].type === 'text') {
      return { role: m.role, content: blocks[0].text, ...(m.name ? { name: m.name } : {}) };
    }
    return { role: m.role, content: blocks, ...(m.name ? { name: m.name } : {}) };
  });
}

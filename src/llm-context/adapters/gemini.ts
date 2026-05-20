/**
 * Google Gemini message format adapter.
 *
 * Wire format: { systemInstruction?: { parts: [...] }, contents: [{ role, parts }, ...] }
 * - system message → top-level systemInstruction
 * - role: "user" | "model" (assistant is "model")
 * - "tool" role becomes role: "user" with functionResponse parts
 * - parts: text | inlineData (base64) | fileData (uri) | functionCall | functionResponse
 */

import { type Message, type ContentBlock, assertToolMessageValid, parseDataUrl } from '../types';

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType?: string; fileUri: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export type GeminiContent = {
  role: 'user' | 'model';
  parts: GeminiPart[];
};

export type GeminiInvocationParams = {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
};

export function toGemini(messages: Message[]): GeminiInvocationParams {
  const systemParts: GeminiPart[] = [];
  const contents: GeminiContent[] = [];

  // Build call_id → function_name lookup so tool_result blocks can populate
  // Gemini's functionResponse.name correctly (Gemini wants the function name,
  // not the opaque call id).
  const idToFnName = new Map<string, string>();
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const b of msg.content) {
      if (b.type === 'tool_use') idToFnName.set(b.id, b.name);
    }
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
      systemParts.push({ text });
      continue;
    }
    if (msg.role === 'tool') assertToolMessageValid(msg);

    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

    if (typeof msg.content === 'string') {
      contents.push({ role, parts: [{ text: msg.content }] });
      continue;
    }

    const parts = msg.content
      .map((b) => blockToGemini(b, idToFnName))
      .filter((p): p is GeminiPart => p !== null);
    contents.push({ role, parts });
  }

  return {
    systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined,
    contents: mergeConsecutiveRoles(contents),
  };
}

function mergeConsecutiveRoles(contents: GeminiContent[]): GeminiContent[] {
  if (contents.length < 2) return contents;
  const out: GeminiContent[] = [];
  for (const c of contents) {
    const prev = out[out.length - 1];
    if (prev && prev.role === c.role) {
      prev.parts = [...prev.parts, ...c.parts];
    } else {
      out.push({ ...c, parts: [...c.parts] });
    }
  }
  return out;
}

function blockToGemini(b: ContentBlock, idToFnName: Map<string, string>): GeminiPart | null {
  switch (b.type) {
    case 'text':
      return { text: b.text };
    case 'image': {
      const parsed = parseDataUrl(b.url);
      if (parsed) {
        return { inlineData: { mimeType: b.mimeType ?? parsed.mediaType, data: parsed.data } };
      }
      // Non-data or malformed data URL — pass as fileData reference.
      return { fileData: { mimeType: b.mimeType, fileUri: b.url } };
    }
    case 'tool_use':
      return { functionCall: { name: b.name, args: b.input } };
    case 'tool_result': {
      let parsed: Record<string, unknown>;
      try {
        const j = JSON.parse(b.content);
        if (typeof j === 'object' && j !== null && !Array.isArray(j)) {
          parsed = j as Record<string, unknown>;
        } else {
          parsed = { result: j };
        }
      } catch {
        parsed = { result: b.content };
      }
      // Resolve to the original function name; fall back to toolUseId if no
      // matching tool_use was seen (e.g. cross-conversation continuation).
      const fnName = idToFnName.get(b.toolUseId) ?? b.toolUseId;
      return { functionResponse: { name: fnName, response: parsed } };
    }
  }
}

function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function fromGemini(params: GeminiInvocationParams): Message[] {
  const result: Message[] = [];
  if (params.systemInstruction) {
    const text = params.systemInstruction.parts
      .filter((p): p is { text: string } => 'text' in p)
      .map((p) => p.text)
      .join('\n');
    if (text) result.push({ role: 'system', content: text });
  }
  for (const c of params.contents) {
    let role: 'user' | 'assistant' | 'tool' = c.role === 'model' ? 'assistant' : 'user';
    const blocks: ContentBlock[] = [];
    for (const p of c.parts) {
      if ('text' in p) blocks.push({ type: 'text', text: p.text });
      else if ('inlineData' in p) blocks.push({ type: 'image', url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`, mimeType: p.inlineData.mimeType });
      else if ('fileData' in p) blocks.push({ type: 'image', url: p.fileData.fileUri, mimeType: p.fileData.mimeType });
      else if ('functionCall' in p) blocks.push({ type: 'tool_use', id: p.functionCall.name, name: p.functionCall.name, input: p.functionCall.args });
      else if ('functionResponse' in p) blocks.push({ type: 'tool_result', toolUseId: p.functionResponse.name, content: JSON.stringify(p.functionResponse.response) });
    }
    // Restore canonical 'tool' role: Gemini encodes tool results as user role
    // with functionResponse parts.
    const isToolResult = role === 'user' && blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
    if (isToolResult) role = 'tool';
    if (blocks.length === 0) {
      result.push({ role, content: '' });
    } else if (blocks.length === 1 && blocks[0].type === 'text') {
      result.push({ role, content: blocks[0].text });
    } else {
      result.push({ role, content: blocks });
    }
  }
  return result;
}

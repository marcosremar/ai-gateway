/**
 * Edge cases for the 3 LLM adapters.
 *
 * Covers: tool calls, multi-modal images (URL + base64), tool results,
 * empty messages, multiple system messages, roundtrip stability.
 */

import { describe, it, expect } from 'vitest';
import { toOpenAI, fromOpenAI } from '../src/llm-context/adapters/openai';
import { toAnthropic, fromAnthropic } from '../src/llm-context/adapters/anthropic';
import { toGemini, fromGemini } from '../src/llm-context/adapters/gemini';
import type { Message } from '../src/llm-context/types';

describe('OpenAI adapter — edge cases', () => {
  it('multiple system messages stay in messages array', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'rule 1' },
      { role: 'system', content: 'rule 2' },
      { role: 'user', content: 'hi' },
    ];
    const out = toOpenAI(msgs);
    expect(out.messages.filter((m) => m.role === 'system')).toHaveLength(2);
  });

  it('tool_use becomes tool_calls array', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Calling tool' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SP' } },
        ],
      },
    ];
    const out = toOpenAI(msgs);
    expect(out.messages[0].tool_calls).toHaveLength(1);
    expect(out.messages[0].tool_calls![0].function.name).toBe('get_weather');
    const args = JSON.parse(out.messages[0].tool_calls![0].function.arguments);
    expect(args).toEqual({ city: 'SP' });
  });

  it('tool_result becomes role:tool with tool_call_id', () => {
    const msgs: Message[] = [
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_1', content: '{"temp": 25}' }] },
    ];
    const out = toOpenAI(msgs);
    expect(out.messages[0].role).toBe('tool');
    expect(out.messages[0].tool_call_id).toBe('call_1');
    expect(out.messages[0].content).toBe('{"temp": 25}');
  });

  it('REGRESSION: roundtrip preserves tool_calls (was being dropped)', () => {
    const original = [
      { role: 'assistant' as const, content: [
        { type: 'text' as const, text: 'calling' },
        { type: 'tool_use' as const, id: 'c1', name: 'get_weather', input: { city: 'SP' } },
      ]},
      { role: 'tool' as const, content: [{ type: 'tool_result' as const, toolUseId: 'c1', content: 'ok' }] },
    ];
    const back = fromOpenAI(toOpenAI(original).messages);
    const asst = back[0];
    expect(typeof asst.content).not.toBe('string');
    const blocks = asst.content as Array<{ type: string; id?: string; name?: string }>;
    const toolUse = blocks.find((b) => b.type === 'tool_use');
    expect(toolUse).toBeDefined();
    expect(toolUse!.id).toBe('c1');
    expect(toolUse!.name).toBe('get_weather');

    expect(back[1].role).toBe('tool');
    const trBlocks = back[1].content as Array<{ type: string; toolUseId?: string }>;
    expect(trBlocks[0].type).toBe('tool_result');
    expect(trBlocks[0].toolUseId).toBe('c1');
  });

  it('empty content roundtrips', () => {
    const msgs: Message[] = [{ role: 'user', content: '' }];
    const out = toOpenAI(msgs);
    const back = fromOpenAI(out.messages);
    expect(back[0].content).toBe('');
  });
});

describe('Anthropic adapter — edge cases', () => {
  it('joins multiple system messages with double newline', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'rule 1' },
      { role: 'system', content: 'rule 2' },
      { role: 'user', content: 'hi' },
    ];
    const out = toAnthropic(msgs);
    expect(out.system).toBe('rule 1\n\nrule 2');
    expect(out.messages.find((m) => (m.role as string) === 'system')).toBeUndefined();
  });

  it('base64 image becomes source.type=base64', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'image', url: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
        ],
      },
    ];
    const out = toAnthropic(msgs);
    const blocks = out.messages[0].content as Array<{ type: string; source?: { type: string; data?: string } }>;
    expect(blocks[0].source?.type).toBe('base64');
    expect(blocks[0].source?.data).toBe('AAAA');
  });

  it('tool role is converted to user with tool_result block', () => {
    const msgs: Message[] = [
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_42', content: 'ok' }] },
    ];
    const out = toAnthropic(msgs);
    expect(out.messages[0].role).toBe('user');
    const blocks = out.messages[0].content as Array<{ type: string; tool_use_id?: string }>;
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('call_42');
  });

  it('preserves tool_use blocks', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_X', name: 'fn', input: { a: 1 } }] },
    ];
    const out = toAnthropic(msgs);
    const blocks = out.messages[0].content as Array<{ type: string; name?: string }>;
    expect(blocks[0].type).toBe('tool_use');
    expect(blocks[0].name).toBe('fn');
  });

  it('REGRESSION: roundtrip preserves tool flow + restores tool role', () => {
    const original: Message[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'whats weather?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'weather', input: { city: 'SP' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c1', content: '25°C' }] },
    ];
    const back = fromAnthropic(toAnthropic(original));
    expect(back[0].role).toBe('system');
    expect(back[0].content).toBe('be helpful');
    expect(back[1].content).toBe('whats weather?');
    // tool_use preserved on assistant
    const asst = back[2];
    const useBlock = (asst.content as Array<{ type: string }>).find((b) => b.type === 'tool_use');
    expect(useBlock).toBeDefined();
    // Tool message: role restored to 'tool' (was 'user' on the wire)
    expect(back[3].role).toBe('tool');
    const resultBlock = (back[3].content as Array<{ type: string; toolUseId?: string }>)[0];
    expect(resultBlock.type).toBe('tool_result');
    expect(resultBlock.toolUseId).toBe('c1');
  });
});

describe('Gemini adapter — edge cases', () => {
  it('https image uses fileData.fileUri', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'image', url: 'https://x.com/p.jpg', mimeType: 'image/jpeg' }] },
    ];
    const out = toGemini(msgs);
    const part = out.contents[0].parts[0] as { fileData?: { fileUri: string } };
    expect(part.fileData?.fileUri).toBe('https://x.com/p.jpg');
  });

  it('base64 image uses inlineData', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'image', url: 'data:image/png;base64,XXXX' }] },
    ];
    const out = toGemini(msgs);
    const part = out.contents[0].parts[0] as { inlineData?: { mimeType: string; data: string } };
    expect(part.inlineData?.mimeType).toBe('image/png');
    expect(part.inlineData?.data).toBe('XXXX');
  });

  it('tool_use becomes functionCall', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fn1', name: 'lookup', input: { q: 'x' } }] },
    ];
    const out = toGemini(msgs);
    const part = out.contents[0].parts[0] as { functionCall?: { name: string; args: Record<string, unknown> } };
    expect(part.functionCall?.name).toBe('lookup');
    expect(part.functionCall?.args).toEqual({ q: 'x' });
  });

  it('tool_result with non-JSON content wraps in {result: ...}', () => {
    const msgs: Message[] = [
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'fn1', content: 'plain text' }] },
    ];
    const out = toGemini(msgs);
    const part = out.contents[0].parts[0] as { functionResponse?: { response: Record<string, unknown> } };
    expect(part.functionResponse?.response).toEqual({ result: 'plain text' });
  });

  it('tool_result with JSON content parses correctly', () => {
    const msgs: Message[] = [
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'fn1', content: '{"x":42}' }] },
    ];
    const out = toGemini(msgs);
    const part = out.contents[0].parts[0] as { functionResponse?: { response: Record<string, unknown> } };
    expect(part.functionResponse?.response).toEqual({ x: 42 });
  });

  it('multiple system messages join with newline', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'rule 1' },
      { role: 'system', content: 'rule 2' },
      { role: 'user', content: 'hi' },
    ];
    const out = toGemini(msgs);
    const parts = out.systemInstruction!.parts;
    expect(parts).toHaveLength(2);
  });

  it('roundtrip preserves text + image flow', () => {
    const original: Message[] = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello back' },
    ];
    const g = toGemini(original);
    const back = fromGemini(g);
    expect(back).toHaveLength(3);
    expect(back[0].content).toBe('rules');
    expect(back[1].content).toBe('hi');
    expect(back[2].role).toBe('assistant');
  });
});

describe('Tool-message validation (regression)', () => {
  it('REGRESSION: Anthropic rejects tool role with string content', () => {
    expect(() => toAnthropic([{ role: 'tool', content: 'just a string' }])).toThrow(/tool_result/);
  });

  it('REGRESSION: OpenAI rejects tool role with string content', () => {
    expect(() => toOpenAI([{ role: 'tool', content: 'just a string' }])).toThrow(/tool_result/);
  });

  it('REGRESSION: Gemini rejects tool role with string content', () => {
    expect(() => toGemini([{ role: 'tool', content: 'just a string' }])).toThrow(/tool_result/);
  });

  it('REGRESSION: tool message with text-only blocks (no tool_result) rejected', () => {
    const bad: Message[] = [{ role: 'tool', content: [{ type: 'text', text: 'just text' }] }];
    expect(() => toAnthropic(bad)).toThrow(/tool_result/);
  });

  it('valid tool message passes validation', () => {
    const ok: Message[] = [{ role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok' }] }];
    expect(() => toAnthropic(ok)).not.toThrow();
    expect(() => toOpenAI(ok)).not.toThrow();
    expect(() => toGemini(ok)).not.toThrow();
  });
});

describe('Gemini functionResponse name (regression)', () => {
  it('REGRESSION: functionResponse.name is function name, not call id', () => {
    const original: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_42', name: 'get_weather', input: { city: 'SP' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call_42', content: '{"temp":25}' }] },
    ];
    const g = toGemini(original);
    const respPart = g.contents[1].parts[0] as { functionResponse: { name: string } };
    expect(respPart.functionResponse.name).toBe('get_weather');
  });

  it('REGRESSION: roundtrip restores tool role from functionResponse', () => {
    const original: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'fn', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok' }] },
    ];
    const back = fromGemini(toGemini(original));
    expect(back[1].role).toBe('tool');
  });

  it('falls back to toolUseId if no matching tool_use seen', () => {
    const orphan: Message[] = [
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'unknown_id', content: 'data' }] },
    ];
    const g = toGemini(orphan);
    const respPart = g.contents[0].parts[0] as { functionResponse: { name: string } };
    // No matching tool_use → falls back to id
    expect(respPart.functionResponse.name).toBe('unknown_id');
  });
});

describe('Consecutive-role merging (regression)', () => {
  it('REGRESSION: Anthropic merges consecutive same-role messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      { role: 'user', content: 'q3' },
    ];
    const out = toAnthropic(msgs);
    // Anthropic API rejects non-alternating roles. Merging keeps it valid.
    expect(out.messages).toHaveLength(3);
    expect(out.messages[0].role).toBe('user');
    expect(out.messages[1].role).toBe('assistant');
    expect(out.messages[2].role).toBe('user');
    // Content concatenated as block array
    expect(Array.isArray(out.messages[0].content)).toBe(true);
    const userBlocks = out.messages[0].content as Array<{ type: string; text?: string }>;
    expect(userBlocks).toHaveLength(2);
    expect(userBlocks.map((b) => b.text)).toEqual(['q1', 'q2']);
  });

  it('REGRESSION: Gemini merges consecutive same-role contents', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
    ];
    const out = toGemini(msgs);
    expect(out.contents).toHaveLength(1);
    expect(out.contents[0].parts).toHaveLength(2);
  });

  it('preserves non-consecutive same-role across other roles', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ];
    const out = toAnthropic(msgs);
    expect(out.messages).toHaveLength(3);
  });
});

describe('Data URL parsing (regression)', () => {
  it('REGRESSION: malformed data URL falls back to URL transport (not empty base64)', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'image', url: 'data:invalid-no-comma', mimeType: 'image/png' }] },
    ];
    const ant = toAnthropic(msgs);
    const blocks = ant.messages[0].content as Array<{ type: string; source?: { type: string; data?: string; url?: string } }>;
    // No empty base64 emitted — falls back to URL.
    expect(blocks[0].source?.type).toBe('url');
    expect(blocks[0].source?.data).toBeUndefined();
  });

  it('REGRESSION: data URL without ;base64 marker falls back to URL', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'image', url: 'data:image/png,raw_no_base64', mimeType: 'image/png' }] },
    ];
    const ant = toAnthropic(msgs);
    const blocks = ant.messages[0].content as Array<{ type: string; source?: { type: string } }>;
    expect(blocks[0].source?.type).toBe('url');
  });

  it('valid base64 data URL preserved', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'image', url: 'data:image/jpeg;base64,/9j/4AAQ', mimeType: 'image/jpeg' }] },
    ];
    const ant = toAnthropic(msgs);
    const blocks = ant.messages[0].content as Array<{ type: string; source?: { type: string; data?: string; media_type?: string } }>;
    expect(blocks[0].source?.type).toBe('base64');
    expect(blocks[0].source?.data).toBe('/9j/4AAQ');
    expect(blocks[0].source?.media_type).toBe('image/jpeg');
  });

  it('Gemini also falls back gracefully on malformed data URL', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'image', url: 'data:bad', mimeType: 'image/png' }] },
    ];
    const g = toGemini(msgs);
    const part = g.contents[0].parts[0] as { fileData?: { fileUri: string }; inlineData?: unknown };
    // Falls back to fileData (URL reference) instead of empty inlineData
    expect(part.fileData?.fileUri).toBe('data:bad');
    expect(part.inlineData).toBeUndefined();
  });
});

describe('Gemini empty parts (regression)', () => {
  it('REGRESSION: empty parts array becomes empty string content (not empty array)', () => {
    const back = fromGemini({ contents: [{ role: 'user', parts: [] }] });
    expect(back[0].content).toBe('');
  });
});

describe('GatedContext null-guard (regression)', () => {
  it('REGRESSION: append rejects null/undefined/non-Message', async () => {
    const { GatedContext } = await import('../src/llm-context/gated-context');
    const gate = new GatedContext();
    expect(() => gate.append(null as never)).toThrow(/invalid message/);
    expect(() => gate.append(undefined as never)).toThrow(/invalid message/);
    expect(() => gate.append({} as never)).toThrow(/invalid message/);
    expect(() => gate.append('string' as never)).toThrow(/invalid message/);
  });

  it('valid message passes', async () => {
    const { GatedContext } = await import('../src/llm-context/gated-context');
    const gate = new GatedContext();
    expect(() => gate.append({ role: 'user', content: 'hi' })).not.toThrow();
    expect(gate.size()).toBe(1);
  });
});

describe('Surrogate-pair handling (regression)', () => {
  it('REGRESSION: emoji as lookahead char does not break sentence yield', async () => {
    const { SentenceAggregator } = await import('../src/llm-context/sentence-aggregator');
    const agg = new SentenceAggregator();
    const out: string[] = [];
    for await (const s of agg.aggregate('Hi. 🎉 Bye.')) out.push(s.text);
    const tail = await agg.flush();
    if (tail) out.push(tail.text);
    // Bug: previously sliced 1 code unit instead of full surrogate pair,
    // leaving lone high surrogate in output.
    expect(out[0]).toBe('Hi.');
    expect(out[0]).not.toContain('\uD83C'); // no orphan high surrogate
    expect(out[1]).toContain('🎉');
  });
});

describe('OpenAI tool message multi-part content (regression)', () => {
  it('REGRESSION: array content for role:tool extracts all text parts', () => {
    const oai = [
      { role: 'tool' as const, content: [{ type: 'text' as const, text: 'multi-part result' }], tool_call_id: 'c1' },
    ];
    const back = fromOpenAI(oai);
    const blocks = back[0].content as Array<{ type: string; content?: string }>;
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].content).toBe('multi-part result');
  });
});

describe('cross-adapter consistency', () => {
  const original: Message[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'follow up' },
  ];

  it('all 3 adapters produce non-empty output', () => {
    expect(toOpenAI(original).messages.length).toBeGreaterThan(0);
    expect(toAnthropic(original).messages.length).toBeGreaterThan(0);
    expect(toGemini(original).contents.length).toBeGreaterThan(0);
  });

  it('all 3 preserve total user+assistant turn count', () => {
    const oai = toOpenAI(original).messages.filter((m) => m.role !== 'system');
    const ant = toAnthropic(original).messages;
    const gem = toGemini(original).contents;
    expect(oai).toHaveLength(3);
    expect(ant).toHaveLength(3);
    expect(gem).toHaveLength(3);
  });
});

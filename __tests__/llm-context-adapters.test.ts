import { describe, it, expect } from 'vitest';
import { toOpenAI, fromOpenAI } from '../src/llm-context/adapters/openai';
import { toAnthropic, fromAnthropic } from '../src/llm-context/adapters/anthropic';
import { toGemini, fromGemini } from '../src/llm-context/adapters/gemini';
import type { Message } from '../src/llm-context/types';

const sample: Message[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', url: 'https://example.com/x.png', mimeType: 'image/png' }] },
];

describe('OpenAI adapter', () => {
  it('keeps system in messages array', () => {
    const out = toOpenAI(sample);
    expect(out.messages[0].role).toBe('system');
    expect(out.messages[0].content).toBe('You are helpful.');
  });

  it('image blocks become image_url parts', () => {
    const out = toOpenAI(sample);
    const msg = out.messages[3];
    expect(Array.isArray(msg.content)).toBe(true);
    const parts = msg.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
  });

  it('roundtrip preserves text content', () => {
    const oai = toOpenAI(sample);
    const back = fromOpenAI(oai.messages);
    expect(back[0].content).toBe('You are helpful.');
    expect(back[1].content).toBe('hi');
  });
});

describe('Anthropic adapter', () => {
  it('extracts system to top-level param', () => {
    const out = toAnthropic(sample);
    expect(out.system).toBe('You are helpful.');
    expect(out.messages.every((m) => m.role !== 'system' as never)).toBe(true);
  });

  it('preserves user/assistant order without system', () => {
    const out = toAnthropic(sample);
    expect(out.messages[0].role).toBe('user');
    expect(out.messages[1].role).toBe('assistant');
  });

  it('image url stays as type:url source', () => {
    const out = toAnthropic(sample);
    const msg = out.messages[2];
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<{ type: string; source?: { type: string; url?: string } }>;
    const img = blocks.find((b) => b.type === 'image');
    expect(img?.source?.type).toBe('url');
  });

  it('roundtrip preserves system + user/assistant', () => {
    const aps = toAnthropic(sample);
    const back = fromAnthropic(aps);
    expect(back[0].role).toBe('system');
    expect(back[0].content).toBe('You are helpful.');
    expect(back[1].role).toBe('user');
  });
});

describe('Gemini adapter', () => {
  it('extracts system to systemInstruction', () => {
    const out = toGemini(sample);
    expect(out.systemInstruction).toBeDefined();
    const parts = out.systemInstruction!.parts as Array<{ text: string }>;
    expect(parts[0].text).toBe('You are helpful.');
  });

  it('assistant becomes role:model', () => {
    const out = toGemini(sample);
    const assistant = out.contents.find((c) => c.parts.some((p) => 'text' in p && (p as { text: string }).text === 'hello'));
    expect(assistant?.role).toBe('model');
  });

  it('image with https url uses fileData', () => {
    const out = toGemini(sample);
    const userWithImage = out.contents.find((c) => c.role === 'user' && c.parts.some((p) => 'fileData' in p));
    expect(userWithImage).toBeDefined();
  });

  it('roundtrip preserves text', () => {
    const g = toGemini(sample);
    const back = fromGemini(g);
    expect(back[0].content).toBe('You are helpful.');
    const userMsg = back.find((m) => m.role === 'user' && m.content === 'hi');
    expect(userMsg).toBeDefined();
  });
});

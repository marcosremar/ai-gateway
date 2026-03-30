/**
 * AIClient Latency Benchmark — Real API
 *
 * Mede a latência de cada provider/caminho para comparação direta.
 * Tudo via SDK: getAIClient().method() — verifica que o gateway
 * realmente chama o provider correto e reporta timing real.
 *
 * Run:
 *   bun run vitest run __tests__/ai-client-latency-bench.test.ts
 */

import 'dotenv/config';

if (typeof globalThis.File === 'undefined') {
  const { File } = await import('node:buffer');
  globalThis.File = File as unknown as typeof globalThis.File;
}

import { describe, it, expect, beforeAll } from 'vitest';
import {
  AIProviderRegistry,
  createAIClient,
  groqSTT, groqTTS, groqLLM,
  modalTTS,
  OpenAICompatLLMProvider, OpenAICompatSTTProvider, OpenAICompatTTSProvider,
  OpenAIOmniProvider, OpenAIRealtimeProvider,
  openaiImage,
  getCooldownState,
} from '@ai-gateway';
import { OPENAI_STT_MODELS, OPENAI_TTS_MODELS, OPENAI_VOICES } from '@ai-gateway/providers/openai/models';
import type { AIClient } from '@ai-gateway';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearCooldowns() { getCooldownState().clear(); }

function generateToneWav(durationSecs = 1.5, sampleRate = 16000): Buffer {
  const numSamples = Math.round(sampleRate * durationSecs);
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); view.setUint32(4, 36 + numSamples * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, numSamples * 2, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
  }
  return Buffer.from(buf);
}

// ---------------------------------------------------------------------------
// API key detection
// ---------------------------------------------------------------------------

const HAS_GROQ = !!process.env.GROQ_API_KEY;
const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
let OPENAI_VALID = false;
let MODAL_AVAILABLE = false;

function skipIf(cond: boolean, _: string) { return cond ? it.skip : it; }

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function makeClient(): AIClient {
  const reg = new AIProviderRegistry();
  if (OPENAI_VALID) {
    reg.register({
      id: 'openai', name: 'OpenAI', description: 'OpenAI', capabilities: ['llm', 'stt', 'tts', 'omni', 'realtime', 'image'], requiresApiKey: true,
      llm: new OpenAICompatLLMProvider({ providerId: 'openai', baseURL: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', defaultModel: 'gpt-4o-mini' }),
      stt: new OpenAICompatSTTProvider({ providerId: 'openai', baseURL: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', models: OPENAI_STT_MODELS, defaultModel: 'gpt-4o-mini-transcribe' }),
      tts: new OpenAICompatTTSProvider({ providerId: 'openai', baseURL: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', models: OPENAI_TTS_MODELS, voices: OPENAI_VOICES, defaultModel: 'gpt-4o-mini-tts', defaultVoice: 'coral' }),
      omni: new OpenAIOmniProvider(),
      realtime: new OpenAIRealtimeProvider(),
      image: openaiImage,
    });
  }
  if (HAS_GROQ) {
    reg.register({
      id: 'groq', name: 'Groq', description: 'Groq', capabilities: ['llm', 'stt', 'tts'], requiresApiKey: true,
      llm: groqLLM, stt: groqSTT, tts: groqTTS,
    });
  }
  reg.register({ id: 'modal', name: 'Modal', description: 'Modal', capabilities: ['tts'], requiresApiKey: false, tts: modalTTS });
  return createAIClient({ registry: reg, defaultProfile: 'speech-to-speech' });
}

// ---------------------------------------------------------------------------
// Results collector
// ---------------------------------------------------------------------------

interface BenchRow {
  test: string;
  provider: string;
  model: string;
  latencyMs: number;
  detail?: string;
}

const rows: BenchRow[] = [];

function record(row: BenchRow) {
  rows.push(row);
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    `  ${pad(row.test, 30)} ${pad(row.provider, 12)} ${pad(row.model, 30)} ${String(row.latencyMs).padStart(6)}ms${row.detail ? `  ${row.detail}` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const PROMPT = 'Você é um tutor de português. Responda em uma frase curta.';
const TEXT = 'Olá, tudo bem? Como vai você hoje?';
let client: AIClient;
const audio = generateToneWav(1.5);

beforeAll(async () => {
  if (HAS_OPENAI) {
    try {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
      OPENAI_VALID = r.ok;
    } catch { OPENAI_VALID = false; }
  }
  try {
    const r = await fetch('https://marcosremar--moss-tts-realtime-mossttsrealtime-serve.modal.run/health', { signal: AbortSignal.timeout(8000) });
    MODAL_AVAILABLE = r.ok;
  } catch { MODAL_AVAILABLE = false; }

  console.log(`\n[bench] OPENAI=${OPENAI_VALID} GROQ=${HAS_GROQ} MODAL=${MODAL_AVAILABLE}\n`);
  console.log(`  ${'TEST'.padEnd(30)} ${'PROVIDER'.padEnd(12)} ${'MODEL'.padEnd(30)} ${'LATENCY'.padStart(8)}`);
  console.log(`  ${'─'.repeat(30)} ${'─'.repeat(12)} ${'─'.repeat(30)} ${'─'.repeat(8)}`);

  client = makeClient();
}, 30_000);

// ═══════════════════════════════════════════════════════════════════════════
// STT — por provider
// ═══════════════════════════════════════════════════════════════════════════

describe('STT latency', () => {
  const testOpenai = skipIf(!HAS_OPENAI, 'no OpenAI');
  const testGroq = skipIf(!HAS_GROQ, 'no Groq');

  testOpenai('OpenAI gpt-4o-mini-transcribe', async () => {
    clearCooldowns();
    const r = await client.transcribe(audio, { stt: [{ provider: 'openai', model: 'gpt-4o-mini-transcribe' }] });
    record({ test: 'STT', provider: r.provider, model: r.model ?? '', latencyMs: r.latencyMs, detail: `"${r.text.slice(0, 40)}"` });
    expect(r.provider).toBe('openai');
  }, 30_000);

  testGroq('Groq whisper-large-v3-turbo', async () => {
    clearCooldowns();
    try {
      const r = await client.transcribe(audio, { stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }] });
      record({ test: 'STT', provider: r.provider, model: r.model ?? '', latencyMs: r.latencyMs, detail: `"${r.text.slice(0, 40)}"` });
      expect(r.provider).toBe('groq');
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// LLM — por provider
// ═══════════════════════════════════════════════════════════════════════════

describe('LLM latency', () => {
  const testOpenai = skipIf(!HAS_OPENAI, 'no OpenAI');
  const testGroq = skipIf(!HAS_GROQ, 'no Groq');
  const msgs = [{ role: 'system' as const, content: PROMPT }, { role: 'user' as const, content: 'Oi, tudo bem?' }];

  testOpenai('OpenAI gpt-4o-mini', async () => {
    clearCooldowns();
    const r = await client.chat(msgs, { llm: [{ provider: 'openai', model: 'gpt-4o-mini' }] });
    record({ test: 'LLM', provider: r.provider, model: r.model ?? '', latencyMs: r.latencyMs, detail: `"${r.content.slice(0, 40)}"` });
    expect(r.provider).toBe('openai');
  }, 30_000);

  testGroq('Groq llama-3.3-70b', async () => {
    clearCooldowns();
    try {
      const r = await client.chat(msgs, { llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }] });
      record({ test: 'LLM', provider: r.provider, model: r.model ?? '', latencyMs: r.latencyMs, detail: `"${r.content.slice(0, 40)}"` });
      expect(r.provider).toBe('groq');
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// TTS — por provider
// ═══════════════════════════════════════════════════════════════════════════

describe('TTS latency', () => {
  const testOpenai = skipIf(!HAS_OPENAI, 'no OpenAI');
  const testGroq = skipIf(!HAS_GROQ, 'no Groq');
  const testModal = skipIf(!MODAL_AVAILABLE, 'Modal offline');

  testOpenai('OpenAI gpt-4o-mini-tts', async () => {
    clearCooldowns();
    const r = await client.synthesize(TEXT, { tts: [{ provider: 'openai', model: 'gpt-4o-mini-tts' }], voice: 'ash' });
    record({ test: 'TTS', provider: r.provider, model: r.model ?? '', latencyMs: r.latencyMs, detail: `${r.audio.length}B` });
    expect(r.provider).toBe('openai');
  }, 30_000);

  testGroq('Groq orpheus-v1', async () => {
    clearCooldowns();
    try {
      const r = await client.synthesize(TEXT, { tts: [{ provider: 'groq', model: 'canopylabs/orpheus-v1-english' }], voice: 'tara' });
      record({ test: 'TTS', provider: r.provider, model: r.model ?? '', latencyMs: r.latencyMs, detail: `${r.audio.length}B` });
      expect(r.provider).toBe('groq');
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 400 || status === 401 || status === 402 || status === 403) return; // API incompatibility, key invalid, or no credits
      throw err;
    }
  }, 30_000);

  testModal('Modal moss-tts', async () => {
    clearCooldowns();
    const r = await client.synthesize(TEXT, { tts: [{ provider: 'modal', model: 'moss-tts-realtime' }], voice: 'moss-pt' });
    record({ test: 'TTS', provider: r.provider, model: r.model ?? '', latencyMs: r.latencyMs, detail: `${r.audio.length}B` });
    expect(r.provider).toBe('modal');
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Pipeline completo — Omni vs Sequential
// ═══════════════════════════════════════════════════════════════════════════

describe('Pipeline latency (speech-to-speech)', () => {
  const testOpenai = skipIf(!HAS_OPENAI, 'no OpenAI');
  const testGroq = skipIf(!HAS_GROQ, 'no Groq');

  testOpenai('OpenAI Omni (single call STT+LLM+TTS)', async () => {
    clearCooldowns();
    const t0 = Date.now();
    const r = await client.pipeline(audio, PROMPT, [], {
      omni: [{ provider: 'openai', model: 'gpt-4o-mini-audio-preview' }],
      // sem stt/llm/tts para forçar omni-only
      stt: [], llm: [], tts: [],
    });
    const ms = Date.now() - t0;
    record({
      test: 'PIPELINE omni',
      provider: r.chat.provider, model: r.chat.model ?? 'gpt-4o-mini-audio-preview',
      latencyMs: ms,
      detail: `"${r.chat.content.slice(0, 40)}" audio=${r.tts.audio.length}B`,
    });
    expect(r.chat.provider).toBe('openai');
    expect(r.chat.content.length).toBeGreaterThan(0);
  }, 45_000);

  testOpenai('OpenAI Sequential (STT → LLM → TTS separados)', async () => {
    clearCooldowns();
    const t0 = Date.now();
    const r = await client.pipeline(audio, PROMPT, [], {
      // sem omni para forçar sequential
      stt: [{ provider: 'openai', model: 'gpt-4o-mini-transcribe' }],
      llm: [{ provider: 'openai', model: 'gpt-4o-mini' }],
      tts: [{ provider: 'openai', model: 'gpt-4o-mini-tts' }],
    });
    const ms = Date.now() - t0;
    record({
      test: 'PIPELINE openai seq',
      provider: 'openai', model: 'stt+llm+tts',
      latencyMs: ms,
      detail: `stt=${r.stt.latencyMs}ms llm=${r.chat.latencyMs}ms tts=${r.tts.latencyMs}ms "${r.chat.content.slice(0, 30)}"`,
    });
    expect(r.totalLatencyMs).toBeGreaterThan(0);
  }, 45_000);

  testGroq('Groq Sequential (STT → LLM → TTS separados)', async () => {
    clearCooldowns();
    try {
      const t0 = Date.now();
      const r = await client.pipeline(audio, PROMPT, [], {
        stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
        llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
        tts: [{ provider: 'groq', model: 'canopylabs/orpheus-v1-english' }],
        voice: 'tara',
      });
      const ms = Date.now() - t0;
      record({
        test: 'PIPELINE groq seq',
        provider: 'groq', model: 'stt+llm+tts',
        latencyMs: ms,
        detail: `stt=${r.stt.latencyMs}ms llm=${r.chat.latencyMs}ms tts=${r.tts.latencyMs}ms "${r.chat.content.slice(0, 30)}"`,
      });
      expect(r.totalLatencyMs).toBeGreaterThan(0);
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status;
      if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
      throw err;
    }
  }, 45_000);

  const testBoth = skipIf(!HAS_OPENAI || !HAS_GROQ, 'need both');
  testBoth('Mixed: Groq STT+LLM → OpenAI TTS', async () => {
    clearCooldowns();
    const t0 = Date.now();
    const r = await client.pipeline(audio, PROMPT, [], {
      stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
      llm: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
      tts: [{ provider: 'openai', model: 'gpt-4o-mini-tts' }],
    });
    const ms = Date.now() - t0;
    record({
      test: 'PIPELINE mixed groq+oai',
      provider: 'groq→openai', model: 'stt+llm→tts',
      latencyMs: ms,
      detail: `stt=${r.stt.latencyMs}ms llm=${r.chat.latencyMs}ms tts=${r.tts.latencyMs}ms`,
    });
  }, 45_000);

  testOpenai('Default profile (omni first, fallback seq)', async () => {
    clearCooldowns();
    const t0 = Date.now();
    const r = await client.pipeline(audio, PROMPT);
    const ms = Date.now() - t0;
    record({
      test: 'PIPELINE default profile',
      provider: r.chat.provider, model: r.chat.model ?? '',
      latencyMs: ms,
      detail: `stt=${r.stt.latencyMs}ms llm=${r.chat.latencyMs}ms tts=${r.tts.latencyMs}ms usedGpu=${r.usedGpu}`,
    });
    expect(r.chat.content.length).toBeGreaterThan(0);
  }, 45_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Realtime session
// ═══════════════════════════════════════════════════════════════════════════

describe('Realtime session latency', () => {
  const testOpenai = skipIf(!HAS_OPENAI, 'no OpenAI');

  testOpenai('realtimeSpeech session token', async () => {
    clearCooldowns();
    const t0 = Date.now();
    const r = await client.realtimeSpeech(
      { voice: 'ash', model: 'gpt-4o-mini-realtime-preview' },
      { realtime: [{ provider: 'openai' }] },
    );
    const ms = Date.now() - t0;
    record({ test: 'REALTIME session', provider: r.provider, model: r.model, latencyMs: ms, detail: `secret=${r.clientSecret?.slice(0, 15)}...` });
    expect(r.transport).toBe('session');
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Summary table
// ═══════════════════════════════════════════════════════════════════════════

describe('Summary', () => {
  it('prints latency comparison', () => {
    console.log(`\n${'═'.repeat(90)}`);
    console.log('LATENCY COMPARISON');
    console.log(`${'═'.repeat(90)}`);

    // Group by test category
    const groups = new Map<string, BenchRow[]>();
    for (const r of rows) {
      const cat = r.test.split(' ')[0];
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(r);
    }

    for (const [cat, items] of groups) {
      console.log(`\n  ${cat}:`);
      const sorted = [...items].sort((a, b) => a.latencyMs - b.latencyMs);
      for (let i = 0; i < sorted.length; i++) {
        const r = sorted[i];
        const badge = i === 0 ? ' ⚡ FASTEST' : ` (+${r.latencyMs - sorted[0].latencyMs}ms)`;
        console.log(`    ${String(r.latencyMs).padStart(6)}ms  ${r.provider.padEnd(14)} ${r.model.padEnd(30)}${badge}`);
      }
    }

    console.log(`\n${'═'.repeat(90)}\n`);
    // Only assert results when at least one provider was available during this run
    if (HAS_OPENAI || HAS_GROQ || MODAL_AVAILABLE) {
      expect(rows.length).toBeGreaterThan(0);
    }
  });
});

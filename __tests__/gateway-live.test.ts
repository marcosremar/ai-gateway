/**
 * Integration tests for the BabelCast gateway via the Node SDK.
 *
 * Tests hit the live gateway on fly.io to validate that:
 * - All SDK endpoints work end-to-end
 * - The PostgreSQL migration didn't break anything
 * - STT, LLM, and config endpoints are operational
 *
 * Run:
 *   cd ai-gateway && bun test __tests__/gateway-live.test.ts
 *
 * Set SKIP_LIVE_TESTS=1 to skip these in CI.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { GatewayHttpClient } from '../sdk/node';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://babelcast-gateway.fly.dev';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'gw_a7970fa694c2f381390fbd12962a2fe915c8d0a24406b28b';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

function makeWav(durationS = 1.0, sampleRate = 16000): Uint8Array {
  const numSamples = Math.floor(sampleRate * durationS);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  const encoder = new TextEncoder();
  const riff = encoder.encode('RIFF');
  const wave = encoder.encode('WAVE');
  const fmt = encoder.encode('fmt ');
  const data = encoder.encode('data');

  let offset = 0;
  for (const b of riff) view.setUint8(offset++, b);
  view.setUint32(offset, 36 + dataSize, true); offset += 4;
  for (const b of wave) view.setUint8(offset++, b);
  for (const b of fmt) view.setUint8(offset++, b);
  view.setUint32(offset, 16, true); offset += 4;       // chunk size
  view.setUint16(offset, 1, true); offset += 2;        // PCM
  view.setUint16(offset, 1, true); offset += 2;        // mono
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * 2, true); offset += 4; // byte rate
  view.setUint16(offset, 2, true); offset += 2;        // block align
  view.setUint16(offset, 16, true); offset += 2;       // bits per sample
  for (const b of data) view.setUint8(offset++, b);
  view.setUint32(offset, dataSize, true);
  // PCM data is all zeros (silence)

  return new Uint8Array(buffer);
}

describe.skipIf(SKIP)('Gateway Live — Node SDK', () => {
  let gw: GatewayHttpClient;

  beforeAll(() => {
    gw = new GatewayHttpClient({
      baseUrl: GATEWAY_URL,
      apiKey: GATEWAY_API_KEY,
      timeouts: { sttMs: 15_000, translateMs: 10_000, pipelineMs: 30_000, healthMs: 10_000 },
    });
  });

  // ── Health ─────────────────────────────────────────────────────────────

  describe('health', () => {
    it('returns healthy status', async () => {
      const result = await gw.health();
      expect(result.isHealthy).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.uptimeSec).toBeGreaterThan(0);
    });

    it('includes component statuses', async () => {
      const result = await gw.health();
      expect(result.components).toBeDefined();
      expect(result.components.stt).toBeDefined();
      expect(result.components.llm).toBeDefined();
    });
  });

  // ── Chat / LLM ───────────────────────────────────────────────────────

  describe('chat', () => {
    it('returns a response from Groq', async () => {
      const result = await gw.chat(
        [{ role: 'user', content: 'Reply with exactly: PONG' }],
        'llama-3.3-70b-versatile',
        { maxTokens: 10 },
      );
      expect(result.content).toBeTruthy();
      expect(result.content.toUpperCase()).toContain('PONG');
    });

    it('handles system + user messages', async () => {
      const result = await gw.chat(
        [
          { role: 'system', content: 'You are a translator. Reply only with the translation.' },
          { role: 'user', content: 'Translate to French: Hello' },
        ],
        'llama-3.3-70b-versatile',
        { maxTokens: 20 },
      );
      expect(result.content).toBeTruthy();
      expect(result.content.length).toBeGreaterThan(0);
    });

    it('returns usage information', async () => {
      const result = await gw.chat(
        [{ role: 'user', content: 'Say hi' }],
        'llama-3.3-70b-versatile',
        { maxTokens: 5 },
      );
      expect(result.usage).toBeDefined();
      expect(result.usage?.total_tokens).toBeGreaterThan(0);
    });
  });

  // ── STT / Transcribe ─────────────────────────────────────────────────

  describe('transcribe', () => {
    it('accepts silence WAV and returns a result', async () => {
      const wav = makeWav(1.5);
      const result = await gw.transcribe(wav, 'en');
      expect(typeof result.text).toBe('string');
    });
  });

  // ── Translation ──────────────────────────────────────────────────────

  describe('translate', () => {
    it('translates French to English', async () => {
      const result = await gw.translate('Bonjour le monde', 'fr', 'en');
      expect(result.translatedText).toBeTruthy();
      const lower = result.translatedText.toLowerCase();
      expect(lower).toMatch(/hello|world|good/);
    });
  });

  // ── GPU Status ───────────────────────────────────────────────────────

  describe('gpu', () => {
    it('returns gpu status', async () => {
      const status = await gw.gpuStatus();
      expect(status.status).toBeDefined();
      expect(['idle', 'ready', 'booting', 'error', 'searching', 'creating', 'installing']).toContain(status.status);
      expect(status.activeTier).toBeDefined();
    });
  });

  // ── End-to-end subtitle translation ──────────────────────────────────

  describe('e2e subtitle flow', () => {
    it('translates French text to English via chat', async () => {
      const result = await gw.chat(
        [
          { role: 'system', content: 'You are a subtitle translator. Translate the following French text to English. Reply ONLY with the translation, nothing else.' },
          { role: 'user', content: 'Bonjour, comment allez-vous aujourd\'hui?' },
        ],
        'llama-3.3-70b-versatile',
        { maxTokens: 50, temperature: 0.1 },
      );
      const text = result.content.toLowerCase();
      expect(text).toMatch(/hello|hi|good|how|today/);
    });
  });
});

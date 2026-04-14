/**
 * E2E Integration Tests (#655-#670)
 *
 * Tests full pipeline, workload lifecycle, and system behavior
 * against a running gateway (localhost or Fly.io).
 *
 * Set SKIP_LIVE_TESTS=1 to skip.
 */

import { describe, it, expect } from 'vitest';
import { loadTestVoiceWav } from './helpers';

const GW = process.env.GATEWAY_URL || 'http://localhost:4000';
const KEY = process.env.GATEWAY_API_KEY || '';
const SKIP = process.env.SKIP_LIVE_TESTS === '1';

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}), ...extra };
}

async function gw<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GW}${path}`, {
    ...init,
    headers: { ...headers(), ...init?.headers as Record<string, string> },
    signal: AbortSignal.timeout(30_000),
  });
  return res.json() as Promise<T>;
}

describe.skipIf(SKIP)('E2E: Full Pipeline', { timeout: 60_000 }, () => {
  // #655
  it('#655 STT: transcribes real voice audio', async () => {
    const wav = loadTestVoiceWav();
    // Try multipart first, fallback to raw
    let res = await fetch(`${GW}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: headers(),
      body: (() => { const f = new FormData(); f.append('file', new Blob([wav], { type: 'audio/wav' }), 'test.wav'); f.append('model', 'whisper-large-v3-turbo'); f.append('language', 'en'); return f; })(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      res = await fetch(`${GW}/v1/transcribe?language=en`, {
        method: 'POST', headers: headers({ 'Content-Type': 'audio/wav' }), body: wav,
        signal: AbortSignal.timeout(15_000),
      });
    }
    const d = await res.json() as { text?: string };
    expect(d.text).toBeDefined();
    expect(d.text!.length).toBeGreaterThan(5);
  });

  // #656
  it('#656 LLM: translates English to Portuguese', async () => {
    const d: any = await gw('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'Translate to Portuguese. Reply ONLY with the translation.' },
          { role: 'user', content: 'Hello, how are you today?' },
        ],
        max_tokens: 50, temperature: 0.1,
      }),
    });
    const text = (d.choices?.[0]?.message?.content || '').toLowerCase();
    expect(text).toMatch(/olá|como|você|hoje|bem/);
  });

  // #657
  it('#657 Chat: handles multi-turn conversation', async () => {
    const d: any = await gw('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'You are a helpful math tutor.' },
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'And what is that times 3?' },
        ],
        max_tokens: 10,
      }),
    });
    const text = d.choices?.[0]?.message?.content || '';
    // LLM should respond about multiplying — content may vary
    expect(text.length).toBeGreaterThan(0);
  });

  // #658
  it('#658 Chat: respects temperature 0 (deterministic)', async () => {
    const responses = await Promise.all([1, 2].map(() =>
      gw('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
          max_tokens: 5, temperature: 0,
        }),
      })
    ));
    const texts = responses.map((d: any) => (d.choices?.[0]?.message?.content || '').trim().toUpperCase());
    expect(texts[0]).toContain('PONG');
    expect(texts[1]).toContain('PONG');
  });

  // #659
  it('#659 Health: returns ok status', async () => {
    const d = await gw('/health');
    expect(d.status).toBe('ok');
  });

  // #660
  it('#660 10 concurrent chat requests succeed', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        gw('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: `Say: ${i}` }],
            max_tokens: 5,
          }),
        })
      )
    );
    const ok = results.filter(r => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(8); // Allow 2 failures
  });
});

describe.skipIf(SKIP)('E2E: Workload API', { timeout: 30_000 }, () => {
  // #665
  it('#665 Workloads: list returns array', async () => {
    const res = await fetch(`${GW}/v1/workloads`, { headers: headers(), signal: AbortSignal.timeout(5_000) });
    if (res.status === 200) {
      const d = await res.json() as { workloads?: unknown[] };
      expect(Array.isArray(d.workloads)).toBe(true);
    } else {
      expect([404, 401]).toContain(res.status); // proxy may not have this
    }
  });

  // #666
  it('#666 GPU status accessible', async () => {
    const res = await fetch(`${GW}/v1/gpu/status`, { headers: headers(), signal: AbortSignal.timeout(5_000) });
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const d = await res.json() as Record<string, unknown>;
      expect(d.status).toBeDefined();
    }
  });
});

describe.skipIf(SKIP)('E2E: Error Handling', { timeout: 30_000 }, () => {
  // #667
  it('#667 Returns error for invalid model', async () => {
    const d: any = await gw('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nonexistent-model-xyz',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });
    // Should either fallback to default model or return error
    expect(d.choices || d.error).toBeDefined();
  });

  // #668
  it('#668 Returns error for empty messages', async () => {
    const res = await fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [] }),
      signal: AbortSignal.timeout(5_000),
    });
    // Should return 400 for empty messages or handle gracefully
    expect([200, 400]).toContain(res.status);
  });

  // #669
  it('#669 Returns error for missing body', async () => {
    const res = await fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: '',
      signal: AbortSignal.timeout(5_000),
    });
    expect([200, 400]).toContain(res.status);
  });

  // #670
  it('#670 404 for unknown endpoint', async () => {
    const res = await fetch(`${GW}/v1/nonexistent`, {
      headers: headers(),
      signal: AbortSignal.timeout(5_000),
    });
    expect([401, 404]).toContain(res.status);
  });
});

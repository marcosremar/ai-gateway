/**
 * Tests for providers/chain-diversifier.ts — diversifyChain()
 *
 * Ensures fallback chains are auto-diversified when all entries
 * come from the same provider family.
 */

import { describe, it, expect } from 'vitest';
import { diversifyChain } from '../src/providers/chain-diversifier';
import type { DiversifyConfig } from '../src/providers/chain-diversifier';
import type { FallbackEntry } from '../src/providers/fallback';

// Helpers
const available = (...providers: string[]): Set<string> => new Set(providers);

describe('diversifyChain', () => {
  // ── Single-provider chain gets backup injected ──────────────────────────

  it('injects a backup when chain is mono-provider (stt)', () => {
    const chain: FallbackEntry[] = [
      { provider: 'groq', model: 'whisper-large-v3-turbo' },
    ];

    const result = diversifyChain(chain, 'stt', available('groq', 'openai', 'deepgram'));

    expect(result.length).toBeGreaterThan(chain.length);
    // The injected entry should be from a different provider
    const providers = new Set(result.map((e) => e.provider));
    expect(providers.size).toBeGreaterThanOrEqual(2);
    // First entry is unchanged
    expect(result[0]).toEqual(chain[0]);
  });

  it('injects a backup when chain is mono-provider (llm)', () => {
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'gpt-4o-mini' },
      { provider: 'openai', model: 'gpt-4o' },
    ];

    const result = diversifyChain(chain, 'llm', available('openai', 'groq'));

    expect(result.length).toBe(3);
    expect(result[2].provider).toBe('groq');
    expect(result[2].model).toBe('llama-3.3-70b-versatile');
  });

  it('injects a backup when chain is mono-provider (tts)', () => {
    const chain: FallbackEntry[] = [
      { provider: 'groq', model: 'playai-tts' },
    ];

    const result = diversifyChain(chain, 'tts', available('groq', 'openai'));

    expect(result.length).toBe(2);
    expect(result[1].provider).toBe('openai');
    expect(result[1].model).toBe('gpt-4o-mini-tts');
  });

  // ── Multi-provider chain is unchanged ───────────────────────────────────

  it('returns chain unchanged when already multi-provider', () => {
    const chain: FallbackEntry[] = [
      { provider: 'groq', model: 'whisper-large-v3-turbo' },
      { provider: 'openai', model: 'whisper-1' },
    ];

    const result = diversifyChain(chain, 'stt', available('groq', 'openai', 'deepgram'));

    expect(result).toEqual(chain);
    // Should be reference-equal (no copy needed)
    expect(result).toBe(chain);
  });

  it('returns chain unchanged when it has 3 providers and minFamilies is 2', () => {
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'gpt-4o-mini' },
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      { provider: 'fireworks', model: 'some-model' },
    ];

    const result = diversifyChain(chain, 'llm', available('openai', 'groq', 'fireworks'));

    expect(result).toBe(chain);
  });

  // ── Backup from same provider is skipped ────────────────────────────────

  it('skips backup entries whose provider is already in the chain', () => {
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'gpt-4o-mini' },
    ];

    // Only openai is available — no other provider to diversify with
    const result = diversifyChain(chain, 'llm', available('openai'));

    // Cannot diversify, returns a copy with only openai
    expect(result.length).toBe(1);
    expect(result[0].provider).toBe('openai');
  });

  it('skips DEFAULT_BACKUPS entries matching existing chain provider', () => {
    // Chain already has openai; DEFAULT_BACKUPS for stt starts with openai
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'whisper-1' },
    ];

    const result = diversifyChain(chain, 'stt', available('openai', 'groq', 'deepgram'));

    // Should skip the openai backup and pick groq instead
    expect(result.length).toBe(2);
    expect(result[0].provider).toBe('openai');
    expect(result[1].provider).toBe('groq');
  });

  // ── Missing API key: entry not injected ─────────────────────────────────

  it('does not inject backup when backup provider has no API key', () => {
    const chain: FallbackEntry[] = [
      { provider: 'fireworks', model: 'some-model' },
    ];

    // Only fireworks is available, no openai/groq keys
    const result = diversifyChain(chain, 'llm', available('fireworks'));

    expect(result.length).toBe(1);
    expect(result[0].provider).toBe('fireworks');
  });

  it('skips unavailable backups and picks the first available one', () => {
    const chain: FallbackEntry[] = [
      { provider: 'groq', model: 'whisper-large-v3-turbo' },
    ];

    // openai is NOT available, but deepgram is
    const result = diversifyChain(chain, 'stt', available('groq', 'deepgram'));

    expect(result.length).toBe(2);
    expect(result[1].provider).toBe('deepgram');
    expect(result[1].model).toBe('nova-3');
  });

  // ── Custom backupEntries override defaults ──────────────────────────────

  it('uses custom backupEntries when provided', () => {
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'gpt-4o-mini' },
    ];

    const config: DiversifyConfig = {
      backupEntries: {
        llm: [
          { provider: 'anthropic', model: 'claude-3-haiku' },
          { provider: 'groq', model: 'llama-3.3-70b-versatile' },
        ],
      },
    };

    const result = diversifyChain(chain, 'llm', available('openai', 'anthropic', 'groq'), config);

    expect(result.length).toBe(2);
    expect(result[1].provider).toBe('anthropic');
    expect(result[1].model).toBe('claude-3-haiku');
  });

  it('custom backupEntries with no matching stage falls through gracefully', () => {
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'gpt-4o-mini' },
    ];

    const config: DiversifyConfig = {
      backupEntries: {
        stt: [{ provider: 'groq', model: 'whisper-large-v3-turbo' }],
        // No 'llm' key
      },
    };

    // Stage is 'llm' but custom backupEntries only has 'stt'
    // Should fall back to DEFAULT_BACKUPS for llm
    const result = diversifyChain(chain, 'llm', available('openai', 'groq'), config);

    expect(result.length).toBe(2);
    expect(result[1].provider).toBe('groq');
  });

  // ── Empty chain handled gracefully ──────────────────────────────────────

  it('returns empty array for empty chain', () => {
    const result = diversifyChain([], 'llm', available('openai', 'groq'));
    expect(result).toEqual([]);
  });

  // ── Config: enabled = false ─────────────────────────────────────────────

  it('returns chain unchanged when enabled is false', () => {
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'gpt-4o-mini' },
    ];

    const result = diversifyChain(chain, 'llm', available('openai', 'groq'), { enabled: false });

    expect(result).toBe(chain);
    expect(result.length).toBe(1);
  });

  // ── Config: custom minFamilies ──────────────────────────────────────────

  it('respects custom minFamilies = 3', () => {
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'gpt-4o-mini' },
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    ];

    const result = diversifyChain(chain, 'llm', available('openai', 'groq', 'fireworks'), {
      minFamilies: 3,
    });

    expect(result.length).toBe(3);
    const providers = new Set(result.map((e) => e.provider));
    expect(providers.size).toBe(3);
    expect(providers.has('fireworks')).toBe(true);
  });

  it('minFamilies = 1 means any chain is accepted as-is', () => {
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'gpt-4o-mini' },
    ];

    const result = diversifyChain(chain, 'llm', available('openai', 'groq'), {
      minFamilies: 1,
    });

    expect(result).toBe(chain);
  });

  // ── Unknown stage (no default backups) ──────────────────────────────────

  it('returns chain unchanged for unknown stage with no backups', () => {
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'some-model' },
    ];

    const result = diversifyChain(chain, 'embedding', available('openai', 'groq'));

    // No DEFAULT_BACKUPS for 'embedding', so chain is returned as-is
    expect(result.length).toBe(1);
    expect(result[0].provider).toBe('openai');
  });

  // ── Does not mutate original chain ──────────────────────────────────────

  it('does not mutate the original chain array', () => {
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'gpt-4o-mini' },
    ];

    const originalLength = chain.length;
    const result = diversifyChain(chain, 'llm', available('openai', 'groq'));

    expect(chain.length).toBe(originalLength);
    expect(result.length).toBeGreaterThan(originalLength);
    expect(result).not.toBe(chain);
  });

  // ── Only appends enough to reach minFamilies ───────────────────────────

  it('stops appending once minFamilies is reached', () => {
    const chain: FallbackEntry[] = [
      { provider: 'openai', model: 'gpt-4o-mini' },
    ];

    // All three backup providers are available, but only one should be added (default minFamilies=2)
    const result = diversifyChain(chain, 'llm', available('openai', 'groq', 'fireworks'));

    const providers = new Set(result.map((e) => e.provider));
    expect(providers.size).toBe(2);
    // Should have added only one backup (groq, the first non-openai with a key)
    expect(result.length).toBe(2);
  });
});

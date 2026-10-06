import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveChatProvider } from '../../src/gateway/pipeline/chat-completions-service';

const hasBun = (() => { try { const r = execFileSync('bun', ['--version'], { stdio: 'pipe' }); return !!r; } catch { return false; } })();

const fallback = {
  providerId: 'groq',
  chat: vi.fn(),
};

const openrouter = {
  providerId: 'openrouter',
  chat: vi.fn(),
};

describe('chat model resolution', () => {
  it('routes provider/model shorthand to provider adapter and strips provider prefix', () => {
    const { provider, resolvedModel } = resolveChatProvider('openrouter/meta-llama/llama-3.1-8b-instruct', {
      chatProviders: {},
      fallback,
      providerDefaults: {},
      providerAdapters: { openrouter },
    });

    expect(provider).toBe(openrouter);
    expect(resolvedModel).toBe('meta-llama/llama-3.1-8b-instruct');
  });

  it('keeps configured model IDs with slashes when exact match exists', () => {
    const { provider, resolvedModel } = resolveChatProvider('google/gemini-2.5-flash', {
      chatProviders: { 'google/gemini-2.5-flash': openrouter },
      fallback,
      providerDefaults: {},
      providerAdapters: { google: fallback },
    });

    expect(provider).toBe(openrouter);
    expect(resolvedModel).toBe('google/gemini-2.5-flash');
  });
});

describe.skipIf(!hasBun)('CLI media help', () => {
  it('documents image+text, audio+text, and media smoke tests', () => {
    const chatHelp = execFileSync('bun', ['bin/ai-gateway.ts', 'chat', '--help'], { encoding: 'utf8' });
    const transcribeHelp = execFileSync('bun', ['bin/ai-gateway.ts', 'transcribe', '--help'], { encoding: 'utf8' });
    const speechHelp = execFileSync('bun', ['bin/ai-gateway.ts', 'speech', '--help'], { encoding: 'utf8' });

    expect(chatHelp).toContain('--image <path>');
    expect(transcribeHelp).toContain('--prompt <text>');
    expect(speechHelp).toContain('Full speech pipeline');
  });

  it('rejects unsupported image types before sending a request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aigw-media-'));
    const badImage = join(dir, 'not-image.gif');
    writeFileSync(badImage, 'GIF89a');

    expect(() => execFileSync('bun', ['bin/ai-gateway.ts', 'chat', 'describe', '-i', badImage, '--no-stream'], { encoding: 'utf8', stdio: 'pipe' })).toThrow(/Unsupported image type/);
  });
});

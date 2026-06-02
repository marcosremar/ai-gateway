import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveChatProvider, resolveProfileChatModel } from '../../src/gateway/pipeline/chat-completions-service';

const fallback = {
  providerId: 'groq',
  chat: vi.fn(),
};

const openrouter = {
  providerId: 'openrouter',
  chat: vi.fn(),
};

const minimax = {
  providerId: 'minimax',
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

  it('routes MiniMax provider/model shorthand to the MiniMax adapter', () => {
    const { provider, resolvedModel } = resolveChatProvider('minimax/MiniMax-M2.7-highspeed', {
      chatProviders: {},
      fallback,
      providerDefaults: {},
      providerAdapters: { minimax },
    });

    expect(provider).toBe(minimax);
    expect(resolvedModel).toBe('MiniMax-M2.7-highspeed');
  });

  it('keeps MiniMax exact model IDs when they are registered in provider map', () => {
    const { provider, resolvedModel } = resolveChatProvider('MiniMax-M2.7-highspeed', {
      chatProviders: { 'MiniMax-M2.7-highspeed': minimax },
      fallback,
      providerDefaults: {},
      providerAdapters: {},
    });

    expect(provider).toBe(minimax);
    expect(resolvedModel).toBe('MiniMax-M2.7-highspeed');
  });

  it('turns app profile provider+model entries into direct provider routing', () => {
    expect(resolveProfileChatModel({ provider: 'minimax', model: 'MiniMax-M2.7-highspeed' }))
      .toBe('minimax/MiniMax-M2.7-highspeed');
    expect(resolveProfileChatModel({ provider: 'gpu', model: 'qwen3-coder' }))
      .toBe('qwen3-coder');
  });
});

describe('CLI media help', () => {
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

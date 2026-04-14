/**
 * CLI integration tests — exercises ai-gateway CLI commands against
 * either a local server (auto-started) or the live Fly.io deployment.
 *
 * These tests call the actual CLI binary via child_process and verify
 * stdout/stderr + exit codes. They are NOT unit tests — they hit real
 * endpoints and real providers.
 *
 * Environment:
 *   AI_GATEWAY_URL  — gateway to test against (default: local auto-start)
 *   AI_GATEWAY_KEY  — API key (optional for localhost)
 *   SKIP_CLI_TESTS  — set to '1' to skip (they're slow, ~60s total)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, type ExecSyncOptions } from 'child_process';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const SKIP = process.env.SKIP_CLI_TESTS === '1';
const CLI = resolve(__dirname, '..', 'bin', 'ai-gateway.ts');
const TIMEOUT = 30_000;

function cli(args: string, opts?: { env?: Record<string, string>; timeout?: number }): { stdout: string; exitCode: number } {
  const env = {
    ...process.env,
    AI_GATEWAY_URL: process.env.AI_GATEWAY_URL || 'https://parle-ai-gateway.fly.dev',
    AI_GATEWAY_KEY: process.env.AI_GATEWAY_KEY || process.env.GATEWAY_API_KEY || '',
    ...opts?.env,
  };
  try {
    const stdout = execSync(`bun ${CLI} ${args}`, {
      env,
      timeout: opts?.timeout ?? TIMEOUT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || '').trim() + (err.stderr || '').trim(),
      exitCode: err.status ?? 1,
    };
  }
}

describe.skipIf(SKIP)('CLI — help system', () => {
  it('shows main help with no args', () => {
    const r = cli('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ai-gateway CLI');
    expect(r.stdout).toContain('Commands:');
  });

  it('shows main help with --help', () => {
    const r = cli('--help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Commands:');
  });

  it('shows main help with help', () => {
    const r = cli('help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Commands:');
  });

  const commands = ['chat', 'transcribe', 'tts', 'image', 'gpu', 'metrics',
    'health', 'models', 'translate', 'voices', 'config', 'whoami', 'ping',
    'benchmark', 'latency', 'server'];

  for (const cmd of commands) {
    it(`shows help for '${cmd}'`, () => {
      const r = cli(`${cmd} help`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(20);
    });

    it(`shows help for 'help ${cmd}'`, () => {
      const r = cli(`help ${cmd}`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(20);
    });
  }

  it('shows error for unknown command', () => {
    const r = cli('nonexistent');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Unknown command');
  });
});

describe.skipIf(SKIP)('CLI — health & config', () => {
  it('health returns ok', () => {
    const r = cli('health');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Status: ok');
  });

  it('health shows connection count', () => {
    const r = cli('health');
    expect(r.stdout).toContain('Connections:');
  });

  it('config shows URL and key', () => {
    const r = cli('config');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Gateway URL:');
    expect(r.stdout).toMatch(/connected|unreachable/);
  });

  it('whoami shows user identity', () => {
    const r = cli('whoami');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('User:');
    expect(r.stdout).toContain('Auth:');
  });

  it('server status shows running state', () => {
    const r = cli('server status');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/running|not running/);
  });
});

describe.skipIf(SKIP)('CLI — models', () => {
  it('lists available models', () => {
    const r = cli('models');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('models:');
    expect(r.stdout).toContain('llama-3.1-8b-instant');
  });

  it('lists at least 5 models', () => {
    const r = cli('models');
    const match = r.stdout.match(/(\d+) models/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1])).toBeGreaterThanOrEqual(5);
  });
});

describe.skipIf(SKIP)('CLI — chat', () => {
  it('chat non-streaming returns content', () => {
    const r = cli('chat "Say OK" --no-stream --max-tokens 5');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('chat shows token usage in non-stream mode', () => {
    const r = cli('chat "Say OK" --no-stream --max-tokens 5');
    expect(r.stdout).toContain('[tokens:');
  });

  it('chat streaming works', () => {
    const r = cli('chat "Say OK" --max-tokens 5');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('chat with specific model works', () => {
    const r = cli('chat "Say hi" -m llama-3.3-70b-versatile --no-stream --max-tokens 5');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('chat rejects proprietary models with 404', () => {
    const r = cli('chat "hi" -m gpt-4o --no-stream');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('not found');
  });

  it('chat without message shows usage', () => {
    const r = cli('chat');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage:');
  });
});

describe.skipIf(SKIP)('CLI — translate', () => {
  it('translates text with auto-detect', () => {
    const r = cli('translate "Bonjour"');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toMatch(/hello|hi|good/);
  });

  it('translates with --from and --to', () => {
    const r = cli('translate "Hello" --from en --to fr');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toMatch(/bonjour|salut/);
  });
});

describe.skipIf(SKIP)('CLI — transcribe (STT)', () => {
  const wavPath = '/tmp/cli-test-stt.wav';

  beforeAll(() => {
    // Generate a 1s silence WAV
    execSync(`python3 -c "
import wave, struct, io
buf = io.BytesIO()
with wave.open(buf, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(struct.pack('<' + 'h' * 16000, *([0] * 16000)))
open('${wavPath}', 'wb').write(buf.getvalue())
"`);
  });

  it('transcribes a WAV file', () => {
    const r = cli(`transcribe ${wavPath}`);
    expect(r.exitCode).toBe(0);
    // Silence produces some text (Whisper often hallucinates on silence)
    expect(typeof r.stdout).toBe('string');
  });

  it('rejects missing file', () => {
    const r = cli('transcribe /nonexistent/file.wav');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('not found');
  });

  it('shows usage without args', () => {
    const r = cli('transcribe');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage:');
  });
});

describe.skipIf(SKIP)('CLI — TTS', () => {
  const outPath = '/tmp/cli-test-tts.wav';

  afterAll(() => {
    try { unlinkSync(outPath); } catch { /* ok */ }
  });

  it('generates audio file', () => {
    const r = cli(`tts "hello" -o ${outPath}`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Audio saved');
    expect(existsSync(outPath)).toBe(true);
  });

  it('shows usage without text', () => {
    const r = cli('tts');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage:');
  });
});

describe.skipIf(SKIP)('CLI — voices', () => {
  it('lists available voices', () => {
    const r = cli('voices');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('autumn');
    expect(r.stdout).toContain('daniel');
    expect(r.stdout).toContain('Female');
    expect(r.stdout).toContain('Male');
  });
});

describe.skipIf(SKIP)('CLI — image', () => {
  const outPath = '/tmp/cli-test-img.jpg';

  afterAll(() => {
    try { unlinkSync(outPath); } catch { /* ok */ }
  });

  it('generates an image', () => {
    const r = cli(`image "red dot" -o ${outPath}`, { timeout: 45_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Image saved');
    expect(existsSync(outPath)).toBe(true);
  });

  it('shows usage without prompt', () => {
    const r = cli('image');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage:');
  });
});

describe.skipIf(SKIP)('CLI — ping', () => {
  it('pings the gateway and shows stats', () => {
    const r = cli('ping -n 3');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('avg=');
    expect(r.stdout).toContain('p50=');
    expect(r.stdout).toMatch(/\d+ms/);
  });
});

describe.skipIf(SKIP)('CLI — GPU commands (proxy-only)', () => {
  it('gpu status shows proxy-only message', () => {
    const r = cli('gpu status');
    expect(r.exitCode).toBe(0);
    // Either shows GPU info or proxy-only message
    expect(r.stdout).toMatch(/status|proxy-only|not available/i);
  });

  it('gpu list handles proxy-only gracefully', () => {
    const r = cli('gpu list');
    expect(r.exitCode).toBe(0);
  });

  it('gpu terminate requires instanceId', () => {
    const r = cli('gpu terminate');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage:');
  });

  it('gpu help shows all subcommands', () => {
    const r = cli('gpu help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('status');
    expect(r.stdout).toContain('deploy');
    expect(r.stdout).toContain('terminate');
  });
});

describe.skipIf(SKIP)('CLI — latency commands (proxy-only)', () => {
  it('latency hosts handles proxy-only gracefully', () => {
    const r = cli('latency hosts');
    expect(r.exitCode).toBe(0);
  });

  it('latency help shows subcommands', () => {
    const r = cli('latency help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hosts');
    expect(r.stdout).toContain('probe');
    expect(r.stdout).toContain('best');
  });
});

describe.skipIf(SKIP)('CLI — auth errors', () => {
  it('rejects with wrong key', () => {
    const r = cli('chat "hi" --no-stream', { env: { AI_GATEWAY_KEY: 'wrong-key' } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/401|Invalid|missing/i);
  });
});

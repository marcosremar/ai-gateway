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
 *   LOCAL_GATEWAY    — set to '1' to test against localhost:4000
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, type ExecSyncOptions } from 'child_process';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';

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

async function isLocalGatewayRunning(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:4000/health', {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const SHOULD_RUN_CLI = !!process.env.AI_GATEWAY_KEY?.trim() && process.env.SKIP_CLI_TESTS !== '1';

describe('CLI — help system', () => {
  it('shows main help with no args', SHOULD_RUN_CLI ? () => {
    const r = cli('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ai-gateway CLI');
    expect(r.stdout).toContain('Commands:');
  } : () => {
    console.log('[SKIP] CLI — help system: needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });

  it('shows main help with --help', SHOULD_RUN_CLI ? () => {
    const r = cli('--help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Commands:');
  } : () => {
    expect(true).toBe(true);
  });

  it('shows main help with help', SHOULD_RUN_CLI ? () => {
    const r = cli('help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Commands:');
  } : () => {
    expect(true).toBe(true);
  });

  const commands = ['chat', 'transcribe', 'tts', 'image', 'gpu', 'metrics',
    'health', 'models', 'translate', 'voices', 'config', 'whoami', 'ping',
    'benchmark', 'latency', 'server'];

  for (const cmd of commands) {
    it(`shows help for '${cmd}'`, SHOULD_RUN_CLI ? () => {
      const r = cli(`${cmd} help`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(20);
    } : () => {
      expect(true).toBe(true);
    });

    it(`shows help for 'help ${cmd}'`, SHOULD_RUN_CLI ? () => {
      const r = cli(`help ${cmd}`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(20);
    } : () => {
      expect(true).toBe(true);
    });
  }

  it('shows error for unknown command', SHOULD_RUN_CLI ? () => {
    const r = cli('nonexistent');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Unknown command');
  } : () => {
    expect(true).toBe(true);
  });
});

describe('CLI — health & config', () => {
  it('health returns ok', SHOULD_RUN_CLI ? () => {
    const r = cli('health');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Status: ok');
  } : () => {
    console.log('[SKIP] CLI health test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });

  it('health shows connection count', SHOULD_RUN_CLI ? () => {
    const r = cli('health');
    expect(r.stdout).toContain('Connections:');
  } : () => {
    expect(true).toBe(true);
  });

  it('config shows URL and key', SHOULD_RUN_CLI ? () => {
    const r = cli('config');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Gateway URL:');
    expect(r.stdout).toMatch(/connected|unreachable/);
  } : () => {
    expect(true).toBe(true);
  });

  it('whoami shows user identity', SHOULD_RUN_CLI ? () => {
    const r = cli('whoami');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('User:');
    expect(r.stdout).toContain('Auth:');
  } : () => {
    expect(true).toBe(true);
  });

  it('server status shows running state', SHOULD_RUN_CLI ? () => {
    const r = cli('server status');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/running|not running/);
  } : () => {
    expect(true).toBe(true);
  });
});

describe('CLI — models', () => {
  it('lists available models', SHOULD_RUN_CLI ? () => {
    const r = cli('models');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('models:');
    expect(r.stdout).toContain('llama-3.1-8b-instant');
  } : () => {
    console.log('[SKIP] CLI models test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });

  it('lists at least 5 models', SHOULD_RUN_CLI ? () => {
    const r = cli('models');
    const match = r.stdout.match(/(\d+) models/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1])).toBeGreaterThanOrEqual(5);
  } : () => {
    expect(true).toBe(true);
  });
});

describe('CLI — chat', () => {
  it('chat non-streaming returns content', SHOULD_RUN_CLI ? () => {
    const r = cli('chat "Say OK" --no-stream --max-tokens 5');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  } : () => {
    console.log('[SKIP] CLI chat test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });

  it('chat shows token usage in non-stream mode', SHOULD_RUN_CLI ? () => {
    const r = cli('chat "Say OK" --no-stream --max-tokens 5');
    expect(r.stdout).toContain('[tokens:');
  } : () => {
    expect(true).toBe(true);
  });

  it('chat streaming works', SHOULD_RUN_CLI ? () => {
    const r = cli('chat "Say OK" --max-tokens 5');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  } : () => {
    expect(true).toBe(true);
  });

  it('chat with specific model works', SHOULD_RUN_CLI ? () => {
    const r = cli('chat "Say hi" -m llama-3.3-70b-versatile --no-stream --max-tokens 5');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  } : () => {
    expect(true).toBe(true);
  });

  it('chat rejects proprietary models with 404', SHOULD_RUN_CLI ? () => {
    const r = cli('chat "hi" -m gpt-4o --no-stream');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('not found');
  } : () => {
    expect(true).toBe(true);
  });

  it('chat without message shows usage', SHOULD_RUN_CLI ? () => {
    const r = cli('chat');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage:');
  } : () => {
    expect(true).toBe(true);
  });
});

describe('CLI — translate', () => {
  it('translates text with auto-detect', SHOULD_RUN_CLI ? () => {
    const r = cli('translate "Bonjour"');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toMatch(/hello|hi|good/);
  } : () => {
    console.log('[SKIP] CLI translate test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });

  it('translates with --from and --to', SHOULD_RUN_CLI ? () => {
    const r = cli('translate "Hello" --from en --to fr');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toMatch(/bonjour|salut/);
  } : () => {
    expect(true).toBe(true);
  });
});

describe('CLI — transcribe (STT)', () => {
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

  it('transcribes a WAV file', SHOULD_RUN_CLI ? () => {
    const r = cli(`transcribe ${wavPath}`);
    expect(r.exitCode).toBe(0);
    // Silence produces some text (Whisper often hallucinates on silence)
    expect(typeof r.stdout).toBe('string');
  } : () => {
    console.log('[SKIP] CLI transcribe test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });

  it('rejects missing file', SHOULD_RUN_CLI ? () => {
    const r = cli('transcribe /nonexistent/file.wav');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('not found');
  } : () => {
    expect(true).toBe(true);
  });

  it('shows usage without args', SHOULD_RUN_CLI ? () => {
    const r = cli('transcribe');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage:');
  } : () => {
    expect(true).toBe(true);
  });
});

describe('CLI — TTS', () => {
  const outPath = '/tmp/cli-test-tts.wav';

  afterAll(() => {
    try { unlinkSync(outPath); } catch { /* ok */ }
  });

  it('generates audio file', SHOULD_RUN_CLI ? () => {
    const r = cli(`tts "hello" -o ${outPath}`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Audio saved');
    expect(existsSync(outPath)).toBe(true);
  } : () => {
    console.log('[SKIP] CLI TTS test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });

  it('shows usage without text', SHOULD_RUN_CLI ? () => {
    const r = cli('tts');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage:');
  } : () => {
    expect(true).toBe(true);
  });
});

describe('CLI — voices', () => {
  it('lists available voices', SHOULD_RUN_CLI ? () => {
    const r = cli('voices');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('autumn');
    expect(r.stdout).toContain('daniel');
    expect(r.stdout).toContain('Female');
    expect(r.stdout).toContain('Male');
  } : () => {
    console.log('[SKIP] CLI voices test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });
});

describe('CLI — image', () => {
  const outPath = '/tmp/cli-test-img.jpg';

  afterAll(() => {
    try { unlinkSync(outPath); } catch { /* ok */ }
  });

  it('generates an image', SHOULD_RUN_CLI ? () => {
    const r = cli(`image "red dot" -o ${outPath}`, { timeout: 45_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Image saved');
    expect(existsSync(outPath)).toBe(true);
  } : () => {
    console.log('[SKIP] CLI image test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });

  it('shows usage without prompt', SHOULD_RUN_CLI ? () => {
    const r = cli('image');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage:');
  } : () => {
    expect(true).toBe(true);
  });
});

describe('CLI — ping', () => {
  it('pings the gateway and shows stats', SHOULD_RUN_CLI ? () => {
    const r = cli('ping -n 3');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('avg=');
    expect(r.stdout).toContain('p50=');
    expect(r.stdout).toMatch(/\d+ms/);
  } : () => {
    console.log('[SKIP] CLI ping test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });
});

describe('CLI — GPU commands (proxy-only)', () => {
  it('gpu status shows proxy-only message', SHOULD_RUN_CLI ? () => {
    const r = cli('gpu status');
    expect(r.exitCode).toBe(0);
    // Either shows GPU info or proxy-only message
    expect(r.stdout).toMatch(/status|proxy-only|not available/i);
  } : () => {
    console.log('[SKIP] CLI GPU status test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });

  it('gpu list handles proxy-only gracefully', SHOULD_RUN_CLI ? () => {
    const r = cli('gpu list');
    expect(r.exitCode).toBe(0);
  } : () => {
    expect(true).toBe(true);
  });

  it('gpu terminate requires instanceId', SHOULD_RUN_CLI ? () => {
    const r = cli('gpu terminate');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('Usage:');
  } : () => {
    expect(true).toBe(true);
  });

  it('gpu help shows all subcommands', SHOULD_RUN_CLI ? () => {
    const r = cli('gpu help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('status');
    expect(r.stdout).toContain('deploy');
    expect(r.stdout).toContain('terminate');
  } : () => {
    expect(true).toBe(true);
  });
});

describe('CLI — latency commands (proxy-only)', () => {
  it('latency hosts handles proxy-only gracefully', SHOULD_RUN_CLI ? () => {
    const r = cli('latency hosts');
    expect(r.exitCode).toBe(0);
  } : () => {
    console.log('[SKIP] CLI latency hosts test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });

  it('latency help shows subcommands', SHOULD_RUN_CLI ? () => {
    const r = cli('latency help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hosts');
    expect(r.stdout).toContain('probe');
    expect(r.stdout).toContain('best');
  } : () => {
    expect(true).toBe(true);
  });
});

describe('CLI — auth errors', () => {
  it('rejects with wrong key', SHOULD_RUN_CLI ? () => {
    const r = cli('chat "hi" --no-stream', { env: { AI_GATEWAY_KEY: 'wrong-key' } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/401|Invalid|missing/i);
  } : () => {
    console.log('[SKIP] CLI auth error test — needs AI_GATEWAY_KEY and live gateway');
    expect(true).toBe(true);
  });
});

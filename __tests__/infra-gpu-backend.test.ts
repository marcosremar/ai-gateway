/**
 * Tests for infra/gpu-backend.ts
 * - sshOpts()
 * - sshCmd()
 * - getSkySSHArgs()
 * - stripAnsi()
 * - SKY_BIN
 * - execAsync export
 */

import { describe, it, expect } from 'vitest';
import {
  sshOpts,
  sshCmd,
  stripAnsi,
  SKY_BIN,
  execAsync,
} from '../src/infra/gpu-backend';

describe('sshOpts', () => {
  it('returns default SSH options', () => {
    const opts = sshOpts();
    expect(opts).toContain('-o');
    expect(opts).toContain('StrictHostKeyChecking=no');
    expect(opts).toContain('BatchMode=yes');
  });

  it('includes ConnectTimeout option', () => {
    const opts = sshOpts(15);
    expect(opts.join(' ')).toContain('ConnectTimeout=15');
  });

  it('uses default connectTimeout=10', () => {
    const opts = sshOpts();
    expect(opts.join(' ')).toContain('ConnectTimeout=10');
  });

  it('returns an array of strings', () => {
    const opts = sshOpts(5);
    expect(Array.isArray(opts)).toBe(true);
    for (const o of opts) {
      expect(typeof o).toBe('string');
    }
  });

  it('each call returns a new array', () => {
    const opts1 = sshOpts(10);
    const opts2 = sshOpts(10);
    expect(opts1).not.toBe(opts2);
  });
});

describe('sshCmd', () => {
  it('builds a valid SSH command string', () => {
    const cmd = sshCmd('my-cluster', 'echo hello');
    expect(cmd).toContain('ssh');
    expect(cmd).toContain('my-cluster');
    expect(cmd).toContain('echo hello');
  });

  it('wraps remote command in single quotes', () => {
    const cmd = sshCmd('cluster', 'ls -la /tmp');
    expect(cmd).toContain("'ls -la /tmp'");
  });

  it('includes SSH options in command', () => {
    const cmd = sshCmd('cluster', 'echo test', 5);
    expect(cmd).toContain('StrictHostKeyChecking=no');
    expect(cmd).toContain('ConnectTimeout=5');
  });

  it('uses default connectTimeout', () => {
    const cmd = sshCmd('cluster', 'echo test');
    expect(cmd).toContain('ConnectTimeout=10');
  });
});

describe('stripAnsi', () => {
  it('removes ANSI color codes', () => {
    const colored = '\x1b[32mGreen text\x1b[0m';
    expect(stripAnsi(colored)).toBe('Green text');
  });

  it('removes multiple ANSI codes', () => {
    const text = '\x1b[1m\x1b[34mBold Blue\x1b[0m and \x1b[31mRed\x1b[0m';
    expect(stripAnsi(text)).toBe('Bold Blue and Red');
  });

  it('leaves non-ANSI text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('handles complex ANSI sequences', () => {
    const complex = '\x1b[0;1;32mStatus: \x1b[0mOK\x1b[0m';
    expect(stripAnsi(complex)).toBe('Status: OK');
  });

  it('handles text with numbers in ANSI codes', () => {
    const text = '\x1b[38;5;196mRed256\x1b[0m';
    expect(stripAnsi(text)).toBe('Red256');
  });
});

describe('SKY_BIN', () => {
  it('is a non-empty string', () => {
    expect(typeof SKY_BIN).toBe('string');
    expect(SKY_BIN.length).toBeGreaterThan(0);
  });

  it('ends with /sky', () => {
    expect(SKY_BIN.endsWith('/sky')).toBe(true);
  });

  it('contains vendor/skypilot-venv/bin/sky path', () => {
    expect(SKY_BIN).toContain('vendor');
    expect(SKY_BIN).toContain('skypilot-venv');
    expect(SKY_BIN).toContain('bin');
  });
});

describe('execAsync', () => {
  it('is a function', () => {
    expect(typeof execAsync).toBe('function');
  });

  it('executes a simple command', async () => {
    const { stdout } = await execAsync('echo "hello"');
    expect(stdout.trim()).toBe('hello');
  });

  it('returns stdout and stderr', async () => {
    const result = await execAsync('echo "test"');
    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('stderr');
  });

  it('throws on non-zero exit code', async () => {
    await expect(execAsync('false')).rejects.toThrow();
  });
});

describe('getSkySSHArgs (fallback behavior)', async () => {
  // We can't test the file-reading path easily, but we can test the fallback
  it('falls back to cluster name as host when SSH config missing', async () => {
    // For a non-existent cluster, should fallback to cluster name
    const { getSkySSHArgs } = await import('../src/infra/gpu-backend');
    const args = await getSkySSHArgs('nonexistent-cluster-xyz');
    // Fallback: args should contain the cluster name
    expect(args.join(' ')).toContain('nonexistent-cluster-xyz');
  });

  it('includes SSH options in fallback', async () => {
    const { getSkySSHArgs } = await import('../src/infra/gpu-backend');
    const args = await getSkySSHArgs('nonexistent-cluster-xyz');
    expect(args.join(' ')).toContain('StrictHostKeyChecking=no');
  });
});

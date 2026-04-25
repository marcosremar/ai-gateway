/**
 * VM offload / onload helper — SSH file-protocol contract.
 *
 * Mocks the SshExec seam so no real network traffic is generated. Verifies
 * that offloadVm touches /tmp/bench.offload then polls for the readiness
 * sentinel /tmp/bench.offloaded, and that onloadVm does the same for
 * /tmp/bench.onload → /tmp/bench.ready. Also asserts timeout semantics so
 * future callers can rely on the return value (true/false) instead of
 * catching exceptions.
 */
import { describe, it, expect } from 'vitest';
import { offloadVm, onloadVm, type SshExec } from '../src/gateway/providers/gpu/vm-offload';

const TARGET = { host: '10.0.0.1', port: 22 };

interface Call {
  argv: string[];
}

/**
 * Build a mock SshExec that records every invocation and answers based on
 * the trailing `touch <path>` / `test -f <path>` shape the helpers emit.
 * After the touch is observed, subsequent `test -f` probes for `sentinel`
 * succeed; all other probes fail.
 */
function makeExec(opts: {
  touchTarget: string;
  sentinel: string;
  /** How many `test -f sentinel` calls to fail before succeeding. */
  pollsBeforeReady?: number;
}): { exec: SshExec; calls: Call[] } {
  const calls: Call[] = [];
  let touched = false;
  let polls = 0;
  const exec: SshExec = async (cmd, argv) => {
    calls.push({ argv });
    // Last argv element is the remote shell command.
    const remote = argv[argv.length - 1] ?? '';
    if (remote.startsWith('touch ')) {
      if (remote === `touch ${opts.touchTarget}`) touched = true;
      return { stdout: '', stderr: '' };
    }
    if (remote.startsWith('test -f ')) {
      const path = remote.slice('test -f '.length);
      if (path === opts.sentinel && touched) {
        polls += 1;
        if (polls > (opts.pollsBeforeReady ?? 0)) return { stdout: '', stderr: '' };
        throw new Error('not yet');
      }
      throw new Error('missing');
    }
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

describe('offloadVm', () => {
  it('touches /tmp/bench.offload and polls for /tmp/bench.offloaded', async () => {
    const { exec, calls } = makeExec({
      touchTarget: '/tmp/bench.offload',
      sentinel: '/tmp/bench.offloaded',
    });
    const ok = await offloadVm(TARGET, { exec, timeoutMs: 2_000 });
    expect(ok).toBe(true);
    const touchCall = calls.find((c) => c.argv[c.argv.length - 1] === 'touch /tmp/bench.offload');
    expect(touchCall).toBeTruthy();
    const probeCall = calls.find(
      (c) => c.argv[c.argv.length - 1] === 'test -f /tmp/bench.offloaded',
    );
    expect(probeCall).toBeTruthy();
  });

  it('returns false when sentinel never appears within timeout', async () => {
    const exec: SshExec = async (_cmd, argv) => {
      const remote = argv[argv.length - 1] ?? '';
      if (remote.startsWith('touch ')) return { stdout: '', stderr: '' };
      // Always fail test -f — sentinel never appears.
      throw new Error('missing');
    };
    const started = Date.now();
    const ok = await offloadVm(TARGET, { exec, timeoutMs: 500 });
    const elapsed = Date.now() - started;
    expect(ok).toBe(false);
    // Should bail out near the 500ms budget, not wait indefinitely.
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe('onloadVm', () => {
  it('touches /tmp/bench.onload and polls for /tmp/bench.ready', async () => {
    const { exec, calls } = makeExec({
      touchTarget: '/tmp/bench.onload',
      sentinel: '/tmp/bench.ready',
      pollsBeforeReady: 1,
    });
    const ok = await onloadVm(TARGET, { exec, timeoutMs: 5_000 });
    expect(ok).toBe(true);
    const touchCall = calls.find((c) => c.argv[c.argv.length - 1] === 'touch /tmp/bench.onload');
    expect(touchCall).toBeTruthy();
    const probeCall = calls.find(
      (c) => c.argv[c.argv.length - 1] === 'test -f /tmp/bench.ready',
    );
    expect(probeCall).toBeTruthy();
  });

  it('uses ubuntu user and passes the SSH port', async () => {
    const recorded: string[][] = [];
    const exec: SshExec = async (_cmd, argv) => {
      recorded.push(argv);
      const remote = argv[argv.length - 1] ?? '';
      if (remote.startsWith('touch ')) return { stdout: '', stderr: '' };
      if (remote === 'test -f /tmp/bench.ready') return { stdout: '', stderr: '' };
      throw new Error('missing');
    };
    await onloadVm({ host: 'gpu-1.example', port: 2222 }, { exec, timeoutMs: 1_000 });
    // Ensure the SSH argv has -p 2222 and the user@host token.
    const argv = recorded[0]!;
    expect(argv).toContain('-p');
    const pIdx = argv.indexOf('-p');
    expect(argv[pIdx + 1]).toBe('2222');
    expect(argv.some((a) => a === 'ubuntu@gpu-1.example')).toBe(true);
  });
});

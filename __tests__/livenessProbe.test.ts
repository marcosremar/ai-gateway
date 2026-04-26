/**
 * Unit tests for `tcpProbe`, `pickProbeTarget`, and `classifyLiveness`.
 *
 * `tcpProbe` is exercised against a real `net.Server` listening on
 * 127.0.0.1 with a random port — that's the same code path the CLI
 * uses, no mocks. The other two are pure functions with table-driven
 * cases.
 *
 * The dead-host test deliberately picks a port that nothing listens on
 * locally (we close the server first, then probe). That guarantees an
 * ECONNREFUSED — fast and deterministic, no flaky DNS or network.
 *
 * The timeout test uses `1.0.0.1:1` — a routed-but-unfiltered IP whose
 * port 1 we do NOT expect to answer. The OS drops the SYN; the connect
 * times out. If your CI sandbox blocks outbound traffic this test will
 * still pass (sandbox = silent drop = timeout). What it must NOT do is
 * connect successfully or error fast — both would falsify the timeout
 * semantics, and that's the whole reason the test exists.
 */

import { describe, it, expect } from 'vitest';
import * as net from 'net';
import {
  tcpProbe,
  pickProbeTarget,
  classifyLiveness,
} from '../src/gateway/providers/gpu/livenessProbe';

/** Spin up a 127.0.0.1 listener on a random port; tests close it. */
function listenLocal(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no address'));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe('tcpProbe', () => {
  it('returns true when the port accepts a connection', async () => {
    const srv = await listenLocal();
    try {
      const alive = await tcpProbe('127.0.0.1', srv.port, 1000);
      expect(alive).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('returns false fast for a refused TCP port (ECONNREFUSED)', async () => {
    // Open then immediately close to grab a port that we KNOW is free
    // and that the kernel will RST on connect attempts.
    const srv = await listenLocal();
    const deadPort = srv.port;
    await srv.close();

    const t0 = Date.now();
    const alive = await tcpProbe('127.0.0.1', deadPort, 5000);
    const dt = Date.now() - t0;

    expect(alive).toBe(false);
    // Refused connect is < 50ms locally; the assertion is just "we did
    // not wait the full timeout" which would mean the early-error path
    // is broken.
    expect(dt).toBeLessThan(2000);
  });

  it('respects timeoutMs when the host silently drops SYNs', async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737) — guaranteed unallocated.
    // Routers on a normal network don't have a path; the kernel sits
    // in SYN_SENT until our timer fires. If your sandbox blocks all
    // egress, the result is the same.
    const t0 = Date.now();
    const alive = await tcpProbe('192.0.2.1', 1, 250);
    const dt = Date.now() - t0;

    expect(alive).toBe(false);
    // Allow generous slack: the timeout is 250ms; we want to confirm
    // we did NOT wait the default 3000ms (the bug we'd regress to if
    // setTimeout call were missing).
    expect(dt).toBeLessThan(2500);
  });

  it('always resolves — never throws', async () => {
    // Bad hostnames are the obvious ones. We use an invalid label so the
    // resolver gives up immediately rather than hammering DNS.
    const result = await tcpProbe('not.a.real.host.invalid', 1, 200).catch(() => 'threw');
    expect(result).not.toBe('threw');
    expect(result).toBe(false);
  });
});

describe('pickProbeTarget', () => {
  it('picks host+port from an http endpoint', () => {
    const t = pickProbeTarget({ endpoint: 'http://1.2.3.4:8080' });
    expect(t).toEqual({ host: '1.2.3.4', port: 8080 });
  });

  it('defaults to 80 for http with no port', () => {
    const t = pickProbeTarget({ endpoint: 'http://example.com' });
    expect(t).toEqual({ host: 'example.com', port: 80 });
  });

  it('defaults to 443 for https with no port', () => {
    const t = pickProbeTarget({ endpoint: 'https://example.com' });
    expect(t).toEqual({ host: 'example.com', port: 443 });
  });

  it('falls back to sshHost/sshPort when there is no http endpoint', () => {
    const t = pickProbeTarget({ sshHost: 'ssh4.vast.ai', sshPort: 12345 });
    expect(t).toEqual({ host: 'ssh4.vast.ai', port: 12345 });
  });

  it('coerces string sshPort to number', () => {
    const t = pickProbeTarget({ sshHost: 'ssh4.vast.ai', sshPort: '12345' });
    expect(t).toEqual({ host: 'ssh4.vast.ai', port: 12345 });
  });

  it('prefers http endpoint over ssh when both are present', () => {
    const t = pickProbeTarget({
      endpoint: 'http://1.2.3.4:8080',
      sshHost: 'ssh4.vast.ai',
      sshPort: 12345,
    });
    // HTTP is what the user-facing app talks to, so it's the more
    // load-bearing reachability signal.
    expect(t).toEqual({ host: '1.2.3.4', port: 8080 });
  });

  it('returns null when neither endpoint nor ssh fields are set', () => {
    expect(pickProbeTarget({})).toBeNull();
  });

  it('returns null for a malformed endpoint with no ssh fallback', () => {
    expect(pickProbeTarget({ endpoint: 'not a url' })).toBeNull();
  });

  it('falls back to ssh when endpoint is malformed', () => {
    const t = pickProbeTarget({
      endpoint: 'http://[malformed',
      sshHost: 'ssh4.vast.ai',
      sshPort: 12345,
    });
    expect(t).toEqual({ host: 'ssh4.vast.ai', port: 12345 });
  });

  it('rejects nonsense ports', () => {
    expect(pickProbeTarget({ sshHost: 'h', sshPort: 'abc' })).toBeNull();
    expect(pickProbeTarget({ sshHost: 'h', sshPort: -1 })).toBeNull();
  });
});

describe('classifyLiveness', () => {
  it('marks unknown when probe was not run', () => {
    expect(classifyLiveness('running', null)).toEqual({
      liveness: 'unknown',
      zombie: false,
    });
  });

  it('marks alive when probe succeeded', () => {
    expect(classifyLiveness('running', true)).toEqual({
      liveness: 'alive',
      zombie: false,
    });
  });

  it('marks ZOMBIE when provider says running but probe failed', () => {
    // The whole reason this code exists. Regression here means the
    // CLI would silently send work to dead pods again.
    expect(classifyLiveness('running', false)).toEqual({
      liveness: 'unreachable',
      zombie: true,
    });
  });

  it('marks ZOMBIE for uppercase RUNNING (RunPod-style status)', () => {
    // RunPod returns 'RUNNING' (uppercase). The zombie detector must
    // catch these — a dead RunPod pod showing RUNNING is the exact
    // same $-burning failure mode as a dead Vast.ai pod showing 'running'.
    expect(classifyLiveness('RUNNING', false)).toEqual({
      liveness: 'unreachable',
      zombie: true,
    });
  });

  it('marks ZOMBIE for mixed-case running variants', () => {
    expect(classifyLiveness('Running', false)).toEqual({
      liveness: 'unreachable',
      zombie: true,
    });
  });

  it('does NOT mark zombie when provider already admits non-running', () => {
    expect(classifyLiveness('booting', false)).toEqual({
      liveness: 'unreachable',
      zombie: false,
    });
    expect(classifyLiveness('error', false)).toEqual({
      liveness: 'unreachable',
      zombie: false,
    });
    expect(classifyLiveness(undefined, false)).toEqual({
      liveness: 'unreachable',
      zombie: false,
    });
  });
});

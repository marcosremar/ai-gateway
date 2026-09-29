import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BABELCAST_DIR = join(homedir(), '.babelcast');
const PID_FILE = join(BABELCAST_DIR, 'ws-server.pid');
const ACTIVE_DEPLOY_FILE = join(BABELCAST_DIR, 'active_deploy.json');

function cleanup() {
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
  try { if (existsSync(ACTIVE_DEPLOY_FILE)) unlinkSync(ACTIVE_DEPLOY_FILE); } catch {}
}

describe('pid-lock', () => {
  beforeEach(() => {
    mkdirSync(BABELCAST_DIR, { recursive: true });
    cleanup();
  });
  afterEach(cleanup);

  it('acquirePidLock writes current pid', async () => {
    const { acquirePidLock, releasePidLock } = await import('../server/ws/pid-lock');
    acquirePidLock();
    expect(existsSync(PID_FILE)).toBe(true);
    expect(readFileSync(PID_FILE, 'utf-8').trim()).toBe(String(process.pid));
    releasePidLock();
    expect(existsSync(PID_FILE)).toBe(false);
  });

  it('acquirePidLock overwrites a stale lock (non-existent pid)', async () => {
    // A pid that is virtually guaranteed not to exist.
    writeFileSync(PID_FILE, '2147483646');
    const { acquirePidLock, releasePidLock } = await import('../server/ws/pid-lock');
    acquirePidLock();
    expect(readFileSync(PID_FILE, 'utf-8').trim()).toBe(String(process.pid));
    releasePidLock();
  });
});

describe('detectOrphanDeployOnBoot', () => {
  beforeEach(() => {
    mkdirSync(BABELCAST_DIR, { recursive: true });
    cleanup();
  });
  afterEach(cleanup);

  it('keeps recent in-flight deploy with podId for re-adoption', async () => {
    writeFileSync(ACTIVE_DEPLOY_FILE, JSON.stringify({
      podId: 'pod1', endpoint: 'http://x:8000', status: 'booting',
      provider: 'hyperstack', savedAt: Date.now(),
    }));
    const { detectOrphanDeployOnBoot } = await import('../server/ws/pid-lock');
    detectOrphanDeployOnBoot();
    // Keeping avoids orphaning a live provider pod across gateway restart.
    expect(existsSync(ACTIVE_DEPLOY_FILE)).toBe(true);
  });

  it('clears nameless in-flight deploy (no podId)', async () => {
    writeFileSync(ACTIVE_DEPLOY_FILE, JSON.stringify({
      endpoint: 'http://x:8000', status: 'booting',
      provider: 'hyperstack', savedAt: Date.now(),
    }));
    const { detectOrphanDeployOnBoot } = await import('../server/ws/pid-lock');
    detectOrphanDeployOnBoot();
    expect(existsSync(ACTIVE_DEPLOY_FILE)).toBe(false);
  });

  it('leaves a ready file alone', async () => {
    writeFileSync(ACTIVE_DEPLOY_FILE, JSON.stringify({
      podId: 'pod1', endpoint: 'http://x:8000', status: 'ready',
      provider: 'hyperstack', savedAt: Date.now(),
    }));
    const { detectOrphanDeployOnBoot } = await import('../server/ws/pid-lock');
    detectOrphanDeployOnBoot();
    expect(existsSync(ACTIVE_DEPLOY_FILE)).toBe(true);
  });

  it('clears a very old file regardless of status', async () => {
    writeFileSync(ACTIVE_DEPLOY_FILE, JSON.stringify({
      podId: 'pod1', endpoint: 'http://x:8000', status: 'ready',
      provider: 'hyperstack', savedAt: Date.now() - 60 * 60 * 1000, // 1h old
    }));
    const { detectOrphanDeployOnBoot } = await import('../server/ws/pid-lock');
    detectOrphanDeployOnBoot();
    expect(existsSync(ACTIVE_DEPLOY_FILE)).toBe(false);
  });

  it('no-op when file does not exist', async () => {
    const { detectOrphanDeployOnBoot } = await import('../server/ws/pid-lock');
    expect(() => detectOrphanDeployOnBoot()).not.toThrow();
  });
});

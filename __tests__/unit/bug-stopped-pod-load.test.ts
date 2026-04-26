/**
 * Bug: loadPersistedDeploy() rejects stopped pods with empty endpoint.
 *
 * persistDeployState() intentionally persists stopped pods even when endpoint
 * is empty (line 157: `if (!isStopped && !deployState.endpoint) return;` —
 * the !isStopped guard means stopped pods skip the endpoint check).
 *
 * But loadPersistedDeploy() has `if (!data.podId || !data.endpoint) return null`
 * on line 213 — an empty string is falsy, so stopped pods with no endpoint
 * are rejected on restart. This means a stopped Vast.ai pod (which can be
 * stopped before ever receiving an endpoint) will never be recovered after
 * a gateway restart — it becomes an orphan that gets swept.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BABELCAST_DIR = join(homedir(), '.babelcast');
const ACTIVE_DEPLOY_FILE = join(BABELCAST_DIR, 'active_deploy.json');

function cleanup() {
  try { if (existsSync(ACTIVE_DEPLOY_FILE)) unlinkSync(ACTIVE_DEPLOY_FILE); } catch {}
  try { if (existsSync(ACTIVE_DEPLOY_FILE + '.tmp')) unlinkSync(ACTIVE_DEPLOY_FILE + '.tmp'); } catch {}
}

describe('loadPersistedDeploy — stopped pod with empty endpoint', () => {
  afterEach(cleanup);

  it('loads a stopped pod that has podId but empty endpoint', async () => {
    // Simulate a stopped pod persisted with empty endpoint
    // (e.g. Vast.ai pod stopped before getting an endpoint assigned)
    mkdirSync(BABELCAST_DIR, { recursive: true });
    writeFileSync(ACTIVE_DEPLOY_FILE, JSON.stringify({
      podId: 'stopped-pod-123',
      endpoint: '',  // empty — never got an endpoint before being stopped
      gpuType: 'NVIDIA GeForce RTX 4090',
      dockerImage: 'test:latest',
      provider: 'vast',
      costPerHr: 0.3,
      startedAt: Date.now() - 100000,
      sshHost: 'ssh.vast.ai',
      sshPort: 12345,
      providerMeta: {},
      savedAt: Date.now(),
      status: 'stopped',
      stoppedAt: Date.now(),
      deployId: 'deploy-test-123',
    }, null, 2));

    const mod = await import('../../src/gateway/state/deploy-state');
    const result = mod.loadPersistedDeploy();

    // A stopped pod with a podId should be loadable even without an endpoint,
    // so it can be resumed or terminated on restart.
    expect(result).not.toBeNull();
    expect(result!.podId).toBe('stopped-pod-123');
    expect(result!.status).toBe('stopped');
  });

  it('still rejects records with no podId', async () => {
    mkdirSync(BABELCAST_DIR, { recursive: true });
    writeFileSync(ACTIVE_DEPLOY_FILE, JSON.stringify({
      podId: '',
      endpoint: 'http://1.2.3.4:8080',
      gpuType: 'RTX 4090',
      dockerImage: 'test',
      provider: 'vast',
      costPerHr: 0.3,
      startedAt: Date.now(),
      sshHost: '',
      sshPort: 0,
      providerMeta: {},
      savedAt: Date.now(),
    }));

    const mod = await import('../../src/gateway/state/deploy-state');
    const result = mod.loadPersistedDeploy();
    expect(result).toBeNull();
  });
});

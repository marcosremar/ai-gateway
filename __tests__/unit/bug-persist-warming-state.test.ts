/**
 * Bug: persistDeployState() skips persisting during 'warming' status.
 *
 * When a GPU pod transitions to 'warming' (models loading after boot), the pod
 * has a valid podId and endpoint (it responds to health probes). However,
 * persistDeployState() only persists 'ready', 'booting', 'installing', and
 * 'stopped' statuses -- 'warming' is excluded.
 *
 * If the gateway restarts during the warming phase, the pod is orphaned:
 *   - Provider charges for the running instance
 *   - Gateway has no record of it
 *   - Orphan sweep eventually catches it, but there's a billing gap
 *
 * The fix: add 'warming' to the list of persisted statuses.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BABELCAST_DIR = join(homedir(), '.babelcast');
const ACTIVE_DEPLOY_FILE = join(BABELCAST_DIR, 'active_deploy.json');
const ACTIVE_DEPLOY_TMP = ACTIVE_DEPLOY_FILE + '.tmp';

function cleanup() {
  try { if (existsSync(ACTIVE_DEPLOY_FILE)) unlinkSync(ACTIVE_DEPLOY_FILE); } catch {}
  try { if (existsSync(ACTIVE_DEPLOY_TMP)) unlinkSync(ACTIVE_DEPLOY_TMP); } catch {}
}

describe('persistDeployState — warming status', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('persists deploy state when status is "warming" (pod exists with endpoint)', async () => {
    mkdirSync(BABELCAST_DIR, { recursive: true });

    const mod = await import('../../src/gateway/state/deploy-state');

    // Simulate a pod that has booted, has an endpoint, and is now warming models
    mod.deployState.status = 'warming';
    mod.deployState.podId = 'warming-pod-456';
    mod.deployState.endpoint = 'http://192.168.1.100:8000';
    mod.deployState.gpuType = 'NVIDIA GeForce RTX 4090';
    mod.deployState.dockerImage = 'marcosremar/babelcast-mistral:latest';
    mod.deployState.provider = 'vast';
    mod.deployState.costPerHr = 0.35;
    mod.deployState.startedAt = Date.now() - 120000;
    mod.deployState.sshHost = 'ssh.vast.ai';
    mod.deployState.sshPort = 54321;
    mod.deployState.providerMeta = {};
    mod.deployState.deployId = 'deploy-warming-test';

    // Call persistDeployState -- this should write to disk
    mod.persistDeployState();

    // Verify the file was written
    expect(existsSync(ACTIVE_DEPLOY_FILE)).toBe(true);

    // Verify the persisted data includes the warming status
    const raw = readFileSync(ACTIVE_DEPLOY_FILE, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.podId).toBe('warming-pod-456');
    expect(data.status).toBe('warming');
    expect(data.endpoint).toBe('http://192.168.1.100:8000');

    // Verify loadPersistedDeploy can recover it (survives restart)
    const loaded = mod.loadPersistedDeploy();
    expect(loaded).not.toBeNull();
    expect(loaded!.podId).toBe('warming-pod-456');
    expect(loaded!.status).toBe('warming');
    expect(loaded!.endpoint).toBe('http://192.168.1.100:8000');
  });

  it('does NOT persist when status is "searching" (no pod yet)', async () => {
    mkdirSync(BABELCAST_DIR, { recursive: true });

    const mod = await import('../../src/gateway/state/deploy-state');

    mod.deployState.status = 'searching';
    mod.deployState.podId = '';
    mod.deployState.endpoint = '';
    mod.deployState.gpuType = 'NVIDIA GeForce RTX 4090';
    mod.deployState.dockerImage = 'test:latest';
    mod.deployState.provider = '';
    mod.deployState.costPerHr = 0;
    mod.deployState.startedAt = Date.now();
    mod.deployState.providerMeta = {};
    mod.deployState.deployId = '';

    mod.persistDeployState();

    // No file should be written (no pod exists yet)
    expect(existsSync(ACTIVE_DEPLOY_FILE)).toBe(false);
  });

  it('persists deploy state when status is "error" and pod/endpoint exist', async () => {
    mkdirSync(BABELCAST_DIR, { recursive: true });

    const mod = await import('../../src/gateway/state/deploy-state');

    mod.deployState.status = 'error';
    mod.deployState.podId = 'error-pod-789';
    mod.deployState.endpoint = 'http://192.168.1.101:8000';
    mod.deployState.gpuType = 'NVIDIA GeForce RTX 4090';
    mod.deployState.dockerImage = 'test:latest';
    mod.deployState.provider = 'runpod';
    mod.deployState.costPerHr = 0.4;
    mod.deployState.startedAt = Date.now() - 60000;
    mod.deployState.message = 'Health check failed';
    mod.deployState.providerMeta = {};
    mod.deployState.deployId = 'deploy-error-test';

    mod.persistDeployState();

    // Error state with a pod should be persisted so it can be cleaned up on restart
    expect(existsSync(ACTIVE_DEPLOY_FILE)).toBe(true);

    const raw = readFileSync(ACTIVE_DEPLOY_FILE, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.status).toBe('error');
    expect(data.podId).toBe('error-pod-789');

    // Verify loadPersistedDeploy can recover it
    const loaded = mod.loadPersistedDeploy();
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('error');
  });
});

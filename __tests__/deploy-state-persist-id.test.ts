import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';

/**
 * Test that persistDeployState includes deployId in the persisted JSON.
 *
 * Since the module computes BABELCAST_DIR at import time using homedir(),
 * we can't redirect it to a temp dir via env vars after import. Instead,
 * we test against the real ~/.babelcast path and clean up afterwards.
 */
describe('deploy-state persistence includes deployId', () => {
  const babelcastDir = join(homedir(), '.babelcast');
  const activeDeployFile = join(babelcastDir, 'active_deploy.json');

  it('should include deployId in the persisted active_deploy.json', async () => {
    const { deployState, persistDeployState } = await import('../src/gateway/state/deploy-state');

    // Save any existing file
    let existingData: string | null = null;
    try { existingData = readFileSync(activeDeployFile, 'utf-8'); } catch {}

    try {
      // Set up a deploy state that would be persisted
      Object.assign(deployState, {
        status: 'ready',
        podId: 'pod-deployid-test-123',
        endpoint: 'http://10.0.0.1:8000',
        gpuType: 'NVIDIA GeForce RTX 4090',
        dockerImage: 'test:latest',
        provider: 'runpod',
        costPerHr: 0.74,
        startedAt: Date.now() - 60000,
        sshHost: '',
        sshPort: 0,
        providerMeta: {},
        deployId: 'deploy-test-unique-999',
      });

      // Call persist
      persistDeployState();

      // Read the file back
      expect(existsSync(activeDeployFile)).toBe(true);

      const data = JSON.parse(readFileSync(activeDeployFile, 'utf-8'));

      // deployId MUST be present for orphan detection correlation
      expect(data.deployId).toBe('deploy-test-unique-999');
    } finally {
      // Clean up: restore original file or delete test file
      if (existingData) {
        const { writeFileSync } = await import('fs');
        writeFileSync(activeDeployFile, existingData);
      } else {
        try { unlinkSync(activeDeployFile); } catch {}
      }
    }
  });
});

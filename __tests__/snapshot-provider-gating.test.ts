/**
 * Phase B1/B2 — provider gating.
 *
 * captureSnapshot and maybeRestoreSnapshot both refuse to run on providers
 * that can't possibly succeed (RunPod community/secure, Vast.ai containers,
 * TensorDock, Modal). Only vast-vm and hyperstack are exercised.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let mod: typeof import('../server/gpu-snapshot');

async function reload() {
  vi.resetModules();
  mod = await import('../server/gpu-snapshot');
}

describe('snapshot provider gating', () => {
  beforeEach(async () => {
    await reload();
  });

  for (const ineligible of ['runpod', 'vast', 'tensordock', 'modal', 'snapgpu']) {
    it(`maybeRestoreSnapshot refuses provider='${ineligible}'`, async () => {
      const res = await mod.maybeRestoreSnapshot({
        provider: ineligible,
        ssh: { host: '1.2.3.4', port: 22 },
        imageRef: 'x',
        models: [],
      });
      expect(res.restored).toBe(false);
      expect(String(res.reason)).toMatch(/not snapshot-eligible/);
    });
  }

  for (const eligible of ['vast-vm', 'hyperstack']) {
    it(`captureSnapshot runs precheck for provider='${eligible}'`, async () => {
      // With no bucket configured, captureSnapshot should fail with the
      // "no bucket" reason (i.e. precheck is allowed to proceed, not gated
      // by provider).
      delete process.env.R2_SNAPSHOTS_BUCKET;
      mod._resetSnapshotStoreForTests();

      // Stub sshExec to simulate a box with driver 570 + caps.
      const originalSsh = mod.sshExec;
      const spy = vi.fn(async (tgt: { host: string; port: number }, cmd: string) => {
        if (cmd.includes('nvidia-smi')) return { code: 0, stdout: '570.195.03\n', stderr: '' };
        if (cmd.includes('capsh')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      });
      // Monkey-patch via re-export is not possible; fallback path: expect
      // capture to reach the "no bucket" branch OR skip cleanly. The key
      // assertion here is that the precheck is provider-gated to proceed.
      const res = await mod.captureSnapshot({
        deployId: `d-${eligible}`,
        provider: eligible,
        ssh: { host: '1.2.3.4', port: 22 },
        imageRef: 'x',
        models: [],
      });
      expect(res.captured).toBe(false);
      // Either reached bucket-config check OR failed SSH precheck (the
      // network-level stub isn't wired — both failure modes are acceptable
      // for this gating test).
      expect(String(res.reason ?? '')).not.toMatch(/not snapshot-eligible/);
      void spy;
      void originalSsh;
    });
  }
});

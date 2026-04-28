/**
 * Deploy improvements #10, #11, #12 — source-level and behavioral tests
 *
 *  #10: Smart retry on deploy timeout — extend PHASE_TIMEOUTS once if progress
 *       signals fired recently (pull/boot/models).
 *  #11: Orphan reconnect on startup — tryReconnectOrphanDeploy scans all
 *       providers for running pods matching gateway-owned prefixes and adopts the
 *       first healthy one instead of letting orphan-sweep terminate it.
 *  #12: Real-time cost-idle alert — while the pod is still billing but has
 *       been idle past the threshold, emit a periodic alert with a "stop?"
 *       suggestion.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const repo = join(__dirname, '../..');
const read = (f: string) => readFileSync(join(repo, f), 'utf-8');

describe('Deploy improvement #10 — progress-aware timeout extension', () => {
  const src = read('server/gpu-poll-health.ts');

  it('declares progress tracking scaffold', () => {
    expect(src).toContain('let lastProgressAt');
    expect(src).toContain('let pullTimeoutExtendedOnce');
    expect(src).toContain('let bootTimeoutExtendedOnce');
    expect(src).toContain('let modelsTimeoutExtendedOnce');
    expect(src).toContain('PROGRESS_WINDOW_MS');
    expect(src).toContain('const markProgress');
  });

  it('extends IMAGE_PULL timeout once when progress observed', () => {
    expect(src).toContain('pullTimeoutExtendedOnce = true');
    expect(src).toMatch(/PHASE_TIMEOUTS\.IMAGE_PULL = .*PHASE_TIMEOUTS\.IMAGE_PULL \* 1\.5/);
    expect(src).toContain("phase: 'pull_extended'");
  });

  it('extends BOOT timeout once when progress observed', () => {
    expect(src).toContain('bootTimeoutExtendedOnce = true');
    expect(src).toMatch(/PHASE_TIMEOUTS\.BOOT = .*PHASE_TIMEOUTS\.BOOT \* 1\.5/);
    expect(src).toContain("phase: 'boot_extended'");
  });

  it('extends MODELS timeout once when progress observed and health body changing', () => {
    expect(src).toContain('modelsTimeoutExtendedOnce = true');
    expect(src).toMatch(/PHASE_TIMEOUTS\.MODELS = .*PHASE_TIMEOUTS\.MODELS \* 1\.5/);
    expect(src).toContain("phase: 'model_extended'");
    expect(src).toContain('stalledInHealth');
  });

  it('marks progress on real signals (provider status, first app response, /health body, services, ssh logs)', () => {
    expect(src).toContain("markProgress('first TCP/app response')");
    expect(src).toContain("markProgress('/health body changed')");
    expect(src).toContain('markProgress(`services snapshot changed');
    expect(src).toContain("markProgress('ssh logs changed')");
    // provider status changed — both runpod and vast
    expect(src).toMatch(/markProgress\(`runpod status →/);
    expect(src).toMatch(/markProgress\(`\$\{providerName\} status →/);
  });

  it('does not extend a phase twice (extension is single-shot)', () => {
    // Each *ExtendedOnce flag is flipped true and guards the extend block
    for (const flag of ['pullTimeoutExtendedOnce', 'bootTimeoutExtendedOnce', 'modelsTimeoutExtendedOnce']) {
      const extendLine = src.indexOf(`${flag} = true`);
      expect(extendLine).toBeGreaterThan(0);
      const guard = src.indexOf(`!${flag}`);
      expect(guard).toBeGreaterThan(0);
      // guard appears BEFORE the flip (structural sanity)
      expect(guard).toBeLessThan(extendLine);
    }
  });
});

describe('Deploy improvement #11 — orphan reconnect on startup', () => {
  const src = read('server/gpu-auto-recovery.ts');

  it('exports tryReconnectOrphanDeploy function', () => {
    expect(src).toContain('export async function tryReconnectOrphanDeploy()');
    const deployHub = read('server/gpu-deploy.ts');
    expect(deployHub).toContain('tryReconnectOrphanDeploy');
  });

  it('scans all four GPU providers (RunPod, Vast, TensorDock, Modal)', () => {
    const fnStart = src.indexOf('export async function tryReconnectOrphanDeploy');
    const fnBody = src.slice(fnStart, fnStart + 8000);
    expect(fnBody).toContain('runpod.listInstances');
    expect(fnBody).toContain('vast.listInstances');
    expect(fnBody).toContain('tensordock.listInstances');
    expect(fnBody).toContain('modal.listInstances');
  });

  it('filters reconnect candidates by gateway prefixes', () => {
    // Auto-recovery uses POD_NAME_PREFIX directly (single prefix, simpler than
    // sweep which uses prefixesForProvider() multi-prefix matching). Both paths
    // ultimately verify "label-starts-with-gateway-prefix".
    const fnStart = src.indexOf('export async function tryReconnectOrphanDeploy');
    const fnBody = src.slice(fnStart, fnStart + 8000);
    expect(fnBody).toMatch(/POD_NAME_PREFIX|prefixesForProvider|labelMatchesGatewayPrefix/);
    expect(fnBody).toContain('.startsWith(');
    const orphanSrc = read('server/gpu-orphan-cleanup.ts');
    expect(orphanSrc).toContain('export function prefixesForProvider');
  });

  it('probes /health before adopting a candidate', () => {
    const fnStart = src.indexOf('export async function tryReconnectOrphanDeploy');
    const fnBody = src.slice(fnStart, fnStart + 8000);
    expect(fnBody).toContain('probeGpuHealth(c.endpoint');
    expect(fnBody).toContain('if (!probe.ok)');
  });

  it('restores provider credentials and registers monitoring on adopt', () => {
    const fnStart = src.indexOf('export async function tryReconnectOrphanDeploy');
    const fnBody = src.slice(fnStart, fnStart + 8000);
    expect(fnBody).toContain('setActiveProvider');
    expect(fnBody).toContain('setDeployApiKey');
    expect(fnBody).toContain('setDeployVastApiKey');
    expect(fnBody).toContain('setDeployTensordockApiKey');
    expect(fnBody).toContain('setDeployModalApiKey');
    expect(fnBody).toContain('deploymentSM.markReady');
    expect(fnBody).toContain('startGpuMonitoring');
    expect(fnBody).toContain("type: 'gpu:orphan_reconnect'");
  });

  it('skips orphan scan when a deploy is already active', () => {
    const fnStart = src.indexOf('export async function tryReconnectOrphanDeploy');
    const fnBody = src.slice(fnStart, fnStart + 600);
    expect(fnBody).toMatch(/deployState\.status === 'ready'/);
    expect(fnBody).toMatch(/return false/);
  });

  it('startup-tasks runs orphan reconnect after active deploy recovery fails', () => {
    const startup = read('server/ws/startup-tasks.ts');
    expect(startup).toContain('tryReconnectOrphanDeploy');
    expect(startup).toContain('recoveredDeploy = await tryRecoverActiveDeploy()');
    expect(startup).toContain('if (!recoveredDeploy)');
    // Order: tryRecoverActiveDeploy → if false → tryReconnectOrphanDeploy
    const recover = startup.indexOf('tryRecoverActiveDeploy');
    const reconnect = startup.indexOf('tryReconnectOrphanDeploy');
    expect(recover).toBeGreaterThan(0);
    expect(reconnect).toBeGreaterThan(recover);
  });
});

describe('Deploy improvement #12 — real-time cost-idle alert', () => {
  const src = read('server/gpu-monitor-loop.ts');

  it('declares session-cost alert constants and state', () => {
    expect(src).toContain('SESSION_COST_ALERT_IDLE_MIN_MS');
    expect(src).toContain('SESSION_COST_ALERT_INTERVAL_MS');
    expect(src).toContain('lastSessionCostAlertAt');
  });

  it('resets alert timestamp when activity happens (resetIdleState)', () => {
    // resetIdleState is called by touchModelRequest — so clearing the timestamp
    // there means a fresh idle period can trigger a new first-alert
    expect(src).toMatch(/resetIdleState[\s\S]*lastSessionCostAlertAt = 0/);
  });

  it('emits a "gpu:cost_idle" websocket event with spend + suggestion', () => {
    expect(src).toContain("type: 'gpu:cost_idle'");
    expect(src).toContain("suggestion: 'stop'");
    expect(src).toContain('sessionSpend');
    expect(src).toContain('idleMin');
    expect(src).toContain('costPerHr');
  });

  it('builds human-readable alert message with $/hr, hours, total, idle', () => {
    expect(src).toMatch(/Spending \$\$\{deployState\.costPerHr/);
    expect(src).toContain('$${sessionSpend.toFixed(2)} total');
    expect(src).toContain('GPU idle ${idleMin} min — stop?');
  });

  it('throttles alerts by SESSION_COST_ALERT_INTERVAL_MS', () => {
    expect(src).toMatch(/Date\.now\(\) - lastSessionCostAlertAt\) >= SESSION_COST_ALERT_INTERVAL_MS/);
    expect(src).toContain('lastSessionCostAlertAt = Date.now()');
  });

  it('resets alert when activity resumes (idleMs < threshold)', () => {
    expect(src).toMatch(/idleMs < SESSION_COST_ALERT_IDLE_MIN_MS[\s\S]{0,200}lastSessionCostAlertAt = 0/);
  });

  it('only runs when pod is actually billing (costPerHr > 0 and startedAt > 0)', () => {
    expect(src).toMatch(/deployState\.costPerHr > 0[\s\S]{0,80}deployState\.startedAt > 0/);
  });

  it('emits a gateway event for downstream subscribers', () => {
    expect(src).toMatch(/emitGatewayEvent\(['"]gpu\.cost_idle['"]/);
  });
});

describe('Deploy improvements — behavioral sanity', () => {
  it('tryReconnectOrphanDeploy is loadable and returns boolean (no providers available = false)', async () => {
    const saved = {
      VAST_API_KEY: process.env.VAST_API_KEY,
      RUNPOD_API_KEY: process.env.RUNPOD_API_KEY,
      TENSORDOCK_API_KEY: process.env.TENSORDOCK_API_KEY,
      TENSORDOCK_AUTH_ID: process.env.TENSORDOCK_AUTH_ID,
      MODAL_TOKEN_ID: process.env.MODAL_TOKEN_ID,
    };
    delete process.env.VAST_API_KEY;
    delete process.env.RUNPOD_API_KEY;
    delete process.env.TENSORDOCK_API_KEY;
    delete process.env.TENSORDOCK_AUTH_ID;
    delete process.env.MODAL_TOKEN_ID;
    try {
      const mod = await import('../../server/gpu-auto-recovery');
      expect(typeof mod.tryReconnectOrphanDeploy).toBe('function');
      const result = await mod.tryReconnectOrphanDeploy();
      expect(typeof result).toBe('boolean');
      // With no api keys and nothing persisted, no adoption should happen.
      expect(result).toBe(false);
    } finally {
      if (saved.VAST_API_KEY) process.env.VAST_API_KEY = saved.VAST_API_KEY;
      if (saved.RUNPOD_API_KEY) process.env.RUNPOD_API_KEY = saved.RUNPOD_API_KEY;
      if (saved.TENSORDOCK_API_KEY) process.env.TENSORDOCK_API_KEY = saved.TENSORDOCK_API_KEY;
      if (saved.TENSORDOCK_AUTH_ID) process.env.TENSORDOCK_AUTH_ID = saved.TENSORDOCK_AUTH_ID;
      if (saved.MODAL_TOKEN_ID) process.env.MODAL_TOKEN_ID = saved.MODAL_TOKEN_ID;
    }
  });
});

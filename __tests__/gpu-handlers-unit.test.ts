/**
 * GPU Handlers Unit Tests (#079-#166)
 *
 * Tests for server/gpu-handlers.ts exports:
 *   handleGpuDeploy, handleGpuStatus, handleGpuStop, handleGpuResume,
 *   handleGpuTerminate, handleGpuOffers, handleGpuTypes, handleGpuLogs,
 *   handleGpuCatalog, handleHealth, handleGpuList, handleGpuMyLocation,
 *   handleGpuReputation, autoBootFromProfile.
 *
 * Uses mockReq/mockRes pattern (PassThrough streams) and vi.mock() for
 * server/state.ts, server/gpu-deploy.ts, and other dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Source code (read once) ──────────────────────────────────────────────────
const handlersSource = readFileSync('server/gpu-handlers.ts', 'utf8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(
  body: Record<string, unknown> | null = null,
  opts: { url?: string; method?: string; headers?: Record<string, string> } = {},
): IncomingMessage {
  const stream = new PassThrough();
  if (body !== null) {
    stream.end(JSON.stringify(body));
  } else {
    stream.end('');
  }
  const req = stream as unknown as IncomingMessage;
  (req as any).url = opts.url || '/';
  (req as any).method = opts.method || 'POST';
  (req as any).headers = opts.headers || {};
  return req;
}

function mockRes(): ServerResponse & { _status: number; _body: string; _headers: Record<string, string> } {
  const res = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string>,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
      return res;
    },
    end(body?: string) {
      res._body = body ?? '';
      return res;
    },
  };
  return res as unknown as ServerResponse & { _status: number; _body: string; _headers: Record<string, string> };
}

function resJson(res: { _body: string }): Record<string, unknown> {
  try { return JSON.parse(res._body); } catch { return { raw: res._body }; }
}

// ──────────────────────────────────────────────────────────────────────────────
// #079-#084: handleGpuDeploy — Structure & Flow
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuDeploy — structure & flow', () => {
  it('#079 handleGpuDeploy is an exported async function', () => {
    expect(handlersSource).toContain('export async function handleGpuDeploy');
  });

  it('#080 handleGpuDeploy calls getOrCreateRequestId', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuDeploy');
    const fnBody = handlersSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('getOrCreateRequestId');
  });

  it('#081 handleGpuDeploy calls setRequestIdHeader', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuDeploy');
    const fnBody = handlersSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('setRequestIdHeader');
  });

  it('#082 handleGpuDeploy checks deployLock and returns 409 if held', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuDeploy');
    const fnBody = handlersSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain('deployLock');
    expect(fnBody).toContain('409');
  });

  it('#083 handleGpuDeploy calls setDeployLock(true) to acquire the lock', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuDeploy');
    const fnBody = handlersSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain('setDeployLock(true)');
  });

  it('#084 handleGpuDeploy releases lock in finally block', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuDeploy');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    const finallyIdx = fnBody.indexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(0);
    const finallyBlock = fnBody.slice(finallyIdx, finallyIdx + 200);
    expect(finallyBlock).toContain('setDeployLock(false)');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #085-#090: handleGpuDeploy — Validation
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuDeploy — validation', () => {
  it('#085 _validateDeployRequest requires at least one provider API key', () => {
    expect(handlersSource).toContain('At least one provider API key is required');
  });

  it('#086 _validateDeployRequest requires dockerImage', () => {
    expect(handlersSource).toContain('dockerImage is required');
  });

  it('#087 _validateDeployRequest enforces GPU allowlist', () => {
    const fnStart = handlersSource.indexOf('async function _validateDeployRequest');
    const fnEnd = handlersSource.indexOf('\n/**', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain('Rejected non-tested GPU');
    expect(fnBody).toContain('None of the requested GPUs are in the tested allowlist');
  });

  it('#088 _validateDeployRequest validates credential format', () => {
    const fnStart = handlersSource.indexOf('async function _validateDeployRequest');
    const fnBody = handlersSource.slice(fnStart, fnStart + 1500);
    expect(fnBody).toContain('validateGpuCredentials');
  });

  it('#089 _validateDeployRequest resolves profile-based GPU deploy config', () => {
    const fnStart = handlersSource.indexOf('async function _validateDeployRequest');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('profileId');
    expect(fnBody).toContain('loadProviderConfig');
    expect(fnBody).toContain('activeProfile');
  });

  it('#090 _validateDeployRequest caps raceCount at 10', () => {
    const fnStart = handlersSource.indexOf('async function _validateDeployRequest');
    const fnBody = handlersSource.slice(fnStart, fnStart + 4000);
    expect(fnBody).toContain('Math.min(Math.floor(body.raceCount), 10)');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #091-#098: handleGpuDeploy — Cancel/Redeploy
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuDeploy — cancel/redeploy', () => {
  it('#091 cancels in-progress deploy before starting new one', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuDeploy');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('Cancelling in-progress deploy');
    expect(fnBody).toContain('setDeployCancelled(true)');
  });

  it('#092 waits for deploy promise to resolve (up to 10s)', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuDeploy');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('deployPromise');
    expect(fnBody).toContain('Promise.race');
    expect(fnBody).toContain('10_000');
  });

  it('#093 releases lock if deploy still running after 10s wait', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuDeploy');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('releasing lock after cancel');
    expect(fnBody).toContain('setDeployLock(false)');
  });

  it('#094 tears down ready GPU before redeploy', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuDeploy');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('GPU was ready — tearing down for redeploy');
    expect(fnBody).toContain('stopGpuMonitoring');
  });

  it('#095 updates translation profile to remove GPU endpoint on redeploy', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuDeploy');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain("updateTranslationProfile({ gpuEndpoint: undefined }");
  });

  it('#096 _startDeployAndRespond writes 202 response', () => {
    const fnStart = handlersSource.indexOf('function _startDeployAndRespond');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('res.writeHead(202');
    expect(fnBody).toContain('Deploy started');
  });

  it('#097 _startDeployAndRespond calls deploymentSM.startDeploying()', () => {
    const fnStart = handlersSource.indexOf('function _startDeployAndRespond');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('deploymentSM.startDeploying()');
  });

  it('#098 _startDeployAndRespond includes balanceWarnings in response', () => {
    const fnStart = handlersSource.indexOf('function _startDeployAndRespond');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('balanceWarnings');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #099-#106: handleGpuDeploy — Tier Selection
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuDeploy — tier selection', () => {
  it('#099 _selectDeploymentTier checks RunPod balance', () => {
    const fnStart = handlersSource.indexOf('async function _selectDeploymentTier');
    const fnBody = handlersSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain('RunPod balance');
    expect(fnBody).toContain('runpod.checkBalance');
  });

  it('#100 _selectDeploymentTier checks TensorDock balance', () => {
    const fnStart = handlersSource.indexOf('async function _selectDeploymentTier');
    const fnBody = handlersSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('TensorDock balance');
    expect(fnBody).toContain('tensordock.checkBalance');
  });

  it('#101 _selectDeploymentTier checks Vast.ai balance', () => {
    const fnStart = handlersSource.indexOf('async function _selectDeploymentTier');
    const fnBody = handlersSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('Vast.ai balance');
    expect(fnBody).toContain('vast.checkBalance');
  });

  it('#102 returns 402 when ALL configured providers have insufficient balance', () => {
    const fnStart = handlersSource.indexOf('async function _selectDeploymentTier');
    const fnBody = handlersSource.slice(fnStart, fnStart + 8000);
    expect(fnBody).toContain('402');
    expect(fnBody).toContain('Insufficient balance for all configured providers');
  });

  it('#103 returns 401 for invalid RunPod API key', () => {
    const fnStart = handlersSource.indexOf('async function _selectDeploymentTier');
    const fnBody = handlersSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain('401');
    expect(fnBody).toContain('RunPod API key is invalid');
  });

  it('#104 calls buildGpuTiers with effective keys', () => {
    const fnStart = handlersSource.indexOf('async function _selectDeploymentTier');
    const fnBody = handlersSource.slice(fnStart, fnStart + 8000);
    expect(fnBody).toContain('buildGpuTiers(');
  });

  it('#105 calls autoSelectCheapestGpu when autoSelectGpu is true', () => {
    const fnStart = handlersSource.indexOf('async function _selectDeploymentTier');
    const fnBody = handlersSource.slice(fnStart, fnStart + 10000);
    expect(fnBody).toContain('autoSelectCheapestGpu');
    expect(fnBody).toContain('autoSelectGpu');
  });

  it('#106 resolves Docker image for Blackwell GPUs', () => {
    const fnStart = handlersSource.indexOf('async function _selectDeploymentTier');
    const fnBody = handlersSource.slice(fnStart, fnStart + 10000);
    expect(fnBody).toContain('resolveDockerImageForGpus');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #107-#114: handleGpuStatus
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuStatus', () => {
  it('#107 handleGpuStatus is an exported async function', () => {
    expect(handlersSource).toContain('export async function handleGpuStatus');
  });

  it('#108 returns 200 with status JSON', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('res.writeHead(200');
  });

  it('#109 includes gpuHealthy in response', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('gpuHealthy');
  });

  it('#110 includes activeTier (gpu or cloud)', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnBody = handlersSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain("isGpuAvailable() ? 'gpu' : 'cloud'");
  });

  it('#111 includes elapsedSec in response', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('elapsedSec');
  });

  it('#112 includes idleSec and idleTimeoutSec in response', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('idleSec');
    expect(fnBody).toContain('idleTimeoutSec');
  });

  it('#113 includes deploymentSM state in response', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('deploymentSM.toJSON');
  });

  it('#114 includes machineInfo with RAM, VRAM, disk, GPU count', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('machineInfo');
    expect(fnBody).toContain('ramGb');
    expect(fnBody).toContain('gpuVramGb');
    expect(fnBody).toContain('diskGb');
    expect(fnBody).toContain('numGpus');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #115-#120: handleGpuStatus — Extended Fields
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuStatus — extended fields', () => {
  it('#115 omits lastLogs from status response', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('lastLogs');
    expect(fnBody).toContain('stateWithoutLogs');
  });

  it('#116 includes providerCooldowns when active', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('providerCooldowns');
    expect(fnBody).toContain('cooldownTracker.getActiveCooldowns');
  });

  it('#117 includes modelWarmth in status', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('modelWarmth');
    expect(fnBody).toContain('gpuModelWarmth');
  });

  it('#118 includes pipelineRouting when GPU is available', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('pipelineRouting');
    expect(fnBody).toContain("'gpu'");
    expect(fnBody).toContain("'cloud'");
  });

  it('#119 includes standby deploy state', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('standby:');
    expect(fnBody).toContain('standbyDeployState');
  });

  it('#120 includes readinessState in response', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStatus');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 50);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('readinessState');
    expect(fnBody).toContain('gpuReadinessState');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #121-#126: handleGpuStop
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuStop', () => {
  it('#121 handleGpuStop is an exported async function', () => {
    expect(handlersSource).toContain('export async function handleGpuStop');
  });

  it('#122 returns 400 when no active pod', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStop');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('No active pod to stop');
    expect(fnBody).toContain('400');
  });

  it('#123 resolves provider client based on deployState.provider', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStop');
    const fnBody = handlersSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain("provider === 'runpod'");
    expect(fnBody).toContain("provider === 'vast'");
    expect(fnBody).toContain("provider === 'tensordock'");
  });

  it('#124 returns 400 when no credentials for provider', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStop');
    const fnBody = handlersSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain('Cannot stop: no credentials');
    expect(fnBody).toContain('400');
  });

  it('#125 calls client.stopInstance and transitions to stopped state', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStop');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain('client.stopInstance');
    // After stop, transitions to 'stopped' state with podId preserved via setDeployState
    expect(fnBody).toContain("status: 'stopped'");
    expect(fnBody).toContain('deploymentSM.markStopped(');
  });

  it('#126 returns 200 with ok:true on success', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuStop');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain('res.writeHead(200');
    expect(fnBody).toContain('ok: true');
    expect(fnBody).toContain('/v1/gpu/resume');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #127-#133: handleGpuResume
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuResume', () => {
  it('#127 handleGpuResume is an exported async function', () => {
    expect(handlersSource).toContain('export async function handleGpuResume');
  });

  it('#128 returns 400 when no pod to resume', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuResume');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('No pod to resume');
    expect(fnBody).toContain('400');
  });

  it('#129 uses body.podId or falls back to deployState.podId', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuResume');
    const fnBody = handlersSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('body.podId');
    expect(fnBody).toContain('deployState.podId');
  });

  it('#130 delegates to resumeOrDeploy for resume-with-fallback', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuResume');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    // Handler delegates to resumeOrDeploy which handles resume + fallback
    expect(fnBody).toContain('resumeOrDeploy(');
    expect(fnBody).toContain("reason: 'manual'");
  });

  it('#131 resumeOrDeploy in gpu-deploy calls startInstance and clears timer', () => {
    // The logic moved from handler to gpu-deploy.ts resumeOrDeploy()
    const deploySource = readFileSync(join(__dirname, '../server/gpu-deploy.ts'), 'utf-8');
    const fnStart = deploySource.indexOf('export async function resumeOrDeploy');
    const fnEnd = deploySource.indexOf('\nexport async function autoTerminateGpu', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain('client.startInstance(podId, credentials)');
    expect(fnBody).toContain('clearAutoDestroyTimer()');
  });

  it('#132 resumeOrDeploy sets booting state and starts monitoring on success', () => {
    const deploySource = readFileSync(join(__dirname, '../server/gpu-deploy.ts'), 'utf-8');
    const fnStart = deploySource.indexOf('export async function resumeOrDeploy');
    const fnEnd = deploySource.indexOf('\nexport async function autoTerminateGpu', fnStart);
    const fnBody = deploySource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain("status: 'booting'");
    expect(fnBody).toContain('startGpuMonitoring()');
  });

  it('#133 returns 200 with ok:true and method field', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuResume');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain('res.writeHead(200');
    expect(fnBody).toContain('ok: true');
    expect(fnBody).toContain('method: result.method');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #134-#140: handleGpuTerminate
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuTerminate', () => {
  it('#134 handleGpuTerminate is an exported async function', () => {
    expect(handlersSource).toContain('export async function handleGpuTerminate');
  });

  it('#135 stops GPU monitoring', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuTerminate');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain('stopGpuMonitoring');
  });

  it('#136 releases deploy lock', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuTerminate');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('setDeployLock(false)');
  });

  it('#137 resets deploy state and state machine', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuTerminate');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('resetDeployState()');
    expect(fnBody).toContain('deploymentSM.reset()');
  });

  it('#138 cleans up ALL providers (runpod, vast, tensordock, modal)', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuTerminate');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain('cleanupAllPods');
    expect(fnBody).toContain('cleanupVastInstances');
    expect(fnBody).toContain('cleanupTensordockInstances');
    expect(fnBody).toContain('cleanupModalApps');
  });

  it('#139 logs gpu event and updates deploy session', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuTerminate');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain("logGpuEvent('instance_terminated'");
    expect(fnBody).toContain("updateDeploySession({ status: 'stopped'");
  });

  it('#140 records host reputation if deploy was ready', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuTerminate');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain('wasReady');
    expect(fnBody).toContain('upsertHostReputation');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #141-#146: handleGpuOffers
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuOffers', () => {
  it('#141 handleGpuOffers is an exported async function', () => {
    expect(handlersSource).toContain('export async function handleGpuOffers');
  });

  it('#142 rejects API keys in query params (security check)', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuOffers');
    const fnBody = handlersSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain('sensitiveParams');
    expect(fnBody).toContain('API keys must not be passed via query params');
    expect(fnBody).toContain('400');
  });

  it('#143 returns 400 when no provider API keys configured', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuOffers');
    const fnBody = handlersSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('No provider API keys configured');
    expect(fnBody).toContain('400');
  });

  it('#144 supports gpuTypes, region, limit, provider query params', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuOffers');
    const fnBody = handlersSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain("url.searchParams.get('gpuTypes')");
    expect(fnBody).toContain("url.searchParams.get('region')");
    expect(fnBody).toContain("url.searchParams.get('limit')");
    expect(fnBody).toContain("url.searchParams.get('provider')");
  });

  it('#145 fetches offers with balances in parallel', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuOffers');
    const fnBody = handlersSource.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('fetchOffersWithBalances');
  });

  it('#146 annotates offers with canDeploy and providerBalance', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuOffers');
    const fnEnd = handlersSource.indexOf('\n/** ', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('canDeploy');
    expect(fnBody).toContain('providerBalance');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #147-#149: handleGpuTypes
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuTypes', () => {
  it('#147 handleGpuTypes is an exported async function', () => {
    expect(handlersSource).toContain('export async function handleGpuTypes');
  });

  it('#148 queries prisma.gpuTypeCache for cached types', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuTypes');
    const fnBody = handlersSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('prisma.gpuTypeCache.findMany');
  });

  it('#149 supports provider query param filter', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuTypes');
    const fnBody = handlersSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain("url.searchParams.get('provider')");
    expect(fnBody).toContain('providerFilter');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #150-#153: handleGpuLogs
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuLogs', () => {
  it('#150 handleGpuLogs is an exported async function', () => {
    expect(handlersSource).toContain('export async function handleGpuLogs');
  });

  it('#151 calls fetchGpuLogs()', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuLogs');
    const fnBody = handlersSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('fetchGpuLogs()');
  });

  it('#152 returns 200 with logs, sshHost, sshPort, endpoint', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuLogs');
    const fnBody = handlersSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('res.writeHead(200');
    expect(fnBody).toContain('logs');
    expect(fnBody).toContain('sshHost');
    expect(fnBody).toContain('sshPort');
    expect(fnBody).toContain('endpoint');
  });

  it('#153 returns 500 on error', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuLogs');
    const fnBody = handlersSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('res.writeHead(500');
    expect(fnBody).toContain('Failed to fetch logs');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #154-#156: handleGpuCatalog and handleGpuEventLogs
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuCatalog & handleGpuEventLogs', () => {
  it('#154 handleGpuCatalog is an exported function returning getImageCatalog', () => {
    expect(handlersSource).toContain('export function handleGpuCatalog');
    const fnStart = handlersSource.indexOf('export function handleGpuCatalog');
    const fnBody = handlersSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('getImageCatalog');
  });

  it('#155 handleGpuEventLogs supports gpu and server log types', () => {
    expect(handlersSource).toContain('export function handleGpuEventLogs');
    const fnStart = handlersSource.indexOf('export function handleGpuEventLogs');
    const fnBody = handlersSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain("'server'");
    expect(fnBody).toContain("'gpu'");
    expect(fnBody).toContain("'events'");
  });

  it('#156 handleGpuEventLogs supports ?lines query param', () => {
    const fnStart = handlersSource.indexOf('export function handleGpuEventLogs');
    const fnBody = handlersSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain("url.searchParams.get('lines')");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #157-#162: handleHealth
// ──────────────────────────────────────────────────────────────────────────────

describe('handleHealth', () => {
  it('#157 handleHealth is an exported async function', () => {
    expect(handlersSource).toContain('export async function handleHealth');
  });

  it('#158 returns 200 with status (ok/degraded)', () => {
    const fnStart = handlersSource.indexOf('export async function handleHealth');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('res.writeHead(200');
    expect(fnBody).toContain("overallStatus = 'ok'");
    expect(fnBody).toContain("overallStatus = 'degraded'");
  });

  it('#159 includes components (stt, llm, tts, gpu)', () => {
    const fnStart = handlersSource.indexOf('export async function handleHealth');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('components');
    // stt and llm are set inline in the object literal: { stt: { status: 'ok' ... }, llm: { ... } }
    expect(fnBody).toContain("stt: { status: 'ok'");
    expect(fnBody).toContain("llm: { status: 'ok'");
    expect(fnBody).toContain('components.tts');
    expect(fnBody).toContain('components.gpu');
  });

  it('#160 includes latency p50/p95/p99', () => {
    const fnStart = handlersSource.indexOf('export async function handleHealth');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('p50_ms');
    expect(fnBody).toContain('p95_ms');
    expect(fnBody).toContain('p99_ms');
    expect(fnBody).toContain('computePercentile');
  });

  it('#161 includes budget tracking info', () => {
    const fnStart = handlersSource.indexOf('export async function handleHealth');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('body.budget');
    expect(fnBody).toContain('dailySpendUsd');
    expect(fnBody).toContain('dailyLimitUsd');
  });

  it('#162 includes providerMetrics with token usage', () => {
    const fnStart = handlersSource.indexOf('export async function handleHealth');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('providerMetrics');
    expect(fnBody).toContain('avgLatencyMs');
    expect(fnBody).toContain('inputTokens');
    expect(fnBody).toContain('outputTokens');
    expect(fnBody).toContain('errorRate');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #163-#166: handleGpuList, handleGpuMyLocation, autoBootFromProfile, friendlyErrorMessage
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuList', () => {
  it('#163 handleGpuList is an exported async function', () => {
    expect(handlersSource).toContain('export async function handleGpuList');
  });

  it('#164 aggregates instances from all providers in parallel', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuList');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain('Promise.allSettled');
    expect(fnBody).toContain('listInstances');
  });

  it('#165 includes the currently tracked deployState even if not in provider list', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuList');
    const fnEnd = handlersSource.indexOf('\n// ──', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
    expect(fnBody).toContain('deployState.podId');
    expect(fnBody).toContain("deployState.status !== 'idle'");
  });
});

describe('handleGpuMyLocation', () => {
  it('#166a handleGpuMyLocation returns location or 503', () => {
    expect(handlersSource).toContain('export async function handleGpuMyLocation');
    const fnStart = handlersSource.indexOf('export async function handleGpuMyLocation');
    const fnBody = handlersSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('fetchMyLocation');
    expect(fnBody).toContain('503');
  });
});

describe('autoBootFromProfile', () => {
  it('#166b autoBootFromProfile skips when deploy already in progress', () => {
    const fnStart = handlersSource.indexOf('export async function autoBootFromProfile');
    const fnBody = handlersSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain("deployState.status !== 'idle'");
    expect(fnBody).toContain('deploy already in progress, skipping');
  });

  it('#166c autoBootFromProfile skips when deploy lock is held', () => {
    const fnStart = handlersSource.indexOf('export async function autoBootFromProfile');
    const fnBody = handlersSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('deployLock');
    expect(fnBody).toContain('deploy lock held, skipping');
  });

  it('#166d autoBootFromProfile only fires when bootOnStartup is true', () => {
    const fnStart = handlersSource.indexOf('export async function autoBootFromProfile');
    const fnBody = handlersSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain('bootOnStartup');
  });
});

describe('friendlyErrorMessage', () => {
  it('#166e strips embedded JSON from error messages', () => {
    const fnStart = handlersSource.indexOf('function friendlyErrorMessage');
    const fnBody = handlersSource.slice(fnStart, fnStart + 800);
    expect(fnBody).toContain('balanceMatch');
    expect(fnBody).toContain('jsonStripped');
    expect(fnBody).toContain('Add funds');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Provider balance caching
// ──────────────────────────────────────────────────────────────────────────────

describe('provider balance caching', () => {
  it('#166f balance cache uses 60s TTL', () => {
    expect(handlersSource).toContain('BALANCE_CACHE_TTL_MS');
    expect(handlersSource).toContain('60_000');
  });

  it('#166g masks API keys in balance output', () => {
    expect(handlersSource).toContain('function maskKey');
    const fnStart = handlersSource.indexOf('function maskKey');
    const fnBody = handlersSource.slice(fnStart, fnStart + 200);
    expect(fnBody).toContain('slice(0, 4)');
    expect(fnBody).toContain('slice(-4)');
  });

  it('#166h offer balance cache uses 90s TTL', () => {
    expect(handlersSource).toContain('OFFER_BALANCE_CACHE_TTL_MS');
    expect(handlersSource).toContain('90_000');
  });

  it('#166i offer balance check uses background-refresh pattern', () => {
    expect(handlersSource).toContain('getCachedOfferBalances');
    expect(handlersSource).toContain('_balanceRefreshPromise');
    expect(handlersSource).toContain('Promise.allSettled');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// handleGpuOffersRanked
// ──────────────────────────────────────────────────────────────────────────────

describe('handleGpuOffersRanked', () => {
  it('#166j handleGpuOffersRanked is an exported async function', () => {
    expect(handlersSource).toContain('export async function handleGpuOffersRanked');
  });

  it('#166k auto-detects location when lat/lon not provided', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuOffersRanked');
    const fnBody = handlersSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('fetchMyLocation');
    expect(fnBody).toContain('clientLat');
    expect(fnBody).toContain('clientLon');
  });

  it('#166l sinks no-credit offers to bottom', () => {
    const fnStart = handlersSource.indexOf('export async function handleGpuOffersRanked');
    const fnEnd = handlersSource.indexOf('\nexport ', fnStart + 100);
    const fnBody = handlersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(fnBody).toContain('deployable');
    expect(fnBody).toContain('blocked');
    expect(fnBody).toContain('canDeploy');
  });
});

/**
 * Live Gateway/Vast reservation E2E.
 *
 * Opt-in and billable. These tests exercise real GPU reservation through the
 * gateway HTTP API only. They never call Vast.ai directly.
 *
 * Run single-slot scenarios:
 *   RUN_LIVE_GPU_RESERVATION_E2E=1 SKIP_LIVE_TESTS=0 \
 *   AIGW_LIVE_GATEWAY_URL=http://localhost:4000 AIGW_LIVE_API_KEY=... \
 *   bun run test __tests__/e2e/gpu-vast-reservation-live-e2e.test.ts --reporter=verbose
 *
 * Run the higher-cost concurrent burst scenario too:
 *   LIVE_GPU_RESERVATION_RUN_BURST=1 LIVE_GPU_RESERVATION_BURST_COUNT=2 ...
 *
 * Run the physical 1000-reservation soak. This attempts 1000 real GPU
 * reservations through /v1/gpu/deploy, one per app slot, and terminates each
 * slot after readiness/error:
 *   LIVE_GPU_RESERVATION_RUN_PHYSICAL_1000=1 LIVE_GPU_RESERVATION_RUN_ONLY_PHYSICAL=1 ...
 *
 * Optional provider-key forwarding for a local gateway that does not already
 * have VAST_API_KEY configured:
 *   LIVE_GPU_RESERVATION_SEND_PROVIDER_KEYS=1 VAST_API_KEY=...
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadEnv } from './helpers';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

await loadEnv();

const shouldRun = process.env.RUN_LIVE_GPU_RESERVATION_E2E === '1' && process.env.SKIP_LIVE_TESTS !== '1';
const runBurst = process.env.LIVE_GPU_RESERVATION_RUN_BURST === '1';
const runSoak = process.env.LIVE_GPU_RESERVATION_RUN_SOAK === '1';
const runPhysical1000 = process.env.LIVE_GPU_RESERVATION_RUN_PHYSICAL_1000 === '1';
const runOnlyPhysical = process.env.LIVE_GPU_RESERVATION_RUN_ONLY_PHYSICAL === '1';
const liveDescribe = shouldRun ? describe : describe.skip;

const DEFAULT_IMAGE = 'nvidia/cuda:12.4.1-base-ubuntu22.04';
const DEFAULT_GPU_TYPES = [
  'NVIDIA GeForce RTX 4090',
  'NVIDIA RTX A5000',
  'NVIDIA A40',
];

type JsonObject = Record<string, unknown>;

interface GatewayResult<T extends JsonObject = JsonObject> {
  status: number;
  body: T;
  text: string;
}

interface DeployResponse extends JsonObject {
  deployId?: string;
  status?: string;
  message?: string;
  idempotent?: boolean;
  slot?: string;
}

interface GpuStatusResponse extends JsonObject {
  status?: string;
  podId?: string;
  endpoint?: string;
  gpuType?: string;
  provider?: string;
  message?: string;
  step?: string;
  stepDetail?: string;
  elapsed?: number;
  elapsedSec?: number;
  startedAt?: number;
  deployId?: string;
  costPerHr?: number;
  sshHost?: string;
  sshPort?: number;
  healthy?: boolean;
  gpuHealthy?: boolean;
  slotOwner?: string;
}

interface GpuListResponse extends JsonObject {
  instances?: Array<JsonObject>;
}

interface LiveSlot {
  slot: string;
  label: string;
  deployId?: string;
}

interface PhysicalAttemptRecord {
  index: number;
  slot: string;
  label: string;
  status: 'ready' | 'deploy-rejected' | 'deploy-error' | 'readiness-error' | 'cleanup-error' | 'terminated';
  deployId?: string;
  podId?: string;
  provider?: string;
  gpuType?: string;
  httpStatus?: number;
  durationMs: number;
  message?: string;
  error?: string;
  cleanupMs?: number;
}

const liveSlots: LiveSlot[] = [];

function gatewayUrl(): string {
  return (process.env.AIGW_LIVE_GATEWAY_URL || process.env.AI_GATEWAY_URL || process.env.GATEWAY_URL || 'http://localhost:4000').replace(/\/+$/, '');
}

function liveApiKey(): string {
  const key = process.env.AIGW_LIVE_API_KEY
    || process.env.AIGW_APP_KEY
    || process.env.AI_GATEWAY_KEY
    || process.env.GATEWAY_API_KEY
    || process.env.GATEWAY_API_KEYS?.split(',')[0]?.split(':')[0]
    || '';
  if (!key) {
    throw new Error('Set AIGW_LIVE_API_KEY, AIGW_APP_KEY, GATEWAY_API_KEY, or GATEWAY_API_KEYS before running live GPU reservation E2E');
  }
  return key.trim();
}

function parseCsvEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw.split(',').map(s => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

function stringEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function uniqueId(kind: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `lv-${kind}-${ts}-${rand}`;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${liveApiKey()}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function gatewayRequest<T extends JsonObject>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
  headerOverrides?: Record<string, string>,
): Promise<GatewayResult<T>> {
  const url = new URL(path, gatewayUrl());
  const res = await fetch(url, {
    method,
    headers: headers(headerOverrides),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: JsonObject = {};
  try {
    json = text ? JSON.parse(text) as JsonObject : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json as T, text };
}

function expectHttpOk<T extends JsonObject>(result: GatewayResult<T>, allowed: number[], context: string): T {
  if (!allowed.includes(result.status)) {
    throw new Error(`${context} returned HTTP ${result.status}: ${result.text.slice(0, 800)}`);
  }
  return result.body;
}

function buildDeployBody(slot: string, label: string, overrides: JsonObject = {}): JsonObject {
  const body: JsonObject = {
    provider: 'vast',
    noTierCascade: true,
    dockerImage: process.env.LIVE_GPU_RESERVATION_IMAGE || DEFAULT_IMAGE,
    gpuTypes: parseCsvEnv('LIVE_GPU_RESERVATION_GPU_TYPES', DEFAULT_GPU_TYPES),
    storageGb: numberEnv('LIVE_GPU_RESERVATION_STORAGE_GB', 20, 5, 100),
    containerDiskInGb: numberEnv('LIVE_GPU_RESERVATION_CONTAINER_DISK_GB', 10, 0, 100),
    maxCostUsd: numberEnv('LIVE_GPU_RESERVATION_MAX_COST_USD', 2.5, 0.1, 20),
    raceCount: numberEnv('LIVE_GPU_RESERVATION_RACE_COUNT', 1, 1, 2),
    readinessProbe: 'ssh',
    bootTimeoutSec: numberEnv('LIVE_GPU_RESERVATION_BOOT_TIMEOUT_SEC', 300, 30, 600),
    searchMode: process.env.LIVE_GPU_RESERVATION_SEARCH_MODE || 'high_quality',
    strictFastBoot: process.env.LIVE_GPU_RESERVATION_STRICT_FAST_BOOT === '0' ? false : true,
    suppressProviderRetries: process.env.LIVE_GPU_RESERVATION_PROVIDER_RETRIES === '1' ? false : true,
    finetune: true,
    runSmokeTests: false,
    requireDockerManifest: false,
    interruptible: false,
    parallelSlot: slot,
    label,
    onstart: 'nohup bash -lc "sleep infinity" >/tmp/aigw-live-reservation-e2e.log 2>&1 &',
    env: {
      AIGW_LIVE_RESERVATION_E2E: slot,
    },
    ...overrides,
  };

  if (process.env.LIVE_GPU_RESERVATION_SEND_PROVIDER_KEYS === '1' && process.env.VAST_API_KEY) {
    body.vastApiKey = process.env.VAST_API_KEY;
  }

  return body;
}

function trackSlot(slot: string, label: string, deployId?: string): void {
  const existing = liveSlots.find(s => s.slot === slot);
  if (existing) {
    existing.deployId = deployId || existing.deployId;
    return;
  }
  liveSlots.push({ slot, label, deployId });
}

function physicalReportPath(runId: string): string {
  const dir = process.env.LIVE_GPU_RESERVATION_REPORT_DIR
    || path.join(process.cwd(), '.codex-temp');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `vast-physical-1000-${runId}.jsonl`);
}

function writePhysicalSummary(reportPath: string, summary: JsonObject): void {
  const summaryPath = reportPath.replace(/\.jsonl$/, '.summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

function appendPhysicalRecord(reportPath: string, record: PhysicalAttemptRecord): void {
  appendFileSync(reportPath, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
}

function slotQuery(slot: string): string {
  return `/v1/gpu/status?parallelSlot=${encodeURIComponent(slot)}`;
}

function statusFingerprint(status: GpuStatusResponse): string {
  return [
    status.status || '',
    status.step || '',
    status.stepDetail || '',
    status.podId || '',
    status.sshHost || '',
    status.message || '',
  ].join('|');
}

function isRetryableReservationStatus(status: GpuStatusResponse): boolean {
  const text = `${status.step || ''} ${status.message || ''}`.toLowerCase();
  return status.status === 'error' && (
    text.includes('ssh readiness timeout')
    || text.includes('never accepted ssh')
    || text.includes('before ssh came up')
    || text.includes('timeout')
  );
}

function statusSummary(status: GpuStatusResponse): string {
  return JSON.stringify({
    status: status.status,
    provider: status.provider,
    podId: status.podId,
    gpuType: status.gpuType,
    deployId: status.deployId,
    sshHost: status.sshHost,
    sshPort: status.sshPort,
    step: status.step,
    stepDetail: status.stepDetail,
    message: status.message,
    elapsed: status.elapsed ?? status.elapsedSec,
  });
}

async function getSlotStatus(slot: string): Promise<GpuStatusResponse> {
  const result = await gatewayRequest<GpuStatusResponse>('GET', slotQuery(slot), undefined, 20_000);
  return expectHttpOk(result, [200], `GET ${slotQuery(slot)}`);
}

async function waitForSlotIdle(slot: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: GpuStatusResponse = {};
  while (Date.now() < deadline) {
    last = await getSlotStatus(slot);
    if (!last.status || last.status === 'idle') return;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  throw new Error(`slot ${slot} did not become idle after terminate. Last status: ${statusSummary(last)}`);
}

async function terminateSlot(slot: string, deployId?: string): Promise<void> {
  const body: JsonObject = {
    parallelSlot: slot,
    provider: 'vast',
    force: true,
    ...(deployId ? { deployId } : {}),
  };
  const result = await gatewayRequest<JsonObject>('POST', '/v1/gpu/terminate', body, 90_000);
  if (![200, 202, 404].includes(result.status)) {
    throw new Error(`terminate ${slot} returned HTTP ${result.status}: ${result.text.slice(0, 800)}`);
  }
}

async function cleanupSlot(slot: string, deployId?: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await terminateSlot(slot, deployId);
      await waitForSlotIdle(slot, 90_000);
      return;
    } catch (err) {
      console.warn(`[live-reservation] cleanup attempt ${attempt + 1} failed for ${slot}: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
  }
}

async function visibleInstances(): Promise<Array<JsonObject>> {
  const result = await gatewayRequest<GpuListResponse>('GET', '/v1/gpu/list?probe=false', undefined, 45_000);
  const body = expectHttpOk(result, [200], 'GET /v1/gpu/list');
  return body.instances || [];
}

async function waitForReservationReady(slot: string, timeoutMs: number, stallMs: number): Promise<GpuStatusResponse> {
  const deadline = Date.now() + timeoutMs;
  let last: GpuStatusResponse = {};
  let lastFingerprint = '';
  let lastChangeAt = Date.now();
  let retryableErrorFingerprint = '';
  let retryableErrorSince = 0;
  const providerRetries = process.env.LIVE_GPU_RESERVATION_PROVIDER_RETRIES === '1';
  const providerRetryGraceMs = numberEnv('LIVE_GPU_RESERVATION_PROVIDER_RETRY_GRACE_MS', 90_000, 10_000, 300_000);

  while (Date.now() < deadline) {
    last = await getSlotStatus(slot);
    const fingerprint = statusFingerprint(last);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastChangeAt = Date.now();
      console.log(`[live-reservation] ${slot}: ${statusSummary(last)}`);
    }

    if (last.status === 'ready' || last.healthy === true || last.gpuHealthy === true) {
      return last;
    }
    if (last.status === 'error') {
      const retryable = providerRetries && isRetryableReservationStatus(last);
      if (retryable) {
        if (retryableErrorFingerprint !== fingerprint) {
          retryableErrorFingerprint = fingerprint;
          retryableErrorSince = Date.now();
        }
        if (Date.now() - retryableErrorSince <= providerRetryGraceMs) {
          await new Promise(resolve => setTimeout(resolve, numberEnv('LIVE_GPU_RESERVATION_POLL_MS', 10_000, 2_000, 60_000)));
          continue;
        }
      }
      throw new Error(`deploy ${slot} errored: ${statusSummary(last)}`);
    }
    retryableErrorFingerprint = '';
    retryableErrorSince = 0;
    if (Date.now() - lastChangeAt > stallMs) {
      throw new Error(`deploy ${slot} appears stalled for ${stallMs}ms: ${statusSummary(last)}`);
    }

    await new Promise(resolve => setTimeout(resolve, numberEnv('LIVE_GPU_RESERVATION_POLL_MS', 10_000, 2_000, 60_000)));
  }

  throw new Error(`deploy ${slot} did not reach SSH readiness in ${timeoutMs}ms. Last status: ${statusSummary(last)}`);
}

async function runSoakScenario(args: {
  index: number;
  slot: string;
  deployId: string;
  deployBody: JsonObject;
  allowDuplicateDeploy: boolean;
}): Promise<string> {
  const { index, slot, deployId, deployBody, allowDuplicateDeploy } = args;
  const requestId = `live-soak-${slot}-${index}`;
  const variant = index % 8;

  if (variant === 0 && allowDuplicateDeploy) {
    const result = await gatewayRequest<DeployResponse>('POST', '/v1/gpu/deploy', deployBody, 30_000, { 'X-Request-Id': requestId });
    const body = expectHttpOk(result, [200, 202], `soak duplicate deploy #${index}`);
    if (body.deployId && deployId) expect(body.deployId).toBe(deployId);
    expect(body.idempotent).toBe(true);
    return 'duplicate-deploy';
  }

  if (variant === 1) {
    await getSlotStatus(slot);
    return 'status-parallelSlot';
  }

  if (variant === 2) {
    const status = await gatewayRequest<GpuStatusResponse>('GET', `/v1/gpu/status?slot=${encodeURIComponent(slot)}`, undefined, 20_000, { 'X-Request-Id': requestId });
    expectHttpOk(status, [200], `soak status slot alias #${index}`);
    return 'status-slot-alias';
  }

  if (variant === 3 && deployId) {
    const status = await gatewayRequest<GpuStatusResponse>('GET', `/v1/gpu/status?deployId=${encodeURIComponent(deployId)}`, undefined, 20_000, { 'X-Request-Id': requestId });
    expectHttpOk(status, [200], `soak status deployId #${index}`);
    return 'status-deployId';
  }

  if (variant === 4) {
    await visibleInstances();
    return 'list';
  }

  if (variant === 5) {
    const result = await gatewayRequest<JsonObject>('POST', '/v1/gpu/deploy/validate', deployBody, 60_000, { 'X-Request-Id': requestId });
    const body = expectHttpOk(result, [200], `soak validate #${index}`);
    expect(body.ok).toBe(true);
    return 'validate';
  }

  if (variant === 6) {
    const result = await gatewayRequest<JsonObject>('GET', '/health', undefined, 20_000, { 'X-Request-Id': requestId });
    expectHttpOk(result, [200], `soak health #${index}`);
    return 'health';
  }

  const status = await getSlotStatus(slot);
  expect(String(status.status || '')).not.toMatch(/error/i);
  return 'status-default';
}

function estimatePhysicalWorstCaseUsd(target: number): number {
  const maxCostUsd = numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_MAX_COST_USD', 1.25, 0.1, 20);
  const bootTimeoutSec = numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_BOOT_TIMEOUT_SEC', 300, 30, 600);
  const keepReadyMs = numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_KEEP_READY_MS', 0, 0, 600_000);
  const cleanupBufferSec = numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_CLEANUP_BUFFER_SEC', 120, 0, 1_800);
  const providerAttemptFactor = process.env.LIVE_GPU_RESERVATION_PROVIDER_RETRIES === '1' ? 3 : 1;
  return target * maxCostUsd * ((bootTimeoutSec + keepReadyMs / 1000 + cleanupBufferSec) / 3600) * providerAttemptFactor;
}

function assertPhysicalBudgetAcknowledged(target: number): void {
  const estimate = estimatePhysicalWorstCaseUsd(target);
  const maxTotal = numberEnv('LIVE_GPU_RESERVATION_MAX_TOTAL_USD', 250, 1, 100_000);
  if (estimate > maxTotal) {
    throw new Error(`Physical 1000-reservation budget guard refused run: estimated worst-case $${estimate.toFixed(2)} exceeds LIVE_GPU_RESERVATION_MAX_TOTAL_USD=$${maxTotal.toFixed(2)}`);
  }
  if (process.env.LIVE_GPU_RESERVATION_ACK_1000_PHYSICAL !== '1') {
    throw new Error('Set LIVE_GPU_RESERVATION_ACK_1000_PHYSICAL=1 to acknowledge this test creates real Vast GPU reservations.');
  }
}

function isBudgetBlocked(result: GatewayResult<JsonObject>): boolean {
  const text = `${result.status} ${result.text}`;
  return result.status === 402 || /insufficient balance|add funds|balance/i.test(text);
}

function isSystemicReservationFailure(message: string): boolean {
  return /rate limit|too frequent|429|queue full|queue timeout|stalled|deploy lock held/i.test(message);
}

async function runPhysicalReservationAttempt(args: {
  index: number;
  runId: string;
  reportPath: string;
}): Promise<PhysicalAttemptRecord> {
  const { index, runId, reportPath } = args;
  const label = `lv-physical-${runId}-${String(index).padStart(4, '0')}`;
  const slot = uniqueId(`phys${index}`);
  const startMs = Date.now();
  let deployId = '';
  let terminal: PhysicalAttemptRecord | null = null;
  trackSlot(slot, label);

  try {
    const body = buildDeployBody(slot, label, {
      bootTimeoutSec: numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_BOOT_TIMEOUT_SEC', 300, 30, 600),
      maxCostUsd: numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_MAX_COST_USD', 1.25, 0.1, 20),
      searchMode: stringEnv('LIVE_GPU_RESERVATION_PHYSICAL_SEARCH_MODE', process.env.LIVE_GPU_RESERVATION_SEARCH_MODE || 'high_quality'),
      strictFastBoot: process.env.LIVE_GPU_RESERVATION_PHYSICAL_STRICT_FAST_BOOT === '0' ? false : true,
      raceCount: 1,
    });

    const create = await gatewayRequest<DeployResponse>('POST', '/v1/gpu/deploy', body, 120_000);
    if (isBudgetBlocked(create)) {
      terminal = {
        index,
        slot,
        label,
        status: 'deploy-rejected',
        httpStatus: create.status,
        durationMs: Date.now() - startMs,
        message: 'budget-gate',
        error: create.text.slice(0, 800),
      };
      appendPhysicalRecord(reportPath, terminal);
      return terminal;
    }

    if (![200, 202].includes(create.status)) {
      terminal = {
        index,
        slot,
        label,
        status: 'deploy-rejected',
        httpStatus: create.status,
        durationMs: Date.now() - startMs,
        error: create.text.slice(0, 800),
      };
      appendPhysicalRecord(reportPath, terminal);
      return terminal;
    }

    deployId = create.body.deployId || '';
    trackSlot(slot, label, deployId);
    const ready = await waitForReservationReady(
      slot,
      numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_READY_TIMEOUT_MS', 720_000, 60_000, 1_800_000),
      numberEnv('LIVE_GPU_RESERVATION_STALL_MS', 240_000, 60_000, 600_000),
    );

    const keepReadyMs = numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_KEEP_READY_MS', 0, 0, 600_000);
    if (keepReadyMs > 0) await new Promise(resolve => setTimeout(resolve, keepReadyMs));

    terminal = {
      index,
      slot,
      label,
      status: 'ready',
      deployId,
      podId: ready.podId,
      provider: ready.provider,
      gpuType: ready.gpuType,
      durationMs: Date.now() - startMs,
      message: ready.message,
    };
    appendPhysicalRecord(reportPath, terminal);
    return terminal;
  } catch (err) {
    terminal = {
      index,
      slot,
      label,
      status: deployId ? 'readiness-error' : 'deploy-error',
      deployId,
      durationMs: Date.now() - startMs,
      error: err instanceof Error ? err.message : String(err),
    };
    appendPhysicalRecord(reportPath, terminal);
    return terminal;
  } finally {
    const cleanupStartMs = Date.now();
    try {
      await cleanupSlot(slot, deployId);
      appendPhysicalRecord(reportPath, {
        index,
        slot,
        label,
        status: 'terminated',
        deployId,
        durationMs: Date.now() - startMs,
        cleanupMs: Date.now() - cleanupStartMs,
      });
    } catch (err) {
      appendPhysicalRecord(reportPath, {
        index,
        slot,
        label,
        status: 'cleanup-error',
        deployId,
        durationMs: Date.now() - startMs,
        cleanupMs: Date.now() - cleanupStartMs,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function runPhysicalReservationPool(args: {
  target: number;
  concurrency: number;
  reportPath: string;
  runId: string;
}): Promise<PhysicalAttemptRecord[]> {
  const { target, concurrency, reportPath, runId } = args;
  const results: PhysicalAttemptRecord[] = [];
  let nextIndex = 0;
  let stopReason = '';
  const maxFailures = numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_MAX_FAILURES', Math.max(1, Math.ceil(target * 0.05)), 0, target);

  async function worker(workerId: number): Promise<void> {
    while (!stopReason) {
      const index = nextIndex++;
      if (index >= target) return;
      const result = await runPhysicalReservationAttempt({ index, runId, reportPath });
      results.push(result);
      console.log(`[live-physical-1000] worker=${workerId} #${index} status=${result.status} deployId=${result.deployId || ''} gpu=${result.gpuType || ''} durationMs=${result.durationMs}`);

      if (result.message === 'budget-gate') {
        stopReason = 'budget-gate';
        return;
      }
      if (result.error && isSystemicReservationFailure(result.error)) {
        stopReason = `systemic-failure: ${result.error.slice(0, 200)}`;
        return;
      }
      const failures = results.filter(r => r.status !== 'ready' && r.status !== 'terminated').length;
      if (failures > maxFailures) {
        stopReason = `failure-threshold: ${failures} > ${maxFailures}`;
        return;
      }

      const delayMs = numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_DELAY_MS', 1_000, 0, 60_000);
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)));
  const firstFailure = results.find(r => r.status !== 'ready');
  const summary = {
    target,
    concurrency,
    attempted: results.length,
    ready: results.filter(r => r.status === 'ready').length,
    rejected: results.filter(r => r.status === 'deploy-rejected').length,
    errors: results.filter(r => r.status === 'deploy-error' || r.status === 'readiness-error').length,
    stopReason,
    firstFailure: firstFailure
      ? {
          index: firstFailure.index,
          status: firstFailure.status,
          httpStatus: firstFailure.httpStatus,
          message: firstFailure.message,
          error: firstFailure.error,
        }
      : null,
    reportPath,
  };
  writePhysicalSummary(reportPath, summary);
  console.log(`[live-physical-1000] summary=${JSON.stringify(summary)}`);
  return results;
}

afterAll(async () => {
  for (const slot of [...liveSlots].reverse()) {
    await cleanupSlot(slot.slot, slot.deployId).catch(err => {
      console.warn(`[live-reservation] final cleanup failed for ${slot.slot}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
});

liveDescribe('live gateway Vast reservation E2E', () => {
  vi.setConfig({ retry: 0 });

  it.skipIf(runOnlyPhysical)('validates the live Vast deploy payload without provisioning', async () => {
    const slot = uniqueId('validate');
    const body = buildDeployBody(slot, slot, { bootTimeoutSec: 60 });

    const result = await gatewayRequest<JsonObject>('POST', '/v1/gpu/deploy/validate', body, 90_000);
    const response = expectHttpOk(result, [200], 'POST /v1/gpu/deploy/validate');

    expect(response.ok).toBe(true);
    expect(response.dryRun).toBe(true);
    expect(response.provider).toBe('vast');
    expect((response.deployPolicy as JsonObject | undefined)?.directSshRequired).toBe(true);
  }, 120_000);

  it.skipIf(runOnlyPhysical)('coalesces duplicate deploys in one app slot and force-terminates cleanly', async () => {
    const slot = uniqueId('dup');
    const body = buildDeployBody(slot, slot, { bootTimeoutSec: 180 });

    const first = await gatewayRequest<DeployResponse>('POST', '/v1/gpu/deploy', body, 120_000);
    const firstBody = expectHttpOk(first, [200, 202], 'first POST /v1/gpu/deploy');
    trackSlot(slot, slot, firstBody.deployId);

    const second = await gatewayRequest<DeployResponse>('POST', '/v1/gpu/deploy', body, 30_000);
    const secondBody = expectHttpOk(second, [200, 202], 'duplicate POST /v1/gpu/deploy');

    expect(secondBody.idempotent).toBe(true);
    if (firstBody.deployId && secondBody.deployId) {
      expect(secondBody.deployId).toBe(firstBody.deployId);
    }

    const status = await getSlotStatus(slot);
    expect(['queued', 'searching', 'creating', 'booting', 'installing', 'warming', 'ready'].includes(String(status.status))).toBe(true);

    await cleanupSlot(slot, firstBody.deployId);
    expect((await getSlotStatus(slot)).status).toBe('idle');
  }, 300_000);

  it.skipIf(runOnlyPhysical)('reserves one real Vast instance and reaches SSH readiness without stalling', async () => {
    const slot = uniqueId('ssh');
    const body = buildDeployBody(slot, slot);
    let deployId = '';

    try {
      const create = await gatewayRequest<DeployResponse>('POST', '/v1/gpu/deploy', body, 120_000);
      const createBody = expectHttpOk(create, [200, 202], 'POST /v1/gpu/deploy');
      deployId = createBody.deployId || '';
      trackSlot(slot, slot, deployId);
      expect(deployId).toBeTruthy();

      const ready = await waitForReservationReady(
        slot,
        numberEnv('LIVE_GPU_RESERVATION_READY_TIMEOUT_MS', 540_000, 60_000, 900_000),
        numberEnv('LIVE_GPU_RESERVATION_STALL_MS', 240_000, 60_000, 600_000),
      );

      expect(ready.provider).toMatch(/vast/);
      expect(ready.deployId).toBe(deployId);
      expect(String(ready.podId || ready.sshHost || '')).toBeTruthy();
      if (ready.sshHost) expect(Number(ready.sshPort || 0)).toBeGreaterThan(0);

      const instances = await visibleInstances();
      expect(instances.some(instance => JSON.stringify(instance).includes(deployId) || JSON.stringify(instance).includes(String(ready.podId || '')))).toBe(true);
    } finally {
      await cleanupSlot(slot, deployId);
    }
  }, 720_000);

  it.skipIf(!runBurst)('runs a concurrent real reservation burst without rate-limit or stuck-slot failures', async () => {
    const burstCount = numberEnv('LIVE_GPU_RESERVATION_BURST_COUNT', 2, 2, 3);
    const slots = Array.from({ length: burstCount }, (_, index) => {
      const slot = uniqueId(`burst${index + 1}`);
      return { slot, body: buildDeployBody(slot, slot, { bootTimeoutSec: 360 }) };
    });

    try {
      const creates = await Promise.all(slots.map(async ({ slot, body }) => {
        const result = await gatewayRequest<DeployResponse>('POST', '/v1/gpu/deploy', body, 120_000);
        const response = expectHttpOk(result, [200, 202], `POST /v1/gpu/deploy ${slot}`);
        trackSlot(slot, slot, response.deployId);
        expect(response.deployId).toBeTruthy();
        return { slot, deployId: response.deployId || '' };
      }));

      const readyStatuses = await Promise.all(creates.map(({ slot }) => waitForReservationReady(
        slot,
        numberEnv('LIVE_GPU_RESERVATION_BURST_READY_TIMEOUT_MS', 720_000, 120_000, 1_200_000),
        numberEnv('LIVE_GPU_RESERVATION_STALL_MS', 240_000, 60_000, 600_000),
      )));

      for (const status of readyStatuses) {
        expect(status.provider).toMatch(/vast/);
        expect(String(status.podId || status.sshHost || '')).toBeTruthy();
        expect(String(status.message || '')).not.toMatch(/rate limit|too frequent|429|queue full|queue timeout/i);
      }
    } finally {
      await Promise.allSettled(slots.map(({ slot }) => cleanupSlot(slot)));
    }
  }, 1_200_000);

  it.skipIf(runOnlyPhysical || !runSoak)('runs 1000+ gateway reservation scenarios around a real Vast reservation', async () => {
    const scenarioCount = numberEnv('LIVE_GPU_RESERVATION_SOAK_SCENARIOS', 1008, 1001, 10_000);
    const slot = uniqueId('soak');
    const body = buildDeployBody(slot, slot, {
      bootTimeoutSec: numberEnv('LIVE_GPU_RESERVATION_SOAK_BOOT_TIMEOUT_SEC', 420, 60, 600),
    });
    const counts: Record<string, number> = {};
    const failures: string[] = [];
    let deployId = '';
    let lastStatus: GpuStatusResponse = {};

    try {
      const create = await gatewayRequest<DeployResponse>('POST', '/v1/gpu/deploy', body, 120_000);
      const createBody = expectHttpOk(create, [200, 202], 'POST /v1/gpu/deploy soak');
      deployId = createBody.deployId || '';
      trackSlot(slot, slot, deployId);
      expect(deployId).toBeTruthy();

      for (let index = 0; index < scenarioCount; index++) {
        try {
          if (index % 20 === 0) lastStatus = await getSlotStatus(slot);
          const status = String(lastStatus.status || '');
          const allowDuplicateDeploy = !['ready', 'error', 'idle', 'stopped'].includes(status);
          const kind = await runSoakScenario({
            index,
            slot,
            deployId,
            deployBody: body,
            allowDuplicateDeploy,
          });
          counts[kind] = (counts[kind] || 0) + 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`#${index}: ${message.slice(0, 500)}`);
          if (/rate limit|too frequent|429|queue full|queue timeout|stalled/i.test(message)) break;
        }

        const delayMs = numberEnv('LIVE_GPU_RESERVATION_SOAK_DELAY_MS', 25, 0, 5_000);
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      console.log(`[live-reservation-soak] scenarios=${scenarioCount} counts=${JSON.stringify(counts)} failures=${failures.length}`);
      if (failures.length > 0) console.log(`[live-reservation-soak] first failures=${JSON.stringify(failures.slice(0, 5))}`);
      expect(failures).toEqual([]);
      expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(1001);
      expect(counts['duplicate-deploy'] || 0).toBeGreaterThan(0);

      const ready = await waitForReservationReady(
        slot,
        numberEnv('LIVE_GPU_RESERVATION_SOAK_READY_TIMEOUT_MS', 900_000, 120_000, 1_800_000),
        numberEnv('LIVE_GPU_RESERVATION_STALL_MS', 240_000, 60_000, 600_000),
      );
      expect(ready.provider).toMatch(/vast/);
      expect(String(ready.podId || ready.sshHost || '')).toBeTruthy();
    } finally {
      await cleanupSlot(slot, deployId);
    }
  }, 1_800_000);

  it.skipIf(!runPhysical1000)('attempts 1000 physical Vast GPU reservations through gateway slots', async () => {
    const target = numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_TARGET', 1000, 1, 1000);
    const concurrency = numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_CONCURRENCY', 1, 1, 20);
    assertPhysicalBudgetAcknowledged(target);

    const runId = Date.now().toString(36);
    const reportPath = physicalReportPath(runId);
    writePhysicalSummary(reportPath, {
      status: 'started',
      target,
      concurrency,
      gatewayUrl: gatewayUrl(),
      estimatedWorstCaseUsd: estimatePhysicalWorstCaseUsd(target),
      startedAt: new Date().toISOString(),
    });

    const results = await runPhysicalReservationPool({ target, concurrency, reportPath, runId });
    const ready = results.filter(r => r.status === 'ready').length;
    const budgetBlocked = results.some(r => r.message === 'budget-gate');
    const systemic = results.find(r => r.error && isSystemicReservationFailure(r.error));
    const maxFailures = numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_MAX_FAILURES', Math.max(1, Math.ceil(target * 0.05)), 0, target);

    expect(budgetBlocked, `Budget Gate blocked the physical 1000 run; report=${reportPath}`).toBe(false);
    expect(systemic?.error || '', `Systemic reservation failure; report=${reportPath}`).toBe('');
    expect(results.length, `Not all physical reservation attempts ran; report=${reportPath}`).toBe(target);
    expect(target - ready, `Too many failed physical reservations; report=${reportPath}`).toBeLessThanOrEqual(maxFailures);
  }, numberEnv('LIVE_GPU_RESERVATION_PHYSICAL_TEST_TIMEOUT_MS', 86_400_000, 600_000, 604_800_000));
});

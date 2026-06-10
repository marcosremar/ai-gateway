#!/usr/bin/env bun
/**
 * Live Vast reservation runner.
 *
 * This is an opt-in, billable E2E harness for long physical reservation runs.
 * It uses the Gateway HTTP API only and never calls Vast.ai directly.
 *
 * Example:
 *   AIGW_LIVE_GATEWAY_URL=https://parle-ai-gateway.fly.dev \
 *   AIGW_LIVE_API_KEY=... \
 *   bun run scripts/live-vast-reservation-1000.ts --target 1000 --ack
 *
 * Resume from an existing JSONL report:
 *   bun run scripts/live-vast-reservation-1000.ts --resume .codex-temp/vast-physical-1000-abc.jsonl --ack
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

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
  deployId?: string;
  costPerHr?: number;
  sshHost?: string;
  sshPort?: number;
  healthy?: boolean;
  gpuHealthy?: boolean;
}

type AttemptStatus =
  | 'ready'
  | 'deploy-rejected'
  | 'deploy-error'
  | 'readiness-error'
  | 'cleanup-error'
  | 'terminated';

interface AttemptRecord {
  index: number;
  slot: string;
  label: string;
  status: AttemptStatus;
  deployId?: string;
  podId?: string;
  provider?: string;
  gpuType?: string;
  httpStatus?: number;
  durationMs: number;
  message?: string;
  error?: string;
  cleanupMs?: number;
  at?: string;
}

interface PreRunAudit {
  checkedAt: string;
  health?: JsonObject;
  offers?: JsonObject;
  preflight?: JsonObject;
  errors: string[];
}

interface RunnerOptions {
  target: number;
  concurrency: number;
  gatewayUrl: string;
  apiKey: string;
  reportPath: string;
  runId: string;
  startIndex: number;
  dryRun: boolean;
  ack: boolean;
  maxTotalUsd: number;
  maxCostUsd: number;
  maxFailures: number;
  maxAttemptsThisRun: number;
  providerRetries: boolean;
  waitForFunds: boolean;
  fundsPollMs: number;
  fundsTimeoutMs: number;
  minVastBalanceUsd: number;
  bootTimeoutSec: number;
  readyTimeoutMs: number;
  stallMs: number;
  providerRetryGraceMs: number;
  pollMs: number;
  delayMs: number;
  keepReadyMs: number;
  cleanupBufferSec: number;
}

const DEFAULT_IMAGE = 'nvidia/cuda:12.4.1-base-ubuntu22.04';
const DEFAULT_GPU_TYPES = [
  'NVIDIA GeForce RTX 4090',
  'NVIDIA RTX A5000',
  'NVIDIA A40',
];

let stopRequested = false;

process.on('SIGINT', () => {
  stopRequested = true;
  console.warn('[vast-physical-1000] stop requested; workers will finish current reservation and cleanup.');
});

process.on('SIGTERM', () => {
  stopRequested = true;
  console.warn('[vast-physical-1000] terminate requested; workers will finish current reservation and cleanup.');
});

function parseCli(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const name = arg.slice(2);
    if (['ack', 'dry-run', 'provider-retries', 'wait-for-funds', 'help'].includes(name)) {
      parsed[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    parsed[name] = value;
    index++;
  }
  return parsed;
}

function cliString(cli: Record<string, string | boolean>, name: string): string | undefined {
  const value = cli[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cliNumber(
  cli: Record<string, string | boolean>,
  name: string,
  envName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = cliString(cli, name) ?? process.env[envName];
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function parseCsvEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw.split(',').map(value => value.trim()).filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function uniqueId(kind: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `lv-${kind}-${ts}-${rand}`;
}

function defaultReportPath(runId: string): string {
  const dir = process.env.LIVE_GPU_RESERVATION_REPORT_DIR
    || path.join(process.cwd(), '.codex-temp');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `vast-physical-1000-${runId}.jsonl`);
}

function resolveApiKey(): string {
  const key = process.env.AIGW_LIVE_API_KEY
    || process.env.AIGW_APP_KEY
    || process.env.AI_GATEWAY_KEY
    || process.env.GATEWAY_API_KEY
    || process.env.GATEWAY_API_KEYS?.split(',')[0]?.split(':')[0]
    || '';
  if (!key.trim()) {
    throw new Error('Set AIGW_LIVE_API_KEY, AIGW_APP_KEY, GATEWAY_API_KEY, or GATEWAY_API_KEYS.');
  }
  return key.trim();
}

function buildOptions(cli: Record<string, string | boolean>): RunnerOptions {
  const runId = cliString(cli, 'run-id')
    || path.basename(cliString(cli, 'resume') || '').match(/vast-physical-1000-(.+)\.jsonl$/)?.[1]
    || Date.now().toString(36);
  const target = cliNumber(cli, 'target', 'LIVE_GPU_RESERVATION_PHYSICAL_TARGET', 1000, 1, 1000);
  const reportPath = path.resolve(cliString(cli, 'report') || cliString(cli, 'resume') || defaultReportPath(runId));
  mkdirSync(path.dirname(reportPath), { recursive: true });

  return {
    target,
    concurrency: cliNumber(cli, 'concurrency', 'LIVE_GPU_RESERVATION_PHYSICAL_CONCURRENCY', 1, 1, 20),
    gatewayUrl: (cliString(cli, 'gateway-url')
      || process.env.AIGW_LIVE_GATEWAY_URL
      || process.env.AI_GATEWAY_URL
      || process.env.GATEWAY_URL
      || 'http://localhost:4000').replace(/\/+$/, ''),
    apiKey: cliString(cli, 'api-key') || resolveApiKey(),
    reportPath,
    runId,
    startIndex: cliNumber(cli, 'start-index', 'LIVE_GPU_RESERVATION_PHYSICAL_START_INDEX', 0, 0, target - 1),
    dryRun: cli['dry-run'] === true || process.env.LIVE_GPU_RESERVATION_DRY_RUN === '1',
    ack: cli['ack'] === true || process.env.LIVE_GPU_RESERVATION_ACK_1000_PHYSICAL === '1',
    maxTotalUsd: cliNumber(cli, 'max-total-usd', 'LIVE_GPU_RESERVATION_MAX_TOTAL_USD', 250, 1, 100_000),
    maxCostUsd: cliNumber(cli, 'max-cost-usd', 'LIVE_GPU_RESERVATION_PHYSICAL_MAX_COST_USD', 1.25, 0.1, 20),
    maxFailures: cliNumber(cli, 'max-failures', 'LIVE_GPU_RESERVATION_PHYSICAL_MAX_FAILURES', Math.max(1, Math.ceil(target * 0.05)), 0, target),
    maxAttemptsThisRun: cliNumber(cli, 'max-attempts-this-run', 'LIVE_GPU_RESERVATION_MAX_ATTEMPTS_THIS_RUN', target, 1, target),
    providerRetries: cli['provider-retries'] === true || process.env.LIVE_GPU_RESERVATION_PROVIDER_RETRIES === '1',
    waitForFunds: cli['wait-for-funds'] === true || process.env.LIVE_GPU_RESERVATION_WAIT_FOR_FUNDS === '1',
    fundsPollMs: cliNumber(cli, 'funds-poll-ms', 'LIVE_GPU_RESERVATION_FUNDS_POLL_MS', 60_000, 5_000, 3_600_000),
    fundsTimeoutMs: cliNumber(cli, 'funds-timeout-ms', 'LIVE_GPU_RESERVATION_FUNDS_TIMEOUT_MS', 86_400_000, 10_000, 604_800_000),
    minVastBalanceUsd: cliNumber(cli, 'min-vast-balance-usd', 'LIVE_GPU_RESERVATION_MIN_VAST_BALANCE_USD', 1, 0.5, 100_000),
    bootTimeoutSec: cliNumber(cli, 'boot-timeout-sec', 'LIVE_GPU_RESERVATION_PHYSICAL_BOOT_TIMEOUT_SEC', 300, 30, 600),
    readyTimeoutMs: cliNumber(cli, 'ready-timeout-ms', 'LIVE_GPU_RESERVATION_PHYSICAL_READY_TIMEOUT_MS', 720_000, 60_000, 1_800_000),
    stallMs: cliNumber(cli, 'stall-ms', 'LIVE_GPU_RESERVATION_STALL_MS', 240_000, 60_000, 600_000),
    providerRetryGraceMs: cliNumber(cli, 'provider-retry-grace-ms', 'LIVE_GPU_RESERVATION_PROVIDER_RETRY_GRACE_MS', 90_000, 10_000, 300_000),
    pollMs: cliNumber(cli, 'poll-ms', 'LIVE_GPU_RESERVATION_POLL_MS', 10_000, 2_000, 60_000),
    delayMs: cliNumber(cli, 'delay-ms', 'LIVE_GPU_RESERVATION_PHYSICAL_DELAY_MS', 1_000, 0, 60_000),
    keepReadyMs: cliNumber(cli, 'keep-ready-ms', 'LIVE_GPU_RESERVATION_PHYSICAL_KEEP_READY_MS', 0, 0, 600_000),
    cleanupBufferSec: cliNumber(cli, 'cleanup-buffer-sec', 'LIVE_GPU_RESERVATION_PHYSICAL_CLEANUP_BUFFER_SEC', 120, 0, 1_800),
  };
}

function printHelp(): void {
  console.log(`Live Vast physical reservation runner

Options:
  --target <n>             Number of physical reservations to complete, max 1000
  --concurrency <n>        Parallel reservation workers, default 1
  --gateway-url <url>      Gateway base URL
  --api-key <key>          Gateway API key
  --report <path>          JSONL report path
  --resume <path>          Reuse an existing JSONL report and skip ready indexes
  --start-index <n>        First index to consider, default 0
  --max-total-usd <n>      Worst-case budget guard, default 250
  --max-cost-usd <n>       Per-deploy hourly cost cap sent to gateway, default 1.25
  --max-failures <n>       Stop after this many non-ready outcomes
  --max-attempts-this-run <n> Stop this process after issuing n new attempts
  --provider-retries       Allow gateway retries within Vast for bad hosts
  --provider-retry-grace-ms <n> Wait for a retry transition after retryable errors
  --wait-for-funds         Poll Gateway balance until Vast can deploy, then start
  --funds-poll-ms <n>      Balance polling interval for --wait-for-funds
  --funds-timeout-ms <n>   Max wait time for --wait-for-funds
  --min-vast-balance-usd <n> Minimum Vast balance before starting, default 1
  --dry-run                Validate payload and health without provisioning
  --ack                    Acknowledge this creates billable Vast reservations
  --help                   Show this help
`);
}

function estimateWorstCaseUsd(options: RunnerOptions): number {
  const providerAttemptFactor = options.providerRetries ? 3 : 1;
  return options.target
    * options.maxCostUsd
    * ((options.bootTimeoutSec + options.keepReadyMs / 1000 + options.cleanupBufferSec) / 3600)
    * providerAttemptFactor;
}

function assertBudgetAcknowledged(options: RunnerOptions): void {
  if (options.dryRun) return;
  const estimate = estimateWorstCaseUsd(options);
  if (estimate > options.maxTotalUsd) {
    throw new Error(`Budget guard refused run: estimated worst-case $${estimate.toFixed(2)} exceeds max $${options.maxTotalUsd.toFixed(2)}.`);
  }
  if (!options.ack) {
    throw new Error('Pass --ack or set LIVE_GPU_RESERVATION_ACK_1000_PHYSICAL=1 to run billable physical reservations.');
  }
}

function authHeaders(options: RunnerOptions, requestId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${options.apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(requestId ? { 'X-Request-Id': requestId } : {}),
  };
}

async function gatewayRequest<T extends JsonObject>(
  options: RunnerOptions,
  method: string,
  route: string,
  body?: unknown,
  timeoutMs = 30_000,
  requestId?: string,
): Promise<GatewayResult<T>> {
  const url = new URL(route, options.gatewayUrl);
  const res = await fetch(url, {
    method,
    headers: authHeaders(options, requestId),
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

function compactHealthAudit(body: JsonObject): JsonObject {
  return {
    status: body.status,
    gpu: body.gpu,
    providerBalances: body.providerBalances,
    balanceAlerts: body.balanceAlerts,
    budget: body.budget,
  };
}

function compactOffersAudit(body: JsonObject): JsonObject {
  const firstOffer = Array.isArray(body.offers) ? body.offers[0] as JsonObject | undefined : undefined;
  return {
    balances: body.balances,
    providers: body.providers,
    firstOffer: firstOffer
      ? {
          provider: firstOffer.provider,
          gpuType: firstOffer.gpuType,
          pricePerHr: firstOffer.pricePerHr,
          canDeploy: firstOffer.canDeploy,
          providerBalance: firstOffer.providerBalance,
        }
      : null,
  };
}

function compactPreflightAudit(body: JsonObject): JsonObject {
  return {
    ok: body.ok,
    errors: body.errors,
    warnings: body.warnings,
  };
}

async function collectPreRunAudit(options: RunnerOptions): Promise<PreRunAudit> {
  const audit: PreRunAudit = { checkedAt: new Date().toISOString(), errors: [] };

  const health = await gatewayRequest<JsonObject>(options, 'GET', '/health', undefined, 20_000, `vast-physical-${options.runId}-health-audit`);
  if (health.status === 200) {
    audit.health = compactHealthAudit(health.body);
  } else {
    audit.errors.push(`/health HTTP ${health.status}: ${health.text.slice(0, 500)}`);
  }

  const offers = await gatewayRequest<JsonObject>(options, 'GET', '/v1/gpu/offers?provider=vast&limit=1&probe=false', undefined, 90_000, `vast-physical-${options.runId}-offers-audit`);
  if (offers.status === 200) {
    audit.offers = compactOffersAudit(offers.body);
  } else {
    audit.errors.push(`/v1/gpu/offers HTTP ${offers.status}: ${offers.text.slice(0, 500)}`);
  }

  const drySlot = uniqueId('audit');
  const preflight = await gatewayRequest<JsonObject>(
    options,
    'POST',
    '/v1/gpu/preflight',
    {
      image: envString('LIVE_GPU_RESERVATION_IMAGE', DEFAULT_IMAGE),
      provider: 'vast',
      gpuTypes: parseCsvEnv('LIVE_GPU_RESERVATION_GPU_TYPES', DEFAULT_GPU_TYPES),
      quotedPricePerHr: options.maxCostUsd,
    },
    90_000,
    `vast-physical-${options.runId}-${drySlot}-preflight-audit`,
  );
  if ([200, 400].includes(preflight.status)) {
    audit.preflight = compactPreflightAudit(preflight.body);
  } else {
    audit.errors.push(`/v1/gpu/preflight HTTP ${preflight.status}: ${preflight.text.slice(0, 500)}`);
  }

  return audit;
}

function summarizeAuditForLog(audit: PreRunAudit): string {
  const balances = audit.offers?.balances as Record<string, JsonObject> | undefined;
  const vastBalance = balances?.vast;
  return JSON.stringify({
    vastBalance: vastBalance?.balance,
    vastCanDeploy: vastBalance?.canDeploy,
    preflightOk: audit.preflight?.ok,
    auditErrors: audit.errors.length,
  });
}

function vastBalanceFromAudit(audit: PreRunAudit): { balance: number | null; canDeploy: boolean | null } {
  const balances = audit.offers?.balances as Record<string, JsonObject> | undefined;
  const vast = balances?.vast;
  const rawBalance = vast?.balance;
  const balance = typeof rawBalance === 'number' && Number.isFinite(rawBalance) ? rawBalance : null;
  const rawCanDeploy = vast?.canDeploy;
  const canDeploy = typeof rawCanDeploy === 'boolean' ? rawCanDeploy : null;
  return { balance, canDeploy };
}

function hasEnoughVastFunds(options: RunnerOptions, audit: PreRunAudit): boolean {
  const { balance, canDeploy } = vastBalanceFromAudit(audit);
  return canDeploy === true && balance !== null && balance >= options.minVastBalanceUsd;
}

async function waitForVastFunds(options: RunnerOptions, startedAt: string): Promise<PreRunAudit> {
  const deadline = Date.now() + options.fundsTimeoutMs;
  let lastAudit: PreRunAudit | null = null;

  while (Date.now() < deadline && !stopRequested) {
    lastAudit = await collectPreRunAudit(options);
    const { balance, canDeploy } = vastBalanceFromAudit(lastAudit);
    writeSummary(options, {
      status: 'waiting-for-funds',
      target: options.target,
      concurrency: options.concurrency,
      maxAttemptsThisRun: options.maxAttemptsThisRun,
      providerRetries: options.providerRetries,
      providerRetryGraceMs: options.providerRetryGraceMs,
      gatewayUrl: options.gatewayUrl,
      reportPath: options.reportPath,
      startedAt,
      updatedAt: new Date().toISOString(),
      estimatedWorstCaseUsd: estimateWorstCaseUsd(options),
      minVastBalanceUsd: options.minVastBalanceUsd,
      vastBalance: balance,
      vastCanDeploy: canDeploy,
      preRunAudit: lastAudit,
    });

    console.log(`[vast-physical-1000] waiting-for-funds audit=${summarizeAuditForLog(lastAudit)} minVastBalanceUsd=${options.minVastBalanceUsd}`);
    if (hasEnoughVastFunds(options, lastAudit)) return lastAudit;
    await sleep(options.fundsPollMs);
  }

  const reason = stopRequested
    ? 'stopped while waiting for funds'
    : `timed out waiting ${options.fundsTimeoutMs}ms for Vast balance >= $${options.minVastBalanceUsd}`;
  const { balance, canDeploy } = lastAudit ? vastBalanceFromAudit(lastAudit) : { balance: null, canDeploy: null };
  throw new Error(`${reason}. Last balance=${balance ?? '?'} canDeploy=${canDeploy ?? '?'}`);
}

function buildDeployBody(options: RunnerOptions, slot: string, label: string): JsonObject {
  const body: JsonObject = {
    provider: 'vast',
    noTierCascade: true,
    dockerImage: envString('LIVE_GPU_RESERVATION_IMAGE', DEFAULT_IMAGE),
    gpuTypes: parseCsvEnv('LIVE_GPU_RESERVATION_GPU_TYPES', DEFAULT_GPU_TYPES),
    storageGb: cliOrEnvNumber('LIVE_GPU_RESERVATION_STORAGE_GB', 20, 5, 100),
    containerDiskInGb: cliOrEnvNumber('LIVE_GPU_RESERVATION_CONTAINER_DISK_GB', 10, 0, 100),
    maxCostUsd: options.maxCostUsd,
    raceCount: 1,
    readinessProbe: 'ssh',
    bootTimeoutSec: options.bootTimeoutSec,
    searchMode: envString('LIVE_GPU_RESERVATION_PHYSICAL_SEARCH_MODE', process.env.LIVE_GPU_RESERVATION_SEARCH_MODE || 'high_quality'),
    strictFastBoot: process.env.LIVE_GPU_RESERVATION_PHYSICAL_STRICT_FAST_BOOT === '0' ? false : true,
    suppressProviderRetries: !options.providerRetries,
    finetune: true,
    runSmokeTests: false,
    requireDockerManifest: false,
    interruptible: false,
    parallelSlot: slot,
    label,
    onstart: 'nohup bash -lc "sleep infinity" >/tmp/aigw-live-reservation-1000.log 2>&1 &',
    env: {
      AIGW_LIVE_RESERVATION_E2E: slot,
      AIGW_LIVE_RESERVATION_INDEX: label,
    },
  };

  if (process.env.LIVE_GPU_RESERVATION_SEND_PROVIDER_KEYS === '1' && process.env.VAST_API_KEY) {
    body.vastApiKey = process.env.VAST_API_KEY;
  }

  return body;
}

function cliOrEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
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

async function getSlotStatus(options: RunnerOptions, slot: string): Promise<GpuStatusResponse> {
  const route = `/v1/gpu/status?parallelSlot=${encodeURIComponent(slot)}`;
  const result = await gatewayRequest<GpuStatusResponse>(options, 'GET', route, undefined, 20_000);
  return expectHttpOk(result, [200], `GET ${route}`);
}

async function waitForSlotIdle(options: RunnerOptions, slot: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: GpuStatusResponse = {};
  while (Date.now() < deadline) {
    last = await getSlotStatus(options, slot);
    if (!last.status || last.status === 'idle') return;
    await sleep(5_000);
  }
  throw new Error(`slot ${slot} did not become idle. Last status: ${statusSummary(last)}`);
}

async function cleanupSlot(options: RunnerOptions, slot: string, deployId?: string): Promise<void> {
  const body: JsonObject = {
    parallelSlot: slot,
    provider: 'vast',
    force: true,
    ...(deployId ? { deployId } : {}),
  };
  const result = await gatewayRequest<JsonObject>(options, 'POST', '/v1/gpu/terminate', body, 90_000);
  if (![200, 202, 404].includes(result.status)) {
    throw new Error(`terminate ${slot} returned HTTP ${result.status}: ${result.text.slice(0, 800)}`);
  }
  await waitForSlotIdle(options, slot, 90_000);
}

async function waitForReservationReady(options: RunnerOptions, slot: string): Promise<GpuStatusResponse> {
  const deadline = Date.now() + options.readyTimeoutMs;
  let last: GpuStatusResponse = {};
  let lastFingerprint = '';
  let lastChangeAt = Date.now();
  let retryableErrorFingerprint = '';
  let retryableErrorSince = 0;

  while (Date.now() < deadline) {
    last = await getSlotStatus(options, slot);
    const fingerprint = statusFingerprint(last);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastChangeAt = Date.now();
      console.log(`[vast-physical-1000] ${slot}: ${statusSummary(last)}`);
    }

    if (last.status === 'ready' || last.healthy === true || last.gpuHealthy === true) {
      return last;
    }
    if (last.status === 'error') {
      const retryable = options.providerRetries && isRetryableReservationStatus(last);
      if (retryable) {
        if (retryableErrorFingerprint !== fingerprint) {
          retryableErrorFingerprint = fingerprint;
          retryableErrorSince = Date.now();
        }
        if (Date.now() - retryableErrorSince <= options.providerRetryGraceMs) {
          await sleep(options.pollMs);
          continue;
        }
      }
      throw new Error(`deploy ${slot} errored: ${statusSummary(last)}`);
    }
    retryableErrorFingerprint = '';
    retryableErrorSince = 0;
    if (Date.now() - lastChangeAt > options.stallMs) {
      throw new Error(`deploy ${slot} appears stalled for ${options.stallMs}ms: ${statusSummary(last)}`);
    }
    await sleep(options.pollMs);
  }

  throw new Error(`deploy ${slot} did not reach SSH readiness in ${options.readyTimeoutMs}ms. Last status: ${statusSummary(last)}`);
}

function appendRecord(reportPath: string, record: AttemptRecord): void {
  appendFileSync(reportPath, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
}

function loadReadyIndexes(reportPath: string): Set<number> {
  const ready = new Set<number>();
  if (!existsSync(reportPath)) return ready;
  const content = readFileSync(reportPath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as AttemptRecord;
      if (record.status === 'ready') ready.add(record.index);
    } catch {
      // Ignore malformed lines so an interrupted write does not strand resume.
    }
  }
  return ready;
}

function isBudgetBlocked(result: GatewayResult<JsonObject>): boolean {
  return result.status === 402 || /insufficient balance|add funds|balance/i.test(`${result.status} ${result.text}`);
}

function isSystemicReservationFailure(message: string): boolean {
  return /rate limit|too frequent|429|queue full|queue timeout|stalled|deploy lock held/i.test(message);
}

async function runAttempt(options: RunnerOptions, index: number): Promise<AttemptRecord> {
  const label = `lv-physical-${options.runId}-${String(index).padStart(4, '0')}`;
  const slot = uniqueId(`phys${index}`);
  const startMs = Date.now();
  let deployId = '';
  let terminal: AttemptRecord | null = null;
  let cleanupError = '';
  let cleanupMs = 0;

  try {
    const body = buildDeployBody(options, slot, label);
    const create = await gatewayRequest<DeployResponse>(
      options,
      'POST',
      '/v1/gpu/deploy',
      body,
      120_000,
      `vast-physical-${options.runId}-${index}`,
    );

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
      appendRecord(options.reportPath, terminal);
    } else if (![200, 202].includes(create.status)) {
      terminal = {
        index,
        slot,
        label,
        status: 'deploy-rejected',
        httpStatus: create.status,
        durationMs: Date.now() - startMs,
        error: create.text.slice(0, 800),
      };
      appendRecord(options.reportPath, terminal);
    } else {
      deployId = create.body.deployId || '';
      const ready = await waitForReservationReady(options, slot);

      if (options.keepReadyMs > 0) await sleep(options.keepReadyMs);

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
      appendRecord(options.reportPath, terminal);
    }
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
    appendRecord(options.reportPath, terminal);
  } finally {
    const cleanupStartMs = Date.now();
    try {
      await cleanupSlot(options, slot, deployId);
      cleanupMs = Date.now() - cleanupStartMs;
      appendRecord(options.reportPath, {
        index,
        slot,
        label,
        status: 'terminated',
        deployId,
        durationMs: Date.now() - startMs,
        cleanupMs,
      });
    } catch (err) {
      cleanupMs = Date.now() - cleanupStartMs;
      cleanupError = err instanceof Error ? err.message : String(err);
      appendRecord(options.reportPath, {
        index,
        slot,
        label,
        status: 'cleanup-error',
        deployId,
        durationMs: Date.now() - startMs,
        cleanupMs,
        error: cleanupError,
      });
    }
  }

  if (cleanupError) {
    return {
      ...(terminal || {
        index,
        slot,
        label,
        durationMs: Date.now() - startMs,
      }),
      status: 'cleanup-error',
      cleanupMs,
      error: cleanupError,
    };
  }

  if (!terminal) {
    return {
      index,
      slot,
      label,
      status: 'deploy-error',
      deployId,
      durationMs: Date.now() - startMs,
      error: 'attempt ended without a terminal record',
    };
  }

  return terminal;
}

function writeSummary(options: RunnerOptions, summary: JsonObject): void {
  const summaryPath = options.reportPath.replace(/\.jsonl$/, '.summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

function makeSummary(args: {
  options: RunnerOptions;
  completedReady: Set<number>;
  attempts: AttemptRecord[];
  stopReason: string;
  startedAt: string;
  audit?: PreRunAudit;
}): JsonObject {
  const { options, completedReady, attempts, stopReason, startedAt, audit } = args;
  const failure = attempts.find(record => !['ready', 'terminated'].includes(record.status));
  return {
    target: options.target,
    concurrency: options.concurrency,
    maxAttemptsThisRun: options.maxAttemptsThisRun,
    providerRetries: options.providerRetries,
    providerRetryGraceMs: options.providerRetryGraceMs,
    gatewayUrl: options.gatewayUrl,
    reportPath: options.reportPath,
    startedAt,
    updatedAt: new Date().toISOString(),
    estimatedWorstCaseUsd: estimateWorstCaseUsd(options),
    ready: completedReady.size,
    remaining: Math.max(0, options.target - completedReady.size),
    attemptedThisRun: attempts.filter(record => record.status !== 'terminated').length,
    rejected: attempts.filter(record => record.status === 'deploy-rejected').length,
    deployErrors: attempts.filter(record => record.status === 'deploy-error').length,
    readinessErrors: attempts.filter(record => record.status === 'readiness-error').length,
    cleanupErrors: attempts.filter(record => record.status === 'cleanup-error').length,
    stopReason,
    preRunAudit: audit,
    firstFailure: failure
      ? {
          index: failure.index,
          status: failure.status,
          httpStatus: failure.httpStatus,
          message: failure.message,
          error: failure.error,
        }
      : null,
  };
}

async function runDryRun(options: RunnerOptions): Promise<number> {
  const startedAt = new Date().toISOString();
  const audit = await collectPreRunAudit(options);
  if (audit.errors.length > 0) {
    throw new Error(`dry-run audit failed: ${audit.errors.join(' | ')}`);
  }

  const slot = uniqueId('dryrun');
  const validate = await gatewayRequest<JsonObject>(
    options,
    'POST',
    '/v1/gpu/deploy/validate',
    buildDeployBody(options, slot, slot),
    90_000,
    `vast-physical-${options.runId}-dry-run`,
  );
  expectHttpOk(validate, [200], 'POST /v1/gpu/deploy/validate');
  writeSummary(options, {
    status: 'dry-run-ok',
    target: options.target,
    concurrency: options.concurrency,
    maxAttemptsThisRun: options.maxAttemptsThisRun,
    providerRetries: options.providerRetries,
    providerRetryGraceMs: options.providerRetryGraceMs,
    gatewayUrl: options.gatewayUrl,
    reportPath: options.reportPath,
    estimatedWorstCaseUsd: estimateWorstCaseUsd(options),
    preRunAudit: audit,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  console.log(`[vast-physical-1000] dry-run-ok audit=${summarizeAuditForLog(audit)} report=${options.reportPath.replace(/\.jsonl$/, '.summary.json')}`);
  return 0;
}

async function runPool(options: RunnerOptions): Promise<number> {
  const startedAt = new Date().toISOString();
  const audit = options.waitForFunds
    ? await waitForVastFunds(options, startedAt)
    : await collectPreRunAudit(options);
  const completedReady = loadReadyIndexes(options.reportPath);
  const attempts: AttemptRecord[] = [];
  let cursor = options.startIndex;
  let issuedThisRun = 0;
  let stopReason = '';

  console.log(`[vast-physical-1000] starting target=${options.target} readyFromResume=${completedReady.size} concurrency=${options.concurrency} providerRetries=${options.providerRetries} audit=${summarizeAuditForLog(audit)} report=${options.reportPath}`);
  writeSummary(options, makeSummary({ options, completedReady, attempts, stopReason, startedAt, audit }));

  function takeIndex(): number | null {
    if (issuedThisRun >= options.maxAttemptsThisRun) {
      stopReason = `run-attempt-limit: ${issuedThisRun}/${options.maxAttemptsThisRun}`;
      return null;
    }
    while (cursor < options.target) {
      const index = cursor++;
      if (!completedReady.has(index)) {
        issuedThisRun++;
        return index;
      }
    }
    return null;
  }

  async function worker(workerId: number): Promise<void> {
    while (!stopReason && !stopRequested) {
      const index = takeIndex();
      if (index === null) return;

      const result = await runAttempt(options, index);
      attempts.push(result);
      if (result.status === 'ready') completedReady.add(index);

      console.log(`[vast-physical-1000] worker=${workerId} index=${index} status=${result.status} deployId=${result.deployId || ''} gpu=${result.gpuType || ''} durationMs=${result.durationMs}`);

      if (result.message === 'budget-gate') {
        stopReason = 'budget-gate';
      } else if (result.error && isSystemicReservationFailure(result.error)) {
        stopReason = `systemic-failure: ${result.error.slice(0, 200)}`;
      } else {
        const failures = attempts.filter(record => !['ready', 'terminated'].includes(record.status)).length;
        if (failures > options.maxFailures) {
          stopReason = `failure-threshold: ${failures} > ${options.maxFailures}`;
        }
      }

      writeSummary(options, makeSummary({ options, completedReady, attempts, stopReason, startedAt, audit }));
      if (options.delayMs > 0) await sleep(options.delayMs);
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, (_, index) => worker(index + 1)));

  if (stopRequested && !stopReason) stopReason = 'signal';
  if (completedReady.size >= options.target && !stopReason) stopReason = 'complete';

  writeSummary(options, {
    ...makeSummary({ options, completedReady, attempts, stopReason, startedAt, audit }),
    finishedAt: new Date().toISOString(),
  });
  console.log(`[vast-physical-1000] finished stopReason=${stopReason || 'exhausted'} ready=${completedReady.size}/${options.target} summary=${options.reportPath.replace(/\.jsonl$/, '.summary.json')}`);

  return stopReason === 'complete' ? 0 : 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help === true) {
    printHelp();
    return 0;
  }

  const options = buildOptions(cli);
  assertBudgetAcknowledged(options);

  if (options.dryRun) {
    return runDryRun(options);
  }

  return runPool(options);
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[vast-physical-1000] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

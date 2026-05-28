#!/usr/bin/env bun
/**
 * VAST.ai + Gateway benchmark.
 *
 * - Search benchmark for `high_quality` and `full` modes (with fallback behavior).
 * - Deploy benchmark through `/v1/gpu/deploy` + `/v1/gpu/status` + `/v1/gpu/terminate`.
 * - Detailed error categories to persist as observation types for future analysis.
 *
 * Usage:
 *   bun scripts/vast-search-bench.ts --runs 6 --deploy-runs 1 --deploy-models marcosremar/babelcast-subtitle:latest
 */

import 'dotenv/config';

const args = process.argv.slice(2);
const VAST_API_BASE = 'https://console.vast.ai/api/v0';
const HELP_TEXT = `
Usage:
  bun scripts/vast-search-bench.ts [options]

Options:
  --gateway <url>             Gateway API base URL (default http://127.0.0.1:4000)
  --gateway-key <token>       Bearer token for gateway endpoints
  --search-modes <modes>      Comma-separated: high_quality,full (default both)
  --gpu-types <gputypes>      Comma-separated GPU names for search
  --runs <n>                  Search runs per GPU per mode (default 6)
  --no-search                 Skip search benchmark
  --no-deploy                 Skip deploy benchmark
  --deploy-models <list>      Comma-separated docker images
  --deploy-runs <n>           Deploy runs per image per mode (default 1)
  --provider <provider>        Deploy provider (default vast)
  --deploy-gpu-types <types>  GPU types for deploy candidate selection
  --storage-gb <n>            Storage GB for deploy (default 0)
  --container-disk-gb <n>     Container disk GB (default 0)
  --deploy-max-cost-usd <n>   Reject deploy if estimated hourly cost exceeds threshold
  --min-inet-down-mbps <n>    Deploy min net down requirement (default 200)
  --search-timeout-ms <n>     Search request timeout
  --deploy-timeout-ms <n>     Deploy ready timeout
  --deploy-poll-ms <n>        Poll interval for status checks
  --probe-paths <paths>       Probe paths (default /health,/v1/models,/v1/chat/completions)
  --probe-timeout-ms <n>      Probe request timeout
  --max-cost-usd <n>          Stop when accumulated estimated cost exceeds this value
  --max-fail-rate <0-1>       Stop when fail rate reaches threshold (default 0.8)
  --stop-after-samples <n>    Minimum samples for fail-rate stop check (default 6)
  --max-consecutive-fails <n> Stop after this many consecutive failures
  --keep                      Keep running deployments (do not terminate)
  --json                      Emit JSON summary
  --quiet                     Reduce per-request console noise
  --help, -h                  Show this help
`;

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function bool(name: string): boolean {
  return args.includes(`--${name}`);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

function parseIntArg(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = flag(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseFloatArg(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = flag(name);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function splitList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  return raw
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function normalizeVastGpuName(raw: string): string {
  if (!raw) return '';
  let name = raw.replace(/_/g, ' ');
  name = name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '');
  name = name.replace(/^(RTX)(\d)/, '$1 $2').replace(/^(RTX)(A)/, '$1 $2');
  return name.trim();
}

function normalizeGpuNameList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = normalizeVastGpuName(item);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function toString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function toNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

function median(arr: number[]): number {
  return pct(arr, 50);
}

function fmtMs(v: number): string {
  return v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(2)}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowDateTs(): string {
  return new Date().toISOString();
}

function sanitizeLabel(value: string, fallback: string): string {
  return (value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s/]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 42);
}

function makeLabel(kind: string, suffix: string): string {
  const raw = `ai-bench-${kind}-${suffix}`;
  return sanitizeLabel(raw, `aib-${kind}`);
}

function makeHeaders(): Record<string, string> {
  const key = process.env.VAST_API_KEY;
  if (!INCLUDE_SEARCH) return {};
  if (!key) {
    console.error('Error: VAST_API_KEY is required in environment for search mode');
    process.exit(2);
  }
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function makeGatewayHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = flag('gateway-key') ?? process.env.AI_GATEWAY_API_KEY ?? process.env.GATEWAY_API_KEY;
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function gatewayRequest<T = unknown>(
  base: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<{ ok: boolean; status: number; data: T | null; text: string; ms: number; error?: string }>{
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...toRecord(init.headers) as Record<string, string>,
        ...makeGatewayHeaders(),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data, text, ms: Date.now() - t0 };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null,
      text: '',
      ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

type SearchMode = 'high_quality' | 'full';
type SearchErrorType =
  | 'search.validation'
  | 'search.auth'
  | 'search.rate_limit'
  | 'search.network'
  | 'search.http_client'
  | 'search.parsing'
  | 'search.no_offers'
  | 'search.unknown';

type DeployErrorType =
  | 'deploy.validation'
  | 'deploy.auth'
  | 'deploy.balance'
  | 'deploy.no_offer'
  | 'deploy.provider_limit'
  | 'deploy.lock_conflict'
  | 'deploy.network'
  | 'deploy.http_client'
  | 'deploy.runtime_boot'
  | 'deploy.image_pull'
  | 'deploy.endpoint_unhealthy'
  | 'deploy.inference'
  | 'deploy.timeout'
  | 'deploy.stop'
  | 'deploy.unknown';

type ErrorType = SearchErrorType | DeployErrorType;

type SearchStep = 'initial' | 'relaxed';

interface SearchRun {
  domain: 'search';
  mode: SearchMode;
  gpu: string;
  run: number;
  step: SearchStep;
  ok: boolean;
  durationMs: number;
  offerCount: number;
  directEligible: number;
  directPortCountMin?: number;
  minPrice?: number;
  maxPrice?: number;
  topReliability?: number;
  topInetDown?: number;
  http: number;
  fallbackUsed: boolean;
  errorType?: SearchErrorType;
  errorPhase?: string;
  error?: string;
}

interface DeployRun {
  domain: 'deploy';
  mode: SearchMode;
  image: string;
  run: number;
  ok: boolean;
  requestMs: number;
  readyMs: number | null;
  firstNonIdleMs: number | null;
  probeMs: number | null;
  totalMs: number;
  submitStatus?: number;
  finalStatus?: string;
  provider?: string;
  gpuType?: string;
  podId?: string;
  deployId?: string;
  endpoint?: string;
  costPerHr?: number;
  elapsedSec?: number;
  estimatedCostUsd?: number;
  cleanupStatus?: number;
  cleanupStatusOk?: boolean;
  errorType?: DeployErrorType;
  errorPhase?: string;
  error?: string;
}

type BenchmarkRun = SearchRun | DeployRun;

type ErrorBucket = {
  count: number;
  domain: 'search' | 'deploy';
  examples: string[];
  phases: Record<string, number>;
};

interface Offer {
  id: number | string;
  dph_total?: number;
  gpu_name?: string;
  geolocation?: string;
  direct_port_count?: number;
  reliability2?: number;
  inet_down?: number;
}

const GATEWAY_URL = (flag('gateway') ?? process.env.AI_GATEWAY_URL ?? process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

const INCLUDE_SEARCH = !bool('no-search');
const INCLUDE_DEPLOY = !bool('no-deploy');

const SEARCH_RUNS = parseIntArg('runs', 6, 1, 50);
const SEARCH_MODES = splitList(flag('search-modes'), ['high_quality', 'full'])
  .map(v => v.toLowerCase() as SearchMode)
  .filter((v): v is SearchMode => v === 'high_quality' || v === 'full');
const SEARCH_GPUS = splitList(
  flag('gpu-types'),
  ['RTX 4090', 'RTX A6000', 'L40S'],
).map(normalizeVastGpuName);

const SEARCH_TIMEOUT_MS = parseIntArg('search-timeout-ms', 25_000, 5_000, 120_000);

const DEPLOY_MODELS = splitList(flag('deploy-models'), ['marcosremar/babelcast-subtitle:latest']);
const DEPLOY_PROVIDER = flag('provider') ?? 'vast';
const DEPLOY_GPU_TYPES = normalizeGpuNameList(
  splitList(flag('deploy-gpu-types'), SEARCH_GPUS.length ? SEARCH_GPUS : ['RTX 4090']),
);
const DEPLOY_RUNS = parseIntArg('deploy-runs', 1, 1, 10);
const DEPLOY_TIMEOUT_MS = parseIntArg('deploy-timeout-ms', 15 * 60_000, 60_000, 3600_000);
const DEPLOY_POLL_MS = parseIntArg('deploy-poll-ms', 8_000, 1_000, 30_000);
const DEPLOY_KEEP = bool('keep');
const DEPLOY_STORAGE_GB = parseIntArg('storage-gb', 0, 0, 500);
const DEPLOY_CONTAINER_DISK_GB = parseIntArg('container-disk-gb', 0, 0, 200);
const DEPLOY_MAX_COST_USD = parseFloatArg('deploy-max-cost-usd', 0, 0);
const DEPLOY_MIN_INET_DOWN_Mbps = parseIntArg('min-inet-down-mbps', 200, 0, 100_000);
const DEPLOY_PROBE_PATHS = splitList(flag('probe-paths'), ['/health', '/v1/models', '/v1/chat/completions']);
const PROBE_TIMEOUT_MS = parseIntArg('probe-timeout-ms', 30_000, 1_000, 120_000);

const MAX_TOTAL_COST_USD = parseFloatArg('max-cost-usd', 6.0, 0);
const MAX_FAIL_RATE = parseFloatArg('max-fail-rate', 0.8, 0, 1);
const MIN_SAMPLES_FOR_FAIL_RATE = parseIntArg('stop-after-samples', 6, 1, 500);
const MAX_CONSECUTIVE_FAILS = parseIntArg('max-consecutive-fails', 4, 1, 100);
const JSON_OUT = bool('json');
const QUIET = bool('quiet');

if (SEARCH_MODES.length === 0) {
  console.error('Invalid --search-modes. Use `high_quality,full`.');
  process.exit(1);
}

if (!INCLUDE_SEARCH && !INCLUDE_DEPLOY) {
  console.error('Both --no-search and --no-deploy were passed. Nothing to run.');
  process.exit(1);
}

function buildSearchBody(mode: SearchMode, gpu: string, gpuTypes: string[], relaxed: boolean): Record<string, unknown> {
  const normalizedGpu = normalizeVastGpuName(gpu);
  const normalizedGpuTypes = normalizeGpuNameList(gpuTypes);
  const body: Record<string, unknown> = {
    rentable: { eq: true },
    rented: { eq: false },
    verified: { eq: true },
    gpu_frac: { eq: 1.0 },
    num_gpus: { eq: 1 },
    disk_space: { gte: 30 },
    type: 'on-demand',
    order: [['dph_total', 'asc']],
    limit: 60,
    cuda_vers: { gte: gpu.includes('5090') ? 12.8 : 12.4 },
    inet_up: { gte: relaxed ? 100 : 200 },
    inet_down: { gte: relaxed ? 500 : 2000 },
  };

  if (mode === 'high_quality') {
    body.direct_port_count = { gte: 1 };
    body.reliability2 = { gte: relaxed ? 0.9 : 0.97 };
  } else {
    body.reliability2 = { gte: relaxed ? 0.9 : 0.95 };
  }

  if (normalizedGpu) {
    body.gpu_name = { in: [normalizedGpu] };
  } else if (normalizedGpuTypes.length > 0) {
    body.gpu_name = { in: normalizedGpuTypes };
  }

  return body;
}

function classifySearchError(params: { ok: boolean; status: number; text: string; errorText?: string }): SearchErrorType {
  if (params.ok) return 'search.unknown';
  if (params.status === 0) return params.errorText ? 'search.network' : 'search.http_client';
  if (params.status === 400 || params.status === 422) return 'search.validation';
  if (params.status === 401 || params.status === 403) return 'search.auth';
  if (params.status === 429) return 'search.rate_limit';
  if (params.status >= 500) return 'search.http_client';
  return 'search.unknown';
}

async function searchOffers(mode: SearchMode, gpu: string, gpuTypes: string[], relaxed: boolean, headers: Record<string, string>): Promise<SearchRun> {
  const t0 = Date.now();
  const step: SearchStep = relaxed ? 'relaxed' : 'initial';

  try {
    const res = await fetch(`${VAST_API_BASE}/bundles/`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildSearchBody(mode, gpu, gpuTypes, relaxed)),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    const ms = Date.now() - t0;
    const text = await res.text();

    if (!res.ok) {
      const type = classifySearchError({ ok: false, status: res.status, text });
      return {
        domain: 'search',
        mode,
        gpu,
        run: 0,
        step,
        ok: false,
        durationMs: ms,
        offerCount: 0,
        directEligible: 0,
        http: res.status,
        fallbackUsed: false,
        errorType: type,
        errorPhase: 'http',
        error: `HTTP ${res.status}: ${text.slice(0, 220)}`,
      };
    }

    let data: { offers?: Offer[] };
    try {
      data = JSON.parse(text) as { offers?: Offer[] };
    } catch {
      return {
        domain: 'search',
        mode,
        gpu,
        run: 0,
        step,
        ok: false,
        durationMs: ms,
        offerCount: 0,
        directEligible: 0,
        http: res.status,
        fallbackUsed: false,
        errorType: 'search.parsing',
        errorPhase: 'parse',
        error: `JSON parse failed (${text.slice(0, 220)})`,
      };
    }

    const offers = Array.isArray(data?.offers) ? data.offers : [];
    const prices = offers.map(o => toNumber(o.dph_total)).filter((n): n is number => typeof n === 'number');
    const reliabilities = offers.map(o => toNumber(o.reliability2)).filter((n): n is number => typeof n === 'number');
    const inDown = offers.map(o => toNumber(o.inet_down)).filter((n): n is number => typeof n === 'number');
    const directVals = offers
      .map(o => toNumber(o.direct_port_count))
      .filter((n): n is number => typeof n === 'number');
    const directEligible = offers.filter(o => {
      const v = toNumber(o.direct_port_count);
      return typeof v === 'number' && v >= 1;
    }).length;

    return {
      domain: 'search',
      mode,
      gpu,
      run: 0,
      step,
      ok: offers.length > 0,
      durationMs: ms,
      offerCount: offers.length,
      directEligible,
      directPortCountMin: directVals.length ? Math.min(...directVals) : undefined,
      minPrice: prices.length ? Math.min(...prices) : undefined,
      maxPrice: prices.length ? Math.max(...prices) : undefined,
      topReliability: reliabilities.length ? Math.max(...reliabilities) : undefined,
      topInetDown: inDown.length ? Math.max(...inDown) : undefined,
      http: res.status,
      fallbackUsed: false,
      ...(!offers.length
        ? {
            errorType: 'search.no_offers',
            errorPhase: 'no_offers',
            error: 'No offers returned',
          }
        : {}),
    };
  } catch (err) {
    return {
      domain: 'search',
      mode,
      gpu,
      run: 0,
      step,
      ok: false,
      durationMs: Date.now() - t0,
      offerCount: 0,
      directEligible: 0,
      http: 0,
      fallbackUsed: false,
      errorType: 'search.network',
      errorPhase: 'exception',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function searchWithFallback(mode: SearchMode, gpu: string, headers: Record<string, string>): Promise<SearchRun[]> {
  const initial = await searchOffers(mode, gpu, [gpu], false, headers);

  // For `full`, we always include relaxed search as fallback. For `high_quality`,
  // fallback is used only when strict filters return empty.
  if (initial.ok || mode === 'full') {
    const primary = { ...initial, run: 1, fallbackUsed: false };
    if (initial.ok) {
      return [primary];
    }
  }

  const relaxed = await searchOffers(mode, gpu, [gpu], true, headers);

  if (relaxed.ok) {
    return [
      { ...initial, run: 1, fallbackUsed: false, errorType: initial.errorType },
      { ...relaxed, run: 1, fallbackUsed: true },
    ];
  }

  return [
    { ...initial, run: 1, fallbackUsed: false, errorType: initial.errorType ?? relaxed.errorType },
    { ...relaxed, run: 1, fallbackUsed: true },
  ];
}

function classifyDeploySubmitError(status: number, bodyText: string, parsed: unknown, thrown?: string): { type: DeployErrorType; reason: string } {
  if (status === 0) {
    return {
      type: thrown ? 'deploy.network' : 'deploy.http_client',
      reason: thrown ?? 'network request failed',
    };
  }
  if (status === 400 || status === 422) {
    return { type: 'deploy.validation', reason: bodyText || toString(parsed) || 'validation error' };
  }
  if (status === 401 || status === 403) {
    return { type: 'deploy.auth', reason: bodyText || 'auth failed' };
  }
  if (status === 402) {
    return { type: 'deploy.balance', reason: bodyText || 'budget insufficient' };
  }
  if (status === 409) {
    return { type: 'deploy.lock_conflict', reason: bodyText || 'deploy lock held or stale status' };
  }
  if (status === 429) {
    return { type: 'deploy.provider_limit', reason: bodyText || 'provider throttling' };
  }
  if (status >= 500) {
    return { type: 'deploy.http_client', reason: `provider/runtime failure: ${bodyText}` };
  }
  return { type: 'deploy.unknown', reason: `HTTP ${status}: ${bodyText}` };
}

function classifyDeployRuntimeError(state: Record<string, unknown>): { type: DeployErrorType; reason: string } {
  const status = (toString(state.status) || '').toLowerCase();
  const step = (toString(state.step) || '').toLowerCase();
  const msg = toString(state.message) || '';

  if (status === 'error') {
    if (step.includes('offer') || msg.toLowerCase().includes('offer')) {
      return { type: 'deploy.no_offer', reason: `runtime no offer: step=${step} message=${msg}` };
    }
    if (step.includes('pull') || msg.toLowerCase().includes('image')) {
      return { type: 'deploy.image_pull', reason: `image pull/runtime failed: step=${step} message=${msg}` };
    }
    return { type: 'deploy.runtime_boot', reason: `deploy runtime failure: step=${step} message=${msg}` };
  }

  if (status === 'stopped') {
    return { type: 'deploy.endpoint_unhealthy', reason: `stopped while starting: step=${step}` };
  }

  return { type: 'deploy.unknown', reason: `status=${status} step=${step} message=${msg}` };
}

async function waitForDeployReady(startedAt: number): Promise<{ timeout: boolean; readyMs: number | null; firstNonIdleMs: number | null; state: Record<string, unknown> | null }> {
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let firstNonIdleMs: number | null = null;

  while (Date.now() < deadline) {
    const status = await gatewayRequest<Record<string, unknown>>(GATEWAY_URL, '/v1/gpu/status', {}, 10_000);
    if (!status.ok || !status.data) {
      await sleep(DEPLOY_POLL_MS);
      continue;
    }

    const state = toRecord(status.data);
    const st = (toString(state.status) || '').toLowerCase();
    const now = Date.now() - startedAt;

    if (!firstNonIdleMs && st && st !== 'idle') {
      firstNonIdleMs = now;
    }

    if (st === 'ready') {
      return { timeout: false, readyMs: now, firstNonIdleMs, state };
    }

    if (st === 'error' || st === 'stopped') {
      return { timeout: true, readyMs: null, firstNonIdleMs, state };
    }

    await sleep(DEPLOY_POLL_MS);
  }

  return { timeout: true, readyMs: null, firstNonIdleMs, state: null };
}

function buildSmokeRequest(path: string): { method: 'GET' | 'POST'; body: string | undefined; headers: Record<string, string> } {
  if (path.includes('chat/completions')) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'Say "ok" in one word.' }],
        max_tokens: 8,
        temperature: 0,
      }),
    };
  }

  if (path.includes('/v1/translate')) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Hello',
        source_language: 'en',
        target_language: 'es',
      }),
    };
  }

  return { method: 'GET', headers: {}, body: undefined };
}

async function probeInference(endpoint: string): Promise<{ ok: boolean; status: number; ms: number; path?: string; error?: string }> {
  let last = { status: 0, ms: 0, path: DEPLOY_PROBE_PATHS[0], error: 'No probe path provided' };

  for (const p of DEPLOY_PROBE_PATHS) {
    const path = p.startsWith('/') ? p : `/${p}`;
    const { method, headers, body } = buildSmokeRequest(path);
    const t0 = Date.now();

    try {
      const r = await fetch(`${endpoint}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const ms = Date.now() - t0;
      if (r.ok) {
        return { ok: true, status: r.status, ms, path };
      }
      last = { status: r.status, ms, path, error: `HTTP ${r.status}` };
    } catch (err) {
      last = {
        status: 0,
        ms: Date.now() - t0,
        path,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { ok: false, status: last.status, ms: last.ms, path: last.path, error: last.error };
}

function estimateCost(status: Record<string, unknown>): number | null {
  const costPerHr = toNumber(status.costPerHr);
  const elapsedSec = toNumber(status.elapsedSec);
  if (!costPerHr || !elapsedSec) return null;
  return costPerHr * (elapsedSec / 3600);
}

async function terminateDeploy(state: Record<string, unknown>): Promise<{ ok: boolean; status: number; error?: string }> {
  if (DEPLOY_KEEP) {
    return { ok: true, status: 200 };
  }

  const body: Record<string, unknown> = { force: true };
  if (toString(state.deployId)) body.deployId = state.deployId;
  if (toString(state.podId)) body.instanceId = state.podId;
  if (toString(state.provider)) body.provider = state.provider;

  const res = await gatewayRequest(GATEWAY_URL, '/v1/gpu/terminate', {
    method: 'POST',
    body: JSON.stringify(body),
  }, 20_000);

  return { ok: res.ok, status: res.status, error: res.error };
}

let globalSpendUsd = 0;

async function deployRun(mode: SearchMode, image: string, run: number): Promise<DeployRun> {
  const start = Date.now();
  const label = makeLabel(`${mode}-${run}`, sanitizeLabel(image, 'image'));
  const submitBody: Record<string, unknown> = {
    provider: DEPLOY_PROVIDER,
    dockerImage: image,
    gpuTypes: DEPLOY_GPU_TYPES,
    label,
    searchMode: mode,
    storageGb: DEPLOY_STORAGE_GB,
    containerDiskInGb: DEPLOY_CONTAINER_DISK_GB,
    minInetDownMbps: DEPLOY_MIN_INET_DOWN_Mbps,
    autoSelectGpu: true,
    runSmokeTests: false,
  };
  if (DEPLOY_MAX_COST_USD > 0) submitBody.maxCostUsd = DEPLOY_MAX_COST_USD;

  const submit = await gatewayRequest<Record<string, unknown>>(GATEWAY_URL, '/v1/gpu/deploy', {
    method: 'POST',
    body: JSON.stringify(submitBody),
  }, Math.max(30_000, DEPLOY_TIMEOUT_MS));

  const requestMs = Date.now() - start;

  if (!submit.ok) {
    const cls = classifyDeploySubmitError(submit.status, submit.text, submit.data, submit.error);
    return {
      domain: 'deploy',
      mode,
      image,
      run,
      ok: false,
      requestMs,
      readyMs: null,
      firstNonIdleMs: null,
      probeMs: null,
      totalMs: Date.now() - start,
      submitStatus: submit.status,
      errorType: cls.type,
      errorPhase: 'submit',
      error: cls.reason,
    };
  }

  const wait = await waitForDeployReady(start);
  if (wait.timeout) {
    const finalStatus = wait.state ? toString(wait.state.status) : 'unknown';
    const reason = wait.state ? classifyDeployRuntimeError(wait.state) : { type: 'deploy.timeout' as const, reason: 'deploy timeout while waiting for ready' };
    if (wait.state) {
      const stop = await terminateDeploy(wait.state);
      const cost = estimateCost(wait.state);
      if (typeof cost === 'number') globalSpendUsd += cost;
      return {
        domain: 'deploy',
        mode,
        image,
        run,
        ok: false,
        requestMs,
        readyMs: null,
        firstNonIdleMs: wait.firstNonIdleMs,
        probeMs: null,
        totalMs: Date.now() - start,
        submitStatus: submit.status,
        finalStatus,
        provider: toString(wait.state.provider),
        gpuType: toString(wait.state.gpuType),
        podId: toString(wait.state.podId),
        deployId: toString(wait.state.deployId),
        endpoint: toString(wait.state.endpoint),
        estimatedCostUsd: cost ?? undefined,
        errorType: reason.type,
        errorPhase: finalStatus === 'error' ? 'runtime' : 'timeout',
        error: reason.reason,
        cleanupStatus: stop.status,
        cleanupStatusOk: stop.ok,
      };
    }

    return {
      domain: 'deploy',
      mode,
      image,
      run,
      ok: false,
      requestMs,
      readyMs: null,
      firstNonIdleMs: wait.firstNonIdleMs,
      probeMs: null,
      totalMs: Date.now() - start,
      submitStatus: submit.status,
      finalStatus,
      errorType: reason.type,
      errorPhase: 'timeout',
      error: reason.reason,
    };
  }

  const state = toRecord(wait.state);
  const endpoint = toString(state.endpoint);
  let probeMs: number | null = null;
  let probe = { ok: false, status: 0, ms: 0, path: DEPLOY_PROBE_PATHS[0], error: 'no endpoint' };
  if (endpoint) {
    probe = await probeInference(endpoint);
    probeMs = probe.ms;
  }

  if (!probe.ok) {
    const stop = await terminateDeploy(state);
    const cost = estimateCost(state);
    if (typeof cost === 'number') globalSpendUsd += cost;
    return {
      domain: 'deploy',
      mode,
      image,
      run,
      ok: false,
      requestMs,
      readyMs: wait.readyMs,
      firstNonIdleMs: wait.firstNonIdleMs,
      probeMs,
      totalMs: Date.now() - start,
      submitStatus: submit.status,
      finalStatus: 'ready',
      provider: toString(state.provider),
      gpuType: toString(state.gpuType),
      podId: toString(state.podId),
      deployId: toString(state.deployId),
      endpoint,
      costPerHr: toNumber(state.costPerHr),
      elapsedSec: toNumber(state.elapsedSec),
      estimatedCostUsd: cost,
      errorType: 'deploy.endpoint_unhealthy',
      errorPhase: 'probe',
      error: `probe failed on ${probe.path}: ${probe.status} ${probe.error ?? ''}`,
      cleanupStatus: stop.status,
      cleanupStatusOk: stop.ok,
    };
  }

  const cost = estimateCost(state);
  if (typeof cost === 'number') globalSpendUsd += cost;

  const stop = await terminateDeploy(state);
  return {
    domain: 'deploy',
    mode,
    image,
    run,
    ok: true,
    requestMs,
    readyMs: wait.readyMs,
    firstNonIdleMs: wait.firstNonIdleMs,
    probeMs,
    totalMs: Date.now() - start,
    submitStatus: submit.status,
    finalStatus: 'ready',
    provider: toString(state.provider),
    gpuType: toString(state.gpuType),
    podId: toString(state.podId),
    deployId: toString(state.deployId),
    endpoint,
    costPerHr: toNumber(state.costPerHr),
    elapsedSec: toNumber(state.elapsedSec),
    estimatedCostUsd: cost,
    cleanupStatus: stop.status,
    cleanupStatusOk: stop.ok,
  };
}

function addErrorObservation(bucketMap: Map<string, ErrorBucket>, domain: 'search' | 'deploy', type: ErrorType, phase: string, message: string) {
  const key = `${domain}:${type}`;
  const bucket = bucketMap.get(key) ?? { count: 0, domain, examples: [], phases: {} };
  bucket.count += 1;
  bucket.phases[phase] = (bucket.phases[phase] ?? 0) + 1;
  if (bucket.examples.length < 5) bucket.examples.push(message);
  bucketMap.set(key, bucket);
}

function runSummarySearch(runs: SearchRun[]) {
  const byMode = new Map<SearchMode, {
    attempts: number;
    success: number;
    fail: number;
    times: number[];
    directEligible: number[];
    fallbackUses: number;
  }>();

  for (const run of runs) {
    const row = byMode.get(run.mode) ?? { attempts: 0, success: 0, fail: 0, times: [], directEligible: [], fallbackUses: 0 };
    row.attempts += 1;
    if (run.ok) row.success += 1;
    else row.fail += 1;
    if (run.fallbackUsed) row.fallbackUses += 1;
    row.times.push(run.durationMs);
    row.directEligible.push(run.directEligible);
    byMode.set(run.mode, row);
  }

  return Object.fromEntries([...byMode.entries()].map(([mode, row]) => [
    mode,
    {
      attempts: row.attempts,
      success: row.success,
      fail: row.fail,
      successRate: +(row.success / Math.max(1, row.attempts) * 100).toFixed(1),
      noOffer: row.fail - row.fallbackUses,
      fallbackUses: row.fallbackUses,
      medianMs: median(row.times),
      p95Ms: pct(row.times, 95),
      directEligibleAvg: row.directEligible.length ? +(row.directEligible.reduce((a, b) => a + b, 0) / row.directEligible.length).toFixed(2) : 0,
    },
  ]));
}

function runSummaryDeploy(runs: DeployRun[]) {
  const byMode = new Map<SearchMode, {
    attempts: number;
    success: number;
    fail: number;
    requestMs: number[];
    readyMs: number[];
    probeMs: number[];
    cost: number[];
  }>();

  const byImage = new Map<string, {
    attempts: number;
    success: number;
    fail: number;
    readyMs: number[];
    cost: number[];
  }>();

  for (const r of runs) {
    const m = byMode.get(r.mode) ?? { attempts: 0, success: 0, fail: 0, requestMs: [], readyMs: [], probeMs: [], cost: [] };
    const i = byImage.get(r.image) ?? { attempts: 0, success: 0, fail: 0, readyMs: [], cost: [] };

    m.attempts += 1;
    i.attempts += 1;
    if (r.ok) {
      m.success += 1;
      i.success += 1;
    } else {
      m.fail += 1;
      i.fail += 1;
    }
    m.requestMs.push(r.requestMs);
    if (r.readyMs !== null) m.readyMs.push(r.readyMs);
    if (r.probeMs !== null) m.probeMs.push(r.probeMs);
    if (typeof r.estimatedCostUsd === 'number') {
      m.cost.push(r.estimatedCostUsd);
      i.cost.push(r.estimatedCostUsd);
    }
    if (r.readyMs !== null) i.readyMs.push(r.readyMs);

    byMode.set(r.mode, m);
    byImage.set(r.image, i);
  }

  return {
    byMode: Object.fromEntries([...byMode.entries()].map(([mode, v]) => [
      mode,
      {
        attempts: v.attempts,
        success: v.success,
        fail: v.fail,
        successRate: +(v.success / Math.max(1, v.attempts) * 100).toFixed(1),
        medianRequestMs: median(v.requestMs),
        medianReadyMs: v.readyMs.length ? median(v.readyMs) : null,
        medianProbeMs: v.probeMs.length ? median(v.probeMs) : null,
        totalCostUsd: +v.cost.reduce((a, b) => a + b, 0).toFixed(4),
        avgCostUsd: v.cost.length ? +(v.cost.reduce((a, b) => a + b, 0) / v.cost.length).toFixed(4) : 0,
      },
    ])),
    byImage: Object.fromEntries([...byImage.entries()].map(([img, v]) => [
      img,
      {
        attempts: v.attempts,
        success: v.success,
        fail: v.fail,
        successRate: +(v.success / Math.max(1, v.attempts) * 100).toFixed(1),
        medianReadyMs: v.readyMs.length ? median(v.readyMs) : null,
        totalCostUsd: +v.cost.reduce((a, b) => a + b, 0).toFixed(4),
        avgCostUsd: v.cost.length ? +(v.cost.reduce((a, b) => a + b, 0) / v.cost.length).toFixed(4) : 0,
      },
    ])),
  };
}

function shouldStop(stats: { attempts: number; fails: number; consecutiveFails: number }): string | null {
  if (MAX_TOTAL_COST_USD > 0 && globalSpendUsd >= MAX_TOTAL_COST_USD) {
    return `global budget exceeded: $${globalSpendUsd.toFixed(4)} >= $${MAX_TOTAL_COST_USD}`;
  }
  if (stats.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
    return `consecutive failures reached ${stats.consecutiveFails} (${MAX_CONSECUTIVE_FAILS} max)`;
  }
  if (stats.attempts >= MIN_SAMPLES_FOR_FAIL_RATE) {
    const rate = stats.fails / stats.attempts;
    if (rate >= MAX_FAIL_RATE) {
      return `fail-rate ${(rate * 100).toFixed(1)}% >= ${(MAX_FAIL_RATE * 100).toFixed(1)}%`;
    }
  }
  return null;
}

async function main() {
  const headers = makeHeaders();
  const runs: BenchmarkRun[] = [];
  const errors = new Map<string, ErrorBucket>();

  let stopReason: string | null = null;
  let searchAttempts = 0;
  let searchFails = 0;
  let searchConsecutiveFails = 0;

  if (INCLUDE_SEARCH) {
    for (const mode of SEARCH_MODES) {
      for (const gpu of SEARCH_GPUS) {
        for (let i = 1; i <= SEARCH_RUNS; i++) {
          const results = await searchWithFallback(mode, gpu, headers);
          for (const rec of results) {
            rec.run = i;
            runs.push(rec);
            searchAttempts += 1;
            if (!rec.ok) {
              searchFails += 1;
              searchConsecutiveFails += 1;
              if (rec.errorType) {
                addErrorObservation(errors, 'search', rec.errorType, rec.errorPhase || 'search', `[search][${mode}] ${gpu} r${i}: ${rec.error || rec.errorType}`);
              }
            } else {
              searchConsecutiveFails = 0;
            }

            if (!QUIET) {
              console.error(`[search][${mode}] ${gpu} r${i} ${rec.step} ${rec.ok ? '✓' : '✗'} offers=${rec.offerCount} direct>=1=${rec.directEligible} t=${fmtMs(rec.durationMs)}${rec.fallbackUsed ? ' +relaxed' : ''}${rec.errorType ? ' ' + rec.errorType : ''}`);
            }
          }

          const reason = shouldStop({ attempts: searchAttempts, fails: searchFails, consecutiveFails: searchConsecutiveFails });
          if (reason) {
            stopReason = `search: ${reason}`;
            break;
          }
        }
        if (stopReason) break;
      }
      if (stopReason) break;
    }
  }

  let deployAttempts = 0;
  let deployFails = 0;
  let deployConsecutiveFails = 0;

  if (!stopReason && INCLUDE_DEPLOY) {
    for (const mode of SEARCH_MODES) {
      for (const image of DEPLOY_MODELS) {
        for (let run = 1; run <= DEPLOY_RUNS; run++) {
          const rec = await deployRun(mode, image, run);
          runs.push(rec);
          deployAttempts += 1;
          if (rec.ok) {
            deployConsecutiveFails = 0;
          } else {
            deployFails += 1;
            deployConsecutiveFails += 1;
            if (rec.errorType) {
              addErrorObservation(errors, 'deploy', rec.errorType, rec.errorPhase || 'deploy', `[deploy][${mode}] ${image} r${run}: ${rec.error || rec.errorType}`);
            }
          }

          if (!QUIET) {
            console.error(`[deploy][${mode}] ${image} r${run} ${rec.ok ? '✓' : '✗'} ${rec.errorType ?? ''} total=${fmtMs(rec.totalMs)}${typeof rec.estimatedCostUsd === 'number' ? ` cost=$${rec.estimatedCostUsd.toFixed(6)}` : ''}`);
          }

          const reason = shouldStop({
            attempts: searchAttempts + deployAttempts,
            fails: searchFails + deployFails,
            consecutiveFails: deployConsecutiveFails,
          });
          if (reason) {
            stopReason = `deploy: ${reason}`;
            break;
          }
        }
        if (stopReason) break;
      }
      if (stopReason) break;
    }
  }

  const searchRuns = runs.filter(r => r.domain === 'search') as SearchRun[];
  const deployRuns = runs.filter(r => r.domain === 'deploy') as DeployRun[];
  const errorSummary = Object.fromEntries(
    [...errors.entries()].map(([k, v]) => [k, { domain: v.domain, count: v.count, phases: v.phases, examples: v.examples }]),
  );

  const summary = {
    generatedAt: nowDateTs(),
    gateway: { url: GATEWAY_URL, provider: DEPLOY_PROVIDER },
    options: {
      search: {
        modes: SEARCH_MODES,
        runsPerGpu: SEARCH_RUNS,
        gpuTypes: SEARCH_GPUS,
      },
      deploy: {
        models: DEPLOY_MODELS,
        runsPerModel: DEPLOY_RUNS,
        gpuTypes: DEPLOY_GPU_TYPES,
        timeoutMs: DEPLOY_TIMEOUT_MS,
        keep: DEPLOY_KEEP,
      },
      stopPolicy: {
        maxTotalCostUsd: MAX_TOTAL_COST_USD,
        maxFailRate: MAX_FAIL_RATE,
        minSamplesForFailRate: MIN_SAMPLES_FOR_FAIL_RATE,
        maxConsecutiveFails: MAX_CONSECUTIVE_FAILS,
      },
    },
    stopReason,
    totals: {
      runs: runs.length,
      search: searchRuns.length,
      deploy: deployRuns.length,
      searchSuccess: searchRuns.filter(r => r.ok).length,
      deploySuccess: deployRuns.filter(r => r.ok).length,
      estimatedCostUsd: +globalSpendUsd.toFixed(6),
      searchFailRate: searchAttempts > 0 ? +(searchFails / searchAttempts * 100).toFixed(2) : 0,
      deployFailRate: deployAttempts > 0 ? +(deployFails / deployAttempts * 100).toFixed(2) : 0,
    },
    searchSummary: searchRuns.length ? runSummarySearch(searchRuns) : null,
    deploySummary: deployRuns.length ? runSummaryDeploy(deployRuns) : null,
    errorSummary,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('\n=== VAST SEARCH + DEPLOY BENCHMARK ===');
  console.log(`generatedAt=${summary.generatedAt}`);
  console.log(`gateway=${summary.gateway.url} provider=${summary.gateway.provider}`);
  console.log(`runs=${summary.totals.runs} (search=${summary.totals.search}, deploy=${summary.totals.deploy})`);
  console.log(`failRate search=${summary.totals.searchFailRate}% deploy=${summary.totals.deployFailRate}%`);
  console.log(`estimatedCostUsd=${summary.totals.estimatedCostUsd}`);
  if (stopReason) {
    console.log(`stopped=${stopReason}`);
  }

  console.log('\nSEARCH');
  if (summary.searchSummary) {
    for (const [mode, row] of Object.entries(summary.searchSummary)) {
      const r = row as any;
      console.log(`[${mode}] attempts=${r.attempts} success=${r.success} fail=${r.fail} rate=${r.successRate}%`);
      console.log(`  median=${fmtMs(r.medianMs)} p95=${fmtMs(r.p95Ms)} fallback=${r.fallbackUses} avgDirect=${r.directEligibleAvg}`);
    }
  } else {
    console.log('skipped');
  }

  console.log('\nDEPLOY');
  if (summary.deploySummary) {
    for (const [mode, row] of Object.entries(summary.deploySummary.byMode)) {
      const r = row as any;
      console.log(`[${mode}] attempts=${r.attempts} success=${r.success} fail=${r.fail} rate=${r.successRate}%`);
      console.log(`  medianRequest=${fmtMs(r.medianRequestMs)} medianReady=${r.medianReadyMs === null ? 'n/a' : fmtMs(r.medianReadyMs)} medianProbe=${r.medianProbeMs === null ? 'n/a' : fmtMs(r.medianProbeMs)} cost=$${r.totalCostUsd}`);
    }

    console.log('\nDEPLOY BY IMAGE');
    for (const [img, row] of Object.entries(summary.deploySummary.byImage)) {
      const r = row as any;
      console.log(`  ${img}`);
      console.log(`    attempts=${r.attempts} success=${r.success} fail=${r.fail} rate=${r.successRate}%`);
      console.log(`    medianReady=${r.medianReadyMs === null ? 'n/a' : fmtMs(r.medianReadyMs)} cost=$${r.totalCostUsd}`);
    }
  } else {
    console.log('skipped');
  }

  console.log('\nERROR TYPES');
  if (Object.keys(summary.errorSummary).length === 0) {
    console.log('  none');
  } else {
    for (const [k, bucket] of Object.entries(summary.errorSummary)) {
      const b: any = bucket;
      const details = Object.entries(b.phases)
        .map(([phase, count]) => `${phase}=${count}`)
        .join(', ');
      console.log(`  ${k}: count=${b.count} phases=[${details}]`);
      for (const ex of b.examples as string[]) {
        console.log(`    - ${ex}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('[fatal]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

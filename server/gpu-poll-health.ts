// ── GPU Poll Health — wait for a newly-created instance to become healthy ─────

import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import type { GpuProviderClient, ProviderCredentials } from '../src/gpu-providers/types';
import { RunpodClient } from '../src/gpu-providers/runpod-client';
import { createLogger } from '../src/logger';
import { getDeployTimeoutMin, getDeployTimeoutMinForProvider } from '../src/gpu-providers/deploy-settings';
import {
  deployState, setDeployState, deployCancelled,
  setLastRequestTime, updateGpuModelWarmth,
} from './state';
import { broadcastWs } from './ws-state';
import { registry } from './providers';
import type { DockerCapability } from '../src/gateway/providers/gpu/docker-manifest';
import {
  validateDockerContractManifest,
  defaultApiPathsForCapabilities,
} from '../src/gateway/providers/gpu/docker-manifest';

const log = createLogger('gpu-deploy');

export interface PollHealthResult {
  result: 'ready' | 'exited' | 'timeout' | 'cancelled' | 'crashed' | 'app_error';
  pullTimeS?: number;  // actual measured pull duration (pullStarted → containerStarted)
  appError?: { message: string; traceback?: string };
}

/** Create a minimal valid WAV file (1s of silence at 16kHz mono) for STT testing. */
function createTestAudioForm(): FormData {
  const sampleRate = 16000;
  const numSamples = sampleRate;
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'test.wav');
  form.append('model', 'whisper-large-v3');
  return form;
}

/** Async wrapper for autoRegisterDockerProvider to avoid blocking the health poll */
async function autoRegisterDockerProviderAsync(endpoint: string): Promise<void> {
  try {
    const { autoRegisterDockerProvider } = await import('../src/gateway/providers/gpu/docker-registry');
    await autoRegisterDockerProvider(registry, endpoint);
  } catch (err) {
    // Non-fatal: registration failure shouldn't break deploy
    log.warn(`[gpu] Auto-registration failed for ${endpoint}: ${err instanceof Error ? err.message : err}`);
  }
}

type HealthPayload = Record<string, unknown>;

const HEALTHY_STATUSES = new Set(['healthy', 'ok', 'degraded', 'ready', 'loading']);
const GENERIC_APP_READY_STATUSES = new Set(['healthy', 'ok', 'degraded', 'ready']);
const PIPELINE_SERVICE_KEYS = new Set(['whisper', 'stt', 'llama_cpp', 'llm', 'tts']);
const SPEECH_CAPABILITIES = new Set<DockerCapability>(['speech_pipeline', 'openai_compat', 'stt', 'llm', 'tts']);
const GLB_SMOKE_TIMEOUT_MS = 10 * 60_000;

function asRecord(value: unknown): HealthPayload | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as HealthPayload
    : null;
}

function healthStatus(data: unknown): string {
  const payload = asRecord(data);
  return typeof payload?.status === 'string' ? payload.status.toLowerCase() : '';
}

function serviceStatus(services: HealthPayload, ...keys: string[]): string {
  for (const key of keys) {
    const value = services[key];
    if (typeof value === 'string') return value.toLowerCase();
  }
  return '';
}

export function hasPipelineServices(data: unknown): boolean {
  const services = asRecord(asRecord(data)?.services);
  if (!services) return false;
  return Object.keys(services).some(key => PIPELINE_SERVICE_KEYS.has(key));
}

export function extractAppHealthError(data: unknown): { message: string; traceback?: string } | null {
  const payload = asRecord(data);
  if (!payload) return null;
  const status = healthStatus(payload);
  const rawError = typeof payload.error === 'string' ? payload.error.trim() : '';
  const rawMessage = typeof payload.message === 'string' ? payload.message.trim() : '';
  const traceback = typeof payload.error_traceback === 'string' && payload.error_traceback.trim()
    ? payload.error_traceback
    : undefined;
  if (status === 'error') {
    return { message: rawError || rawMessage || 'unknown app error', traceback };
  }
  if (!hasPipelineServices(payload) && (rawError || traceback)) {
    return { message: rawError || rawMessage || 'app reported an error in /health', traceback };
  }
  return null;
}

export function isGenericAppHealthReady(data: unknown): boolean {
  if (!GENERIC_APP_READY_STATUSES.has(healthStatus(data))) return false;
  if (hasPipelineServices(data)) return false;
  return extractAppHealthError(data) === null;
}

function isExpectedGenericGpuApp(
  expectedApiPaths: string[] = [],
  expectedCapabilities: DockerCapability[] = [],
): boolean {
  if (expectedCapabilities.some(capability => !SPEECH_CAPABILITIES.has(capability))) return true;
  return expectedApiPaths.some(path => /generate(?:-from-(?:text|url))?|glb|image|embed|rerank/i.test(path));
}

function hasTruthyFlag(value: unknown, ...keys: string[]): boolean {
  const payload = asRecord(value);
  if (!payload) return false;
  return keys.some(key => payload[key] === true);
}

function isGenericAppUsableWhileLoading(
  data: unknown,
  expectedApiPaths: string[] = [],
  expectedCapabilities: DockerCapability[] = [],
): boolean {
  if (!isExpectedGenericGpuApp(expectedApiPaths, expectedCapabilities)) return false;
  if (hasPipelineServices(data)) return false;
  if (extractAppHealthError(data)) return false;
  if (healthStatus(data) !== 'loading') return false;
  const payload = asRecord(data);
  return hasTruthyFlag(payload, 'ready', 'loaded', 'model_loaded', 'shape_loaded')
    || hasTruthyFlag(payload?.config, 'ready', 'loaded', 'model_loaded', 'shape_loaded')
    || hasTruthyFlag(payload?.model, 'ready', 'loaded', 'model_loaded', 'shape_loaded');
}

function describeGenericAppHealth(data: unknown, dockerImage?: string): string {
  const payload = asRecord(data);
  const model = typeof payload?.model === 'string' ? payload.model : '';
  return model || dockerImage || 'generic GPU app';
}

function normalizeApiPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function collectApiPaths(payload: unknown): Set<string> {
  const paths = new Set<string>();
  const data = asRecord(payload);
  if (!data) return paths;

  const openApiPaths = asRecord(data.paths);
  if (openApiPaths) {
    for (const path of Object.keys(openApiPaths)) paths.add(normalizeApiPath(path));
  }

  const api = asRecord(data.api);
  if (api) {
    for (const value of Object.values(api)) {
      const route = asRecord(value)?.endpoint;
      if (typeof route === 'string') paths.add(normalizeApiPath(route));
    }
  }

  const routes = Array.isArray(data.routes) ? data.routes : [];
  for (const route of routes) {
    if (typeof route === 'string') paths.add(normalizeApiPath(route));
    const routePath = asRecord(route)?.path;
    if (typeof routePath === 'string') paths.add(normalizeApiPath(routePath));
  }

  return paths;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchJsonPaths(url: string): Promise<Set<string>> {
  return collectApiPaths(await fetchJson(url));
}

async function probePathExists(endpoint: string, path: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(3_000),
    });
    return res.status !== 404;
  } catch {
    return false;
  }
}

export async function validateEndpointApiContract(
  endpoint: string,
  expectedApiPaths: string[] = [],
  expectedCapabilities: DockerCapability[] = [],
  requireDockerManifest = false,
): Promise<{ ok: true; discoveredPaths: string[] } | { ok: false; error: string; discoveredPaths: string[] }> {
  const explicitExpectedPaths = expectedApiPaths.map(normalizeApiPath);
  const expected = [...new Set(
    explicitExpectedPaths.length > 0
      ? explicitExpectedPaths
      : defaultApiPathsForCapabilities(expectedCapabilities),
  )];

  const manifestPayload = await fetchJson(`${endpoint}/v1/manifest`);
  if (requireDockerManifest && !manifestPayload) {
    return {
      ok: false,
      error: 'Docker API contract mismatch. Missing required /v1/manifest for declared capability validation.',
      discoveredPaths: [],
    };
  }
  if (manifestPayload && (requireDockerManifest || expectedCapabilities.length > 0)) {
    const manifestResult = validateDockerContractManifest(
      manifestPayload,
      expectedCapabilities,
      expected,
    );
    if (!manifestResult.ok) {
      return {
        ok: false,
        error: `Docker API contract mismatch. ${manifestResult.errors.join(' ')}`,
        discoveredPaths: manifestResult.paths,
      };
    }
  }

  if (expected.length === 0) return { ok: true, discoveredPaths: [] };

  const discovered = new Set<string>();
  for (const path of collectApiPaths(manifestPayload)) discovered.add(path);
  for (const url of [`${endpoint}/openapi.json`]) {
    for (const path of await fetchJsonPaths(url)) discovered.add(path);
  }

  const missingFromDocs = expected.filter(path => !discovered.has(path));
  const missing: string[] = [];
  for (const path of missingFromDocs) {
    if (!await probePathExists(endpoint, path)) missing.push(path);
  }

  const discoveredPaths = [...discovered].sort();
  if (missing.length > 0) {
    const discoveredMsg = discoveredPaths.length > 0 ? discoveredPaths.join(', ') : 'no /openapi.json or /v1/manifest paths discovered';
    return {
      ok: false,
      error: `Docker API contract mismatch. Missing expected path(s): ${missing.join(', ')}. Discovered: ${discoveredMsg}`,
      discoveredPaths,
    };
  }

  return { ok: true, discoveredPaths };
}

function shouldRunGlbSmokeTest(expectedApiPaths: string[] = [], expectedCapabilities: DockerCapability[] = []): boolean {
  return expectedCapabilities.includes('glb_generation')
    || expectedApiPaths.some(path => /generate(?:-from-text)?|glb/i.test(path));
}

function findGlbSmokePath(expectedApiPaths: string[] = []): string {
  if (expectedApiPaths.includes('/generate-from-text')) return '/generate-from-text';
  if (expectedApiPaths.includes('/generate')) return '/generate';
  return '/generate-from-text';
}

async function endpointPathExpectsMultipartFile(endpoint: string, path: string): Promise<boolean> {
  const api = asRecord(await fetchJson(`${endpoint}/openapi.json`));
  const paths = asRecord(api?.paths);
  const pathSpec = asRecord(paths?.[normalizeApiPath(path)]);
  const post = asRecord(pathSpec?.post);
  const requestBody = asRecord(post?.requestBody);
  const content = asRecord(requestBody?.content);
  return Boolean(content?.['multipart/form-data']);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const dataBuffer = Buffer.from(data);
  const payload = Buffer.concat([typeBuffer, dataBuffer]);
  const chunk = Buffer.alloc(12 + dataBuffer.length);
  chunk.writeUInt32BE(dataBuffer.length, 0);
  typeBuffer.copy(chunk, 4);
  dataBuffer.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(payload), 8 + dataBuffer.length);
  return chunk;
}

function createSmokePngBuffer(): Buffer {
  const width = 96;
  const height = 96;
  const bytesPerPixel = 4;
  const raw = Buffer.alloc((width * bytesPerPixel + 1) * height);

  for (let y = 0; y < height; y++) {
    const row = y * (width * bytesPerPixel + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * bytesPerPixel;
      const inObject = x >= 24 && x <= 71 && y >= 20 && y <= 74;
      const onEdge = inObject && (x <= 27 || x >= 68 || y <= 23 || y >= 71);
      const shadow = x >= 34 && x <= 80 && y >= 76 && y <= 82;
      const highlight = inObject && x < 44 && y < 42;
      const [r, g, b] = onEdge
        ? [52, 57, 65]
        : highlight
          ? [255, 140, 128]
          : inObject
            ? [220, 70, 62]
            : shadow
              ? [185, 190, 198]
              : [248, 250, 252];
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createGlbSmokeImageForm(): FormData {
  const form = new FormData();
  const png = createSmokePngBuffer();
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'smoke.png');
  return form;
}

function responseLooksLikeGlbResult(contentType: string, body: string, byteLength: number): boolean {
  if (byteLength > 128 && /model\/gltf-binary|application\/octet-stream/i.test(contentType)) return true;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const candidates = [
      parsed.url,
      parsed.glbUrl,
      parsed.glb_url,
      parsed.output,
      parsed.file,
      parsed.path,
      parsed.assetUrl,
      parsed.asset_url,
      parsed.model_url,
    ];
    return candidates.some(value => typeof value === 'string' && /\.glb(?:$|\?)/i.test(value));
  } catch {
    return /\.glb(?:$|\?)/i.test(body);
  }
}

type GlbSmokeResult = { ok: true } | { ok: false; error: string; missingMultipartFile?: boolean };

async function postGlbSmokeRequest(endpoint: string, path: string, useMultipartFile: boolean): Promise<GlbSmokeResult> {
  const url = `${endpoint}${path}${useMultipartFile && !path.includes('?') ? '?seed=1' : ''}`;
  const res = await fetch(url, useMultipartFile
    ? {
        method: 'POST',
        body: createGlbSmokeImageForm(),
        signal: AbortSignal.timeout(GLB_SMOKE_TIMEOUT_MS),
      }
    : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'a small red cube, low detail',
          with_texture: false,
          texture: false,
          seed: 1,
        }),
        signal: AbortSignal.timeout(GLB_SMOKE_TIMEOUT_MS),
      });
  const contentType = res.headers.get('content-type') || '';
  const buffer = await res.arrayBuffer();
  const text = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, 8192)));
  if (!res.ok) {
    return {
      ok: false,
      error: `GLB smoke test failed on ${path}: HTTP ${res.status} ${text.slice(0, 300)}`,
      missingMultipartFile: res.status === 422 && /body.*file|field required|multipart|uploadfile/i.test(text),
    };
  }
  if (!responseLooksLikeGlbResult(contentType, text, buffer.byteLength)) {
    return { ok: false, error: `GLB smoke test on ${path} returned unexpected payload (${contentType || 'unknown content-type'}, ${buffer.byteLength} bytes).` };
  }
  return { ok: true };
}

export async function runGlbSmokeTest(
  endpoint: string,
  expectedApiPaths: string[] = [],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const path = findGlbSmokePath(expectedApiPaths);
  try {
    const useMultipartFile = await endpointPathExpectsMultipartFile(endpoint, path);
    const result = await postGlbSmokeRequest(endpoint, path, useMultipartFile);
    if (!result.ok && !useMultipartFile && path === '/generate' && result.missingMultipartFile) {
      return await postGlbSmokeRequest(endpoint, path, true);
    }
    return result;
  } catch (err) {
    return { ok: false, error: `GLB smoke test failed: ${err instanceof Error ? err.message : err}` };
  }
}

/** Minimal TCP reachability check — resolves true once a TCP connection to host:port
 * opens within the timeout. Used by the SSH-only readiness branch. */
async function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const net = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** Wait for SSH (TCP :22) on the instance. Polls provider for liveness and
 * returns 'ready' once the socket opens. No HTTP /health required. */
async function pollSshUntilReady(
  providerClient: GpuProviderClient,
  providerName: string,
  credentials: ProviderCredentials,
  podId: string,
  endpoint: string,
  deployStartedAt: number,
): Promise<PollHealthResult> {
  // Cap SSH probe at 90s — Vast.ai SSH proxies either answer fast or never.
  // If a host fails this cap, the deploy retries on different hosts in
  // parallel via race=N (configured at deploy time, default 3).
  const deployTimeoutMs = Math.min(
    getDeployTimeoutMinForProvider(providerName) * 60_000,
    90_000,
  );
  // Extract host from `endpoint` (e.g. "http://1.2.3.4:8000") — fall back to the raw string.
  let host = endpoint;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    host = endpoint.replace(/^https?:\/\//, '').split(':')[0].split('/')[0];
  }
  log.log(`[gpu] ${providerName} pod ${podId}: SSH-only readiness probe against ${host}:22`);
  setDeployState({ status: 'booting', step: 'waiting_ssh', stepDetail: `${host}:22` });

  while (true) {
    if (deployCancelled) return { result: 'cancelled' };
    const elapsed = Date.now() - deployStartedAt;
    if (elapsed > deployTimeoutMs) {
      const msg = `SSH readiness timeout after ${Math.round(elapsed / 1000)}s — :22 never answered on ${host}`;
      log.warn(`[gpu] ${msg}`);
      setDeployState({ status: 'error', step: 'waiting_ssh', message: msg });
      return { result: 'timeout' };
    }
    // Check provider says instance is still alive — bail fast if it died.
    try {
      const status = await providerClient.getInstanceStatus(podId, credentials);
      if (status === 'exited' || status === 'deleted' || status === 'terminated') {
        setDeployState({ status: 'error', step: 'waiting_ssh', message: `Instance ${status} before SSH came up` });
        return { result: 'exited' };
      }
    } catch (err) {
      log.debug(`[gpu] provider status check failed during SSH wait: ${err instanceof Error ? err.message : err}`);
    }
    if (await tcpReachable(host, 22, 3000)) {
      const durationMs = Date.now() - deployStartedAt;
      log.log(`[gpu] ${providerName} pod ${podId}: SSH reachable after ${Math.round(durationMs / 1000)}s`);
      setLastRequestTime(Date.now());
      setDeployState({ status: 'ready', step: 'ready', message: 'SSH reachable', deployDurationMs: durationMs, alert: '', alertLevel: 'info' });
      return { result: 'ready' };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export async function pollHealthUntilReady(
  providerClient: GpuProviderClient,
  providerName: string,
  apiKey: string,
  podId: string,
  endpoint: string,
  deployStartedAt: number,
  dockerImage?: string,
  providerMeta?: Record<string, unknown>,
  expectedApiPaths: string[] = [],
  expectedCapabilities: DockerCapability[] = [],
  requireDockerManifest = false,
  runSmokeTests = true,
): Promise<PollHealthResult> {
  const credentials: ProviderCredentials = { apiKey };

  // SSH-only readiness mode: skip HTTP /health polling entirely and just wait
  // for TCP :22 to answer on the endpoint host. Used for experiments that only
  // need shell access (e.g. CRIU on a plain CPU process, cold-boot benchmarks).
  if (deployState.readinessProbe === 'ssh') {
    return pollSshUntilReady(providerClient, providerName, credentials, podId, endpoint, deployStartedAt);
  }

  let consecutiveExited = 0;
  let containerStartedAt = 0;
  let healthRespondedOnce = false;
  let healthFirstResponseAt = 0;
  let allServicesLoaded = false;
  let pullStartedAt = 0;
  let actualPullTimeS: number | undefined;
  let consecutiveHealthFailures = 0;
  let firstNonTransientErrorAt = 0;
  let consecutiveNonTransient = 0;

  // Stalled download detection
  let lastHealthBody = '';
  let identicalHealthCount = 0;
  let stalledWarned = false;

  // Progress-aware timeout extension (smart retry — #10)
  // Each phase can be extended ONCE if progress was observed in the last 120s.
  let lastProgressAt = Date.now();
  let pullTimeoutExtendedOnce = false;
  let bootTimeoutExtendedOnce = false;
  let modelsTimeoutExtendedOnce = false;
  const PROGRESS_WINDOW_MS = 120_000;
  const markProgress = (kind: string) => {
    lastProgressAt = Date.now();
    log.debug(`[gpu] progress: ${kind}`);
  };
  let lastProviderStatus = '';
  let lastServicesSnapshot = '';
  let lastSshLogDigest = '';

  const healthPath = '/health';
  let consecutiveConnectionRefused = 0;
  let lastErrorBody = '';
  let firstAppResponseAt = 0;
  const BOOT_5XX_LEEWAY_MS = 60_000;
  let preflightDone = false;
  let speedTestDone = false;

  // ── Adaptive pull timeout ──────────────────────────────────────────────
  const { estimatePullTimeout, deriveHostKey: deriveKey } = await import('../src/gpu-providers/pull-time-estimator');
  const inetDown = (providerMeta?.inetDown as number) || (providerMeta?.inet_down as number) || 500;
  const diskGb = (providerMeta?.diskGb as number) || 20;
  const hostKey = deriveKey(providerName, providerMeta);
  const pullEstimate = await estimatePullTimeout({
    dockerImage: dockerImage || 'unknown',
    inetDownMbps: inetDown,
    diskGb,
    hostKey,
  });
  log.log(`[gpu] Pull timeout: ${Math.round(pullEstimate.timeoutMs / 1000)}s (${pullEstimate.confidence}: ${pullEstimate.basis})`);

  while (true) {
    if (deployCancelled) return { result: 'cancelled' };
    const deployTimeoutMs = getDeployTimeoutMinForProvider(providerName) * 60_000;
    const totalElapsedMs = Date.now() - deployStartedAt;

    // ── Global deploy timeout guard ──
    if (totalElapsedMs > deployTimeoutMs) {
      throw new Error(`Deploy timed out after ${Math.round(deployTimeoutMs / 60000)} minutes (total elapsed: ${Math.round(totalElapsedMs / 1000)}s)`);
    }

    // ── Early-abandon stuck/offline hosts (fast self-heal) ──
    // A dud/offline host can sit "offline" without ever starting the image pull
    // until the full deploy timeout. If neither the pull nor the container has
    // started within AIGW_OFFLINE_ABANDON_SEC (default 150s) of creation, give up
    // on this host and return a retryable timeout so the deploy loop immediately
    // picks a fresh machine — the gateway self-heals instead of waiting minutes.
    {
      const offlineAbandonMs = (parseInt(process.env.AIGW_OFFLINE_ABANDON_SEC || '150', 10) || 150) * 1000;
      if (!pullStartedAt && !containerStartedAt && totalElapsedMs > offlineAbandonMs) {
        const msg = `Host offline / no image-pull after ${Math.round(totalElapsedMs / 1000)}s (> ${Math.round(offlineAbandonMs / 1000)}s) — abandoning dud host, trying next machine`;
        log.warn(`[gpu] ${providerName} pod ${podId}: ${msg}`);
        broadcastWs({ type: 'gpu:deploy', phase: 'offline_abandon', deployId: deployState.deployId, provider: providerName, elapsedMs: totalElapsedMs });
        setDeployState({ status: 'error', step: 'creating', message: msg });
        return { result: 'timeout' };
      }
    }

    // ── Per-phase timeouts (fail fast, try next machine) ──
    const isInfServer = /vllm|text-generation-inference|tgi|llama\.cpp|ollama/i.test(dockerImage || '');
    const modelHint = `${dockerImage || ''} ${deployState.message || ''}`;
    const bootMs = isInfServer
      ? (/70b|65b|72b/i.test(modelHint) ? 15 * 60_000
        : /32b|34b|33b/i.test(modelHint) ? 10 * 60_000
        : 7 * 60_000)
      : 5 * 60_000;
    const PHASE_TIMEOUTS = {
      IMAGE_PULL:  pullEstimate.timeoutMs,
      BOOT:        bootMs,
      MODELS:     10 * 60_000,
    };

    // Image pull timeout — smart retry: extend once if progress observed recently (#10)
    if (!containerStartedAt && pullStartedAt > 0 && (Date.now() - pullStartedAt) > PHASE_TIMEOUTS.IMAGE_PULL) {
      const pullSec = Math.round((Date.now() - pullStartedAt) / 1000);
      const sinceProgress = Date.now() - lastProgressAt;
      if (!pullTimeoutExtendedOnce && sinceProgress < PROGRESS_WINDOW_MS) {
        pullTimeoutExtendedOnce = true;
        PHASE_TIMEOUTS.IMAGE_PULL = Math.round(PHASE_TIMEOUTS.IMAGE_PULL * 1.5);
        const extMsg = `Image pull slow but progressing (${pullSec}s, last signal ${Math.round(sinceProgress / 1000)}s ago) — extending timeout by 50%`;
        log.warn(`[gpu] ${providerName} pod ${podId}: ${extMsg}`);
        broadcastWs({ type: 'gpu:deploy', phase: 'pull_extended', deployId: deployState.deployId, provider: providerName, elapsedMs: totalElapsedMs, newTimeoutMs: PHASE_TIMEOUTS.IMAGE_PULL });
        setDeployState({ alert: extMsg, alertLevel: 'info' });
      } else {
        const reason = pullTimeoutExtendedOnce ? 'after extension' : `no progress for ${Math.round(sinceProgress / 1000)}s`;
        const timeoutMsg = `Image pull timeout (${pullSec}s, ${reason}) — machine too slow, trying next`;
        log.warn(`[gpu] ${providerName} pod ${podId}: ${timeoutMsg}`);
        broadcastWs({ type: 'gpu:deploy', phase: 'pull_timeout', deployId: deployState.deployId, provider: providerName, elapsedMs: totalElapsedMs });
        setDeployState({ status: 'error', step: 'pulling_image', message: timeoutMsg });
        return { result: 'timeout', pullTimeS: actualPullTimeS };
      }
    }

    // Boot timeout — smart retry (#10)
    if (containerStartedAt && !healthRespondedOnce && (Date.now() - containerStartedAt) > PHASE_TIMEOUTS.BOOT) {
      const inLeeway = firstAppResponseAt > 0 && (Date.now() - firstAppResponseAt) < BOOT_5XX_LEEWAY_MS;
      if (!inLeeway) {
        const bootSec = Math.round((Date.now() - containerStartedAt) / 1000);
        const sinceProgress = Date.now() - lastProgressAt;
        if (!bootTimeoutExtendedOnce && sinceProgress < PROGRESS_WINDOW_MS) {
          bootTimeoutExtendedOnce = true;
          PHASE_TIMEOUTS.BOOT = Math.round(PHASE_TIMEOUTS.BOOT * 1.5);
          const extMsg = `Boot slow but progressing (${bootSec}s, last signal ${Math.round(sinceProgress / 1000)}s ago) — extending boot timeout by 50%`;
          log.warn(`[gpu] ${providerName} pod ${podId}: ${extMsg}`);
          broadcastWs({ type: 'gpu:deploy', phase: 'boot_extended', deployId: deployState.deployId, provider: providerName, newTimeoutMs: PHASE_TIMEOUTS.BOOT });
          setDeployState({ alert: extMsg, alertLevel: 'info' });
        } else {
          const leewayNote = firstAppResponseAt > 0
            ? ` (app was returning errors, last body: ${lastErrorBody.slice(0, 120)})`
            : ` (TCP refused — ${consecutiveConnectionRefused} consecutive failures)`;
          const reason = bootTimeoutExtendedOnce ? 'after extension' : `no progress for ${Math.round(sinceProgress / 1000)}s`;
          const timeoutMsg = `Boot timeout (${bootSec}s, ${reason}) — container up but /health not responding${leewayNote}`;
          log.warn(`[gpu] ${providerName} pod ${podId}: ${timeoutMsg}`);
          broadcastWs({ type: 'gpu:deploy', phase: 'boot_timeout', deployId: deployState.deployId, provider: providerName });
          setDeployState({ status: 'error', step: 'waiting_health', message: timeoutMsg });
          return { result: 'timeout', pullTimeS: actualPullTimeS };
        }
      }
    }

    // Model loading timeout — smart retry (#10)
    if (healthRespondedOnce && !allServicesLoaded && (Date.now() - (healthFirstResponseAt || Date.now())) > PHASE_TIMEOUTS.MODELS) {
      const modelSec = Math.round((Date.now() - (healthFirstResponseAt || Date.now())) / 1000);
      const sinceProgress = Date.now() - lastProgressAt;
      // Specifically require that /health body wasn't identical for long — models phase tracks identicalHealthCount
      const stalledInHealth = identicalHealthCount >= 5;
      if (!modelsTimeoutExtendedOnce && sinceProgress < PROGRESS_WINDOW_MS && !stalledInHealth) {
        modelsTimeoutExtendedOnce = true;
        PHASE_TIMEOUTS.MODELS = Math.round(PHASE_TIMEOUTS.MODELS * 1.5);
        const extMsg = `Model loading slow but progressing (${modelSec}s, last signal ${Math.round(sinceProgress / 1000)}s ago) — extending timeout by 50%`;
        log.warn(`[gpu] ${providerName} pod ${podId}: ${extMsg}`);
        broadcastWs({ type: 'gpu:deploy', phase: 'model_extended', deployId: deployState.deployId, provider: providerName, newTimeoutMs: PHASE_TIMEOUTS.MODELS });
        setDeployState({ alert: extMsg, alertLevel: 'info' });
      } else {
        const reason = modelsTimeoutExtendedOnce ? 'after extension' : stalledInHealth ? 'health body stuck' : `no progress for ${Math.round(sinceProgress / 1000)}s`;
        const timeoutMsg = `Model loading timeout (${modelSec}s, ${reason}) — services still downloading`;
        log.warn(`[gpu] ${providerName} pod ${podId}: ${timeoutMsg}`);
        broadcastWs({ type: 'gpu:deploy', phase: 'model_timeout', deployId: deployState.deployId, provider: providerName });
        setDeployState({ status: 'error', step: 'downloading_models', message: timeoutMsg });
        return { result: 'timeout', pullTimeS: actualPullTimeS };
      }
    }

    // Proactive alert: slow model warming (> 3 min)
    if (healthRespondedOnce && !allServicesLoaded && (Date.now() - (healthFirstResponseAt || Date.now())) > 180_000) {
      const warmSec = Math.round((Date.now() - (healthFirstResponseAt || Date.now())) / 1000);
      const currentAlert = deployState.alert;
      if (!currentAlert.includes('slow warm')) {
        setDeployState({ alert: `Model warming slow (${warmSec}s) — large model or slow GPU`, alertLevel: 'warning' });
      }
    }

    // Proactive alert: total deploy taking > 5 min
    if (totalElapsedMs > 300_000 && deployState.status !== 'ready' && !deployState.alert.includes('slow deploy')) {
      setDeployState({ alert: `Deploy taking ${Math.round(totalElapsedMs / 60000)} min — checking for issues`, alertLevel: 'info' });
    }

    // Proactive alert: total deploy taking > 10 min (critical)
    if (totalElapsedMs > 600_000 && deployState.status !== 'ready' && !deployState.alert.includes('very slow deploy')) {
      setDeployState({ alert: `Very slow deploy (${Math.round(totalElapsedMs / 60000)} min) — may need to terminate and retry`, alertLevel: 'error' });
    }

    // Ghost machine detection (RunPod)
    if (!containerStartedAt && providerName === 'runpod' && totalElapsedMs > 90_000) {
      try {
        const { RunpodClient } = await import('../src/gpu-providers/runpod-client');
        if (providerClient instanceof RunpodClient) {
          const detail = await providerClient.getInstanceDetail(podId, credentials);
          if (detail?.ghostMachine) {
            const ghostMsg = `Ghost machine — pod created but no physical machine assigned after ${Math.round(totalElapsedMs / 1000)}s. RunPod silently failed to schedule (check storage size, GPU availability).`;
            log.error(`[gpu] ${providerName} pod ${podId}: ${ghostMsg}`);
            broadcastWs({ type: 'gpu:deploy', phase: 'ghost_machine', deployId: deployState.deployId, provider: providerName, elapsedMs: totalElapsedMs });
            setDeployState({ status: 'error', step: 'ghost_machine', message: ghostMsg });
            try { await providerClient.deleteInstance(podId, credentials); } catch { /* best effort */ }
            return { result: 'crashed', pullTimeS: actualPullTimeS };
          }
        }
      } catch { /* best-effort ghost detection */ }
    }

    // Overall deploy timeout (safety net)
    if (totalElapsedMs > deployTimeoutMs) {
      const phase = containerStartedAt ? 'waiting for /health' : 'pulling image';
      const timeoutMsg = `Overall timeout after ${getDeployTimeoutMin()} min (stuck ${phase})`;
      log.error(`[gpu] ${providerName} pod ${podId} timed out: ${phase}, endpoint=${endpoint || 'none'}`);
      setDeployState({ status: 'error', message: timeoutMsg });
      return { result: 'timeout', pullTimeS: actualPullTimeS };
    }

    const elapsed = Math.round((Date.now() - deployStartedAt) / 1000);

    // Provider-specific status polling
    if (providerName === 'runpod') {
      try {
        const detail = await (providerClient as RunpodClient).getInstanceDetail(podId, credentials);
        if (detail) {
          // Progress signal: RunPod status fields changed
          const statusSnap = `${detail.desiredStatus}|${detail.runtime ? 'running' : 'pre'}|${detail.imageName || ''}`;
          if (statusSnap !== lastProviderStatus) { markProgress(`runpod status → ${statusSnap}`); lastProviderStatus = statusSnap; }
          if (detail.desiredStatus === 'EXITED') {
            consecutiveExited++;
            if (consecutiveExited >= 2) return { result: 'exited', pullTimeS: actualPullTimeS };
          } else {
            consecutiveExited = 0;
          }

          if (detail.gpuType) setDeployState({ gpuType: detail.gpuType });
          if (detail.costPerHr) setDeployState({ costPerHr: detail.costPerHr });
          const costStr = detail.costPerHr ? `$${detail.costPerHr.toFixed(3)}/h` : '';

          if (!detail.runtime) {
            if (!pullStartedAt) {
              pullStartedAt = Date.now();
              // Record pull start in history
              const pullEntry = { image: detail.imageName ?? deployState.dockerImage, attempt: 1, startedAt: Date.now(), status: 'downloading' as const };
              setDeployState({ pullHistory: [...deployState.pullHistory, pullEntry] });
            }
            setDeployState({
              status: 'installing', step: 'pulling_image',
              message: `Pulling image & starting container... [${elapsed}s]`,
              stepDetail: [detail.imageName, detail.gpuType, costStr].filter(Boolean).join(' — '),
            });
            // Proactive alert: slow pull detection
            if (elapsed > 120 && !deployState.alert.includes('slow pull')) {
              setDeployState({ alert: `Image pull taking ${elapsed}s — large image or slow network`, alertLevel: 'warning' });
            }
          } else if (!containerStartedAt) {
            containerStartedAt = Date.now();
            if (pullStartedAt > 0) {
              actualPullTimeS = Math.round((containerStartedAt - pullStartedAt) / 1000);
              // Update pull history entry to completed
              const updatedPullHistory = deployState.pullHistory.map(p =>
                p.status === 'downloading' ? { ...p, completedAt: Date.now(), status: 'completed' as const } : p
              );
              setDeployState({ pullHistory: updatedPullHistory });
              log.log(`[gpu] Pull completed in ${actualPullTimeS}s`);
            }
            const newEndpoint = await providerClient.resolveInstanceEndpoint(podId, credentials);
            if (newEndpoint && newEndpoint !== endpoint) {
              endpoint = newEndpoint;
              setDeployState({ endpoint });
            }
            setDeployState({
              status: 'booting', step: 'starting_container',
              message: `Container running, loading models... [${elapsed}s]`,
              stepDetail: [detail.gpuType, costStr].filter(Boolean).join(' — '),
            });
          } else {
            const appElapsed = Math.round((Date.now() - containerStartedAt) / 1000);
            setDeployState({
              status: 'booting', step: 'waiting_health',
              message: `App starting, waiting for /health... [${elapsed}s, container up ${appElapsed}s]`,
              stepDetail: [detail.gpuType, costStr].filter(Boolean).join(' — '),
            });
          }
        }
      } catch (err) {
        log.warn(`[gpu] Failed to get RunPod detail for pod ${podId}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      // Vast.ai (and other providers): use GpuProviderClient interface
      try {
        const status = await providerClient.getInstanceStatus(podId, credentials);
        if (status) {
          const statusLower = status.toLowerCase();
          // Progress signal: status string changed
          if (status !== lastProviderStatus) { markProgress(`${providerName} status → ${status}`); lastProviderStatus = status; }
          const TERMINAL = new Set(['exited', 'failed', 'destroyed', 'error', 'deleted']);
          const DISASSOCIATED = statusLower === 'stoppeddisassociated' || statusLower === 'stopped_disassociated';
          if (TERMINAL.has(statusLower) || DISASSOCIATED) {
            consecutiveExited++;
            if (DISASSOCIATED) {
              log.warn(`[gpu] ${providerName} instance ${podId} GPU disassociated (hostnode reclaimed GPU)`);
              setDeployState({ alert: `GPU disassociated — hostnode reclaimed the GPU. Will retry on a more stable host.` });
            }
            if (consecutiveExited >= 2) return { result: 'exited', pullTimeS: actualPullTimeS };
          } else {
            consecutiveExited = 0;
          }

          const isRunning = ['running', 'active'].includes(statusLower);
          if (isRunning && !containerStartedAt) {
            containerStartedAt = Date.now();
            if (pullStartedAt > 0) actualPullTimeS = Math.round((containerStartedAt - pullStartedAt) / 1000);
          }

          if (!containerStartedAt) {
            const isQueued = ['created', 'pending', 'queued', 'provisioning'].includes(statusLower);
            const isPulling = ['loading', 'pulling', 'starting', 'initializing'].includes(statusLower) || (!isQueued && !isRunning);
            if (isQueued) {
              setDeployState({
                status: 'queued', step: 'queued',
                message: `GPU allocated, waiting in queue... [${elapsed}s]`,
                stepDetail: deployState.gpuType || '',
              });
            } else {
              if (!pullStartedAt) pullStartedAt = Date.now();
              setDeployState({
                status: 'installing', step: 'pulling_image',
                message: `Pulling Docker image... [${elapsed}s]`,
                stepDetail: deployState.gpuType || '',
              });
            }
          } else {
            const appElapsed = Math.round((Date.now() - containerStartedAt) / 1000);
            setDeployState({
              status: 'booting', step: 'waiting_health',
              message: `Container running, waiting for /health... [${elapsed}s, up ${appElapsed}s]`,
              stepDetail: deployState.gpuType || '',
            });
            setLastRequestTime(Date.now());
          }
        }
      } catch (err) {
        log.warn(`[gpu] Failed to get ${providerName} status for pod ${podId}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Re-resolve endpoint periodically
    if (!containerStartedAt || !endpoint || providerName === 'vast') {
      try {
        const resolved = await providerClient.resolveInstanceEndpoint(podId, credentials);
        if (resolved && resolved !== endpoint) {
          log.log(`[gpu] ${providerName} endpoint resolved: ${endpoint || '(none)'} → ${resolved}`);
          endpoint = resolved;
          setDeployState({ endpoint });
        }
      } catch (err) {
        if (containerStartedAt) log.warn(`[gpu] Failed to resolve ${providerName} endpoint for pod ${podId}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // SSH tunnel fallback
    if (!endpoint && containerStartedAt && (Date.now() - containerStartedAt) > 60_000 && deployState.sshHost && deployState.sshPort) {
      try {
        const { getOrCreateTunnel } = await import('./ssh-tunnel');
        const tunnel = getOrCreateTunnel(deployState.sshHost, deployState.sshPort, 8000);
        if (!tunnel.isOpen) {
          log.log(`[gpu] No direct endpoint — opening SSH tunnel to ${deployState.sshHost}:${deployState.sshPort}`);
          setDeployState({ step: 'ssh_tunnel', message: `Opening SSH tunnel (no direct port)...` });
          const ok = await tunnel.open();
          if (ok) {
            endpoint = tunnel.endpoint;
            setDeployState({ endpoint, message: `SSH tunnel active: ${endpoint}` });
            log.log(`[gpu] SSH tunnel established: ${endpoint}`);
          } else {
            log.warn(`[gpu] SSH tunnel failed to ${deployState.sshHost}:${deployState.sshPort}`);
          }
        } else {
          endpoint = tunnel.endpoint;
        }
      } catch (err) {
        log.warn(`[gpu] SSH tunnel error: ${err instanceof Error ? err.message : err}`);
      }
    }

    // One-time SSH pre-flight check
    {
      const sshHost = deployState.sshHost;
      const sshPort = deployState.sshPort;
      if (sshHost && sshPort && !preflightDone) {
        preflightDone = true;
        try {
          const { spawn: sshSpawn } = await import('child_process');
          const proc = sshSpawn('ssh', [
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ConnectTimeout=8',
            '-o', 'LogLevel=ERROR',
            '-p', String(sshPort),
            `root@${sshHost}`,
            'pgrep -af python | head -3; echo ===; pgrep -af sshd | head -3; echo ===; ls /app/ 2>&1',
          ], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          proc.stdout.on('data', (c) => { out += c.toString(); });
          await new Promise<void>((r) => {
            const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* best-effort */ }; r(); }, 12_000);
            proc.on('exit', () => { clearTimeout(t); r(); });
            proc.on('error', () => { clearTimeout(t); r(); });
          });
          log.log(`[gpu] [trellis-debug] preflight ssh inspection:\n${out}`);
        } catch (e) {
          log.log(`[gpu] [trellis-debug] preflight ssh failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    // One-time internet speed test — abort if actual << advertised
    {
      const sshHost = deployState.sshHost;
      const sshPort = deployState.sshPort;
      if (sshHost && sshPort && !speedTestDone && inetDown > 0) {
        speedTestDone = true;
        try {
          const { spawn: sshSpawn } = await import('child_process');
          const proc = sshSpawn('ssh', [
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ConnectTimeout=8',
            '-o', 'LogLevel=ERROR',
            '-p', String(sshPort),
            `root@${sshHost}`,
            'curl -o /dev/null -w "%{speed_download}" -s --max-time 30 https://speed.cloudflare.com/__down?bytes=50000000 2>/dev/null',
          ], { stdio: ['ignore', 'pipe', 'pipe'] });
          let speedOut = '';
          proc.stdout.on('data', (c: Buffer) => { speedOut += c.toString(); });
          await new Promise<void>((r) => {
            const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* best-effort */ } r(); }, 40_000);
            proc.on('exit', () => { clearTimeout(t); r(); });
            proc.on('error', () => { clearTimeout(t); r(); });
          });
          const speedBytes = parseFloat(speedOut.trim());
          if (!isNaN(speedBytes) && speedBytes > 0) {
            const actualMbps = Math.round(speedBytes * 8 / 1_000_000);
            // Configurable gate. SPEED_TEST_THRESHOLD_FACTOR (default 0.5) is the
            // fraction of advertised bandwidth a host must actually deliver.
            // SPEED_TEST_ALLOW_DEGRADED keeps a slow-but-usable host instead of
            // destroying it, as long as it clears SPEED_TEST_DEGRADED_FLOOR
            // (default 0.25 of advertised) — avoids the "every cheap 4090 fails
            // the gate and we churn pods forever" failure mode.
            const thresholdFactor = Math.min(1, Math.max(0.1, parseFloat(process.env.SPEED_TEST_THRESHOLD_FACTOR ?? '0.5') || 0.5));
            const degradedFloorFactor = Math.min(thresholdFactor, Math.max(0, parseFloat(process.env.SPEED_TEST_DEGRADED_FLOOR ?? '0.25') || 0.25));
            const allowDegraded = process.env.SPEED_TEST_ALLOW_DEGRADED === '1' || process.env.SPEED_TEST_ALLOW_DEGRADED === 'true';
            const threshold = inetDown * thresholdFactor;
            const degradedFloor = inetDown * degradedFloorFactor;
            log.log(`[gpu] Speed test: ${actualMbps} Mbps actual vs ${inetDown} Mbps advertised (threshold: ${Math.round(threshold)} Mbps)`);
            broadcastWs({ type: 'gpu:deploy', phase: 'speed_test', deployId: deployState.deployId, provider: providerName, actualMbps, advertisedMbps: inetDown });
            if (actualMbps < threshold) {
              if (allowDegraded && actualMbps >= degradedFloor) {
                // Slow but acceptable — keep the host, flag degraded, continue.
                const dmsg = `Speed test degraded-accept: ${actualMbps} Mbps actual < ${Math.round(threshold)} Mbps threshold but >= ${Math.round(degradedFloor)} Mbps floor (advertised ${inetDown} Mbps)`;
                log.warn(`[gpu] ${providerName} pod ${podId}: ${dmsg}`);
                setDeployState({ networkDegraded: true, alert: dmsg, alertLevel: 'warning' });
              } else {
                const msg = `Speed test failed: ${actualMbps} Mbps actual < ${Math.round(threshold)} Mbps threshold (advertised ${inetDown} Mbps) — destroying pod and trying faster machine`;
                log.warn(`[gpu] ${providerName} pod ${podId}: ${msg}`);
                // Penalize this host so auto-select avoids it next time (#10).
                try {
                  const { upsertHostReputation } = await import('./metrics');
                  await upsertHostReputation({
                    provider: providerName,
                    gpuType: deployState.gpuType || '',
                    providerMeta,
                    success: false,
                    failureCategory: 'network',
                    latencyMs: undefined,
                  });
                } catch (repErr) {
                  log.warn(`[gpu] failed to record speed_test reputation: ${repErr instanceof Error ? repErr.message : repErr}`);
                }
                // Auto-destroy the slow pod so it stops charging (#7). Leaving it
                // running was the root cause of the cost cascade: a failed speed
                // test left a $1.2-1.4/hr pod billing while the race retried.
                try {
                  await providerClient.deleteInstance(podId, credentials);
                  log.log(`[gpu] destroyed pod ${podId} after speed_test_failed`);
                } catch (delErr) {
                  log.error(`[gpu] FAILED to destroy pod ${podId} after speed_test_failed — MAY STILL BE BILLING: ${delErr instanceof Error ? delErr.message : delErr}`);
                }
                setDeployState({ status: 'error', step: 'speed_test_failed', message: msg });
                return { result: 'timeout', pullTimeS: actualPullTimeS };
              }
            }
          } else {
            log.warn(`[gpu] Speed test: curl not available or returned invalid output: "${speedOut.trim().slice(0, 100)}"`);
          }
        } catch (e) {
          log.warn(`[gpu] Speed test failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    // ── Periodic SSH log inspection for early crash detection ──
    {
      const sshHost = deployState.sshHost;
      const sshPort = deployState.sshPort;
      const containerUp = containerStartedAt > 0;
      const timeSinceContainerStart = containerUp ? Date.now() - containerStartedAt : 0;
      const shouldCheckLogs = containerUp && sshHost && sshPort && !healthRespondedOnce
        && timeSinceContainerStart > 20_000
        && timeSinceContainerStart % 30_000 < 8_000;
      if (shouldCheckLogs) {
        try {
          const { spawn: sshSpawn } = await import('child_process');
          const logProc = sshSpawn('ssh', [
            '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR',
            '-p', String(sshPort), `root@${sshHost}`,
            'tail -20 /var/log/app.log 2>/dev/null || tail -20 /root/.log 2>/dev/null || echo NO_LOGS',
          ], { stdio: ['ignore', 'pipe', 'pipe'] });
          let logOut = '';
          logProc.stdout.on('data', (c: Buffer) => { logOut += c.toString(); });
          await new Promise<void>((r) => {
            const t = setTimeout(() => { try { logProc.kill('SIGKILL'); } catch { /* process already exited */ } r(); }, 8_000);
            logProc.on('exit', () => { clearTimeout(t); r(); });
            logProc.on('error', () => { clearTimeout(t); r(); });
          });
          const FATAL_PATTERNS = [
            /RuntimeError.*failed/i,
            /CUDA out of memory/i,
            /torch\.cuda\.OutOfMemoryError/i,
            /OOM|OutOfMemory/i,
            /Killed.*signal 9/i,
            /Engine core initialization failed/i,
            /Cannot allocate memory/i,
          ];
          for (const pat of FATAL_PATTERNS) {
            if (pat.test(logOut)) {
              const crashLine = logOut.split('\n').find(l => pat.test(l)) || logOut.slice(-200);
              const crashMsg = `Container crashed: ${crashLine.trim().slice(0, 200)}`;
              log.error(`[gpu] ${providerName} pod ${podId}: FATAL in logs → ${crashMsg}`);
              broadcastWs({ type: 'gpu:deploy', phase: 'container_crash', deployId: deployState.deployId, provider: providerName, error: crashMsg });
              setDeployState({ status: 'error', step: 'container_crash', message: crashMsg });
              return { result: 'crashed', pullTimeS: actualPullTimeS };
            }
          }
          if (logOut && !logOut.includes('NO_LOGS')) {
            // Progress signal: SSH logs changed (download bytes, load progress)
            const digest = logOut.slice(-400);
            if (digest !== lastSshLogDigest) { markProgress('ssh logs changed'); lastSshLogDigest = digest; }
            log.log(`[gpu] [log-check] ${providerName} ${podId} (${Math.round(timeSinceContainerStart/1000)}s): ${logOut.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200)}`);
          }
        } catch { /* SSH log check is best-effort */ }
      }
    }

    // Probe health endpoint
    if (endpoint) {
      let httpStatus = 0;
      let connectionRefused = false;
      try {
        const res = await fetch(`${endpoint}${healthPath}`, { signal: AbortSignal.timeout(8000) });
        httpStatus = res.status;
        consecutiveConnectionRefused = 0;
        if (!firstAppResponseAt) { firstAppResponseAt = Date.now(); markProgress('first TCP/app response'); }
        if (!res.ok) {
          const body = await res.text().catch(() => '<unreadable>');
          lastErrorBody = body.substring(0, 500);
          log.log(`[gpu] [trellis-debug] /health body (status=${res.status}, len=${body.length}): ${lastErrorBody.substring(0, 300)}`);
          const kind = httpStatus >= 500 ? '5xx (app bug or model loading)' : '4xx (wrong endpoint?)';
          log.warn(`[gpu] Health endpoint ${endpoint}${healthPath} returned ${httpStatus} ${kind}: ${lastErrorBody}`);
        }
        if (res.ok) {
          const data = await res.json();
          updateGpuModelWarmth(data);

          // ── Stalled download detection ────────────────────────────────
          const healthBodyStr = JSON.stringify(data);
          if (healthBodyStr === lastHealthBody) {
            identicalHealthCount++;
            if (identicalHealthCount >= 20) {
              // 20 identical responses ≈ 10 min stalled after /health started responding.
              // No phase timeout will save us here — abort now so the retry picks a better host.
              const stalledSec = Math.round(identicalHealthCount * 30);
              const stallMsg = `Health stalled — same /health response for ${stalledSec}s (${identicalHealthCount} checks). Aborting to retry on a better host.`;
              log.error(`[gpu] ${providerName} pod ${podId}: ${stallMsg}`);
              broadcastWs({ type: 'gpu:deploy', phase: 'stalled_abort', deployId: deployState.deployId, provider: providerName, stalledSeconds: stalledSec });
              setDeployState({ status: 'error', step: 'stalled', message: stallMsg });
              return { result: 'timeout', pullTimeS: actualPullTimeS };
            }
            if (identicalHealthCount >= 5 && !stalledWarned) {
              stalledWarned = true;
              const stalledSec = identicalHealthCount * 30;
              log.warn(`[gpu] Download appears stalled — same /health response for ${stalledSec}s (${identicalHealthCount} checks)`);
              broadcastWs({ type: 'gpu:deploy', phase: 'stalled', deployId: deployState.deployId, provider: providerName, stalledSeconds: stalledSec, identicalChecks: identicalHealthCount });
              setDeployState({ alert: `Download may be stalled — no progress for ${stalledSec}s`, alertLevel: 'warning' });
            } else if (identicalHealthCount === 3) {
              log.log(`[gpu] Possible stall — identical /health response for 3 consecutive checks`);
            }
          } else {
            identicalHealthCount = 0;
            lastHealthBody = healthBodyStr;
            stalledWarned = false;
            markProgress('/health body changed');
          }

          // Progress signal: per-service status snapshot changed (download → load → ready)
          const svcSnapshot = data && typeof data === 'object' && data.services
            ? JSON.stringify(data.services)
            : '';
          if (svcSnapshot && svcSnapshot !== lastServicesSnapshot) {
            markProgress(`services snapshot changed`);
            lastServicesSnapshot = svcSnapshot;
          }

          // ── Fail-fast on app-reported error ──────────────────────────
          const appHealthError = extractAppHealthError(data);
          if (appHealthError) {
            const appErrMsg = appHealthError.message;
            const appTraceback = appHealthError.traceback;
            log.error(`[gpu] App reported error via /health — failing deploy fast.`);
            log.error(`[gpu]   error: ${appErrMsg}`);
            if (appTraceback) {
              log.error(`[gpu]   traceback (first 2KiB):\n${appTraceback.slice(0, 2048)}`);
            }
            setDeployState({
              status: 'error',
              step: 'app_error',
              message: `App load failed: ${appErrMsg}`,
              stepDetail: appErrMsg.slice(0, 200),
            });
            broadcastWs({
              type: 'gpu:deploy',
              phase: 'app_error',
              deployId: deployState.deployId,
              provider: providerName,
              error: appErrMsg,
            });
            return {
              result: 'app_error',
              pullTimeS: actualPullTimeS,
              appError: { message: appErrMsg, traceback: appTraceback },
            };
          }

            if (HEALTHY_STATUSES.has(healthStatus(data))) {
              if (!healthRespondedOnce) { healthRespondedOnce = true; healthFirstResponseAt = Date.now(); }
              consecutiveHealthFailures = 0;

              const expectedGenericApp = isExpectedGenericGpuApp(expectedApiPaths, expectedCapabilities);
              const genericAppReady = isGenericAppHealthReady(data)
                || isGenericAppUsableWhileLoading(data, expectedApiPaths, expectedCapabilities);
              if (expectedGenericApp && !hasPipelineServices(data) && !genericAppReady) {
                const appLabel = describeGenericAppHealth(data, dockerImage);
                const status = healthStatus(data) || 'unknown';
                const stepDetail = `generic_app_loading:${status}`;
                if (lastServicesSnapshot !== stepDetail) {
                  log.log(`[gpu] Generic GPU app health=${status}; waiting without speech pipeline warmup checks.`);
                  lastServicesSnapshot = stepDetail;
                }
                setDeployState({
                  status: 'booting',
                  step: 'loading_app',
                  message: `Loading GPU app: ${appLabel} (${status})`,
                  stepDetail,
                });
                continue;
              }

              if (genericAppReady) {
                allServicesLoaded = true;
                const appLabel = describeGenericAppHealth(data, dockerImage);
                const stepDetail = `generic_app_ready:${appLabel}`;
                const apiContract = await validateEndpointApiContract(endpoint, expectedApiPaths, expectedCapabilities, requireDockerManifest);
                if (!apiContract.ok) {
                  log.error(`[gpu] ${apiContract.error}`);
                  setDeployState({
                    status: 'error',
                    step: 'api_contract_error',
                    message: apiContract.error,
                    stepDetail: expectedApiPaths.join(', '),
                  });
                  broadcastWs({
                    type: 'gpu:deploy',
                    phase: 'api_contract_error',
                    deployId: deployState.deployId,
                    provider: providerName,
                    error: apiContract.error,
                  });
                  return {
                    result: 'app_error',
                    pullTimeS: actualPullTimeS,
                    appError: { message: apiContract.error },
                  };
                }
                if (runSmokeTests && shouldRunGlbSmokeTest(expectedApiPaths, expectedCapabilities)) {
                  setDeployState({ step: 'testing_api', message: 'Running GLB smoke test...', stepDetail: expectedApiPaths.join(', ') });
                  const smoke = await runGlbSmokeTest(endpoint, expectedApiPaths);
                  if (!smoke.ok) {
                    log.error(`[gpu] ${smoke.error}`);
                    setDeployState({
                      status: 'error',
                      step: 'api_smoke_error',
                      message: smoke.error,
                      stepDetail: expectedApiPaths.join(', '),
                    });
                    return {
                      result: 'app_error',
                      pullTimeS: actualPullTimeS,
                      appError: { message: smoke.error },
                    };
                  }
                }
                log.log(`[gpu] Generic GPU app health ready — ${appLabel}. Skipping speech pipeline warmup checks.`);
                setDeployState({
                  step: 'ready',
                  stepDetail,
                  message: `GPU app ready: ${appLabel}`,
                });
                await autoRegisterDockerProviderAsync(endpoint);
                return { result: 'ready', pullTimeS: actualPullTimeS };
              }

              const svc = asRecord(asRecord(data)?.services) ?? {};
              const ttsStatus = serviceStatus(svc, 'tts');
              const sttStatus = serviceStatus(svc, 'whisper', 'stt');
              const llmStatus = serviceStatus(svc, 'llama_cpp', 'llm');
              const ttsReady = ttsStatus === 'loaded' || ttsStatus === 'disabled';
              const sttReady = sttStatus === 'loaded' || sttStatus === 'ready';
              const llmReady = llmStatus === 'ready' || llmStatus === 'loaded';
              allServicesLoaded = sttReady && llmReady && ttsReady;
              const readyStages = [sttReady && 'STT', llmReady && 'LLM', ttsReady && 'TTS'].filter(Boolean);
              const loadingStages = [!sttReady && 'STT', !llmReady && 'LLM', !ttsReady && 'TTS'].filter(Boolean);

              // ── Update warming status tracking ──
              const warmingPatch: Partial<typeof deployState> = {};
              const warmPhase = allServicesLoaded ? 'complete' : (sttReady ? (llmReady ? 'tts' : 'llm') : 'stt');
              warmingPatch.warmingStatus = {
                phase: warmPhase,
                sttProgress: { loaded: sttReady, modelName: sttStatus || 'whisper', loadTimeMs: sttReady ? (containerStartedAt ? Date.now() - containerStartedAt : 0) : 0 },
                llmProgress: { loaded: llmReady, modelName: llmStatus || 'llm', loadTimeMs: llmReady ? (containerStartedAt ? Date.now() - containerStartedAt : 0) : 0 },
                ttsProgress: { loaded: ttsReady, modelName: ttsStatus || 'tts', loadTimeMs: ttsReady ? (containerStartedAt ? Date.now() - containerStartedAt : 0) : 0 },
                startedAt: containerStartedAt || Date.now(),
                ...(allServicesLoaded ? { completedAt: Date.now() } : {}),
              };

              if (readyStages.length > 0 || containerStartedAt) {
                const stepDetail = loadingStages.length > 0
                  ? `${readyStages.join(', ') || 'none'} ready — loading: ${loadingStages.join(', ')}`
                  : 'all services loaded';
                log.log(`[gpu] Pod health OK — ${readyStages.length}/3 services loaded (${readyStages.join(', ') || 'none'}). Loading: ${loadingStages.join(', ') || 'none'}`);
                broadcastWs({ type: 'gpu:services', loaded: readyStages, loading: loadingStages });

                // Set warming status while models are loading
                if (!allServicesLoaded) {
                  setDeployState({
                    status: 'warming',
                    step: `warming_${warmPhase}`,
                    message: `Warming ${warmPhase.toUpperCase()} model... (${readyStages.join(', ') || 'none'} ready)`,
                    stepDetail,
                    ...warmingPatch,
                  });
                }

                // Only run inference test when at least STT is loaded (minimum for speech pipeline)
                if (!sttReady && !llmReady) {
                  log.log(`[gpu] Skipping inference test — need STT or LLM ready first (${readyStages.join(', ') || 'none'} ready)`);
                  continue;
                }

              const apiContract = await validateEndpointApiContract(endpoint, expectedApiPaths, expectedCapabilities, requireDockerManifest);
              if (!apiContract.ok) {
                log.error(`[gpu] ${apiContract.error}`);
                setDeployState({
                  status: 'error',
                  step: 'api_contract_error',
                  message: apiContract.error,
                  stepDetail: expectedApiPaths.join(', '),
                });
                broadcastWs({
                  type: 'gpu:deploy',
                  phase: 'api_contract_error',
                  deployId: deployState.deployId,
                  provider: providerName,
                  error: apiContract.error,
                });
                return {
                  result: 'app_error',
                  pullTimeS: actualPullTimeS,
                  appError: { message: apiContract.error },
                };
              }
              if (runSmokeTests && shouldRunGlbSmokeTest(expectedApiPaths, expectedCapabilities)) {
                setDeployState({ step: 'testing_api', message: 'Running GLB smoke test...', stepDetail: expectedApiPaths.join(', ') });
                const smoke = await runGlbSmokeTest(endpoint, expectedApiPaths);
                if (!smoke.ok) {
                  log.error(`[gpu] ${smoke.error}`);
                  setDeployState({
                    status: 'error',
                    step: 'api_smoke_error',
                    message: smoke.error,
                    stepDetail: expectedApiPaths.join(', '),
                  });
                  return {
                    result: 'app_error',
                    pullTimeS: actualPullTimeS,
                    appError: { message: smoke.error },
                  };
                }
              }

              // ── Inference test: verify actual AI pipeline works before marking ready ──
              setDeployState({ step: 'testing_inference', message: 'Testing inference...' });
              log.log(`[gpu] Testing inference on ${endpoint}...`);
              let inferenceOk = false;
              let inferenceError = '';
              let passedStage = '';

              // Try STT first (works for most images including translation ones)
              try {
                const sttStart = Date.now();
                const sttRes = await fetch(`${endpoint}/v1/audio/transcriptions`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'multipart/form-data' },
                  body: createTestAudioForm(),
                  signal: AbortSignal.timeout(30_000),
                });
                const sttMs = Date.now() - sttStart;
                const sttBody = await sttRes.text();
                log.log(`[gpu] STT test: status=${sttRes.status}, body=${sttBody.slice(0, 200)}`);
                if (sttRes.ok) {
                  try {
                    const body = JSON.parse(sttBody);
                    // text can be "" (silence) — that's still a valid response
                    if (body && (typeof body.text === 'string' || body.transcription)) {
                      inferenceOk = true;
                      passedStage = 'STT';
                      log.log(`[gpu] Inference test PASSED (STT, text="${(body.text || '').slice(0, 30)}") in ${sttMs}ms`);
                    }
                  } catch { /* JSON parse failed — response not valid JSON */ }
                }
              } catch (err) {
                log.log(`[gpu] STT test failed: ${err instanceof Error ? err.message : err}`);
              }

              // If STT failed, try translation endpoint (babelcast-subtitle and similar)
              if (!inferenceOk) {
                try {
                  const transStart = Date.now();
                  const transRes = await fetch(`${endpoint}/v1/translate/text`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: 'Hello', source_lang: 'en', target_lang: 'pt' }),
                    signal: AbortSignal.timeout(30_000),
                  });
                  const transMs = Date.now() - transStart;
                  const transBody = await transRes.text();
                  log.log(`[gpu] Translation test: status=${transRes.status}, body=${transBody.slice(0, 200)}`);
                  if (transRes.ok && transBody.trim()) {
                    try {
                      const body = JSON.parse(transBody);
                      if (body && (body.text || body.translation || body.output)) {
                        inferenceOk = true;
                        passedStage = 'LLM(translate)';
                        log.log(`[gpu] Inference test PASSED (translation) in ${transMs}ms`);
                      }
                    } catch { /* JSON parse failed — translation response not valid JSON */ }
                  }
                } catch (err) {
                  log.log(`[gpu] Translation test failed: ${err instanceof Error ? err.message : err}`);
                }
              }

              // If translation failed, try chat completions
              if (!inferenceOk) {
                try {
                  const llmStart = Date.now();
                  const llmRes = await fetch(`${endpoint}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      messages: [{ role: 'user', content: 'Hi' }],
                      max_tokens: 10,
                    }),
                    signal: AbortSignal.timeout(30_000),
                  });
                  const llmMs = Date.now() - llmStart;
                  const responseBodyStr = await llmRes.text();
                  if (llmRes.ok && responseBodyStr.trim()) {
                    try {
                      const body = JSON.parse(responseBodyStr);
                      if (body && (body.choices?.length > 0 || body.output?.text || body.response)) {
                        inferenceOk = true;
                        passedStage = 'LLM';
                        log.log(`[gpu] Inference test PASSED (LLM) in ${llmMs}ms`);
                      }
                    } catch { /* JSON parse failed — LLM response not valid JSON */ }
                  }
                } catch (err) {
                  log.log(`[gpu] LLM test failed: ${err instanceof Error ? err.message : err}`);
                }
              }

              // If neither STT nor LLM worked, try TTS
              if (!inferenceOk) {
                try {
                  const ttsStart = Date.now();
                  const ttsRes = await fetch(`${endpoint}/v1/audio/speech`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ input: 'test', voice: 'default' }),
                    signal: AbortSignal.timeout(30_000),
                  });
                  const ttsMs = Date.now() - ttsStart;
                  if (ttsRes.ok) {
                    const buf = await ttsRes.arrayBuffer();
                    if (buf.byteLength > 100) {
                      inferenceOk = true;
                      passedStage = 'TTS';
                      log.log(`[gpu] Inference test PASSED (TTS) in ${ttsMs}ms`);
                    }
                  }
                } catch (err) {
                  log.log(`[gpu] TTS test failed: ${err instanceof Error ? err.message : err}`);
                }
              }

              if (!inferenceOk) {
                // Health says services are loaded but inference test failed — this could mean
                // the image uses a non-standard API format (e.g., translation-only image).
                // Mark ready anyway but log a warning and note it in the step detail.
                inferenceError = 'Inference test inconclusive (STT/LLM/TTS failed) — health says services ready';
                log.warn(`[gpu] Inference test inconclusive: ${inferenceError}`);
                setDeployState({
                  step: 'ready',
                  stepDetail: `inference_inconclusive:${passedStage || 'none'}`,
                });
                // Auto-register as AI provider even if inference test was inconclusive
                await autoRegisterDockerProviderAsync(endpoint);
                return { result: 'ready', pullTimeS: actualPullTimeS };
              }

              setDeployState({ step: 'ready', stepDetail });
              // Auto-register GPU as AI provider in the registry
              await autoRegisterDockerProviderAsync(endpoint);
              return { result: 'ready', pullTimeS: actualPullTimeS };
            }

            if (!containerStartedAt) {
              containerStartedAt = Date.now();
              if (pullStartedAt > 0) actualPullTimeS = Math.round((containerStartedAt - pullStartedAt) / 1000);
            }
            const appElapsed = Math.round((Date.now() - containerStartedAt) / 1000);

            const whisperStatus = sttStatus;
            const llamaStatus = llmStatus;
            let modelStep = 'downloading_models';
            let modelDetail = '';

            if (whisperStatus === 'downloading') {
              modelStep = 'loading_stt';
              modelDetail = 'Downloading Whisper STT model...';
            } else if (whisperStatus === 'loading') {
              modelStep = 'loading_stt';
              modelDetail = 'Loading Whisper into memory...';
            } else if (llamaStatus === 'downloading') {
              modelStep = 'loading_llm';
              modelDetail = 'Downloading LLM model...';
            } else if (llamaStatus === 'loading' || llamaStatus === 'starting') {
              modelStep = 'loading_llm';
              modelDetail = 'Loading LLM into GPU VRAM...';
            } else if (ttsStatus === 'downloading') {
              modelStep = 'loading_tts';
              modelDetail = 'Downloading TTS model...';
            } else if (ttsStatus === 'loading' || ttsStatus === 'compiling') {
              modelStep = 'compiling_tts';
              modelDetail = 'Compiling TTS CUDA graphs...';
            } else {
              modelDetail = `Services: ${Object.entries(svc).map(([k, v]) => `${k}=${v}`).join(', ')}`;
            }

            setDeployState({
              status: 'booting', step: modelStep,
              message: `${modelDetail} [${elapsed}s, up ${appElapsed}s]`,
              stepDetail: `${Object.entries(svc).map(([k, v]) => `${k}=${v}`).join(', ')}`,
            });
            broadcastWs({ type: 'gpu:services', step: modelStep, services: svc });
          }
        }
      } catch (fetchErr) {
        httpStatus = 0;
        connectionRefused = true;
        consecutiveConnectionRefused++;
        if (consecutiveConnectionRefused === 1 || consecutiveConnectionRefused % 5 === 0) {
          const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          log.debug(`[gpu] Health probe ${endpoint}${healthPath} TCP fail #${consecutiveConnectionRefused}: ${msg}`);
        }
        // Proactive alert: connection refused for extended period
        if (consecutiveConnectionRefused === 10) {
          setDeployState({ alert: `Health endpoint unreachable for ${consecutiveConnectionRefused} checks — container may still be starting`, alertLevel: 'warning' });
        } else if (consecutiveConnectionRefused === 20) {
          setDeployState({ alert: `Health endpoint unreachable for ${consecutiveConnectionRefused} checks — possible networking issue or slow start`, alertLevel: 'error' });
        }
      }
      void connectionRefused;

      // Track non-transient HTTP errors
      if (httpStatus >= 400 && httpStatus < 500) {
        consecutiveNonTransient++;
        if (!firstNonTransientErrorAt) firstNonTransientErrorAt = Date.now();
        const nonTransientDurationMs = Date.now() - firstNonTransientErrorAt;
        if (nonTransientDurationMs > 3 * 60_000) {
          log.error(`[gpu] Pod ${podId} returning HTTP ${httpStatus} for ${Math.round(nonTransientDurationMs / 1000)}s — container likely failed to start`);
          try {
            const podStatus = await providerClient.getInstanceStatus(podId, credentials);
            log.error(`[gpu] Pod ${podId} provider status: ${podStatus}`);
          } catch (statusErr) {
            log.warn(`[gpu] Failed to get ${providerName} pod ${podId} status during crash detection: ${statusErr instanceof Error ? statusErr.message : statusErr}`);
          }
          setDeployState({ status: 'error', message: `Container returning HTTP ${httpStatus} for ${Math.round(nonTransientDurationMs / 60_000)}+ min — app failed to start (check image logs)` });
          return { result: 'crashed', pullTimeS: actualPullTimeS };
        }
      } else {
        consecutiveNonTransient = 0;
        firstNonTransientErrorAt = 0;
      }

      // Track consecutive health failures while container is running
      if (containerStartedAt) {
        consecutiveHealthFailures++;
      } else {
        consecutiveHealthFailures = 0;
      }

      // After 10 consecutive failures with container "running", verify pod status
      if (consecutiveHealthFailures >= 10 && containerStartedAt) {
        try {
          const podStatus = await providerClient.getInstanceStatus(podId, credentials);
          const statusLower = podStatus?.toLowerCase() || '';
          const CRASHED_STATES = new Set(['exited', 'terminated', 'error', 'failed', 'destroyed', 'deleted', 'stopped']);
          if (CRASHED_STATES.has(statusLower)) {
            const uptime = Math.round((Date.now() - containerStartedAt) / 1000);
            log.error(`[gpu] ${providerName} pod ${podId} crashed: status=${podStatus} after ${consecutiveHealthFailures} health failures (container was up ${uptime}s, endpoint=${endpoint})`);
            setDeployState({ status: 'error', message: `Pod crashed (status: ${podStatus}) after ${uptime}s — check GPU logs for details` });
            return { result: 'crashed', pullTimeS: actualPullTimeS };
          }
          if (consecutiveHealthFailures % 10 === 0) {
            log.warn(`[gpu] Pod ${podId} status=${podStatus} but ${consecutiveHealthFailures} consecutive health failures (container up ${Math.round((Date.now() - containerStartedAt) / 1000)}s)`);
          }
        } catch (err) {
          log.warn(`[gpu] Failed to check pod status for crash detection: ${err}`);
        }
      }
    }

    // Adaptive polling (cold-start plan A4).
    //
    // Modal's <2s cold-start works partly because its health probe
    // interval is sub-second during boot. We can't match that without
    // hammering the providers, but tightening to 2s during active
    // boot/model-load is a safe win: the pod's /health is a cheap
    // static read, and detecting "ready" 6-8s earlier saves the user
    // a request-queued moment.
    //
    //   Phase                                            poll
    //   ─────────────────────────────────────────────   ─────
    //   pre-container (long image pull, no /health yet)   8s
    //   container just started (< 60s)                    2s
    //   /health responding but services loading           2s
    //   all services loaded (about to return 'ready')    30s
    //
    // The "all services loaded" branch rarely fires because the main
    // loop exits in the same iteration — it exists only so we don't
    // busy-wait in the unlikely case the inference test loops back.
    let pollMs: number;
    if (healthRespondedOnce && allServicesLoaded) {
      pollMs = 30_000;
    } else if (healthRespondedOnce) {
      pollMs = 2_000;
    } else if (containerStartedAt && (Date.now() - containerStartedAt) < 60_000) {
      pollMs = 2_000;
    } else {
      pollMs = 8_000;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

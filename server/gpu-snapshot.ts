// ── GPU Snapshot — CRIU/cuda-checkpoint capture + restore (Phase B) ─────────
// Wires automatic snapshot capture after first-ready, and snapshot restore on
// cold boot. Works ONLY on providers where the pod can get CAP_SYS_ADMIN +
// CAP_CHECKPOINT_RESTORE + NVIDIA driver 570+ — today that is:
//
//   - vast-vm (Vast.ai KVM mode)
//   - hyperstack
//
// RunPod containers, Vast.ai containers, and TensorDock default drivers
// cannot participate. Callers never have to check this — `captureSnapshot`
// and `maybeRestoreSnapshot` silently no-op when the preconditions fail.
//
// Storage: S3-compatible bucket (defaults to Cloudflare R2). Snapshot
// catalog is persisted to `~/.babelcast/snapshot-catalog.json`.
//
// Security: every SSH command is built from whitelisted, validated inputs
// (alpha-num + `-_./:=`) and passed as a single literal string to `ssh`;
// user-controlled data never interpolates directly into a shell string.

import { createLogger } from '../src/logger';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, writeFile, readFile, rename, access } from 'fs/promises';
import { createHash } from 'crypto';
import type { ObjectStore } from '../src/storage/types';
import { createR2Store } from '../src/storage/r2-store';
import { createS3Store } from '../src/storage/s3-store';
import { onGatewayEvent } from './event-bus';
import { deployState } from './state';

const log = createLogger('gpu-snapshot');

// ── Catalog ─────────────────────────────────────────────────────────────────
export interface SnapshotCatalogEntry {
  /** Hash of (imageRef + imageDigest if known). */
  imageHash: string;
  /** Hash of the concatenation of model identifiers used by the app. */
  modelHash: string;
  /** Provider that produced the snapshot. Only snapshot-capable providers. */
  provider: 'vast-vm' | 'hyperstack';
  /** Major NVIDIA driver version the snapshot was captured with. */
  driverMajor: number;
  /** Key in the snapshot object store (R2). */
  r2Key: string;
  /** Bucket URL hint for diagnostics. */
  bucket?: string;
  /** When the snapshot was captured (epoch ms). */
  createdAt: number;
  /** Size in bytes of the tar.zst snapshot. */
  sizeBytes: number;
  /** DeployId that produced the snapshot (audit only). */
  sourceDeployId?: string;
}

const BABELCAST_DIR = join(homedir(), '.babelcast');
const CATALOG_PATH = join(BABELCAST_DIR, 'snapshot-catalog.json');

/** Maximum acceptable age of a snapshot before we treat it as stale (ADR-005). */
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ── Metrics (lightweight — Prometheus counters exposed separately) ──────────
interface SnapshotMetrics {
  captureOk: number;
  captureFail: number;
  restoreOk: number;
  restoreFail: number;
  restoreSkipped: number;
  coldFallback: number;
  lastRestoreDurationMs: number;
  autoDisableCount: number;
}

const metrics: SnapshotMetrics = {
  captureOk: 0,
  captureFail: 0,
  restoreOk: 0,
  restoreFail: 0,
  restoreSkipped: 0,
  coldFallback: 0,
  lastRestoreDurationMs: 0,
  autoDisableCount: 0,
};

export function getSnapshotMetrics(): Readonly<SnapshotMetrics> {
  return { ...metrics };
}

// ── R2/S3 helpers ───────────────────────────────────────────────────────────

/** Singleton snapshot bucket client. Returns null if config not provided. */
let _store: ObjectStore | null | undefined;
function getSnapshotStore(): ObjectStore | null {
  if (_store !== undefined) return _store;
  const bucket = process.env.R2_SNAPSHOTS_BUCKET;
  if (!bucket) {
    _store = null;
    return null;
  }
  const endpoint = process.env.R2_SNAPSHOTS_ENDPOINT;
  const accessKey = process.env.R2_SNAPSHOTS_ACCESS_KEY;
  const secretKey = process.env.R2_SNAPSHOTS_SECRET_KEY;
  if (!accessKey || !secretKey) {
    log.warn(`[snapshot] R2_SNAPSHOTS_BUCKET set but R2_SNAPSHOTS_ACCESS_KEY/SECRET_KEY missing — disabling`);
    _store = null;
    return null;
  }
  // Prefer R2 when endpoint matches *.r2.cloudflarestorage.com; fall back to
  // generic S3 for MinIO or custom endpoints.
  if (!endpoint || /r2\.cloudflarestorage\.com$/i.test(endpoint)) {
    const accountId = endpoint
      ? (endpoint.match(/^https?:\/\/([^.]+)\./)?.[1] ?? '')
      : (process.env.R2_ACCOUNT_ID ?? '');
    _store = createR2Store({ bucket, accountId, accessKeyId: accessKey, secretAccessKey: secretKey, endpoint });
  } else {
    _store = createS3Store({ bucket, endpoint, accessKeyId: accessKey, secretAccessKey: secretKey, region: process.env.R2_SNAPSHOTS_REGION ?? 'auto' });
  }
  log.log(`[snapshot] Bucket configured: ${bucket}${endpoint ? ` @ ${endpoint}` : ''}`);
  return _store;
}

/** Exposed for tests — reset the cached client. */
export function _resetSnapshotStoreForTests(): void {
  _store = undefined;
}

/** Inject a custom store (tests). */
export function _setSnapshotStoreForTests(store: ObjectStore | null): void {
  _store = store;
}

// ── Catalog I/O ─────────────────────────────────────────────────────────────

let _catalogCache: SnapshotCatalogEntry[] | null = null;

export async function loadSnapshotCatalog(forceReload = false): Promise<SnapshotCatalogEntry[]> {
  if (_catalogCache && !forceReload) return _catalogCache;
  try {
    await access(CATALOG_PATH);
  } catch {
    _catalogCache = [];
    return _catalogCache;
  }
  try {
    const raw = await readFile(CATALOG_PATH, 'utf8');
    const data = JSON.parse(raw) as SnapshotCatalogEntry[];
    _catalogCache = Array.isArray(data) ? data : [];
    return _catalogCache;
  } catch (err) {
    log.warn(`[snapshot] Failed to parse catalog: ${err instanceof Error ? err.message : err}`);
    _catalogCache = [];
    return _catalogCache;
  }
}

let _catalogSaveTimer: ReturnType<typeof setTimeout> | null = null;

async function saveCatalog(entries: SnapshotCatalogEntry[]): Promise<void> {
  await mkdir(BABELCAST_DIR, { recursive: true });
  const tmp = `${CATALOG_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(entries, null, 2));
  await rename(tmp, CATALOG_PATH);
}

export async function appendCatalogEntry(entry: SnapshotCatalogEntry): Promise<void> {
  const list = await loadSnapshotCatalog(true);
  // De-dupe on matching key — newer entries replace older.
  const filtered = list.filter(
    (e) =>
      !(
        e.imageHash === entry.imageHash &&
        e.modelHash === entry.modelHash &&
        e.provider === entry.provider &&
        e.driverMajor === entry.driverMajor
      ),
  );
  filtered.unshift(entry);
  // Retain last 200 entries (catalog is small but shouldn't grow unbounded).
  const trimmed = filtered.slice(0, 200);
  _catalogCache = trimmed;
  if (_catalogSaveTimer) clearTimeout(_catalogSaveTimer);
  _catalogSaveTimer = setTimeout(() => {
    _catalogSaveTimer = null;
    saveCatalog(trimmed).catch((err) =>
      log.warn(`[snapshot] catalog save failed: ${err instanceof Error ? err.message : err}`),
    );
  }, 500);
}

/** Force a synchronous-ish flush; for tests. */
export async function _flushCatalogForTests(): Promise<void> {
  if (_catalogSaveTimer) {
    clearTimeout(_catalogSaveTimer);
    _catalogSaveTimer = null;
  }
  if (_catalogCache) await saveCatalog(_catalogCache);
}

// ── Hashing helpers ─────────────────────────────────────────────────────────

export function hashImage(ref: string, digest?: string): string {
  return createHash('sha256').update(`${ref}|${digest ?? ''}`).digest('hex').slice(0, 16);
}

export function hashModels(models: readonly string[]): string {
  const joined = [...models].sort().join('|');
  return createHash('sha256').update(joined).digest('hex').slice(0, 16);
}

export function matchSnapshot(
  catalog: SnapshotCatalogEntry[],
  key: { imageHash: string; modelHash: string; provider: string; driverMajor: number },
  now = Date.now(),
): SnapshotCatalogEntry | null {
  return (
    catalog.find(
      (e) =>
        e.imageHash === key.imageHash &&
        e.modelHash === key.modelHash &&
        e.provider === key.provider &&
        e.driverMajor >= key.driverMajor &&
        now - e.createdAt < SNAPSHOT_MAX_AGE_MS,
    ) ?? null
  );
}

// ── Input sanitization ──────────────────────────────────────────────────────

/** Allow only safe characters in values interpolated into shell commands. */
const SAFE_RE = /^[A-Za-z0-9_.:/=@+-]+$/;

export function assertSafe(value: string, field: string): string {
  if (!SAFE_RE.test(value)) {
    throw new Error(`[snapshot] Unsafe value for ${field}: ${value}`);
  }
  return value;
}

// ── SSH helpers ─────────────────────────────────────────────────────────────

export interface SshTarget {
  host: string;
  port: number;
  user?: string;
  /** Optional private key path (defaults to system ~/.ssh/id_rsa). */
  keyPath?: string;
}

/**
 * Run an SSH command and return { code, stdout, stderr }. NEVER passes
 * user-controlled data through shell interpolation. `cmd` is a literal
 * string — callers are responsible for validating every interpolated piece
 * with `assertSafe()` before constructing it.
 */
export async function sshExec(
  tgt: SshTarget,
  cmd: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  assertSafe(tgt.host, 'host');
  if (!Number.isFinite(tgt.port) || tgt.port <= 0 || tgt.port > 65535) {
    throw new Error(`[snapshot] Invalid port: ${tgt.port}`);
  }
  const user = tgt.user ?? 'root';
  assertSafe(user, 'user');
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes',
    '-p', String(tgt.port),
  ];
  if (tgt.keyPath) args.push('-i', tgt.keyPath);
  args.push(`${user}@${tgt.host}`, cmd);
  return new Promise((resolve) => {
    const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    }, timeoutMs);
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
  });
}

// ── Pre-check: driver major + caps ──────────────────────────────────────────

export interface PreCheckResult {
  ok: boolean;
  reason?: string;
  driverMajor?: number;
}

export async function snapshotPreCheck(
  tgt: SshTarget,
  provider: string,
): Promise<PreCheckResult> {
  if (provider !== 'vast-vm' && provider !== 'hyperstack') {
    return { ok: false, reason: `provider ${provider} not snapshot-eligible` };
  }
  // nvidia-smi query — whitelisted, no interpolation.
  const driver = await sshExec(tgt, 'nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1', { timeoutMs: 15_000 });
  if (driver.code !== 0) {
    return { ok: false, reason: `nvidia-smi failed: ${driver.stderr.slice(0, 200)}` };
  }
  const driverStr = driver.stdout.trim();
  const driverMajor = parseInt(driverStr.split('.')[0] ?? '0', 10);
  if (!Number.isFinite(driverMajor) || driverMajor < 570) {
    return { ok: false, reason: `driver ${driverStr} < 570`, driverMajor };
  }
  // Cap check — need either CAP_CHECKPOINT_RESTORE or CAP_SYS_ADMIN.
  const caps = await sshExec(tgt, 'capsh --has-p=CAP_CHECKPOINT_RESTORE || capsh --has-p=CAP_SYS_ADMIN', { timeoutMs: 10_000 });
  if (caps.code !== 0) {
    return { ok: false, reason: 'missing CAP_CHECKPOINT_RESTORE and CAP_SYS_ADMIN', driverMajor };
  }
  return { ok: true, driverMajor };
}

// ── Capture (B1) ────────────────────────────────────────────────────────────

export interface CaptureInput {
  deployId: string;
  provider: string;
  ssh: SshTarget;
  imageRef: string;
  imageDigest?: string;
  models: readonly string[];
  /** Main process PID inside the pod that should be dumped. */
  mainPid?: number;
}

export interface CaptureResult {
  captured: boolean;
  reason?: string;
  entry?: SnapshotCatalogEntry;
}

export async function captureSnapshot(input: CaptureInput): Promise<CaptureResult> {
  const precheck = await snapshotPreCheck(input.ssh, input.provider);
  if (!precheck.ok) {
    metrics.captureFail++;
    log.log(`[snapshot] capture skipped for ${input.deployId}: ${precheck.reason}`);
    return { captured: false, reason: precheck.reason };
  }
  const store = getSnapshotStore();
  if (!store) {
    metrics.captureFail++;
    return { captured: false, reason: 'no snapshot bucket configured' };
  }

  const imageHash = hashImage(input.imageRef, input.imageDigest);
  const modelHash = hashModels(input.models);
  const driverMajor = precheck.driverMajor!;
  const provider = input.provider as 'vast-vm' | 'hyperstack';
  const r2Key = `snapshots/${provider}/${imageHash}/${modelHash}-d${driverMajor}.tar.zst`;

  // Capture: criu dump --leave-running → tar --zstd → upload via `aws s3` CLI
  // if present, else use pipe to stdin of a presigned PUT. Here we keep it
  // simple: capture on the remote, then `scp` the tarball back to the
  // gateway host and upload from local. In production, a pre-baked uploader
  // would run inside the pod — for now this runs end-to-end through the
  // gateway.
  assertSafe(input.deployId, 'deployId');
  const pid = input.mainPid && Number.isFinite(input.mainPid) ? input.mainPid : 1;
  const dumpCmd =
    `set -e && sudo rm -rf /tmp/snapshot && sudo mkdir -p /tmp/snapshot ` +
    `&& sudo criu dump --tree ${pid} --images-dir /tmp/snapshot --leave-running ` +
    `--tcp-established --ext-unix-sk --file-locks 2>&1 | tail -50`;
  const dump = await sshExec(input.ssh, dumpCmd, { timeoutMs: 120_000 });
  if (dump.code !== 0) {
    metrics.captureFail++;
    log.warn(`[snapshot] criu dump failed: ${dump.stderr.slice(0, 300)}`);
    return { captured: false, reason: `criu dump rc=${dump.code}` };
  }

  const tarCmd = `sudo tar --zstd -cf /tmp/snapshot.tar.zst -C /tmp snapshot && sudo stat -c %s /tmp/snapshot.tar.zst`;
  const tar = await sshExec(input.ssh, tarCmd, { timeoutMs: 180_000 });
  if (tar.code !== 0) {
    metrics.captureFail++;
    return { captured: false, reason: `tar failed rc=${tar.code}` };
  }
  const sizeBytes = parseInt(tar.stdout.trim(), 10) || 0;

  // Read tarball back over SSH stdout (BatchMode + no tty). We use `cat` +
  // capture; for large files this is OK because snapshots are 500MB-2GB.
  const fetched = await sshExec(input.ssh, 'sudo cat /tmp/snapshot.tar.zst | base64 -w0', { timeoutMs: 300_000 });
  if (fetched.code !== 0 || !fetched.stdout) {
    metrics.captureFail++;
    return { captured: false, reason: `fetch failed rc=${fetched.code}` };
  }
  const payload = Buffer.from(fetched.stdout.trim(), 'base64');
  await store.put(r2Key, payload, { contentType: 'application/zstd' });

  // Best-effort cleanup — don't fail capture if this doesn't work.
  sshExec(input.ssh, 'sudo rm -rf /tmp/snapshot /tmp/snapshot.tar.zst', { timeoutMs: 15_000 }).catch(() => {});

  const entry: SnapshotCatalogEntry = {
    imageHash,
    modelHash,
    provider,
    driverMajor,
    r2Key,
    bucket: process.env.R2_SNAPSHOTS_BUCKET,
    createdAt: Date.now(),
    sizeBytes,
    sourceDeployId: input.deployId,
  };
  await appendCatalogEntry(entry);
  metrics.captureOk++;
  log.log(
    `[snapshot] captured ${r2Key} (${Math.round(sizeBytes / 1024 / 1024)}MB) in ${input.deployId}`,
  );
  return { captured: true, entry };
}

// ── Restore (B2) ────────────────────────────────────────────────────────────

export interface RestoreInput {
  provider: string;
  ssh: SshTarget;
  imageRef: string;
  imageDigest?: string;
  models: readonly string[];
}

export interface RestoreResult {
  restored: boolean;
  reason?: string;
  durationMs?: number;
  entry?: SnapshotCatalogEntry;
}

export async function maybeRestoreSnapshot(input: RestoreInput): Promise<RestoreResult> {
  if (input.provider !== 'vast-vm' && input.provider !== 'hyperstack') {
    metrics.restoreSkipped++;
    return { restored: false, reason: 'provider not snapshot-eligible' };
  }
  const store = getSnapshotStore();
  if (!store) {
    metrics.restoreSkipped++;
    return { restored: false, reason: 'no snapshot bucket configured' };
  }
  const catalog = await loadSnapshotCatalog();
  const imageHash = hashImage(input.imageRef, input.imageDigest);
  const modelHash = hashModels(input.models);
  const match = matchSnapshot(catalog, {
    imageHash,
    modelHash,
    provider: input.provider,
    driverMajor: 570,
  });
  if (!match) {
    metrics.restoreSkipped++;
    return { restored: false, reason: 'no matching snapshot' };
  }

  const start = Date.now();
  try {
    // Download tarball on the gateway side; pipe into pod via SSH stdin.
    const tarball = await store.get(match.r2Key);
    const b64 = Buffer.from(tarball).toString('base64');
    const prep =
      `set -e && sudo rm -rf /tmp/snapshot /tmp/snapshot.tar.zst ` +
      `&& sudo mkdir -p /tmp/snapshot_in && printf %s ${shellQuote(b64)} | base64 -d > /tmp/snapshot.tar.zst ` +
      `&& sudo tar --zstd -xf /tmp/snapshot.tar.zst -C /tmp && sudo criu restore --images-dir /tmp/snapshot ` +
      `--tcp-established --ext-unix-sk --file-locks -d 2>&1 | tail -50`;
    const restore = await sshExec(input.ssh, prep, { timeoutMs: 180_000 });
    if (restore.code !== 0) {
      metrics.restoreFail++;
      metrics.coldFallback++;
      // ADR-005: consistent failure should trigger auto-disable (tracked via counter).
      metrics.autoDisableCount++;
      return { restored: false, reason: `criu restore rc=${restore.code}: ${restore.stderr.slice(0, 200)}` };
    }
    const durationMs = Date.now() - start;
    metrics.restoreOk++;
    metrics.lastRestoreDurationMs = durationMs;
    return { restored: true, durationMs, entry: match };
  } catch (err) {
    metrics.restoreFail++;
    metrics.coldFallback++;
    return { restored: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── Hook into deploy lifecycle ──────────────────────────────────────────────

let _hookInstalled = false;

/**
 * Install a listener on the event bus that fires `captureSnapshot` after
 * `gpu.deployed`. Idempotent. Called once at server startup.
 */
export function installSnapshotHook(): void {
  if (_hookInstalled) return;
  _hookInstalled = true;
  onGatewayEvent((event, data) => {
    if (event !== 'gpu.deployed') return;
    const provider = String(data.provider ?? '');
    if (provider !== 'vast-vm' && provider !== 'hyperstack') return;

    // Pull fields from deployState to avoid requiring the handler to
    // thread them through. The state has been set ready by the time this
    // event fires.
    const deployId = String(data.deployId ?? deployState.deployId);
    const imageRef = String(deployState.dockerImage || '');
    if (!deployState.sshHost || !deployState.sshPort) {
      log.log(`[snapshot] ${deployId}: no SSH target, skipping capture`);
      return;
    }
    const ssh: SshTarget = { host: deployState.sshHost, port: deployState.sshPort };
    // Fire-and-forget; capture is best-effort and must not block callers.
    captureSnapshot({
      deployId,
      provider,
      ssh,
      imageRef,
      models: modelsFromDeployState(),
    }).catch((err) => log.warn(`[snapshot] capture threw: ${err instanceof Error ? err.message : err}`));
  });
  log.log('[snapshot] event-bus hook installed — will capture on gpu.deployed');
}

function modelsFromDeployState(): readonly string[] {
  // Best-effort: pull service model names from the warming status. Defaults
  // to an empty list (produces a deterministic modelHash).
  const ws = deployState.warmingStatus;
  const names: string[] = [];
  if (ws?.sttProgress?.modelName) names.push(String(ws.sttProgress.modelName));
  if (ws?.llmProgress?.modelName) names.push(String(ws.llmProgress.modelName));
  if (ws?.ttsProgress?.modelName) names.push(String(ws.ttsProgress.modelName));
  return names;
}

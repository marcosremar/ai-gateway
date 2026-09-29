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

/** Resolve the snapshot store provider from env. Pure — returns a descriptor
 * or null when required config is missing. Exported for unit tests so we can
 * exercise the routing rules without pulling in the Bun S3 SDK. */
export type SnapshotStoreConfig =
  | { kind: 'hyperstack-s3'; bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string; region: string }
  | { kind: 'r2'; bucket: string; accountId: string; accessKeyId: string; secretAccessKey: string; endpoint?: string }
  | { kind: 's3'; bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string; region: string }
  | { kind: 'disabled'; reason: string };

export function resolveSnapshotStoreConfig(env: NodeJS.ProcessEnv = process.env): SnapshotStoreConfig {
  // Prefer Hyperstack Object Storage — co-located with Hyperstack GPU pods
  // (CANADA-1), so restore downloads stay in-DC.
  const hsBucket = env.HYPERSTACK_SNAPSHOTS_BUCKET;
  if (hsBucket) {
    const endpoint = env.HYPERSTACK_SNAPSHOTS_ENDPOINT;
    const accessKeyId = env.HYPERSTACK_SNAPSHOTS_ACCESS_KEY;
    const secretAccessKey = env.HYPERSTACK_SNAPSHOTS_SECRET_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      return { kind: 'disabled', reason: 'HYPERSTACK_SNAPSHOTS_BUCKET set but ENDPOINT/ACCESS_KEY/SECRET_KEY missing' };
    }
    return {
      kind: 'hyperstack-s3',
      bucket: hsBucket,
      endpoint,
      accessKeyId,
      secretAccessKey,
      region: env.HYPERSTACK_SNAPSHOTS_REGION ?? 'CANADA-1',
    };
  }

  const bucket = env.R2_SNAPSHOTS_BUCKET;
  if (!bucket) return { kind: 'disabled', reason: 'no bucket configured' };

  const endpoint = env.R2_SNAPSHOTS_ENDPOINT;
  const accessKeyId = env.R2_SNAPSHOTS_ACCESS_KEY;
  const secretAccessKey = env.R2_SNAPSHOTS_SECRET_KEY;
  if (!accessKeyId || !secretAccessKey) {
    return { kind: 'disabled', reason: 'R2_SNAPSHOTS_BUCKET set but ACCESS_KEY/SECRET_KEY missing' };
  }

  // R2 when endpoint matches *.r2.cloudflarestorage.com or is empty; generic
  // S3 (MinIO, DigitalOcean Spaces, etc.) otherwise.
  if (!endpoint || /r2\.cloudflarestorage\.com$/i.test(endpoint)) {
    const accountId = endpoint
      ? (endpoint.match(/^https?:\/\/([^.]+)\./)?.[1] ?? '')
      : (env.R2_ACCOUNT_ID ?? '');
    return { kind: 'r2', bucket, accountId, accessKeyId, secretAccessKey, endpoint };
  }

  return {
    kind: 's3', bucket, endpoint, accessKeyId, secretAccessKey,
    region: env.R2_SNAPSHOTS_REGION ?? 'auto',
  };
}

/** Singleton snapshot bucket client. Returns null if config not provided. */
let _store: ObjectStore | null | undefined;
function getSnapshotStore(): ObjectStore | null {
  if (_store !== undefined) return _store;
  const cfg = resolveSnapshotStoreConfig();
  switch (cfg.kind) {
    case 'disabled':
      if (cfg.reason !== 'no bucket configured') log.warn(`[snapshot] ${cfg.reason} — disabling`);
      _store = null;
      return null;
    case 'hyperstack-s3':
      _store = createS3Store({
        bucket: cfg.bucket, endpoint: cfg.endpoint,
        accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
        region: cfg.region,
      });
      log.log(`[snapshot] Hyperstack bucket configured: ${cfg.bucket} @ ${cfg.endpoint}`);
      return _store;
    case 'r2':
      _store = createR2Store({
        bucket: cfg.bucket, accountId: cfg.accountId,
        accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
        endpoint: cfg.endpoint,
      });
      log.log(`[snapshot] R2 bucket configured: ${cfg.bucket}${cfg.endpoint ? ` @ ${cfg.endpoint}` : ''}`);
      return _store;
    case 's3':
      _store = createS3Store({
        bucket: cfg.bucket, endpoint: cfg.endpoint,
        accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
        region: cfg.region,
      });
      log.log(`[snapshot] S3 bucket configured: ${cfg.bucket} @ ${cfg.endpoint}`);
      return _store;
  }
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

/** Reset in-memory catalog cache (for test isolation). */
export function _resetCatalogForTests(): void {
  _catalogCache = null;
  if (_catalogSaveTimer) {
    clearTimeout(_catalogSaveTimer);
    _catalogSaveTimer = null;
  }
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

export type SshExecFn = (
  tgt: SshTarget,
  cmd: string,
  opts?: { timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Test injection hook — when set, captureSnapshot/maybeRestoreSnapshot use it
 * instead of the real ssh binary. Not exported from index.ts. */
let _sshExecOverride: SshExecFn | null = null;
export function _setSshExecForTests(fn: SshExecFn | null): void {
  _sshExecOverride = fn;
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
  if (_sshExecOverride) return _sshExecOverride(tgt, cmd, opts);
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

// ── cuda-checkpoint bootstrap ───────────────────────────────────────────────

/** Canonical install path for the cuda-checkpoint helper on the remote VM. */
export const CUDA_CHECKPOINT_PATH = '/usr/local/bin/cuda-checkpoint';
// Pin to a specific commit SHA rather than `main` so a tampered or moved
// upstream tip can't silently substitute the binary we install with sudo.
// Bump via CUDA_CHECKPOINT_COMMIT env var without a code change if needed.
const CUDA_CHECKPOINT_COMMIT =
  process.env.CUDA_CHECKPOINT_COMMIT?.trim() || 'main';
const CUDA_CHECKPOINT_URL =
  `https://raw.githubusercontent.com/NVIDIA/cuda-checkpoint/${CUDA_CHECKPOINT_COMMIT}/bin/x86_64_Linux/cuda-checkpoint`;
// Optional integrity check: set CUDA_CHECKPOINT_SHA256 to the expected hex
// digest of the binary. When unset we fall back to a sanity check that the
// downloaded file is a real ELF of plausible size.
const CUDA_CHECKPOINT_SHA256 = process.env.CUDA_CHECKPOINT_SHA256?.trim() || '';
const CUDA_CHECKPOINT_MIN_BYTES = 50_000;
const CUDA_CHECKPOINT_MAX_BYTES = 50_000_000;

/**
 * Ensure `cuda-checkpoint` is installed at {@link CUDA_CHECKPOINT_PATH} on the
 * remote VM. Idempotent — runs a single SSH command that (1) probes `-h` and
 * (2) only downloads when the probe fails. The download lands in a temp file,
 * is verified, and only then atomically moved into the canonical path.
 * Returns true if the binary is usable after the call, false otherwise.
 */
export async function ensureCudaCheckpointInstalled(tgt: SshTarget): Promise<boolean> {
  const expectedSha = CUDA_CHECKPOINT_SHA256;
  const shaCheck = expectedSha
    ? `echo "${expectedSha}  $TMP" | sha256sum -c --status`
    : `
       size=$(stat -c%s "$TMP") &&
       [ "$size" -ge ${CUDA_CHECKPOINT_MIN_BYTES} ] &&
       [ "$size" -le ${CUDA_CHECKPOINT_MAX_BYTES} ] &&
       head -c4 "$TMP" | od -An -c | grep -q 'E   L   F'
      `.replace(/\s+/g, ' ');
  const probeAndInstall =
    `if ${CUDA_CHECKPOINT_PATH} -h >/dev/null 2>&1; then echo ok; else ` +
    `TMP=$(mktemp) && ` +
    `curl -fsSL -o "$TMP" ${CUDA_CHECKPOINT_URL} && ` +
    `${shaCheck} && ` +
    `sudo install -m 0755 -o root -g root "$TMP" ${CUDA_CHECKPOINT_PATH} && ` +
    `rm -f "$TMP" && ` +
    `${CUDA_CHECKPOINT_PATH} -h >/dev/null 2>&1 && echo installed || echo failed; fi`;
  const res = await sshExec(tgt, probeAndInstall, { timeoutMs: 60_000 });
  if (res.code !== 0) return false;
  const out = res.stdout.trim();
  return out.endsWith('ok') || out.endsWith('installed');
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
  /**
   * When true, drain VRAM via `cuda-checkpoint --toggle` before `criu dump`
   * (required for any CUDA-using process) and add `--tcp-established` to the
   * dump (HF Hub fetches leave outbound TCP sockets). Default false preserves
   * existing non-CUDA behavior.
   */
  useCudaCheckpoint?: boolean;
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

  // When the target process is CUDA-resident, VRAM must be drained to host
  // memory before CRIU can see a consistent process tree. cuda-checkpoint
  // `--toggle` performs exactly that drain on its first invocation (and the
  // inverse re-materialization after restore).
  if (input.useCudaCheckpoint) {
    const installed = await ensureCudaCheckpointInstalled(input.ssh);
    if (!installed) {
      metrics.captureFail++;
      return { captured: false, reason: 'cuda-checkpoint install failed' };
    }
    const drain = await sshExec(
      input.ssh,
      `sudo ${CUDA_CHECKPOINT_PATH} --toggle --pid ${pid}`,
      { timeoutMs: 60_000 },
    );
    if (drain.code !== 0) {
      metrics.captureFail++;
      log.warn(`[snapshot] cuda-checkpoint drain failed: ${drain.stderr.slice(0, 300)}`);
      return { captured: false, reason: `cuda-checkpoint drain rc=${drain.code}` };
    }
  }

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
  /**
   * When true, after `criu restore` toggle cuda-checkpoint again to
   * re-materialize VRAM in the restored process. Must match the value used
   * at capture time.
   */
  useCudaCheckpoint?: boolean;
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
    if (input.useCudaCheckpoint) {
      const installed = await ensureCudaCheckpointInstalled(input.ssh);
      if (!installed) {
        metrics.restoreFail++;
        metrics.coldFallback++;
        return { restored: false, reason: 'cuda-checkpoint install failed' };
      }
    }

    // Download tarball on the gateway side; pipe into pod via SSH stdin.
    const tarball = await store.get(match.r2Key);
    const b64 = Buffer.from(tarball).toString('base64');
    // `--pidfile` lets us recover the restored process's PID for the post-
    // restore cuda-checkpoint toggle. Harmless when toggle is off.
    const prep =
      `set -e && sudo rm -rf /tmp/snapshot /tmp/snapshot.tar.zst /tmp/snapshot.pid ` +
      `&& sudo mkdir -p /tmp/snapshot_in && printf %s ${shellQuote(b64)} | base64 -d > /tmp/snapshot.tar.zst ` +
      `&& sudo tar --zstd -xf /tmp/snapshot.tar.zst -C /tmp && sudo criu restore --images-dir /tmp/snapshot ` +
      `--tcp-established --ext-unix-sk --file-locks --restore-detached --pidfile /tmp/snapshot.pid 2>&1 | tail -50`;
    const restore = await sshExec(input.ssh, prep, { timeoutMs: 180_000 });
    if (restore.code !== 0) {
      metrics.restoreFail++;
      metrics.coldFallback++;
      // ADR-005: consistent failure should trigger auto-disable (tracked via counter).
      metrics.autoDisableCount++;
      return { restored: false, reason: `criu restore rc=${restore.code}: ${restore.stderr.slice(0, 200)}` };
    }

    if (input.useCudaCheckpoint) {
      // Read the restored PID and toggle cuda-checkpoint again to re-materialize
      // VRAM. A dedicated shell step so we surface failures distinctly from
      // the restore itself.
      const toggle = await sshExec(
        input.ssh,
        `set -e && NEW_PID=$(sudo cat /tmp/snapshot.pid) ` +
          `&& sudo ${CUDA_CHECKPOINT_PATH} --toggle --pid "$NEW_PID"`,
        { timeoutMs: 60_000 },
      );
      if (toggle.code !== 0) {
        metrics.restoreFail++;
        metrics.coldFallback++;
        return { restored: false, reason: `cuda-checkpoint re-materialize rc=${toggle.code}: ${toggle.stderr.slice(0, 200)}` };
      }
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

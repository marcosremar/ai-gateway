// ── BabelCast Gateway — Deploy Diagnostics Persistence ──────────────────────
// Saves a structured JSON dump of every failed deploy attempt to
// ~/.babelcast/deploys/<id>.json so the operator can review past failures
// without needing the original GPU instance still running.
//
// Why a separate file per deploy instead of one big log: failures are rare
// but when they happen the diagnostic bundle is large (HF tracebacks,
// /var/log/app.log tails, ssh forensic dumps, /diag JSON). One-file-per-
// failure keeps reads cheap and trivially diff-able.

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { createLogger } from '../src/logger';

const log = createLogger('deploy-diagnostics');

const BABELCAST_DIR = join(homedir(), '.babelcast');
const DEPLOYS_DIR = join(BABELCAST_DIR, 'deploys');

/** Inputs the orchestrator gives us at the moment a deploy attempt fails. */
export interface DeployDiagnosticsInput {
  instanceId: string;
  provider: string;
  dockerImage?: string;
  sshHost?: string;
  sshPort?: number;
  endpoint: string;
  /** Result code returned by pollHealthUntilReady. */
  result: 'ready' | 'exited' | 'timeout' | 'cancelled' | 'crashed' | 'app_error';
  /** Structured app-reported error if /health returned status:'error'. */
  appError?: { message: string; traceback?: string };
  /** Plain-text dump from fetchGpuLogs (SSH-based forensic battery). */
  remoteLogs?: string;
  /** When the deploy attempt began (epoch ms). */
  startedAt: number;
}

/** Shape we serialize to disk — adds derived fields the input didn't have. */
export interface DeployDiagnosticsRecord extends DeployDiagnosticsInput {
  id: string;            // deterministic per-attempt ID (used as filename)
  savedAt: number;       // when this record was persisted
  durationMs: number;    // how long the failed deploy ran
  schemaVersion: 1;      // bump if we change the on-disk format
}

function ensureDir(): void {
  try {
    if (!existsSync(DEPLOYS_DIR)) mkdirSync(DEPLOYS_DIR, { recursive: true });
  } catch (e) {
    // Directory creation failures are non-fatal — we'll just lose this
    // bundle. The deploy itself should never be aborted by a logging
    // problem.
    log.warn(`mkdir ${DEPLOYS_DIR} failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Persist a single failed deploy attempt as JSON. Best-effort: never throws,
 * never blocks the orchestrator on disk problems. Returns the record ID
 * (filename without extension) so callers can reference it later.
 */
export async function persistDeployDiagnostics(
  input: DeployDiagnosticsInput,
): Promise<string> {
  ensureDir();
  // ID is `<isoTimestamp>-<instanceIdShort>` so directory listings sort
  // chronologically and the operator can spot which provider failed at
  // which time without opening every file.
  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const idShort = input.instanceId.slice(0, 12) || 'unknown';
  const id = `${isoStamp}_${input.provider}_${idShort}`;
  const record: DeployDiagnosticsRecord = {
    ...input,
    id,
    savedAt: Date.now(),
    durationMs: Date.now() - input.startedAt,
    schemaVersion: 1,
  };
  const path = join(DEPLOYS_DIR, `${id}.json`);
  try {
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');
    log.log(`Saved ${input.result} diagnostics → ${path}`);
  } catch (e) {
    log.warn(`writeFile ${path} failed: ${e instanceof Error ? e.message : e}`);
  }
  return id;
}

/** Lightweight summary returned by listDeployDiagnostics. */
export interface DeployDiagnosticsSummary {
  id: string;
  instanceId: string;
  provider: string;
  dockerImage?: string;
  result: string;
  appErrorMessage?: string;
  savedAt: number;
  durationMs: number;
}

/**
 * List all persisted deploy attempts (newest first), returning a small
 * summary per record. Used by the /v1/gpu/deploy-history endpoint.
 */
export function listDeployDiagnostics(limit = 100): DeployDiagnosticsSummary[] {
  ensureDir();
  let files: string[];
  try {
    files = readdirSync(DEPLOYS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  // Sort by mtime desc — file IDs already sort chronologically but mtime
  // is more accurate if a file is hand-edited.
  const withMtime = files.map((f) => {
    const full = join(DEPLOYS_DIR, f);
    let mtime = 0;
    try { mtime = statSync(full).mtimeMs; } catch { /* ignore */ }
    return { f, mtime };
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const out: DeployDiagnosticsSummary[] = [];
  for (const { f } of withMtime.slice(0, limit)) {
    try {
      const raw = readFileSync(join(DEPLOYS_DIR, f), 'utf-8');
      const r = JSON.parse(raw) as DeployDiagnosticsRecord;
      out.push({
        id: r.id,
        instanceId: r.instanceId,
        provider: r.provider,
        dockerImage: r.dockerImage,
        result: r.result,
        appErrorMessage: r.appError?.message,
        savedAt: r.savedAt,
        durationMs: r.durationMs,
      });
    } catch {
      // Corrupt file — skip silently. We could delete but the operator
      // may want to investigate manually.
    }
  }
  return out;
}

/** Return the full diagnostic record by ID, or null if not found. */
export function getDeployDiagnostics(id: string): DeployDiagnosticsRecord | null {
  // Defensive: only allow filenames we generated, no path traversal.
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) return null;
  const path = join(DEPLOYS_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as DeployDiagnosticsRecord;
  } catch {
    return null;
  }
}

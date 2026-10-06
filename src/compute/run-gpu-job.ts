/**
 * runGpuJob — rent → wait ready → run → (optional) destroy.
 *
 * Transport-agnostic: callers inject deploy / waitReady / exec / destroy.
 * Used by library consumers (e.g. motion-import) that should not shell out
 * to `ai-gateway gpu jobs run`.
 */

import type { InstanceSpec } from '../gpu-providers/types';

export type RunGpuJobDeps = {
  /** Deploy a GPU instance; return instanceId + how to reach it */
  deploy: (spec: InstanceSpec) => Promise<{ instanceId: string; endpoint?: string; provider: string }>;
  /** Poll until ready or throw */
  waitReady: (instanceId: string, opts: { timeoutMs: number }) => Promise<void>;
  /** Run remote command (SSH or HTTP). Return exit code. */
  exec: (instanceId: string, command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Terminate / destroy instance */
  destroy: (instanceId: string) => Promise<void>;
  logger?: { log: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
};

export type RunGpuJobInput = {
  spec: InstanceSpec;
  command: string;
  readyTimeoutMs?: number; // default 15min
  /** If true (default), destroy even when command fails. If false, leave instance for debug. */
  destroyOnFailure?: boolean;
  /** Always destroy on success (default true). */
  destroyOnSuccess?: boolean;
};

export type RunGpuJobResult = {
  instanceId: string;
  provider: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  destroyed: boolean;
  durationMs: number;
};

const DEFAULT_READY_TIMEOUT_MS = 15 * 60_000;

function shouldDestroyAfter(
  exitCode: number,
  destroyOnSuccess: boolean,
  destroyOnFailure: boolean,
): boolean {
  const success = exitCode === 0;
  return (success && destroyOnSuccess) || (!success && destroyOnFailure);
}

/**
 * Rent a GPU, wait until ready, run `command`, then destroy per flags.
 *
 * Uses try/finally so an instance is never left behind when destroy flags
 * require cleanup — including when `waitReady` throws.
 */
export async function runGpuJob(deps: RunGpuJobDeps, input: RunGpuJobInput): Promise<RunGpuJobResult> {
  const startedAt = Date.now();
  const readyTimeoutMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const destroyOnSuccess = input.destroyOnSuccess !== false;
  const destroyOnFailure = input.destroyOnFailure !== false;
  const log = (m: string) => deps.logger?.log(m);
  const warn = (m: string) => (deps.logger?.warn ?? deps.logger?.log)?.(m);

  let instanceId = '';
  let provider = '';
  let exitCode = 1;
  let stdout = '';
  let stderr = '';
  let destroyed = false;
  let ranExec = false;
  let pendingError: unknown;

  try {
    log('runGpuJob: deploying');
    const deployed = await deps.deploy(input.spec);
    instanceId = deployed.instanceId;
    provider = deployed.provider;

    log(`runGpuJob: waiting ready (${instanceId})`);
    await deps.waitReady(instanceId, { timeoutMs: readyTimeoutMs });

    log(`runGpuJob: exec (${instanceId})`);
    const execResult = await deps.exec(instanceId, input.command);
    exitCode = execResult.exitCode;
    stdout = execResult.stdout;
    stderr = execResult.stderr;
    ranExec = true;
  } catch (err) {
    pendingError = err;
  } finally {
    const needDestroy =
      !!instanceId &&
      (ranExec
        ? shouldDestroyAfter(exitCode, destroyOnSuccess, destroyOnFailure)
        : destroyOnFailure);

    if (needDestroy) {
      try {
        log(`runGpuJob: destroying (${instanceId})`);
        await deps.destroy(instanceId);
        destroyed = true;
      } catch (destroyErr) {
        const msg = destroyErr instanceof Error ? destroyErr.message : String(destroyErr);
        warn(`runGpuJob: destroy failed for ${instanceId}: ${msg}`);
        destroyed = false;
      }
    }
  }

  if (pendingError) {
    throw pendingError;
  }

  return {
    instanceId,
    provider,
    exitCode,
    stdout,
    stderr,
    destroyed,
    durationMs: Date.now() - startedAt,
  };
}

// ── VM offload / onload helpers ───────────────────────────────────────────
//
// Keeps a VM running but drops the model off the GPU via the same
// /tmp/bench.offload + /tmp/bench.onload file protocol the snapshot-bench
// loader honours. Motivation: on Hyperstack we bill per-VM, so hibernate/
// terminate save money but take 60-90s to restore. Offloading to CPU drops
// the VRAM footprint in seconds without a full cold boot — useful for
// sub-5s "request arrives → model responds" wake-on-request paths.
//
// Hyperstack billing note: this file does NOT pause billing. The only
// savings are (a) VRAM available for another workload on the same GPU
// instance (rare in practice — L40S slots are dedicated) and (b) no model
// management overhead in steady state. For actual cost savings use
// pauseInstanceForIdle with allowHibernate:true or terminate the VM.

import { execFile } from 'child_process';

/**
 * Minimal SSH executor contract. The production callers pass
 * `execFile` from node:child_process; tests swap in a stub. Kept to a single
 * argv-style signature so there's no shell injection surface.
 */
export type SshExec = (
  cmd: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface SshTarget {
  host: string;
  port: number;
  /** Optional username override — defaults to 'ubuntu' (what snapshot-bench uses). */
  user?: string;
  /** Optional SSH private-key path; falls back to ssh-agent / default keys. */
  identityFile?: string;
}

const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 10_000;

function defaultExec(): SshExec {
  return (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: opts.timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
}

function sshArgs(t: SshTarget): string[] {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-p', String(t.port),
  ];
  if (t.identityFile) args.push('-i', t.identityFile);
  args.push(`${t.user ?? 'ubuntu'}@${t.host}`);
  return args;
}

/** Touch a file on the remote VM (idempotent). */
async function sshTouch(t: SshTarget, path: string, exec: SshExec): Promise<void> {
  await exec('ssh', [...sshArgs(t), `touch ${path}`], { timeout: DEFAULT_TIMEOUT_MS });
}

/** Return true if the given path exists on the remote VM. */
async function sshFileExists(t: SshTarget, path: string, exec: SshExec): Promise<boolean> {
  try {
    await exec('ssh', [...sshArgs(t), `test -f ${path}`], { timeout: DEFAULT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Trigger CUDA → CPU offload on the remote VM. Waits for `/tmp/bench.offloaded`
 * to appear (signalling the loader moved the model off the GPU) up to
 * `timeoutMs`. Returns true on success, false on timeout.
 */
export async function offloadVm(
  target: SshTarget,
  opts: { timeoutMs?: number; exec?: SshExec } = {},
): Promise<boolean> {
  const exec = opts.exec ?? defaultExec();
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  await sshTouch(target, '/tmp/bench.offload', exec);
  while (Date.now() < deadline) {
    if (await sshFileExists(target, '/tmp/bench.offloaded', exec)) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Trigger CPU → CUDA re-materialize on the remote VM. Waits for
 * `/tmp/bench.ready` to reappear (signalling the loader put the model back
 * on the GPU and is ready to serve) up to `timeoutMs`. Returns true on
 * success, false on timeout. Callers typically use 5000ms as the wake-on-
 * request budget.
 */
export async function onloadVm(
  target: SshTarget,
  opts: { timeoutMs?: number; exec?: SshExec } = {},
): Promise<boolean> {
  const exec = opts.exec ?? defaultExec();
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  await sshTouch(target, '/tmp/bench.onload', exec);
  while (Date.now() < deadline) {
    if (await sshFileExists(target, '/tmp/bench.ready', exec)) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

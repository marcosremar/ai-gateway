/**
 * Shared utilities for GPU backend operations.
 *
 * Centralizes SkyPilot CLI, SSH, and SCP operations used across
 * multiple API routes (skypilot-deploy, skypilot-status, skypilot-stop,
 * skypilot-proxy, benchmark-ws).
 *
 * Eliminates duplication of:
 *  - SKY_BIN path resolution (was in 3 files)
 *  - SSH option strings (was in 6+ places)
 *  - execAsync definition (was in 5 files)
 *  - SCP spawn logic (was in 2 files)
 *  - SSH+curl health check (was in 3 files)
 */

import { exec, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

// ── Core ──

export const execAsync = promisify(exec);

/** Resolve sky binary from vendor venv. */
export const SKY_BIN = path.join(process.cwd(), 'vendor', 'skypilot-venv', 'bin', 'sky');

// ── SSH ──

/** Default SSH options for cluster connections. */
const SSH_OPTS = [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'BatchMode=yes',
];

/** Build SSH option flags with custom connect timeout. */
export function sshOpts(connectTimeout = 10): string[] {
  return [...SSH_OPTS, '-o', `ConnectTimeout=${connectTimeout}`];
}

/**
 * Read the SkyPilot-generated SSH config for a cluster and return direct SSH args.
 * This bypasses the need for ~/.ssh/config Include resolution in Node.js subprocesses.
 */
export async function getSkySSHArgs(clusterName: string, connectTimeout = 10): Promise<string[]> {
  const sshConfigPath = path.join(os.homedir(), '.sky', 'generated', 'ssh', clusterName);
  try {
    const content = await fs.readFile(sshConfigPath, 'utf-8');
    let host = '';
    let port = '22';
    let identityFile = '';
    let user = 'root';
    for (const line of content.split('\n')) {
      const m = line.trim().match(/^(\w+)\s+(.+)$/);
      if (!m) continue;
      const [, key, val] = m;
      if (key === 'HostName') host = val;
      if (key === 'Port') port = val;
      if (key === 'IdentityFile') identityFile = val.replace(/^~/, os.homedir());
      if (key === 'User') user = val;
    }
    if (!host) throw new Error('HostName not found in SSH config');
    const args = [...sshOpts(connectTimeout)];
    if (port !== '22') args.push('-p', port);
    if (identityFile) args.push('-i', identityFile);
    args.push(`${user}@${host}`);
    return args;
  } catch {
    // Fallback: use cluster name as hostname
    return [...sshOpts(connectTimeout), clusterName];
  }
}

/** Build a full SSH command string for execAsync. */
export async function sshCmdAsync(cluster: string, remoteCmd: string, connectTimeout = 10): Promise<string> {
  const args = await getSkySSHArgs(cluster, connectTimeout);
  return `ssh ${args.join(' ')} '${remoteCmd}'`;
}

/** Build a full SSH command string for execAsync (sync fallback using cluster name as host). */
export function sshCmd(cluster: string, remoteCmd: string, connectTimeout = 10): string {
  const opts = sshOpts(connectTimeout).join(' ');
  return `ssh ${opts} ${cluster} '${remoteCmd}'`;
}

/**
 * Execute a command on a remote cluster via SSH.
 * Returns stdout trimmed. Throws on non-zero exit or timeout.
 */
export async function sshExec(
  cluster: string,
  remoteCmd: string,
  options: { timeout?: number; connectTimeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  const { timeout = 30_000, connectTimeout = 10, maxBuffer } = options;
  const cmd = await sshCmdAsync(cluster, remoteCmd, connectTimeout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exec options
  const execOpts: Record<string, any> = { timeout };
  if (maxBuffer) execOpts.maxBuffer = maxBuffer;
  const { stdout } = await execAsync(cmd, execOpts);
  return stdout.trim();
}

/**
 * Execute a command on a remote cluster via SSH, suppressing stderr.
 * Returns stdout or empty string on failure (non-throwing).
 */
export async function sshExecSilent(
  cluster: string,
  remoteCmd: string,
  options: { timeout?: number; connectTimeout?: number } = {},
): Promise<string> {
  try {
    const cmd = `${await sshCmdAsync(cluster, remoteCmd, options.connectTimeout ?? 5)} 2>/dev/null`;
    const { stdout } = await execAsync(cmd, { timeout: options.timeout ?? 15_000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

// ── SCP ──

/**
 * SCP a local file to a remote cluster.
 * Returns a promise that resolves when transfer is complete.
 */
export function scpToCluster(
  localPath: string,
  cluster: string,
  remotePath: string,
  connectTimeout = 10,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('scp', [
      ...sshOpts(connectTimeout),
      localPath,
      `${cluster}:${remotePath}`,
    ]);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SCP failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// ── Health Check ──

/**
 * Check GPU backend health via SSH + curl.
 * Tries curl to localhost:8000/health inside the cluster.
 * Returns parsed JSON or null on failure.
 */
export async function checkBackendHealthSSH(
  cluster: string,
  options: { timeout?: number; connectTimeout?: number } = {},
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic JSON response
): Promise<Record<string, any> | null> {
  try {
    const raw = await sshExecSilent(
      cluster,
      'curl -s http://localhost:8000/health',
      options,
    );
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data.status === 'healthy' ? data : null;
  } catch {
    return null;
  }
}

// ── SkyPilot CLI ──

/** Get cluster IP via `sky status <cluster> --ip`. */
export async function skyGetClusterIP(
  cluster: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`${SKY_BIN} status ${cluster} --ip`, {
      timeout: 30_000,
      env: env ?? process.env,
    });
    const ip = stdout.trim();
    return ip || null;
  } catch {
    return null;
  }
}

/** Spawn a SkyPilot CLI command (for long-running operations like `sky launch`). */
export function skySpawn(
  args: string[],
  env?: NodeJS.ProcessEnv,
): ChildProcess {
  return spawn(SKY_BIN, args, {
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ── Utilities ──

/** Strip ANSI color codes from a string. */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Pod Provisioner — instala o aigw-agent dentro de pods recém-deployados.
 *
 * Por que? Antes cada Docker (musetalk, kokoro, etc.) precisava bakear backup
 * scripts + heartbeat na própria imagem. Isso quebra DRY e qualquer fix exige
 * rebuild de toda imagem. Solução: gateway faz push dos scripts via SSH logo
 * depois que o pod entra em estado "ready".
 *
 * Fluxo:
 *   1. SSH no pod (mesmas credenciais do SshTunnel)
 *   2. SCP dos 3 scripts (backup, restore, agent) + install.sh + .env
 *   3. Roda install.sh que: instala rclone, dá chmod, sobe heartbeat em background,
 *      faz restore inicial do /workspace, agenda backup loop.
 *   4. Idempotente — pode rodar de novo sem efeito colateral.
 *
 * Hook: registrado em deploymentSM.onTransition (state=ready) — ver bootstrap.
 */

import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '../src/logger';

const log = createLogger('pod-provisioner');

const AGENT_DIR = join(__dirname, 'pod-agent');
const SSH_OPTS = [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'ConnectTimeout=20',
  '-o', 'ServerAliveInterval=30',
  '-o', 'LogLevel=ERROR',
];

export interface ProvisionConfig {
  sshHost: string;
  sshPort: number;
  podId: string;
  /** URL do gateway que o agente vai POSTar — geralmente process.env.AIGW_PUBLIC_URL */
  gatewayUrl?: string;
  /** Token bearer pra autenticar heartbeat (opcional) */
  gatewayToken?: string;
  /** Segundos entre heartbeats (default 30) */
  heartbeatInterval?: number;
  /** Backup interval em horas (default 24) */
  backupIntervalHours?: number;
  /** Path do log da app pra fazer tail no heartbeat */
  appLogFile?: string;
  /** Credenciais R2/B2/S3 — passadas via env do install.sh */
  s3?: {
    accountId: string;
    applicationKey: string;
    bucket: string;
    endpoint?: string;
    region?: string;
    prefix?: string;
  };
}

interface ProvisionResult {
  ok: boolean;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * Roda um comando SSH e captura stdout/stderr.
 */
function sshExec(host: string, port: number, command: string, timeoutMs = 60_000): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const args = [...SSH_OPTS, '-p', String(port), `root@${host}`, command];
    const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ ok: false, stdout, stderr: stderr + '\n[provisioner] timeout', code: null });
    }, timeoutMs);
    proc.stdout?.on('data', (b) => { stdout += b.toString(); });
    proc.stderr?.on('data', (b) => { stderr += b.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr + '\n' + String(e), code: null });
    });
  });
}

/**
 * Escreve um arquivo no pod via heredoc — evita scp pra arquivos pequenos
 * (mais rápido, menos overhead, menos race com sshd ainda subindo).
 */
async function writeRemoteFile(host: string, port: number, content: string, remotePath: string, mode = '0644'): Promise<boolean> {
  // Heredoc com EOF single-quoted preserva o conteúdo literalmente — sem
  // expansão de variáveis nem escapes. Single quotes no conteúdo seriam um
  // problema mas usamos um delimiter improvável (AIGW_EOF) e zero processing.
  // Reject conteúdo que contenha o delimiter exato pra não corromper o stream.
  if (content.includes('\nAIGW_EOF\n') || content.endsWith('\nAIGW_EOF')) {
    log.warn(`writeRemoteFile: content contains delimiter, refusing to write ${remotePath}`);
    return false;
  }
  const cmd = `mkdir -p $(dirname ${remotePath}) && cat > ${remotePath} <<'AIGW_EOF'\n${content}\nAIGW_EOF\nchmod ${mode} ${remotePath}`;
  const result = await sshExec(host, port, cmd, 30_000);
  if (!result.ok) {
    log.warn(`writeRemoteFile failed for ${remotePath}: code=${result.code} stderr=${result.stderr}`);
  }
  return result.ok;
}

/**
 * Monta o /etc/aigw-agent.env baseado na config.
 */
function buildEnvFile(cfg: ProvisionConfig): string {
  const lines: string[] = [
    `AIGW_POD_ID=${cfg.podId}`,
    `AIGW_INTERVAL=${cfg.heartbeatInterval ?? 30}`,
    `BACKUP_INTERVAL_HOURS=${cfg.backupIntervalHours ?? 24}`,
  ];
  if (cfg.gatewayUrl) lines.push(`AIGW_URL=${cfg.gatewayUrl}`);
  if (cfg.gatewayToken) lines.push(`AIGW_TOKEN=${cfg.gatewayToken}`);
  if (cfg.appLogFile) lines.push(`AIGW_LOG_FILE=${cfg.appLogFile}`);
  if (cfg.s3) {
    lines.push(`B2_ACCOUNT_ID=${cfg.s3.accountId}`);
    lines.push(`B2_APPLICATION_KEY=${cfg.s3.applicationKey}`);
    lines.push(`B2_BUCKET=${cfg.s3.bucket}`);
    if (cfg.s3.endpoint) lines.push(`B2_ENDPOINT=${cfg.s3.endpoint}`);
    if (cfg.s3.region) lines.push(`B2_REGION=${cfg.s3.region}`);
    if (cfg.s3.prefix) lines.push(`B2_PREFIX=${cfg.s3.prefix}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Provisiona um pod recém-criado. Idempotente — chame de novo sem medo.
 *
 * Fluxo:
 *   1. Lê os 4 assets locais (backup.sh, restore.sh, agent.py, install.sh)
 *   2. Escreve cada um no pod via heredoc (mais robusto que scp pra arquivos pequenos)
 *   3. Escreve /etc/aigw-agent.env com a config dinâmica
 *   4. Roda install.sh
 */
export async function provisionPod(cfg: ProvisionConfig): Promise<ProvisionResult> {
  const start = Date.now();
  const { sshHost, sshPort, podId } = cfg;

  if (!sshHost || !sshPort) {
    return { ok: false, durationMs: 0, error: 'sshHost/sshPort missing — pod has no SSH access' };
  }

  log.log(`[provision] starting for pod=${podId} via ${sshHost}:${sshPort}`);

  // Quick reachability probe — fail fast em vez de pendurar 60s
  const probe = await sshExec(sshHost, sshPort, 'echo aigw-probe-ok', 15_000);
  if (!probe.ok) {
    const error = `SSH probe failed: code=${probe.code} stderr=${probe.stderr.trim()}`;
    log.warn(`[provision] ${error}`);
    return { ok: false, durationMs: Date.now() - start, error };
  }

  // 1. Lê assets locais
  let backup: string, restore: string, agent: string, install: string;
  try {
    [backup, restore, agent, install] = await Promise.all([
      readFile(join(AGENT_DIR, 'backup_workspace.sh'), 'utf8'),
      readFile(join(AGENT_DIR, 'restore_workspace.sh'), 'utf8'),
      readFile(join(AGENT_DIR, 'aigw_agent.py'), 'utf8'),
      readFile(join(AGENT_DIR, 'install.sh'), 'utf8'),
    ]);
  } catch (e) {
    return { ok: false, durationMs: Date.now() - start, error: `Failed to read local agent assets: ${e}` };
  }

  // 2. Push assets
  const writes = [
    writeRemoteFile(sshHost, sshPort, backup, '/usr/local/bin/aigw-backup', '0755'),
    writeRemoteFile(sshHost, sshPort, restore, '/usr/local/bin/aigw-restore', '0755'),
    writeRemoteFile(sshHost, sshPort, agent, '/usr/local/bin/aigw-agent', '0755'),
    writeRemoteFile(sshHost, sshPort, install, '/usr/local/bin/aigw-install', '0755'),
    writeRemoteFile(sshHost, sshPort, buildEnvFile(cfg), '/etc/aigw-agent.env', '0600'),
  ];
  const writeResults = await Promise.all(writes);
  if (writeResults.some(r => !r)) {
    return { ok: false, durationMs: Date.now() - start, error: 'One or more remote file writes failed' };
  }

  // 3. Roda install.sh
  log.log(`[provision] running install.sh on ${podId}`);
  const installResult = await sshExec(sshHost, sshPort, 'bash /usr/local/bin/aigw-install', 300_000);
  const durationMs = Date.now() - start;

  if (!installResult.ok) {
    log.warn(`[provision] install failed for ${podId}: code=${installResult.code}`);
    return {
      ok: false,
      durationMs,
      stdout: installResult.stdout,
      stderr: installResult.stderr,
      error: `install.sh exited with code ${installResult.code}`,
    };
  }

  log.log(`[provision] ✓ pod=${podId} provisioned in ${durationMs}ms`);
  return { ok: true, durationMs, stdout: installResult.stdout };
}

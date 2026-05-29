/**
 * Hook que conecta o deploymentSM ao pod-provisioner.
 *
 * Quando o pod transita pra 'ready', dispara provisionPod() em background
 * (não bloqueia a deploy promise). Lê config das env vars do gateway:
 *
 *   AIGW_PUBLIC_URL          URL pública do gateway (pra agente POSTar)
 *   AIGW_AGENT_TOKEN         bearer token (opcional)
 *   AIGW_AGENT_INTERVAL      segundos entre heartbeats (default 30)
 *   AIGW_BACKUP_INTERVAL_H   horas — teto de fallback do backup (default 6; backup real é por checkpoint)
 *   AIGW_BACKUP_CHECK_SECS   segundos entre checagens do dir de checkpoints (default 120)
 *   AIGW_BACKUP_PREFIX       prefix estável do backup (ex: jobs/<projeto>) — sobrevive a recreate do pod
 *   AIGW_RESTORE_FROM        prefix de onde restaurar /workspace ao subir (default = AIGW_BACKUP_PREFIX)
 *   AIGW_AGENT_LOG_FILE      caminho do log da app (default /tmp/container.log)
 *   AIGW_DEV_CLIS            csv de CLIs dev p/ instalar no pod ("claude,opencode"|"all") — opt-in
 *   ANTHROPIC_API_KEY        auth headless do Claude Code (só enviado se AIGW_DEV_CLIS inclui claude)
 *   AIGW_PROVISION_DISABLED  se "1", pula provisioning (debug)
 *
 *   B2_ACCOUNT_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION, B2_PREFIX
 *     ↑ credenciais R2/B2 — sem elas o backup/restore vira no-op, mas heartbeat ainda roda.
 */

import { createLogger } from '../src/logger';
import { deploymentSM, type DeployPhase } from './deployment-state-machine';
import { provisionPod, type ProvisionConfig } from './pod-provisioner';
import { deployState } from '../src/gateway/state/deploy-state';

const log = createLogger('pod-provisioner-hook');

let registered = false;
const provisioned = new Set<string>(); // pod IDs já provisionados nesta sessão

function buildConfig(podId: string): ProvisionConfig | null {
  const sshHost = deployState.sshHost;
  const sshPort = deployState.sshPort;
  if (!sshHost || !sshPort) {
    log.warn(`[hook] pod=${podId} ready mas sshHost/sshPort vazios — skipping provision`);
    return null;
  }

  // Credenciais R2/B2/S3 vêm hidratadas do vault em startup-tasks step 1d
  // (chaves aigw:agent* → B2_* env vars). Funciona pra qualquer endpoint S3.
  const accessKey = process.env.B2_ACCOUNT_ID || '';
  const secretKey = process.env.B2_APPLICATION_KEY || '';
  const endpoint  = process.env.B2_ENDPOINT || '';
  const region    = process.env.B2_REGION || 'auto';
  const bucket    = process.env.B2_BUCKET || 'ai-gateway-pods';

  const cfg: ProvisionConfig = {
    sshHost,
    sshPort,
    podId,
    gatewayUrl: process.env.AIGW_PUBLIC_URL || (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : undefined),
    gatewayToken: process.env.AIGW_AGENT_TOKEN,
    heartbeatInterval: process.env.AIGW_AGENT_INTERVAL ? parseInt(process.env.AIGW_AGENT_INTERVAL, 10) : undefined,
    backupIntervalHours: process.env.AIGW_BACKUP_INTERVAL_H ? parseInt(process.env.AIGW_BACKUP_INTERVAL_H, 10) : undefined,
    backupCheckSecs: process.env.AIGW_BACKUP_CHECK_SECS ? parseInt(process.env.AIGW_BACKUP_CHECK_SECS, 10) : undefined,
    appLogFile: process.env.AIGW_AGENT_LOG_FILE || '/tmp/container.log',
    devClis: process.env.AIGW_DEV_CLIS || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  };

  if (accessKey && secretKey && bucket) {
    // Prefix estável (AIGW_BACKUP_PREFIX/B2_PREFIX) liga checkpoints ao *job/run*
    // em vez do pod efêmero — assim um pod novo restaura o run anterior sozinho.
    // Sem ele, cai no escopo-por-pod (pods/<id>), que NÃO sobrevive recreate.
    const stablePrefix = process.env.AIGW_BACKUP_PREFIX || process.env.B2_PREFIX;
    cfg.s3 = {
      accountId: accessKey,
      applicationKey: secretKey,
      bucket,
      endpoint,
      region,
      prefix: stablePrefix || `pods/${podId}`,
    };
    // De onde restaurar: explícito (AIGW_RESTORE_FROM) tem precedência; senão,
    // se há prefix estável, restaura dele (resume automático do run anterior).
    cfg.restoreFrom = process.env.AIGW_RESTORE_FROM || stablePrefix || undefined;
    log.log(`[hook] pod=${podId} s3 backup configured: bucket=${bucket} endpoint=${endpoint || '(default)'} prefix=${cfg.s3.prefix}${cfg.restoreFrom ? ` restoreFrom=${cfg.restoreFrom}` : ''}`);
  } else {
    log.log(`[hook] pod=${podId} no s3 creds available — backup/restore will no-op (heartbeat still works)`);
  }

  return cfg;
}

export function registerPodProvisioner(): void {
  if (registered) return;
  registered = true;

  if (process.env.AIGW_PROVISION_DISABLED === '1') {
    log.log('[hook] AIGW_PROVISION_DISABLED=1 — skipping provisioner registration');
    return;
  }

  deploymentSM.onTransition((next: DeployPhase) => {
    if (next.phase !== 'ready') return;
    const podId = next.podId;
    if (provisioned.has(podId)) {
      log.log(`[hook] pod=${podId} already provisioned this session — skipping`);
      return;
    }
    provisioned.add(podId);

    const cfg = buildConfig(podId);
    if (!cfg) return;

    // Fire-and-forget — não bloqueia deploy promise
    provisionPod(cfg)
      .then(r => {
        if (r.ok) {
          log.log(`[hook] ✓ pod=${podId} provisioned (${r.durationMs}ms)`);
        } else {
          log.warn(`[hook] ✗ pod=${podId} provision failed: ${r.error || 'unknown'}`);
          // Permite retry no próximo transition
          provisioned.delete(podId);
        }
      })
      .catch(e => {
        log.warn(`[hook] pod=${podId} provision threw: ${e?.message || e}`);
        provisioned.delete(podId);
      });
  });

  log.log('[hook] pod-provisioner registered on deploymentSM');
}

/** Test/manual hook — limpa state pra forçar re-provision. */
export function resetProvisionedSet(): void {
  provisioned.clear();
}

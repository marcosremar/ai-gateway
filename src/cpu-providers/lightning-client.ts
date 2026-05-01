/**
 * Lightning AI Studio client — lazy-start/stop/status for CPU cloudspaces.
 *
 * Auth: LIGHTNING_API_KEY (stable, from studio env) or LIGHTNING_TOKEN (JWT, 7-day TTL).
 * SSH: ED25519 key registered via /v1/ssh-keys, proxied through ssh.lightning.ai.
 *
 * Idle policy: caller tracks last SSH activity; after IDLE_TIMEOUT_MS with no
 * active sessions, call stop(). No keep-alive loop here — that's server-side.
 */

const LIGHTNING_API = 'https://lightning.ai/v1';

export interface LightningConfig {
  apiKey: string;          // LIGHTNING_API_KEY
  projectId: string;       // LIGHTNING_CLOUD_PROJECT_ID
  cloudspaceId: string;    // LIGHTNING_CLOUD_SPACE_ID
  sshUser: string;         // s_<cloudspaceId>
  sshHost: string;         // ssh.lightning.ai
  sshKeyPath: string;      // ~/.ssh/id_ed25519
}

export type StudioPhase =
  | 'CLOUD_SPACE_INSTANCE_STATE_RUNNING'
  | 'CLOUD_SPACE_INSTANCE_STATE_PENDING'
  | 'CLOUD_SPACE_INSTANCE_STATE_STOPPED'
  | 'STOPPED'; // our own sentinel when no instance exists

export interface StudioStatus {
  phase: StudioPhase;
  sshUser?: string;
  sshHost?: string;
  instanceId?: string;
  startedAt?: string;
}

export function loadLightningConfig(): LightningConfig | null {
  const apiKey = process.env.LIGHTNING_API_KEY;
  const projectId = process.env.LIGHTNING_PROJECT_ID;
  const cloudspaceId = process.env.LIGHTNING_CLOUDSPACE_ID;
  const sshUser = process.env.LIGHTNING_SSH_USER;
  if (!apiKey || !projectId || !cloudspaceId || !sshUser) return null;
  return {
    apiKey,
    projectId,
    cloudspaceId,
    sshUser,
    sshHost: process.env.LIGHTNING_SSH_HOST ?? 'ssh.lightning.ai',
    sshKeyPath: process.env.LIGHTNING_SSH_KEY ?? `${process.env.HOME}/.ssh/id_ed25519`,
  };
}

export class LightningAIClient {
  constructor(private cfg: LightningConfig) {}

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.cfg.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private csUrl(): string {
    return `${LIGHTNING_API}/projects/${this.cfg.projectId}/cloudspaces/${this.cfg.cloudspaceId}`;
  }

  async getStatus(): Promise<StudioStatus> {
    const res = await fetch(this.csUrl(), { headers: this.headers() });
    if (!res.ok) throw new Error(`Lightning AI API ${res.status}: ${await res.text()}`);
    const data = await res.json() as Record<string, unknown>;
    const codeStatus = data.codeStatus as Record<string, unknown> | undefined;
    const inUse = codeStatus?.inUse as Record<string, unknown> | null | undefined;

    if (!inUse) {
      return { phase: 'STOPPED' };
    }

    return {
      phase: (inUse.phase as StudioPhase) ?? 'STOPPED',
      sshUser: inUse.sshUsername as string | undefined,
      sshHost: inUse.sshHost as string | undefined,
      instanceId: inUse.cloudSpaceInstanceId as string | undefined,
      startedAt: inUse.startTimestamp as string | undefined,
    };
  }

  async start(): Promise<void> {
    const res = await fetch(`${this.csUrl()}/start`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({}),
    });
    const body = await res.json() as Record<string, unknown>;
    // 200 = started; code=2 "already running/pending" = fine
    if (!res.ok && body.code !== 2) {
      throw new Error(`Failed to start studio: ${body.message ?? res.status}`);
    }
  }

  async stop(): Promise<void> {
    const status = await this.getStatus();
    if (status.phase === 'STOPPED') return;

    const res = await fetch(
      `${LIGHTNING_API}/projects/${this.cfg.projectId}/cloudspaces/${this.cfg.cloudspaceId}/stop`,
      { method: 'POST', headers: this.headers(), body: '{}' }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(`Failed to stop studio: ${body.message ?? res.status}`);
    }
  }

  /** Poll until RUNNING or timeout. Returns SSH credentials. */
  async waitForRunning(timeoutMs = 5 * 60 * 1000): Promise<StudioStatus> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getStatus();
      if (status.phase === 'CLOUD_SPACE_INSTANCE_STATE_RUNNING') return status;
      if (status.phase === 'STOPPED') throw new Error('Studio stopped unexpectedly during boot');
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`Studio did not reach RUNNING within ${timeoutMs / 1000}s`);
  }

  getSSHCredentials(): { host: string; user: string; keyPath: string } {
    return {
      host: this.cfg.sshHost,
      user: this.cfg.sshUser,
      keyPath: this.cfg.sshKeyPath,
    };
  }
}

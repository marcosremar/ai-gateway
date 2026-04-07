/**
 * BotWorkloadDriver — bridges existing bot deploy/terminate logic
 * (server/bot-handlers.ts) into the WorkloadDriver interface.
 */

import type { Workload, WorkloadConfig, WorkloadDriver, BotWorkloadConfig } from './types';
import { WorkloadRegistry } from './registry';

export class BotWorkloadDriver implements WorkloadDriver {
  readonly type = 'bot' as const;

  private async serverState() {
    return import('../../server/state');
  }

  private async providers() {
    return import('../../server/providers');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async deploy(name: string, config: WorkloadConfig): Promise<Workload> {
    const cfg = config as BotWorkloadConfig;
    const state = await this.serverState();
    const prov = await this.providers();

    if (state.botDeployLock) {
      throw new Error('Bot deploy already in progress');
    }

    const flyKey = process.env.FLY_API_TOKEN || '';
    const apiKey = cfg.apiKey || process.env.RUNPOD_API_KEY || '';
    if (!flyKey && !apiKey) {
      throw new Error('No deploy credentials — set FLY_API_TOKEN or RUNPOD_API_KEY');
    }

    const botDockerImage = cfg.dockerImage || process.env.BOT_DOCKER_IMAGE || 'marcosremar/meet-teams-bot:latest';
    const podApiKey = crypto.randomUUID();
    const podEnv: Record<string, string> = {
      SERVERLESS: 'true',
      NODE_ENV: 'production',
      BOT_API_KEY: podApiKey,
      TMPDIR: '/tmp',
      ...cfg.env,
    };

    state.setBotDeployLock(true);
    state.setBotPodApiKey(podApiKey);

    // Non-blocking deploy — kick off and return immediately
    const preferFlyio = !!flyKey;
    (async () => {
      try {
        let instance: { instanceId: string; endpoint?: string; sshHost?: string; sshPort?: number } | null = null;

        if (preferFlyio) {
          try {
            instance = await prov.flyio.createInstance(
              { dockerImage: botDockerImage, ramGb: 8, vcpus: 2, env: podEnv },
              { apiKey: flyKey },
            );
          } catch (err) {
            console.warn(`[workloads:bot] Fly.io failed: ${err instanceof Error ? err.message : err}`);
            if (!apiKey) throw err;
          }
        }

        if (!instance && apiKey) {
          instance = await prov.runpod.createInstance(
            {
              gpuTypes: ['NVIDIA RTX A4000', 'NVIDIA RTX A4500', 'NVIDIA RTX 2000 Ada Generation'],
              dockerImage: botDockerImage,
              storageGb: 20,
              ports: ['8080/http', '1936/tcp', '5900/tcp', '22/tcp', '3099/http'],
              cloudType: 'SECURE',
              interruptible: false,
              env: podEnv,
            },
            { apiKey },
          );
        }

        if (!instance) throw new Error('All bot deploy providers failed');

        state.setBotStateVar({
          status: 'booting',
          podId: instance.instanceId,
          endpoint: instance.endpoint || '',
          sshHost: instance.sshHost || '',
          sshPort: instance.sshPort || 0,
          message: 'Bot pod created, waiting for boot...',
          startedAt: Date.now(),
          botId: crypto.randomUUID(),
          meetingUrl: cfg.meetingUrl || '',
          webcamRtmpUrl: '',
          youtubeStreamKey: '',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[workloads:bot] Deploy failed: ${msg}`);
        state.setBotStateVar({
          ...state.botState,
          status: 'error',
          message: msg,
        });
      } finally {
        state.setBotDeployLock(false);
      }
    })();

    const now = Date.now();
    return {
      id: WorkloadRegistry.newId(),
      type: 'bot',
      name,
      status: 'deploying',
      provider: preferFlyio ? 'fly' : 'runpod',
      costPerHr: 0,
      metadata: {
        botKind: cfg.botKind,
        dockerImage: botDockerImage,
        meetingUrl: cfg.meetingUrl || '',
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  async stop(workload: Workload): Promise<Workload> {
    // Bots don't support pause — stop is equivalent to terminate
    await this.terminate(workload);
    return { ...workload, status: 'stopped', updatedAt: Date.now() };
  }

  async start(workload: Workload): Promise<Workload> {
    // Re-deploy since bots don't support resume
    const config: BotWorkloadConfig = {
      type: 'bot',
      botKind: (workload.metadata.botKind as string) || 'teams',
      dockerImage: workload.metadata.dockerImage as string,
      meetingUrl: workload.metadata.meetingUrl as string,
    };
    return this.deploy(workload.name, config);
  }

  async terminate(workload: Workload): Promise<void> {
    const state = await this.serverState();
    const prov = await this.providers();

    const podId = state.botState.podId || (workload.instanceId as string);
    const apiKey = process.env.RUNPOD_API_KEY || '';
    const flyKey = process.env.FLY_API_TOKEN || '';

    if (podId && podId !== 'local') {
      if (flyKey && state.botState.endpoint?.includes('.fly.dev')) {
        try { await prov.flyio.deleteInstance(podId, { apiKey: flyKey }); } catch {}
      } else if (apiKey) {
        try { await prov.runpod.deleteInstance(podId, { apiKey }); } catch {}
      }
    }

    // Reset bot state
    state.setBotStateVar({
      status: 'idle', podId: '', endpoint: '', sshHost: '', sshPort: 0,
      message: '', startedAt: 0, botId: '', meetingUrl: '',
      webcamRtmpUrl: '', youtubeStreamKey: '',
    });
    state.setBotDeployLock(false);
  }

  async status(workload: Workload): Promise<Workload> {
    const state = await this.serverState();
    const bs = state.botState;

    const statusMap: Record<string, Workload['status']> = {
      idle: 'idle',
      creating: 'deploying',
      booting: 'deploying',
      ready: 'running',
      joined: 'running',
      joining: 'running',
      error: 'error',
    };

    return {
      ...workload,
      status: statusMap[bs.status] || 'idle',
      endpoint: bs.endpoint || workload.endpoint,
      instanceId: bs.podId || workload.instanceId,
      error: bs.status === 'error' ? bs.message : undefined,
      updatedAt: Date.now(),
      metadata: {
        ...workload.metadata,
        podId: bs.podId,
        botId: bs.botId,
        meetingUrl: bs.meetingUrl,
        botStatus: bs.status,
      },
    };
  }
}

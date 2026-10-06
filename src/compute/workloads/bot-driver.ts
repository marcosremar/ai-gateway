/**
 * BotWorkloadDriver — bridges bot deploy/terminate runtime operations
 * into the WorkloadDriver interface.
 */

import type { Workload, WorkloadConfig, WorkloadDriver, BotWorkloadConfig } from './types';
import { WorkloadRegistry } from './registry';
import { getWorkloadServerRuntime } from './server-runtime';
import {
  selectBotProviderChain,
  detectBotProviderFromEndpoint,
  type BotProviderId,
} from '../bot-provider-chain';

export class BotWorkloadDriver implements WorkloadDriver {
  readonly type = 'bot' as const;

  private async serverState() {
    return getWorkloadServerRuntime().state();
  }

  private async providers() {
    return getWorkloadServerRuntime().providers();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async deploy(name: string, config: WorkloadConfig): Promise<Workload> {
    const cfg = config as BotWorkloadConfig;
    const state = await this.serverState();
    const prov = await this.providers();

    if (state.botDeployLock) {
      throw new Error('Bot deploy already in progress');
    }

    const chain = selectBotProviderChain(process.env);
    if (chain.length === 0) {
      throw new Error(
        'No deploy credentials — set FLY_API_TOKEN, RAILWAY_PROJECT_ID, SCALEWAY_SECRET_KEY, or RUNPOD_API_KEY',
      );
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

    const primaryId = chain[0]!.id;
    // Non-blocking deploy — kick off and return immediately
    (async () => {
      try {
        let instance: { instanceId: string; endpoint?: string; sshHost?: string; sshPort?: number } | null = null;
        let usedProvider: BotProviderId | null = null;

        for (const entry of chain) {
          try {
            if (entry.id === 'flyio') {
              const flyKey = process.env.FLY_API_TOKEN || '';
              if (!flyKey) continue;
              instance = await prov.flyio.createInstance(
                { dockerImage: botDockerImage, ramGb: 8, vcpus: 2, env: podEnv },
                { apiKey: flyKey },
              );
            } else if (entry.id === 'railway') {
              instance = await prov.railway.createInstance(
                { dockerImage: botDockerImage, env: podEnv },
                { apiKey: process.env.RAILWAY_TOKEN || process.env.RAILWAY_API_TOKEN || '' },
              );
            } else if (entry.id === 'scaleway') {
              const scwKey = process.env.SCALEWAY_SECRET_KEY || '';
              instance = await prov.scaleway.createInstance(
                {
                  dockerImage: botDockerImage,
                  region: process.env.SCALEWAY_ZONE || 'fr-par-1',
                  ramGb: 12,
                  env: podEnv,
                },
                { apiKey: scwKey },
              );
            } else if (entry.id === 'runpod') {
              const apiKey = cfg.apiKey || process.env.RUNPOD_API_KEY || '';
              if (!apiKey) continue;
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
            if (instance) {
              usedProvider = entry.id;
              break;
            }
          } catch (err) {
            console.warn(
              `[workloads:bot] ${entry.id} failed: ${err instanceof Error ? err.message : err}`,
            );
            instance = null;
          }
        }

        if (!instance) throw new Error('All bot deploy providers failed');

        state.setBotStateVar({
          status: 'booting',
          podId: instance.instanceId,
          endpoint: instance.endpoint || '',
          sshHost: instance.sshHost || '',
          sshPort: instance.sshPort || 0,
          message: `Bot pod created via ${usedProvider}, waiting for boot...`,
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
      provider: primaryId === 'flyio' ? 'fly' : primaryId,
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
    const endpoint = state.botState.endpoint || '';
    const provider = detectBotProviderFromEndpoint(endpoint);
    const apiKey = process.env.RUNPOD_API_KEY || '';
    const flyKey = process.env.FLY_API_TOKEN || '';
    const scwKey = process.env.SCALEWAY_SECRET_KEY || '';
    const rwKey = process.env.RAILWAY_TOKEN || process.env.RAILWAY_API_TOKEN || '';

    if (podId && podId !== 'local') {
      try {
        if (provider === 'flyio' || (flyKey && endpoint.includes('.fly.dev'))) {
          await prov.flyio.deleteInstance(podId, { apiKey: flyKey });
        } else if (provider === 'railway' && process.env.RAILWAY_PROJECT_ID) {
          await prov.railway.deleteInstance(podId, { apiKey: rwKey });
        } else if (provider === 'scaleway' && scwKey) {
          await prov.scaleway.deleteInstance(podId, { apiKey: scwKey });
        } else if (apiKey) {
          await prov.runpod.deleteInstance(podId, { apiKey });
        } else if (process.env.RAILWAY_PROJECT_ID) {
          await prov.railway.deleteInstance(podId, { apiKey: rwKey });
        }
      } catch { /* best-effort cleanup */ }
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

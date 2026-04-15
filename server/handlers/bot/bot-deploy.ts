/**
 * Bot Deploy — Pod deployment, cleanup, and termination
 */

import type { IncomingMessage, ServerResponse } from 'http';
import {
  botState, setBotStateVar, botDeployLock, setBotDeployLock, setBotApiKey,
  botApiKey, botPodApiKey, setBotPodApiKey, deployApiKey,
} from '../../state';
import { runpod, scaleway, flyio } from '../../providers';
import { readJsonBody, handleBodyError } from '../../http-utils';
import { validateInput } from '../../../src/input-validator';
import { BotDeployRequestSchema } from '../../../src/contracts';
import {
  log, BOT_POD_PREFIX, BOT_DOCKER_IMAGE, BOT_PORTS, BOT_LOCAL_CONTAINER,
  setBotState,
} from './bot-shared';

export async function cleanupBotPods(apiKey: string): Promise<void> {
  try {
    const instances = await runpod.listInstances({ apiKey });
    const toTerminate = instances.filter(inst =>
      (inst.instanceName || '').startsWith(BOT_POD_PREFIX) && inst.status !== 'EXITED'
    );
    if (toTerminate.length > 0) {
      log.log(`[bot] Cleaning up ${toTerminate.length} RunPod bot pod(s)...`);
      await Promise.allSettled(
        toTerminate.map(async (inst) => {
          try {
            await runpod.deleteInstance(inst.instanceId, { apiKey });
            log.log(`[bot] Terminated RunPod bot pod ${inst.instanceId}`);
          } catch (err) {
            log.warn(`[bot] Failed to terminate RunPod bot pod ${inst.instanceId}: ${err}`);
          }
        })
      );
    }
  } catch (err) {
    log.warn(`[bot] Failed to list RunPod pods for bot cleanup: ${err}`);
  }
  const scwKey = process.env.SCALEWAY_SECRET_KEY || '';
  if (scwKey) {
    try {
      const scwInstances = await scaleway.listInstances({ apiKey: scwKey });
      const scwToTerminate = scwInstances.filter(inst => inst.status === 'running');
      if (scwToTerminate.length > 0) {
        log.log(`[bot] Cleaning up ${scwToTerminate.length} Scaleway bot instance(s)...`);
        await Promise.allSettled(
          scwToTerminate.map(async (inst) => {
            try {
              await scaleway.deleteInstance(inst.instanceId, { apiKey: scwKey });
              log.log(`[bot] Terminated Scaleway bot ${inst.instanceId}`);
            } catch (err) {
              log.warn(`[bot] Failed to terminate Scaleway bot ${inst.instanceId}: ${err}`);
            }
          })
        );
      }
    } catch (err) {
      log.warn(`[bot] Failed to list Scaleway instances for cleanup: ${err}`);
    }
  }
  const flyKey = process.env.FLY_API_TOKEN || '';
  if (flyKey) {
    try {
      const flyInstances = await flyio.listInstances({ apiKey: flyKey });
      const flyToTerminate = flyInstances.filter(inst => inst.status === 'running');
      if (flyToTerminate.length > 0) {
        log.log(`[bot] Cleaning up ${flyToTerminate.length} Fly.io bot machine(s)...`);
        await Promise.allSettled(
          flyToTerminate.map(async (inst) => {
            try {
              await flyio.deleteInstance(inst.instanceId, { apiKey: flyKey });
              log.log(`[bot] Terminated Fly.io bot machine ${inst.instanceId}`);
            } catch (err) {
              log.warn(`[bot] Failed to terminate Fly.io bot ${inst.instanceId}: ${err}`);
            }
          })
        );
      }
    } catch (err) {
      log.warn(`[bot] Failed to list Fly.io machines for cleanup: ${err}`);
    }
  }
}

async function cleanupLocalDocker(): Promise<void> {
  try {
    const rm = Bun.spawn(['docker', 'rm', '-f', BOT_LOCAL_CONTAINER], { stdout: 'pipe', stderr: 'pipe' });
    await rm.exited;
  } catch { /* container may not exist */ }
  try {
    const prune = Bun.spawn(['docker', 'network', 'prune', '-f'], { stdout: 'pipe', stderr: 'pipe' });
    await prune.exited;
  } catch { /* ignore */ }
}

async function deployLocalDocker(dockerImage: string, envVars?: Record<string, string>): Promise<void> {
  await cleanupLocalDocker();

  setBotState({
    status: 'creating', startedAt: Date.now(), podId: 'local',
    endpoint: '', message: 'Starting local Docker container...', botId: '', meetingUrl: '',
  });

  const LOCAL_BOT_PORT = 8085;
  const envFlags = Object.entries(envVars || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const proc = Bun.spawn([
    'docker', 'run', '-d',
    '--platform', 'linux/amd64',
    '--name', BOT_LOCAL_CONTAINER,
    '--shm-size', '2g',
    '-p', `${LOCAL_BOT_PORT}:8080`,
    '-p', '5900:5900',
    '-p', '3099:3099',
    ...envFlags,
    dockerImage,
  ], { stdout: 'pipe', stderr: 'pipe' });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const check = Bun.spawn(['docker', 'inspect', '-f', '{{.State.Running}}', BOT_LOCAL_CONTAINER], { stdout: 'pipe', stderr: 'pipe' });
    await check.exited;
    const isRunning = (await new Response(check.stdout).text()).trim() === 'true';
    if (!isRunning) {
      throw new Error(`Docker run failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
    }
    log.log(`[bot] Docker exited ${exitCode} but container is running (platform warning)`);
  }

  const endpoint = `http://localhost:${LOCAL_BOT_PORT}`;
  setBotState({
    status: 'booting', podId: 'local', endpoint,
    message: 'Local container started, waiting for bot startup...',
  });

  const startedAt = Date.now();
  const TIMEOUT_MS = 10 * 60_000;
  while (true) {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      setBotState({ status: 'error', message: 'Local bot timed out waiting for startup' });
      await cleanupLocalDocker();
      return;
    }
    try {
      const resp = await fetch(`${endpoint}/version`, { signal: AbortSignal.timeout(3_000) });
      if (resp.ok) {
        setBotState({ status: 'ready', message: `Local bot ready: ${endpoint}`, webcamRtmpUrl: '', sshHost: '', sshPort: 0 });
        return;
      }
    } catch { /* not ready yet */ }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    setBotState({ message: `Waiting for local bot startup... [${elapsed}s]` });
    await new Promise(r => setTimeout(r, 3_000));
  }
}

export async function autoDeployBot(): Promise<void> {
  if (botState.status !== 'idle' && botState.status !== 'error') {
    log.log(`[bot] Auto-boot: bot already deployed (status=${botState.status}), skipping`);
    return;
  }
  const flyKey = process.env.FLY_API_TOKEN || '';
  if (!flyKey) {
    log.log('[bot] Auto-boot: FLY_API_TOKEN not set — bot will not auto-deploy');
    return;
  }

  const bootStartMs = Date.now();
  const podApiKey = crypto.randomUUID();
  setBotPodApiKey(podApiKey);
  const podEnv: Record<string, string> = {
    SERVERLESS: 'true', NODE_ENV: 'production', BOT_API_KEY: podApiKey, TMPDIR: '/tmp',
  };

  setBotDeployLock(true);
  setBotState({
    status: 'creating', startedAt: Date.now(), podId: '', endpoint: '',
    message: 'Auto-boot: deploying bot on Fly.io...', botId: '', meetingUrl: '',
  });

  try {
    log.log('[bot] Auto-boot: starting Fly.io bot deploy...');
    const instance = await flyio.createInstance(
      { dockerImage: BOT_DOCKER_IMAGE, ramGb: 8, vcpus: 4, env: podEnv },
      { apiKey: flyKey },
    );

    setBotState({
      status: 'booting', podId: instance.instanceId,
      endpoint: instance.endpoint || `https://${process.env.BOT_FLY_APP_NAME || 'babelcast-bot'}.fly.dev`,
      message: `Auto-boot: bot machine created (${instance.instanceId.slice(0, 8)}), waiting for startup...`,
    });

    const BOT_TIMEOUT_MS = 30 * 60_000;
    while (true) {
      if (Date.now() - bootStartMs > BOT_TIMEOUT_MS) {
        setBotState({ status: 'error', message: 'Auto-boot: bot timed out waiting for startup' });
        await flyio.deleteInstance(instance.instanceId, { apiKey: flyKey }).catch(() => {});
        return;
      }

      const endpoint = botState.endpoint || instance.endpoint || `https://${process.env.BOT_FLY_APP_NAME || 'babelcast-bot'}.fly.dev`;
      try {
        const probeHeaders: Record<string, string> = { 'fly-force-instance-id': instance.instanceId };
        const flyHost = flyio.getFlyHost();
        if (flyHost) probeHeaders['Host'] = flyHost;
        const resp = await fetch(`${endpoint}/version`, { headers: probeHeaders, signal: AbortSignal.timeout(5_000) });
        if (resp.ok) {
          const bootSec = Math.round((Date.now() - bootStartMs) / 1000);
          setBotState({ status: 'ready', message: `Auto-boot: bot ready in ${bootSec}s (Fly.io)`, webcamRtmpUrl: '', sshHost: '', sshPort: 0 });
          log.log(`[bot] Auto-boot: Fly.io bot ready in ${bootSec}s — endpoint: ${endpoint}`);
          return;
        }
      } catch { /* not ready yet */ }

      const elapsed = Math.round((Date.now() - bootStartMs) / 1000);
      setBotState({ message: `Auto-boot: waiting for bot startup... [${elapsed}s]` });
      await new Promise(r => setTimeout(r, 5_000));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[bot] Auto-boot: Fly.io deploy failed — ${msg}`);
    setBotState({ status: 'error', message: `Auto-boot failed: ${msg}` });
  } finally {
    setBotDeployLock(false);
  }
}

export async function handleBotDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (botDeployLock || (botState.status !== 'idle' && botState.status !== 'error')) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bot deploy already in progress', ...botState }));
    return;
  }
  setBotDeployLock(true);

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { setBotDeployLock(false); handleBodyError(res, e); return; }

  const deployResult = validateInput(body, BotDeployRequestSchema);
  if (!deployResult.ok) {
    setBotDeployLock(false);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Validation failed', details: deployResult.details }));
    return;
  }
  const deployData = deployResult.data;

  const isLocal = !!(deployData.local);
  const botDockerImage = deployData.dockerImage || BOT_DOCKER_IMAGE;
  const enableAvatar = !!(deployData.enableAvatar || deployData.avatar);

  if (isLocal) {
    (async () => {
      try {
        const podApiKey = crypto.randomUUID();
        setBotPodApiKey(podApiKey);
        const localEnv: Record<string, string> = {
          SERVERLESS: 'true', BOT_API_KEY: podApiKey,
          TMPDIR: '/tmp',
        };
        if (enableAvatar) localEnv.ENABLE_AVATAR = 'true';
        await deployLocalDocker(botDockerImage, localEnv);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[bot] Local deploy failed: ${msg}`);
        setBotState({ status: 'error', message: `Local deploy failed: ${msg}` });
      } finally {
        setBotDeployLock(false);
      }
    })().catch(err => {
      log.error('[bot] Unexpected error escaping local deploy task:', err);
    });

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'creating', message: 'Local Docker bot deploy started' }));
    return;
  }

  const flyKey = process.env.FLY_API_TOKEN || '';
  const apiKey = deployData.apiKey || deployApiKey || process.env.RUNPOD_API_KEY || '';
  if (!flyKey && !apiKey) {
    setBotDeployLock(false);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No deploy credentials — set FLY_API_TOKEN or RUNPOD_API_KEY in .env' }));
    return;
  }
  if (apiKey) setBotApiKey(apiKey);
  const forceCpu = !!(deployData.cpuOnly || deployData.cpu);
  const preferFlyio = !!flyKey && !deployData.runpod;

  const podApiKey = crypto.randomUUID();
  setBotPodApiKey(podApiKey);
  const podEnv: Record<string, string> = {
    SERVERLESS: 'true', NODE_ENV: 'production', BOT_API_KEY: podApiKey,
    TMPDIR: '/tmp',
    ...(enableAvatar ? { ENABLE_AVATAR: 'true' } : {}),
  };

  if (apiKey) await cleanupBotPods(apiKey);

  const podName = `${BOT_POD_PREFIX}${Date.now()}`;
  setBotState({
    status: 'creating', startedAt: Date.now(), podId: '', endpoint: '',
    message: `Creating bot pod${preferFlyio ? ' on Fly.io' : ` on RunPod${forceCpu ? ' (CPU)' : ''}`}...`, botId: '', meetingUrl: '',
  });

  (async () => {
    try {
      let isCpuPod = forceCpu;
      let isScalewayPod = false;
      let isFlyioPod = false;
      let instance: Awaited<ReturnType<typeof runpod.createInstance>> | null = null;

      if (preferFlyio) {
        try {
          log.log('[bot] Deploying on Fly.io (default)...');
          isFlyioPod = true;
          isCpuPod = true;
          instance = await flyio.createInstance(
            { dockerImage: botDockerImage, ramGb: 8, vcpus: 2, env: podEnv },
            { apiKey: flyKey },
          );
        } catch (flyErr) {
          log.warn(`[bot] Fly.io failed: ${flyErr instanceof Error ? flyErr.message : flyErr}`);
          isFlyioPod = false;
          instance = null;
          if (!apiKey) throw flyErr;
          log.log('[bot] Falling back to RunPod...');
          setBotState({ message: 'Fly.io failed, trying RunPod...' });
        }
      }

      if (!instance && !forceCpu) {
        try {
          instance = await runpod.createInstance(
            {
              gpuTypes: ['NVIDIA RTX A4000', 'NVIDIA RTX A4500', 'NVIDIA RTX 2000 Ada Generation',
                'NVIDIA GeForce RTX 3060', 'NVIDIA GeForce RTX 4060 Ti'],
              dockerImage: botDockerImage,
              storageGb: 20,
              ports: BOT_PORTS,
              cloudType: 'SECURE',
              interruptible: false,
              env: podEnv,
            },
            { apiKey },
          );
        } catch {
          log.log('[bot] GPU pods exhausted, trying CPU pod...');
          isCpuPod = true;
        }
      }
      if (!instance) {
        isCpuPod = true;
        try {
          instance = await runpod.createInstance(
            {
              computeType: 'CPU',
              cpuFlavorIds: ['cpu5c', 'cpu5g', 'cpu3c', 'cpu3g'],
              vcpus: 2,
              ramGb: 16,
              dockerImage: botDockerImage,
              storageGb: 20,
              ports: BOT_PORTS,
              cloudType: 'SECURE',
              interruptible: false,
              env: podEnv,
            },
            { apiKey },
          );
        } catch (runpodErr) {
          log.warn(`[bot] RunPod CPU failed: ${runpodErr instanceof Error ? runpodErr.message : runpodErr}`);
          const scwKey = process.env.SCALEWAY_SECRET_KEY || '';
          const flyKeyInner = process.env.FLY_API_TOKEN || '';
          if (scwKey) {
            try {
              log.log('[bot] Trying Scaleway fallback...');
              setBotState({ message: 'RunPod unavailable, deploying on Scaleway...' });
              isScalewayPod = true;
              instance = await scaleway.createInstance(
                { dockerImage: botDockerImage, region: process.env.SCALEWAY_ZONE || 'fr-par-1', ramGb: 12, env: podEnv },
                { apiKey: scwKey },
              );
            } catch (scwErr) {
              log.warn(`[bot] Scaleway failed: ${scwErr instanceof Error ? scwErr.message : scwErr}`);
              isScalewayPod = false;
              if (flyKeyInner) {
                log.log('[bot] Trying Fly.io fallback...');
                setBotState({ message: 'Scaleway unavailable, deploying on Fly.io...' });
                isFlyioPod = true;
                instance = await flyio.createInstance(
                  { dockerImage: botDockerImage, ramGb: 8, vcpus: 2, env: podEnv },
                  { apiKey: flyKeyInner },
                );
              } else {
                throw scwErr;
              }
            }
          } else if (flyKeyInner) {
            log.log('[bot] Trying Fly.io fallback...');
            setBotState({ message: 'RunPod unavailable, deploying on Fly.io...' });
            isFlyioPod = true;
            instance = await flyio.createInstance(
              { dockerImage: botDockerImage, ramGb: 8, vcpus: 2, env: podEnv },
              { apiKey: flyKeyInner },
            );
          } else {
            throw runpodErr;
          }
        }
      }

      setBotState({
        status: 'booting', podId: instance.instanceId,
        endpoint: '', sshHost: instance.sshHost || '', sshPort: instance.sshPort || 0,
        message: `Bot pod created (${instance.instanceId.slice(0, 8)}), waiting for startup...`,
      });

      const startedAt = Date.now();
      const BOT_TIMEOUT_MS = 30 * 60_000;
      while (true) {
        if (Date.now() - startedAt > BOT_TIMEOUT_MS) {
          setBotState({ status: 'error', message: 'Bot pod timed out waiting for startup' });
          try {
            if (isFlyioPod) {
              await flyio.deleteInstance(instance.instanceId, { apiKey: flyKey });
            } else if (isScalewayPod) {
              await scaleway.deleteInstance(instance.instanceId, { apiKey: process.env.SCALEWAY_SECRET_KEY || '' });
            } else {
              await runpod.deleteInstance(instance.instanceId, { apiKey });
            }
          } catch { /* best-effort: cleanup */ }
          return;
        }

        let endpoint = botState.endpoint;
        if (!endpoint) {
          if (isFlyioPod) {
            endpoint = instance.endpoint || `https://${process.env.BOT_FLY_APP_NAME || 'babelcast-bot'}.fly.dev`;
            setBotState({ endpoint });
          } else if (isScalewayPod) {
            if (botState.endpoint) {
              endpoint = botState.endpoint;
              log.log(`[bot] Scaleway endpoint from state: ${endpoint}`);
            }
          } else if (isCpuPod) {
            endpoint = `https://${instance.instanceId}-8080.proxy.runpod.net`;
            setBotState({ endpoint });
          } else {
            const resolved = await runpod.resolveInstanceEndpoint(instance.instanceId, { apiKey });
            if (resolved) {
              endpoint = resolved.replace(/-8000\.proxy\.runpod\.net/, '-8080.proxy.runpod.net').replace(/:8000\b/, ':8080');
              setBotState({ endpoint });
            }
          }
        }

        if (endpoint) {
          try {
            const probeHeaders: Record<string, string> = {};
            const fetchOpts: Record<string, unknown> = { headers: probeHeaders, signal: AbortSignal.timeout(5_000) };
            if (isFlyioPod) {
              probeHeaders['fly-force-instance-id'] = instance.instanceId;
              const flyHost = flyio.getFlyHost();
              if (flyHost) {
                probeHeaders['Host'] = flyHost;
                (fetchOpts as any).tls = { rejectUnauthorized: false };
              }
            }
            const resp = await fetch(`${endpoint}/version`, fetchOpts as any);
            if (resp.ok) {
              let webcamRtmpUrl = '';
              let sshHost = '';
              let sshPort = 0;

              if (isFlyioPod || isCpuPod) {
                log.log(`[bot] ${isFlyioPod ? 'Fly.io' : 'CPU'} pod ready (HTTPS only — no RTMP/SSH)`);
              } else {
                try {
                  const podDetail = await runpod.getInstanceDetail(instance.instanceId, { apiKey });
                  if (podDetail?.runtime) {
                    const runtimePorts = podDetail.runtime.ports as Array<Record<string, unknown>> | undefined;
                    if (runtimePorts && runtimePorts.length > 0) {
                      const publicIp = runtimePorts[0]?.ip as string | undefined;
                      if (publicIp) {
                        const rtmpPort = runtimePorts.find(p => p.privatePort === 1936);
                        if (rtmpPort?.publicPort) {
                          webcamRtmpUrl = `rtmp://${publicIp}:${rtmpPort.publicPort}/live`;
                          log.log(`[bot] RTMP webcam URL: ${webcamRtmpUrl}`);
                        }
                        const sshPort_ = runtimePorts.find(p => p.privatePort === 22);
                        if (sshPort_?.publicPort) {
                          sshHost = publicIp;
                          sshPort = sshPort_.publicPort as number;
                          log.log(`[bot] SSH: ${sshHost}:${sshPort}`);
                        }
                      }
                    }
                  }
                } catch (err) {
                  log.warn(`[bot] Failed to resolve ports: ${err}`);
                }
              }
              setBotState({ status: 'ready', message: `Bot pod ready: ${endpoint}`, webcamRtmpUrl, sshHost, sshPort });
              return;
            }
          } catch { /* not ready yet */ }
        }

        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        setBotState({ message: `Waiting for bot startup... [${elapsed}s]` });
        await new Promise(r => setTimeout(r, 10_000));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[bot] Deploy failed: ${msg}`);
      setBotState({ status: 'error', message: `Bot deploy failed: ${msg}` });
    } finally {
      setBotDeployLock(false);
    }
  })().catch(err => {
    log.error('[bot] Unexpected error escaping deploy task:', err);
  });

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'creating', message: 'Bot pod deploy started' }));
}

export async function handleBotTerminate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const apiKey = botApiKey || deployApiKey || process.env.RUNPOD_API_KEY || '';
  const podId = botState.podId;

  const { clearBotIdleTimer } = await import('./bot-meeting');
  clearBotIdleTimer();
  const { stopBotTranscriptPoll } = await import('../../ws-state');
  stopBotTranscriptPoll();
  const { stopParecCapture } = await import('../../ws-server');
  stopParecCapture();
  const { broadcastWs } = await import('../../ws-state');
  broadcastWs({ type: 'bot:status', status: 'idle', message: 'Bot terminated' });
  setBotStateVar({
    status: 'idle', podId: '', endpoint: '', sshHost: '', sshPort: 0,
    message: '', startedAt: 0, botId: '', meetingUrl: '',
    webcamRtmpUrl: '', youtubeStreamKey: '',
  });
  setBotDeployLock(false);

  if (podId === 'local') {
    await cleanupLocalDocker();
    log.log(`[bot] Stopped local Docker container`);
  } else if (podId) {
    const flyKey = process.env.FLY_API_TOKEN || '';
    if (flyKey && (botState.endpoint?.includes('.fly.dev') || botState.endpoint?.includes('66.'))) {
      try {
        await flyio.deleteInstance(podId, { apiKey: flyKey });
        log.log(`[bot] Terminated Fly.io bot machine ${podId}`);
      } catch (err) {
        log.warn(`[bot] Failed to terminate Fly.io bot ${podId}: ${err}`);
      }
    } else if (apiKey) {
      try {
        await runpod.deleteInstance(podId, { apiKey });
        log.log(`[bot] Terminated RunPod bot pod ${podId}`);
      } catch (err) {
        log.warn(`[bot] Failed to terminate RunPod pod ${podId}: ${err}`);
      }
    }
  }
  if (apiKey) await cleanupBotPods(apiKey);
  else {
    const flyKey = process.env.FLY_API_TOKEN || '';
    if (flyKey) await cleanupBotPods('');
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

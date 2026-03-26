// ── BabelCast Gateway — Bot HTTP Handlers ───────────────────────────────────
// setBotState, cleanupBotPods, handleBotDeploy, handleBotStatus,
// handleBotJoin, handleBotLeave, handleBotTerminate.

import type { IncomingMessage, ServerResponse } from 'http';
import {
  botState, setBotStateVar, botDeployLock, setBotDeployLock, setBotApiKey,
  botApiKey, botPodApiKey, setBotPodApiKey, deployState, deployApiKey,
} from './state';
import { warmupAllGpuModels } from './provider-warmup';
import type { BotDeploymentState } from './state';
import { runpod, scaleway } from './providers';
import { maskKey } from './http-utils';
import { readJsonBody, handleBodyError } from './http-utils';
import { broadcastWs, startBotTranscriptPoll, stopBotTranscriptPoll } from './ws-state';
import { PORT } from './config';
// Re-export consolidated SSRF check from ai-handlers (single source of truth)
import { isPrivateUrl } from './ai-handlers';
export { isPrivateUrl };

/** Redact meeting URL for logging — show only protocol + domain, hide path/query. */
function redactMeetingUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/[redacted]`;
  } catch {
    return '[invalid-url]';
  }
}

export const BOT_POD_PREFIX = 'babelcast-bot-';
export const BOT_DOCKER_IMAGE = 'marcosremar/meet-teams-bot:latest';
export const BOT_PORTS = ['8080/http', '1936/tcp', '5900/http', '22/tcp', '3099/http']; // control API + RTMP webcam input + VNC debug + SSH + Avatar

/** Build headers for proxied requests to the bot pod (includes Bearer auth if key is set). */
function botHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (botPodApiKey) h['Authorization'] = `Bearer ${botPodApiKey}`;
  return h;
}

export function setBotState(patch: Partial<BotDeploymentState>) {
  Object.assign(botState, patch);
  console.log(`[bot] ${botState.status}: ${botState.message}`);
}

export async function cleanupBotPods(apiKey: string): Promise<void> {
  try {
    const instances = await runpod.listInstances({ apiKey });
    const toTerminate = instances.filter(inst =>
      (inst.instanceName || '').startsWith(BOT_POD_PREFIX) && inst.status !== 'EXITED'
    );
    if (toTerminate.length === 0) return;
    console.log(`[bot] Cleaning up ${toTerminate.length} bot pod(s)...`);
    await Promise.allSettled(
      toTerminate.map(async (inst) => {
        try {
          await runpod.deleteInstance(inst.instanceId, { apiKey });
          console.log(`[bot] Terminated bot pod ${inst.instanceId} (${inst.instanceName})`);
        } catch (err) {
          console.warn(`[bot] Failed to terminate bot pod ${inst.instanceId}: ${err}`);
        }
      })
    );
  } catch (err) {
    console.warn(`[bot] Failed to list pods for bot cleanup: ${err}`);
  }
}

export const BOT_LOCAL_CONTAINER = 'babelcast-bot';

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

  // Use port 8085 on host to avoid conflicts with gateway/other services on 8080
  const LOCAL_BOT_PORT = 8085;

  // Build -e flags for environment variables
  const envFlags = Object.entries(envVars || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const proc = Bun.spawn([
    'docker', 'run', '-d',
    '--platform', 'linux/amd64',     // Bot image is x86 — Rosetta on ARM Macs
    '--name', BOT_LOCAL_CONTAINER,
    '--shm-size', '2g',              // Chromium needs shared memory
    '-p', `${LOCAL_BOT_PORT}:8080`,
    '-p', '5900:5900',               // VNC debug
    '-p', '3099:3099',               // Avatar server
    ...envFlags,
    dockerImage,
  ], { stdout: 'pipe', stderr: 'pipe' });

  const exitCode = await proc.exited;
  // exit 125 with platform warning is OK on ARM Macs — container still runs
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    // Check if container is actually running despite the exit code
    const check = Bun.spawn(['docker', 'inspect', '-f', '{{.State.Running}}', BOT_LOCAL_CONTAINER], { stdout: 'pipe', stderr: 'pipe' });
    await check.exited;
    const isRunning = (await new Response(check.stdout).text()).trim() === 'true';
    if (!isRunning) {
      throw new Error(`Docker run failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
    }
    console.log(`[bot] Docker exited ${exitCode} but container is running (platform warning)`);
  }

  const endpoint = `http://localhost:${LOCAL_BOT_PORT}`;
  setBotState({
    status: 'booting', podId: 'local', endpoint,
    message: 'Local container started, waiting for bot startup...',
  });

  // Poll /version until ready (10 min timeout — Rosetta emulation on ARM is slow)
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

  const isLocal = !!(body.local);
  const botDockerImage = (body.dockerImage as string) || BOT_DOCKER_IMAGE;
  const enableAvatar = !!(body.enableAvatar || body.avatar);

  // ── Local Docker deploy ──
  if (isLocal) {
    (async () => {
      try {
        const podApiKey = crypto.randomUUID();
        setBotPodApiKey(podApiKey);
        const localEnv: Record<string, string> = {
          SERVERLESS: 'true', BOT_API_KEY: podApiKey,
          TMPDIR: '/tmp',  // Playwright artifacts dir
        };
        if (enableAvatar) localEnv.ENABLE_AVATAR = 'true';
        await deployLocalDocker(botDockerImage, localEnv);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[bot] Local deploy failed: ${msg}`);
        setBotState({ status: 'error', message: `Local deploy failed: ${msg}` });
      } finally {
        setBotDeployLock(false);  // always released exactly once here
      }
    })().catch(err => {
      // Only log — lock already released in finally
      console.error('[bot] Unexpected error escaping local deploy task:', err);
    });

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'creating', message: 'Local Docker bot deploy started' }));
    return;
  }

  // ── RunPod cloud deploy ──
  const apiKey = (body.apiKey as string) || deployApiKey || process.env.RUNPOD_API_KEY || '';
  if (!apiKey) {
    setBotDeployLock(false);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'RunPod API key required (apiKey or RUNPOD_API_KEY env)' }));
    return;
  }
  setBotApiKey(apiKey);
  const forceCpu = !!(body.cpuOnly || body.cpu);

  // Generate a random API key for bot pod HTTP auth
  const podApiKey = crypto.randomUUID();
  setBotPodApiKey(podApiKey);
  const podEnv: Record<string, string> = {
    SERVERLESS: 'true', NODE_ENV: 'production', BOT_API_KEY: podApiKey,
    // Playwright uses TMPDIR for artifacts — /workspace/tmp may not exist on all pod types
    TMPDIR: '/tmp',
    ...(enableAvatar ? { ENABLE_AVATAR: 'true' } : {}),
  };

  // Clean up any existing bot pods
  await cleanupBotPods(apiKey);

  const podName = `${BOT_POD_PREFIX}${Date.now()}`;
  setBotState({
    status: 'creating', startedAt: Date.now(), podId: '', endpoint: '',
    message: `Creating bot pod on RunPod${forceCpu ? ' (CPU)' : ''}...`, botId: '', meetingUrl: '',
  });

  // Deploy asynchronously
  (async () => {
    try {
      // Try GPU first (much faster boot ~1min), fallback to CPU ($0.12/hr)
      // Bot doesn't need GPU but GPU pods pull images faster
      let isCpuPod = forceCpu;
      let isScalewayPod = false;
      let instance: Awaited<ReturnType<typeof runpod.createInstance>> | null = null;
      if (!forceCpu) {
        try {
          instance = await runpod.createInstance(
            {
              gpuTypes: ['NVIDIA RTX A4000', 'NVIDIA RTX A4500', 'NVIDIA RTX 2000 Ada Generation',
                'NVIDIA GeForce RTX 3060', 'NVIDIA GeForce RTX 4060 Ti'],
              dockerImage: botDockerImage,
              storageGb: 20,
              ports: BOT_PORTS,
              // IMPORTANT: NEVER use 'COMMUNITY' — unreliable third-party machines that die mid-task
              cloudType: 'SECURE',
              interruptible: false,
              env: podEnv,
            },
            { apiKey },
          );
        } catch {
          console.log('[bot] GPU pods exhausted, trying CPU pod...');
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
              vcpus: 4,
              ramGb: 16,  // Chromium needs ≥8GB; 16GB avoids OOM on busy meetings
              dockerImage: botDockerImage,
              storageGb: 20,
              ports: BOT_PORTS,
              // IMPORTANT: NEVER use 'COMMUNITY' — unreliable third-party machines that die mid-task
              cloudType: 'SECURE',
              interruptible: false,
              env: podEnv,
            },
            { apiKey },
          );
        } catch (runpodErr) {
          console.warn(`[bot] RunPod CPU failed: ${runpodErr instanceof Error ? runpodErr.message : runpodErr}`);
          // Fallback to Scaleway if RunPod fails (e.g. insufficient balance)
          const scwKey = process.env.SCALEWAY_SECRET_KEY || '';
          if (scwKey) {
            console.log('[bot] Trying Scaleway fallback...');
            setBotState({ message: 'RunPod unavailable, deploying on Scaleway...' });
            isScalewayPod = true;
            instance = await scaleway.createInstance(
              {
                dockerImage: botDockerImage,
                region: process.env.SCALEWAY_ZONE || 'fr-par-1',
                ramGb: 12,
                env: podEnv,
              },
              { apiKey: scwKey },
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

      // Poll until the bot's HTTP server on :8080 is up
      const startedAt = Date.now();
      const BOT_TIMEOUT_MS = 30 * 60_000; // 30 min (image pull can take 15-25 min on first boot)
      while (true) {
        if (Date.now() - startedAt > BOT_TIMEOUT_MS) {
          setBotState({ status: 'error', message: 'Bot pod timed out waiting for startup' });
          try {
            if (isScalewayPod) {
              await scaleway.deleteInstance(instance.instanceId, { apiKey: process.env.SCALEWAY_SECRET_KEY || '' });
            } else {
              await runpod.deleteInstance(instance.instanceId, { apiKey });
            }
          } catch {}
          return;
        }

        // Resolve endpoint — Scaleway uses public IP, RunPod CPU uses proxy, RunPod GPU uses resolved endpoint
        let endpoint = botState.endpoint;
        if (!endpoint) {
          if (isScalewayPod) {
            // Scaleway: endpoint is stored in instance when created (already in botState)
            // Try to get from stored instance or use instance ID format
            if (botState.endpoint) {
              endpoint = botState.endpoint;
              console.log(`[bot] Scaleway endpoint from state: ${endpoint}`);
            }
          } else if (isCpuPod) {
            // CPU pods: build proxy URL directly from pod ID (RunPod doesn't expose runtime/IP)
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

        // Probe /version endpoint (lightweight health check)
        if (endpoint) {
          try {
            const resp = await fetch(`${endpoint}/version`, { signal: AbortSignal.timeout(5_000) });
            if (resp.ok) {
              let webcamRtmpUrl = '';
              let sshHost = '';
              let sshPort = 0;

              if (isCpuPod) {
                // CPU pods: no direct IP/TCP ports — only HTTP proxy URLs available
                // RTMP (TCP) not available via proxy; webcam push requires GPU pod
                console.log(`[bot] CPU pod ready (proxy only — no RTMP/SSH direct access)`);
              } else {
                // GPU pods: resolve direct IP + port mappings for RTMP/SSH via RunpodClient
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
                          console.log(`[bot] RTMP webcam URL: ${webcamRtmpUrl}`);
                        }
                        const sshPort_ = runtimePorts.find(p => p.privatePort === 22);
                        if (sshPort_?.publicPort) {
                          sshHost = publicIp;
                          sshPort = sshPort_.publicPort as number;
                          console.log(`[bot] SSH: ${sshHost}:${sshPort}`);
                        }
                      }
                    }
                  }
                } catch (err) {
                  console.warn(`[bot] Failed to resolve ports: ${err}`);
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
      console.error(`[bot] Deploy failed: ${msg}`);
      setBotState({ status: 'error', message: `Bot deploy failed: ${msg}` });
    } finally {
      setBotDeployLock(false);
    }
  })().catch(err => {
    // Only log — lock already released in finally
    console.error('[bot] Unexpected error escaping deploy task:', err);
  });

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'creating', message: 'Bot pod deploy started' }));
}

export async function handleBotStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const elapsed = botState.startedAt > 0 ? Math.round((Date.now() - botState.startedAt) / 1000) : 0;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ...botState,
    elapsedSec: elapsed,
    webcamRtmpUrl: botState.webcamRtmpUrl,
    youtubeStreamKey: botState.youtubeStreamKey ? `${botState.youtubeStreamKey.slice(0, 4)}****` : '',
  }));
}

export async function handleBotJoin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  const meetingUrl = (body.meetingUrl as string) || '';
  const botName = (body.botName as string) || 'BabelCast Bot';
  const sourceLang = (body.source as string) || 'fr';
  const targetLang = (body.target as string) || 'en';
  const streamKey = (body.streamKey as string) || '';

  if (!meetingUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'meetingUrl is required' }));
    return;
  }

  // Validate meeting URL format and protocol
  try {
    const parsed = new URL(meetingUrl);
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid meeting URL: must be http or https' }));
      return;
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid meeting URL format' }));
    return;
  }

  // SSRF protection — block private/internal network URLs
  if (isPrivateUrl(meetingUrl)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Meeting URL must not point to private/internal networks' }));
    return;
  }

  if (botState.status !== 'ready') {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Bot pod not ready (status: ${botState.status})`, ...botState }));
    return;
  }

  // For local Docker: parec captures audio directly from PulseAudio (no Web Audio needed).
  // For RunPod: bot streams via WebSocket.
  const isLocalBot = botState.podId === 'local';
  // For cloud bots: use GATEWAY_PUBLIC_WS_URL if set (bot pod needs to reach the gateway).
  // Without a public URL, bot audio streaming won't work from cloud pods.
  const publicWsUrl = process.env.GATEWAY_PUBLIC_WS_URL;
  const streamingOutput = isLocalBot
    ? ''  // parec handles audio for local Docker
    : publicWsUrl
      ? `${publicWsUrl}/ws/bot-audio`
      : `ws://localhost:${PORT + 1}/ws/bot-audio`;

  const botUuid = crypto.randomUUID();
  const config = {
    meeting_url: meetingUrl,
    bot_name: botName,
    bot_uuid: botUuid,
    streaming_output: streamingOutput,
    streaming_audio_frequency: 16000,
    recording_mode: 'speaker_view',
    remote: null,
    speech_to_text_provider: 'Default',
    automatic_leave: {
      waiting_room_timeout: 600,
      noone_joined_timeout: 300,
      silence_timeout: 600,
    },
    // Extra metadata for our pipeline
    _source_lang: sourceLang,
    _target_lang: targetLang,
  };

  // Send config to bot pod via HTTP POST /join endpoint
  const botEndpoint = botState.endpoint;
  if (!botEndpoint) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bot pod has no endpoint' }));
    return;
  }

  setBotState({
    botId: botUuid, meetingUrl, status: 'joining',
    message: `Bot joining: ${redactMeetingUrl(meetingUrl)}`,
    youtubeStreamKey: streamKey,
  });

  // Send meeting config to bot's /join HTTP endpoint
  try {
    const joinRes = await fetch(`${botEndpoint}/join`, {
      method: 'POST',
      headers: botHeaders(),
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(30_000),
    });
    const ct = joinRes.headers.get('content-type') ?? '';
    const joinBody = ct.includes('application/json')
      ? await joinRes.json().catch(() => ({}))
      : await joinRes.text().catch(() => '');
    if (!joinRes.ok) {
      const errDetail = typeof joinBody === 'string' ? joinBody : JSON.stringify(joinBody);
      console.warn(`[bot] /join returned ${joinRes.status}: ${errDetail}`);
      setBotState({ status: 'ready', message: `Bot /join failed (HTTP ${joinRes.status}): ${errDetail.slice(0, 100)}` });
    } else {
      console.log(`[bot] /join OK: ${JSON.stringify(joinBody)}`);
      setBotState({ status: 'joined' });
      broadcastWs({ type: 'bot:status', status: 'in_meeting', message: 'Bot joined meeting' });
      // Predictive warmup: warm all GPU models for minimal first-request latency
      if (deployState.status === 'ready' && deployState.endpoint) {
        warmupAllGpuModels(deployState.endpoint).catch(err =>
          console.warn('[warmup] Predictive warmup failed:', err instanceof Error ? err.message : err)
        );
      }
      // Start PulseAudio capture for local Docker
      const { startParecCapture } = await import('./ws-server');
      startParecCapture();
    }
  } catch (err) {
    console.warn(`[bot] Failed to POST /join: ${err}`);
    setBotState({ status: 'ready', message: 'Bot /join error — pod still running' });
  }

  // If streamKey provided, launch YouTube streaming via SSH (needs FFmpeg on Xvfb display)
  if (streamKey && botState.sshHost && botState.sshPort) {
    // Validate streamKey to prevent command injection (alphanumeric + hyphens + underscores only)
    if (!/^[\w\-]{1,128}$/.test(streamKey)) {
      console.warn(`[bot] Rejected invalid YouTube stream key format`);
    } else {
      // Validate SSH host — block private/internal network addresses
      const sshHostBlocked = /^localhost$/i.test(botState.sshHost) || /^127\./.test(botState.sshHost) ||
        /^10\./.test(botState.sshHost) || /^192\.168\./.test(botState.sshHost) ||
        /^169\.254\./.test(botState.sshHost) || /^172\.(1[6-9]|2\d|3[01])\./.test(botState.sshHost);
      if (sshHostBlocked) {
        console.warn(`[bot] Blocked SSH to private IP: ${botState.sshHost}`);
      } else {
        try {
          // Use Bun.spawn with array args to avoid shell injection.
          // streamKey is safe in the command string: validated above by /^[\w\-]{1,128}$/ regex,
          // which only allows alphanumeric chars, underscores, and hyphens.
          const sshArgs = [
            'ssh',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=10',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-p', String(botState.sshPort),
            `root@${botState.sshHost}`,
            `STREAM_KEY='${streamKey}' nohup /app/start_youtube_stream.sh > /var/log/youtube_stream.log 2>&1 &`,
          ];
          const proc = Bun.spawn(sshArgs, { stdout: 'pipe', stderr: 'pipe' });
          // Don't await — fire and forget with a timeout
          setTimeout(async () => {
            try { proc.kill(); } catch { /* ignore */ }
          }, 30_000);
          proc.exited.then(code => {
            if (code !== 0) console.warn(`[bot] YouTube stream SSH launch exited with code ${code}`);
          }).catch(err => {
            console.warn(`[bot] YouTube stream SSH launch warning: ${err}`);
          });
          console.log(`[bot] YouTube stream started with key ${maskKey(streamKey)}`);
        } catch (err) {
          console.warn(`[bot] Failed to launch YouTube stream via SSH: ${err}`);
        }
      }
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    botId: botUuid,
    meetingUrl,
    streamingOutput,
    webcamRtmpUrl: botState.webcamRtmpUrl,
    config,
  }));
}

export async function handleBotLeave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!botState.endpoint || (botState.status !== 'joined' && botState.status !== 'ready')) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Bot not in a meeting (status: ${botState.status})` }));
    return;
  }

  try {
    const stopRes = await fetch(`${botState.endpoint}/stop_record`, {
      method: 'POST',
      headers: botHeaders(),
      body: JSON.stringify({ meeting_url: botState.meetingUrl }),
      signal: AbortSignal.timeout(10_000),
    });
    const ct = stopRes.headers.get('content-type') ?? '';
    const data = ct.includes('application/json')
      ? await stopRes.json().catch(() => ({}))
      : {};
    stopBotTranscriptPoll();
    broadcastWs({ type: 'bot:status', status: 'idle', message: 'Bot left meeting' });
    setBotState({ status: 'ready', message: 'Bot left meeting', meetingUrl: '', botId: '' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...data as Record<string, unknown> }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bot] Leave failed: ${msg}`);
    // Still reset state — bot has attempted to leave regardless
    stopBotTranscriptPoll();
    setBotState({ status: 'ready', message: 'Bot leave errored — state reset', meetingUrl: '', botId: '' });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to stop bot: ${msg}` }));
  }
}

export async function handleBotTerminate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const apiKey = botApiKey || deployApiKey || process.env.RUNPOD_API_KEY || '';
  const podId = botState.podId;

  stopBotTranscriptPoll();
  const { stopParecCapture } = await import('./ws-server');
  stopParecCapture();
  broadcastWs({ type: 'bot:status', status: 'idle', message: 'Bot terminated' });
  setBotStateVar({
    status: 'idle', podId: '', endpoint: '', sshHost: '', sshPort: 0,
    message: '', startedAt: 0, botId: '', meetingUrl: '',
    webcamRtmpUrl: '', youtubeStreamKey: '',
  });
  setBotDeployLock(false);

  // Clean up local Docker container if it was a local deploy
  if (podId === 'local') {
    await cleanupLocalDocker();
    console.log(`[bot] Stopped local Docker container`);
  } else if (apiKey) {
    if (podId) {
      try {
        await runpod.deleteInstance(podId, { apiKey });
        console.log(`[bot] Terminated bot pod ${podId}`);
      } catch (err) {
        console.warn(`[bot] Failed to terminate pod ${podId}: ${err}`);
      }
    }
    await cleanupBotPods(apiKey);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// ── Page Streaming Proxy ───────────────────────────────────────────────────

/** POST /v1/bot/stream-page — Start streaming a web page's video+audio into the Teams meeting. */
export async function handleBotStreamPage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); }
  catch (e) { handleBodyError(res, e); return; }

  if (botState.status !== 'joined') {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Bot not in a meeting (status: ${botState.status})` }));
    return;
  }

  const ep = botState.endpoint;
  if (!ep) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bot pod has no endpoint' }));
    return;
  }

  try {
    const apiRes = await fetch(`${ep}/stream-page`, {
      method: 'POST',
      headers: botHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const isJson = (apiRes.headers.get('content-type') ?? '').includes('application/json');
    const result = isJson
      ? await apiRes.json().catch(() => ({}))
      : { raw: await apiRes.text().catch(() => '') };
    res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `stream-page proxy failed: ${(err as Error).message}` }));
  }
}

/** POST /v1/bot/stop-stream — Stop active page streaming. */
export async function handleBotStopStream(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ep = botState.endpoint;
  if (!ep) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bot pod has no endpoint' }));
    return;
  }

  try {
    const apiRes = await fetch(`${ep}/stop-stream`, {
      method: 'POST',
      headers: botHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    const isJson = (apiRes.headers.get('content-type') ?? '').includes('application/json');
    const result = isJson
      ? await apiRes.json().catch(() => ({}))
      : { raw: await apiRes.text().catch(() => '') };
    res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `stop-stream proxy failed: ${(err as Error).message}` }));
  }
}

/** GET /v1/bot/stream-status — Check page streaming status. */
export async function handleBotStreamStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ep = botState.endpoint;
  if (!ep) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ streaming: false, reason: 'No bot pod' }));
    return;
  }

  try {
    const apiRes = await fetch(`${ep}/stream-status`, {
      headers: botHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    const isJson = (apiRes.headers.get('content-type') ?? '').includes('application/json');
    const result = isJson
      ? await apiRes.json().catch(() => ({}))
      : { raw: await apiRes.text().catch(() => '') };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ streaming: false, reason: `Bot unreachable: ${(err as Error).message}` }));
  }
}

/** GET /v1/bot/debug/* — Proxy debug endpoints to bot pod (authenticated). */
/** Proxy that preserves binary responses (screenshots, images). */
export async function handleBotProxyBinary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ep = botState.endpoint;
  if (!ep) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No bot pod' }));
    return;
  }
  const proxyPath = (req.url || '').replace(/^\/v1\/bot/, '') || '/';
  try {
    const apiRes = await fetch(`${ep}${proxyPath}`, {
      method: req.method || 'GET',
      headers: botHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    const buf = Buffer.from(await apiRes.arrayBuffer());
    const ct = apiRes.headers.get('content-type') || 'application/octet-stream';
    res.writeHead(apiRes.status, { 'Content-Type': ct, 'Content-Length': buf.length.toString() });
    res.end(buf);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy failed: ${(err as Error).message}` }));
  }
}

export async function handleBotProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ep = botState.endpoint;
  if (!ep) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No bot pod' }));
    return;
  }

  // Map /v1/bot/debug/X → /debug/X on bot pod
  const proxyPath = (req.url || '').replace(/^\/v1\/bot/, '') || '/';

  try {
    const apiRes = await fetch(`${ep}${proxyPath}`, {
      method: req.method || 'GET',
      headers: botHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await apiRes.text();
    res.writeHead(apiRes.status, { 'Content-Type': apiRes.headers.get('content-type') || 'application/json' });
    res.end(result);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy failed: ${(err as Error).message}` }));
  }
}

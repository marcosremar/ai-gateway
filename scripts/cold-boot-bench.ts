#!/usr/bin/env bun
/**
 * Babelcast Cold-Boot A/B Bench
 *
 * Measures the full deploy → ready → first-inference lifecycle of a
 * babelcast-subtitle Docker image on Vast.ai. Use this to compare image
 * variants (e.g. `:latest` vs `:lazy`).
 *
 * Phases measured (timestamped from t0 = deploy POST sent):
 *   T1  Vast reports actual_status='running'   (image pulled, container up)
 *   T2  /health returns 200                     (uvicorn accepting)
 *   T3  STT model warm                          (whisper loaded)
 *   T4  LLM model ready                         (llama.cpp accepting requests)
 *   T5  first /v1/chat/completions OK          (real inference round-trip)
 *
 * The instance is automatically destroyed at the end (or on script exit).
 *
 * Usage:
 *   bun scripts/cold-boot-bench.ts --image marcosremar/babelcast-subtitle:latest
 *   bun scripts/cold-boot-bench.ts --image marcosremar/babelcast-subtitle:lazy
 *
 * Optional flags:
 *   --offer-id <id>      Use a specific Vast offer instead of searching
 *   --max-wait <sec>     Overall deadline (default 1200 = 20 min)
 *   --skip-inference     Skip the T5 inference round-trip (just measure model load)
 *   --keep                Don't destroy the instance at the end (for debugging)
 *
 * Env:
 *   VAST_API_KEY  required (read from .env automatically by Bun)
 */

const VAST_API_BASE = 'https://console.vast.ai/api/v0';

// ── CLI parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function bool(name: string): boolean {
  return args.includes(`--${name}`);
}

const IMAGE = flag('image');
if (!IMAGE) {
  console.error('ERROR: --image <docker-image> is required');
  console.error('Example: bun scripts/cold-boot-bench.ts --image marcosremar/babelcast-subtitle:latest');
  process.exit(1);
}
const OFFER_ID_OVERRIDE = flag('offer-id');
const MAX_WAIT_S = parseInt(flag('max-wait') ?? '1200', 10);
const SKIP_INFERENCE = bool('skip-inference');
const KEEP = bool('keep');

const VAST_KEY = process.env.VAST_API_KEY;
if (!VAST_KEY) {
  console.error('ERROR: VAST_API_KEY not set in .env');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${VAST_KEY}`,
  'Content-Type': 'application/json',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}

let cleanupRan = false;
let createdInstanceId: number | null = null;

async function destroyInstance(id: number): Promise<void> {
  if (cleanupRan) return;
  cleanupRan = true;
  try {
    const res = await fetch(`${VAST_API_BASE}/instances/${id}/`, { method: 'DELETE', headers });
    const body = await res.text();
    console.error(`[cleanup] DELETE instance ${id} → HTTP ${res.status}: ${body.slice(0, 100)}`);
  } catch (e) {
    console.error(`[cleanup] failed to destroy instance ${id}:`, e);
  }
}

// Make sure we always tear down — Ctrl+C, errors, normal exit, etc.
process.on('SIGINT', async () => {
  if (createdInstanceId) await destroyInstance(createdInstanceId);
  process.exit(130);
});
process.on('SIGTERM', async () => {
  if (createdInstanceId) await destroyInstance(createdInstanceId);
  process.exit(143);
});

// ── Step 1: Find a fast US offer ─────────────────────────────────────────────

async function searchOffer(): Promise<{ id: number; gpu: string; pricePerHr: number; geo: string }> {
  console.error('[offer] searching Vast.ai for fast US host...');
  const body = {
    rentable: { eq: true },
    rented: { eq: false },
    num_gpus: { eq: 1 },
    disk_space: { gte: 30 },
    direct_port_count: { gte: 2 },
    reliability2: { gte: 0.97 },
    inet_down: { gte: 5000 },
    type: 'on-demand',
    order: [['dph_total', 'asc']],
    limit: 10,
  };
  const res = await fetch(`${VAST_API_BASE}/bundles/`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Vast bundles search failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { offers?: Array<Record<string, unknown>> };
  const offers = data.offers ?? [];
  if (offers.length === 0) throw new Error('No offers found matching criteria');

  // Filter to US/CA hosts (avoid CN/EU for consistent baseline)
  const usCa = offers.filter(o => {
    const geo = String(o.geolocation ?? '');
    return /,\s*(US|CA)$/.test(geo);
  });
  const pick = usCa[0] ?? offers[0];

  return {
    id: Number(pick.id),
    gpu: String(pick.gpu_name),
    pricePerHr: Number(pick.dph_total),
    geo: String(pick.geolocation ?? '?'),
  };
}

// ── Step 2: Deploy ──────────────────────────────────────────────────────────

async function deploy(offerId: number): Promise<number> {
  console.error(`[deploy] PUT /asks/${offerId}/ with image=${IMAGE}`);
  const body = {
    client_id: 'me',
    image: IMAGE,
    disk: 30,
    runtype: 'ssh_direct',
    onstart: 'nohup /app/start.sh > /var/log/babelcast.log 2>&1 &',
    env: {
      TZ: 'UTC',
      '-p 8000:8000': '1',
    },
  };
  const res = await fetch(`${VAST_API_BASE}/asks/${offerId}/`, {
    method: 'PUT', headers, body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Deploy failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { success?: boolean; new_contract?: number };
  if (!data.success || !data.new_contract) {
    throw new Error(`Deploy returned: ${JSON.stringify(data)}`);
  }
  return data.new_contract;
}

// ── Step 3: Poll Vast until container is running + HTTP endpoint resolvable ─

interface InstanceInfo {
  id: number;
  status: string;
  publicIp: string;
  endpoint: string; // http://ip:port for the babelcast :8000 service
}

async function getInstance(id: number): Promise<InstanceInfo | null> {
  const res = await fetch(`${VAST_API_BASE}/instances/`, { headers });
  if (!res.ok) return null;
  const data = (await res.json()) as { instances?: Array<Record<string, unknown>> };
  const inst = (data.instances ?? []).find(i => Number(i.id) === id);
  if (!inst) return null;

  const status = String(inst.actual_status ?? inst.cur_state ?? '?');
  const publicIp = String(inst.public_ipaddr ?? '');

  let endpoint = '';
  const ports = inst.ports as Record<string, unknown> | undefined;
  const directPort = inst.direct_port_start as number | undefined;

  if (ports && directPort && directPort > 0) {
    const p8000 = (ports['8000/tcp'] ?? ports['8000']) as
      | Array<{ HostPort?: string; HostIp?: string }>
      | undefined;
    const entry = p8000?.find(e => Number(e.HostPort) > 0);
    if (entry?.HostPort && publicIp) {
      const hostIp = entry.HostIp && !entry.HostIp.startsWith('172.') && !entry.HostIp.startsWith('10.') && entry.HostIp !== '0.0.0.0'
        ? entry.HostIp : publicIp;
      endpoint = `http://${hostIp}:${entry.HostPort}`;
    }
  }
  if (!endpoint && publicIp && directPort && directPort > 0) {
    endpoint = `http://${publicIp}:${directPort}`;
  }

  return { id, status, publicIp, endpoint };
}

// ── Step 4: Probe babelcast /health ─────────────────────────────────────────

interface HealthResponse {
  status?: string;
  services?: { whisper?: string; llm?: string };
  model_warmth?: { stt?: { warm?: boolean }; llm?: { warm?: boolean } };
}

async function probeHealth(endpoint: string): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

// ── Step 5: Run inference ───────────────────────────────────────────────────

async function testInference(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'translategemma',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    return res.ok;
  } catch (e) {
    console.error('[inference] error:', (e as Error).message);
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const milestones: Record<string, number | null> = {
    deploy_submit: 0,
    vast_running: null,
    health_responding: null,
    stt_warm: null,
    llm_ready: null,
    first_inference: null,
  };

  // 1. Find offer (or use override)
  let offerId: number;
  let offerInfo: { gpu: string; pricePerHr: number; geo: string };
  if (OFFER_ID_OVERRIDE) {
    offerId = parseInt(OFFER_ID_OVERRIDE, 10);
    offerInfo = { gpu: '?', pricePerHr: 0, geo: 'override' };
  } else {
    const o = await searchOffer();
    offerId = o.id;
    offerInfo = o;
  }
  console.error(`[offer] id=${offerId} ${offerInfo.gpu} $${offerInfo.pricePerHr}/hr ${offerInfo.geo}`);

  // 2. Deploy
  const instanceId = await deploy(offerId);
  createdInstanceId = instanceId;
  milestones.deploy_submit = Date.now() - t0;
  console.error(`[deploy] instance ${instanceId} created at t+0s`);

  // 3. Poll for running + endpoint
  let inst: InstanceInfo | null = null;
  while ((Date.now() - t0) / 1000 < MAX_WAIT_S) {
    await sleep(5_000);
    inst = await getInstance(instanceId);
    if (!inst) continue;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.error(`[t+${elapsed}s] status=${inst.status} ip=${inst.publicIp || '?'} endpoint=${inst.endpoint || '?'}`);
    if (inst.status === 'running' && inst.endpoint) {
      milestones.vast_running = Date.now() - t0;
      break;
    }
  }
  if (!inst || !inst.endpoint) throw new Error('Timed out waiting for vast running + endpoint');

  // 4. Poll /health for each milestone
  let firstHealthSeen = false;
  let sttWarmSeen = false;
  let llmReadySeen = false;
  while ((Date.now() - t0) / 1000 < MAX_WAIT_S) {
    const h = await probeHealth(inst.endpoint);
    if (h) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (!firstHealthSeen) {
        firstHealthSeen = true;
        milestones.health_responding = Date.now() - t0;
        console.error(`[t+${elapsed}s] /health=200 services=${JSON.stringify(h.services ?? {})}`);
      }
      const sttWarm = h.model_warmth?.stt?.warm === true;
      const llmReady = h.model_warmth?.llm?.warm === true;
      if (sttWarm && !sttWarmSeen) {
        sttWarmSeen = true;
        milestones.stt_warm = Date.now() - t0;
        console.error(`[t+${elapsed}s] STT warm`);
      }
      if (llmReady && !llmReadySeen) {
        llmReadySeen = true;
        milestones.llm_ready = Date.now() - t0;
        console.error(`[t+${elapsed}s] LLM ready`);
      }
      if (sttWarmSeen && llmReadySeen) break;
    }
    await sleep(3_000);
  }

  // 5. Run inference (optional)
  if (!SKIP_INFERENCE && llmReadySeen) {
    console.error('[inference] sending test /v1/chat/completions...');
    const ok = await testInference(inst.endpoint);
    if (ok) {
      milestones.first_inference = Date.now() - t0;
      console.error(`[t+${Math.round((Date.now() - t0) / 1000)}s] first inference OK`);
    } else {
      console.error('[inference] failed');
    }
  }

  // 6. Tear down
  if (!KEEP) await destroyInstance(instanceId);
  else console.error(`[keep] instance ${instanceId} kept alive — destroy manually`);

  // 7. Output JSON
  const result = {
    image: IMAGE,
    offer: { id: offerId, gpu: offerInfo.gpu, pricePerHr: offerInfo.pricePerHr, geo: offerInfo.geo },
    instance_id: instanceId,
    milestones_ms: milestones,
    milestones_human: Object.fromEntries(
      Object.entries(milestones).map(([k, v]) => [k, v == null ? null : fmtSec(v)]),
    ),
  };
  console.log('\nJSON_RESULT:');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(async (e) => {
  console.error('[fatal]', e);
  if (createdInstanceId && !KEEP) await destroyInstance(createdInstanceId);
  process.exit(1);
});

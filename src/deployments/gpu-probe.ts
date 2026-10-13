/**
 * Active health check of the GPU deployments named in app profiles (app-gpu-health.ts): every ready replica gets one
 * minimal real call per stage it serves — STT a 0.6 s WAV, chat 1 token, TTS one word (a cloned voice from the replica's
 * own catalog, as a real turn sends it) — straight on the replica, never through `acquire`: it never wakes, starts or
 * keeps a machine up. `GPU_PROBE_FAILS` failed rounds in a row make the replica failing and take the failed stages out
 * of rotation (`holdStageOut`, the same mechanism repeated request failures use) until a round passes.
 */

import type { ModelRoutesSpec } from '../config/serve-providers';
import { probeWav } from '../telemetry/fallback-probe';
import { redactSecrets } from '../gateway/proxy/provider-routing';
import type { DeploymentController } from './controller';
import { replicaBase } from './http';
import { catalogOf, isBaseTtsModel, languageName, VOICE_CATALOG_SOURCES } from './inference-providers';
import { qwenTokenCap } from './qwen-token-cap';
import { replicaTls } from './replica-tls';
import type { DeploymentView } from './types';

/** A broken stage shows within ~2–4 min while a class runs, for one tiny call per stage (≪ 1 % of a replica's slots). */
export const GPU_PROBE_INTERVAL_MS = 2 * 60_000;
/** A replica that just became ready is probed within this. */
const GPU_PROBE_TICK_MS = 15_000;
/** A 1-token / one-word call takes < 3 s even under class load (realtime-edge measures): 30 s means stuck, not busy. */
const GPU_PROBE_TIMEOUT_MS = 30_000;
/** Owner, 12/10/2026: two failed rounds in a row → failing (one alone may be a replica restarting a worker). */
const GPU_PROBE_FAILS = 2;
const PROBE_TEXT = 'Olá.';
const PROBE_WAV = probeWav();

export type GpuStage = 'stt' | 'llm' | 'tts';
export interface StageTarget { stage: GpuStage; model: string; voice?: string }
export interface ProbeRound { at: number; ok: boolean; ms: number; error: string | null; failed: GpuStage[] }

const ROUTE_STAGE = { stt: 'stt', chat: 'llm', tts: 'tts' } as const;
const CONTROLLER_STAGE: Record<GpuStage, string> = { stt: 'stt', llm: 'chat', tts: 'tts' };

/** The stages an app's routes send to `deployment` (its first deployment entry, one-GPU mode resolved), with the model asked. */
export function servedStages(routes: ModelRoutesSpec | undefined, deployment: string, exists: (name: string) => boolean): StageTarget[] {
  const out = new Map<GpuStage, StageTarget>();
  for (const [routeStage, stage] of Object.entries(ROUTE_STAGE) as Array<[keyof typeof ROUTE_STAGE, GpuStage]>) {
    for (const [alias, chain] of Object.entries(routes?.[routeStage] ?? {})) {
      for (const e of chain) {
        if (e.provider !== 'deployment' || !e.deployment) continue;
        const target = !exists(e.deployment) && e.oneGpuDeployment && exists(e.oneGpuDeployment) ? e.oneGpuDeployment : e.deployment;
        if (target === deployment && !out.has(stage)) out.set(stage, { stage, model: e.model ?? alias, ...(e.voice ? { voice: e.voice } : {}) });
      }
    }
  }
  return [...out.values()];
}

type Call = (path: string, init?: RequestInit) => Promise<Response>;

async function expectJson(res: Response, check: (body: Record<string, unknown>) => boolean, what: string): Promise<void> {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !check(body)) throw new Error(`answer without ${what}`);
}

async function ttsBody(call: Call, t: StageTarget): Promise<Record<string, unknown>> {
  let catalog: ReturnType<typeof catalogOf> = null;
  for (const [path, parse] of VOICE_CATALOG_SOURCES) {
    const res = await call(path);
    catalog = res.ok && (res.headers.get('content-type') ?? '').includes('json') ? parse(await res.json().catch(() => null)) : null;
    if (catalog) break;
    await res.body?.cancel().catch(() => {});
  }
  const voice = catalog?.voices[0];
  if (voice) {
    const language = languageName(voice.lang);
    return {
      model: catalog!.model ?? t.model, input: PROBE_TEXT, task_type: 'Base', ref_audio: voice.audio, ref_text: voice.text,
      response_format: 'wav', max_new_tokens: qwenTokenCap(PROBE_TEXT), ...(language ? { language } : {}),
    };
  }
  if (isBaseTtsModel(t.model)) throw new Error('voice catalog unavailable (a cloning TTS is never sent a voice without ref_audio)');
  return { model: t.model, input: PROBE_TEXT, response_format: 'wav', ...(t.voice ? { voice: t.voice } : {}) };
}

async function probeStage(call: Call, t: StageTarget): Promise<void> {
  const json = { 'Content-Type': 'application/json' };
  if (t.stage === 'stt') {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(PROBE_WAV)]), 'probe.wav');
    form.append('model', t.model);
    form.append('response_format', 'json');
    return expectJson(await call('/v1/audio/transcriptions', { method: 'POST', body: form }), b => typeof b.text === 'string', 'text');
  }
  if (t.stage === 'llm') {
    const body = JSON.stringify({ model: t.model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 });
    return expectJson(await call('/v1/chat/completions', { method: 'POST', headers: json, body }), b => Array.isArray(b.choices), 'choices');
  }
  const res = await call('/v1/audio/speech', { method: 'POST', headers: json, body: JSON.stringify(await ttsBody(call, t)) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  if ((res.headers.get('content-type') ?? '').includes('json')) throw new Error(`no audio: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  if ((await res.arrayBuffer()).byteLength <= 44) throw new Error('empty audio');
}

interface ReplicaProbe { deployment: string; last: ProbeRound; fails: number; held: Set<GpuStage> }

export interface GpuProbeOptions {
  controller: Pick<DeploymentController, 'get' | 'tokenOf' | 'holdStageOut'>;
  /** Deployments to probe and what each serves; read at every tick. */
  targets: () => Array<{ deployment: string; stages: StageTarget[] }>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class GpuProbe {
  private readonly replicas = new Map<string, ReplicaProbe>();
  private readonly lastOf = new Map<string, ProbeRound>();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: GpuProbeOptions) { this.now = opts.now ?? Date.now; }

  failing(replicaId: string): boolean { return (this.replicas.get(replicaId)?.fails ?? 0) >= GPU_PROBE_FAILS; }

  round(replicaId: string): ProbeRound | null { return this.replicas.get(replicaId)?.last ?? null; }

  /** The deployment's latest round, whatever replica it was (kept after the replicas are gone). */
  lastRound(deployment: string): ProbeRound | null { return this.lastOf.get(deployment) ?? null; }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const seen = new Set<string>();
      const due: Array<Promise<void>> = [];
      for (const { deployment, stages } of this.opts.targets()) {
        const view = this.opts.controller.get(deployment);
        if (!view || !stages.length) continue;
        for (const r of view.replicas) {
          if (r.phase !== 'ready' || !r.ip) continue;
          seen.add(r.id);
          const known = this.replicas.get(r.id);
          if (!known || this.now() - known.last.at >= GPU_PROBE_INTERVAL_MS) due.push(this.probe(view, r, stages));
        }
      }
      await Promise.all(due);
      for (const id of this.replicas.keys()) if (!seen.has(id)) this.replicas.delete(id);
    } finally {
      this.running = false;
    }
  }

  private async probe(view: DeploymentView, r: DeploymentView['replicas'][number], stages: StageTarget[]): Promise<void> {
    const token = this.opts.controller.tokenOf(view.name, r.id) ?? '';
    const base = replicaBase(r, Boolean(view.spec.exposure));
    const call: Call = (path, init = {}) => (this.opts.fetchImpl ?? fetch)(`${base}${path}`, {
      ...init, ...replicaTls(base, token),
      headers: { ...(init.headers as Record<string, string> | undefined), 'X-Aigw-Token': token },
      signal: AbortSignal.timeout(GPU_PROBE_TIMEOUT_MS),
    });
    const started = this.now();
    const failed: GpuStage[] = [];
    let error: string | null = null;
    for (const t of stages) {
      try { await probeStage(call, t); } catch (err) {
        failed.push(t.stage);
        error ??= `${t.stage}: ${redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
      }
    }
    const last: ProbeRound = { at: this.now(), ok: !failed.length, ms: this.now() - started, error, failed };
    const prev = this.replicas.get(r.id);
    const entry: ReplicaProbe = { deployment: view.name, last, fails: last.ok ? 0 : (prev?.fails ?? 0) + 1, held: prev?.held ?? new Set<GpuStage>() };
    this.replicas.set(r.id, entry);
    this.lastOf.set(view.name, last);
    this.route(r.id, entry);
  }

  private route(id: string, entry: ReplicaProbe): void {
    const out = entry.fails >= GPU_PROBE_FAILS ? new Set(entry.last.failed) : new Set<GpuStage>();
    for (const stage of out) {
      if (!entry.held.has(stage)) this.opts.log?.('gpu probe: replica failing, stage out of rotation', { deployment: entry.deployment, id, stage, error: entry.last.error });
      this.opts.controller.holdStageOut(id, CONTROLLER_STAGE[stage], this.now() + 2 * GPU_PROBE_INTERVAL_MS);
      entry.held.add(stage);
    }
    for (const stage of [...entry.held].filter(s => !out.has(s))) {
      this.opts.controller.holdStageOut(id, CONTROLLER_STAGE[stage], 0);
      entry.held.delete(stage);
      this.opts.log?.('gpu probe: stage back in rotation', { deployment: entry.deployment, id, stage });
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(err => this.opts.log?.('gpu probe failed', { error: String(err) })), GPU_PROBE_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

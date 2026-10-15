import { createHash } from 'crypto';
import { emitGatewayEvent } from '../telemetry/emit';
import { askLlm, hear, type S2SConfig, type Speculated, type StageClient } from './composite';

const SPECULATION_TTL_MS = 4_000;
const SPECULATION_MIN_AUDIO_MS = 600;
const SPECULATION_PER_TURN = 2;
const SPECULATION_TAIL_SLACK_MS = 400;
const MAX_LIVE = 256;
const MAX_TURNS = 1_024;

interface SpeculationRef { id: string; turn?: string; action?: 'start' | 'cancel' }

interface Entry { spec: Speculated; audioMs: number; elapsed(): number; timer: ReturnType<typeof setTimeout>; discard(reason: string): void }

const live = new Map<string, Entry>();
const perTurn = new Map<string, number>();
export const speculationCounts = { started: 0, refused: 0, committed: 0, discarded: 0 };

const envMs = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export function wavMs(audio: Uint8Array): number | null {
  const ascii = (at: number) => String.fromCharCode(...audio.subarray(at, at + 4));
  if (audio.length < 44 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') return null;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let byteRate = 0;
  for (let at = 12; at + 8 <= audio.length;) {
    const size = view.getUint32(at + 4, true);
    if (ascii(at) === 'fmt ' && at + 20 <= audio.length) byteRate = view.getUint32(at + 16, true);
    if (ascii(at) === 'data') return byteRate > 0 ? (Math.min(size, audio.length - at - 8) / byteRate) * 1000 : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

const speculationKey = (owner: string, id: string) => createHash('sha256').update(`${owner}\n${id}`).digest('hex');

export function speculationRef(config: S2SConfig): SpeculationRef | null {
  const ref = config.speculation;
  return ref && typeof ref === 'object' && typeof ref.id === 'string' && ref.id ? ref : null;
}

interface StartOptions {
  owner: string;
  ref: SpeculationRef;
  stages: StageClient;
  audio: Uint8Array;
  contentType: string;
  config: S2SConfig;
  now?: () => number;
}

export function startSpeculation(o: StartOptions): { speculative: true } | { speculative: false; reason: string } {
  const refuse = (reason: string) => {
    speculationCounts.refused++;
    emitGatewayEvent('s2s.stt_speculative_refused', { attrs: { reason } });
    return { speculative: false as const, reason };
  };
  if (process.env.S2S_SPECULATE === '0') return refuse('off');
  const audioMs = wavMs(o.audio);
  if (audioMs === null) return refuse('format');
  if (audioMs < envMs('S2S_SPECULATE_MIN_MS', SPECULATION_MIN_AUDIO_MS)) return refuse('short');
  const turnKey = speculationKey(o.owner, o.ref.turn ?? o.ref.id);
  const asked = perTurn.get(turnKey) ?? 0;
  if (asked >= envMs('S2S_SPECULATE_PER_TURN', SPECULATION_PER_TURN)) return refuse('turn_cap');
  if (live.size >= MAX_LIVE) return refuse('busy');
  while (perTurn.size >= MAX_TURNS) perTurn.delete(perTurn.keys().next().value as string);
  perTurn.set(turnKey, asked + 1);

  const key = speculationKey(o.owner, o.ref.id);
  live.get(key)?.discard('superseded');
  const now = o.now ?? (() => performance.now());
  const t0 = now();
  const abort = new AbortController();
  let discarded = false;
  const discard = (reason: string) => {
    abort.abort(new Error(`speculation ${reason}`));
    clearTimeout(entry.timer);
    if (live.get(key) === entry) live.delete(key);
    if (discarded) return;
    discarded = true;
    speculationCounts.discarded++;
    emitGatewayEvent('s2s.stt_speculative_discarded', { attrs: { reason, audio_ms: Math.round(audioMs), stt_done: spec.text !== null } });
  };
  const heard = hear(o.stages, o.audio, o.contentType, o.config, abort.signal).catch((err: Error) => {
    throw Object.assign(err, { spentMs: now() - t0 });
  });
  const spec: Speculated = {
    same: false, text: null, sttMs: null, leadMs: 0, heard,
    chat: heard.then((h) => {
      spec.text = h.text.trim();
      spec.sttMs = Math.round(now() - t0);
      return spec.text && !abort.signal.aborted ? askLlm(o.stages, o.config, spec.text, abort.signal) : null;
    }),
    cancel: (reason) => (reason === 'aborted' || reason === 'llm_failed' ? abort.abort(new Error(`speculation ${reason}`)) : discard(reason)),
  };
  spec.chat.catch(() => {});
  const entry: Entry = { spec, audioMs, discard, elapsed: () => now() - t0, timer: setTimeout(() => discard('expired'), envMs('S2S_SPECULATE_TTL_MS', SPECULATION_TTL_MS)) };
  live.set(key, entry);
  speculationCounts.started++;
  emitGatewayEvent('s2s.stt_speculative', { attrs: { audio_ms: Math.round(audioMs) } });
  return { speculative: true };
}

export function cancelSpeculation(owner: string, id: string, reason = 'cancelled'): boolean {
  const entry = live.get(speculationKey(owner, id));
  entry?.discard(reason);
  return Boolean(entry);
}

export function takeSpeculation(owner: string, id: string, audio: Uint8Array, endpointMs: number): Speculated | null {
  const key = speculationKey(owner, id);
  const entry = live.get(key);
  if (!entry) return null;
  live.delete(key);
  clearTimeout(entry.timer);
  const finalMs = wavMs(audio);
  entry.spec.same = finalMs !== null && Math.abs(finalMs - entry.audioMs) <= endpointMs + SPECULATION_TAIL_SLACK_MS;
  entry.spec.leadMs = Math.round(entry.elapsed());
  speculationCounts.committed++;
  return entry.spec;
}

export function resetSpeculations(): void {
  for (const entry of [...live.values()]) entry.discard('reset');
  perTurn.clear();
  Object.assign(speculationCounts, { started: 0, refused: 0, committed: 0, discarded: 0 });
}

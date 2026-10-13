import type { ProbeResult, ReplicaMachine } from './types';
import { readStateFile, writeStateFile } from './state-file';

export type BootPhase = 'placing' | 'provisioning' | 'pulling' | 'starting' | 'loading' | 'ready';
export type ActivePhase = Exclude<BootPhase, 'ready'>;

export const PHASE_DEFAULT_MINUTES: Record<ActivePhase, number> = { placing: 3, provisioning: 5, pulling: 15, starting: 15, loading: 10 };
export const BOOT_LOG_LINES = 100;
export const BOOTS_KEPT = 5;
const FAILURE_REASONS = new Set(['boot-timeout', 'boot-failed', 'unhealthy', 'halted', 'too-far', 'gone']);

export interface PhaseMark { phase: BootPhase; at: number }
export interface BootRecord { replicaId: string | null; startedAt: number; endedAt: number; result: 'ready' | 'failed' | 'interrupted'; reason: string | null; phases: PhaseMark[] }
export interface BootLogLine { at: number; replicaId: string | null; text: string }
export interface ActiveBoot { replicaId: string | null; phases: PhaseMark[] }
export interface BootHistory { past: Record<string, BootRecord[]>; lines: Record<string, BootLogLine[]> }
export const BOOT_HISTORY_SAVE_MS = 60_000;

export interface BootState {
  phase: ActivePhase;
  replicaId: string | null;
  startedAt: number;
  since: number;
  phaseMinutes: number;
  totalMinutes: number;
  expectedMinutes: number;
  timeoutMinutes: number;
  stuck: boolean;
  phases: PhaseMark[];
}

export function bootPhaseOf(
  m: Pick<ReplicaMachine, 'state' | 'ip' | 'providerStatus'>, probe: { everReady: boolean; last?: ProbeResult } | undefined,
): BootPhase {
  if (probe?.everReady) return 'ready';
  if (m.providerStatus === 'loading') return 'pulling';
  if (m.state !== 'running' || !m.ip) return 'provisioning';
  return probe?.last === 'busy' ? 'loading' : 'starting';
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : null;
};

export function phaseDurations(phases: PhaseMark[], endedAt: number): Array<{ phase: BootPhase; at: number; ms: number }> {
  return phases.map((p, i) => ({ ...p, ms: (phases[i + 1]?.at ?? endedAt) - p.at }));
}

export function expectedPhaseMinutes(phase: ActivePhase, past: BootRecord[]): number {
  const seen = past.filter(b => b.result === 'ready')
    .flatMap(b => phaseDurations(b.phases, b.endedAt).filter(p => p.phase === phase).map(p => p.ms / 60_000));
  const typical = median(seen);
  return typical === null ? PHASE_DEFAULT_MINUTES[phase] : Math.max(2, Math.ceil(typical * 1.5));
}

export function bootStates(active: ActiveBoot[], past: BootRecord[], now: number, timeoutMinutes: number): BootState[] {
  return active.flatMap((b) => {
    const last = b.phases.at(-1);
    if (!last || last.phase === 'ready') return [];
    const phase = last.phase as ActivePhase;
    const phaseMinutes = (now - last.at) / 60_000;
    const totalMinutes = (now - b.phases[0]!.at) / 60_000;
    const expectedMinutes = expectedPhaseMinutes(phase, past);
    return [{
      phase, replicaId: b.replicaId, startedAt: b.phases[0]!.at, since: last.at, phaseMinutes, totalMinutes, expectedMinutes, timeoutMinutes,
      stuck: phaseMinutes > expectedMinutes || totalMinutes > timeoutMinutes, phases: b.phases,
    }];
  });
}

export function logText(msg: string, data: Record<string, unknown> = {}): string {
  const fields = Object.entries(data).filter(([k, v]) => k !== 'deployment' && k !== 'id' && v !== undefined && v !== null && typeof v !== 'object')
    .map(([k, v]) => `${k}=${String(v).slice(0, 300)}`);
  return [msg.replace(/^deployments: /, ''), ...fields].join(' ');
}

export class BootTracker {
  private readonly active = new Map<string, { deployment: string; phases: PhaseMark[] }>();
  private readonly placing = new Map<string, number>();
  private readonly past = new Map<string, BootRecord[]>();
  private readonly lines = new Map<string, BootLogLine[]>();
  private readonly messages = new Map<string, string>();

  line(deployment: string, replicaId: string | null, text: string, at: number): void {
    const list = this.lines.get(deployment) ?? [];
    list.push({ at, replicaId, text });
    this.lines.set(deployment, list.slice(-BOOT_LOG_LINES));
  }

  providerMessage(deployment: string, replicaId: string, message: string | undefined, at: number): void {
    if (!message || this.messages.get(replicaId) === message) return;
    this.messages.set(replicaId, message);
    this.line(deployment, replicaId, `provider: ${message.trim().slice(0, 300)}`, at);
  }

  placingStart(deployment: string, at: number): void {
    if (!this.placing.has(deployment)) this.placing.set(deployment, at);
  }

  placingFailed(deployment: string, reason: string | null, at: number): void {
    const since = this.placing.get(deployment);
    this.placing.delete(deployment);
    this.record(deployment, { replicaId: null, startedAt: since ?? at, endedAt: at, result: 'failed', reason, phases: [{ phase: 'placing', at: since ?? at }] });
  }

  phase(deployment: string, replicaId: string, phase: BootPhase, at: number, bootStartedAt: number): void {
    let boot = this.active.get(replicaId);
    if (!boot) {
      if (phase === 'ready') return;
      const placed = this.placing.get(deployment);
      this.placing.delete(deployment);
      const start = Math.min(bootStartedAt, at);
      boot = { deployment, phases: [...(placed !== undefined && placed < start ? [{ phase: 'placing' as const, at: placed }] : []), { phase, at: start }] };
      this.active.set(replicaId, boot);
      this.line(deployment, replicaId, `phase ${phase}`, at);
      return;
    }
    if (boot.phases.at(-1)!.phase === phase) return;
    boot.phases.push({ phase, at });
    this.line(deployment, replicaId, `phase ${phase}`, at);
    if (phase === 'ready') this.finish(replicaId, 'ready', at);
  }

  finish(replicaId: string, reason: string, at: number): void {
    const boot = this.active.get(replicaId);
    if (!boot) return;
    this.active.delete(replicaId);
    this.messages.delete(replicaId);
    const result = reason === 'ready' ? 'ready' : FAILURE_REASONS.has(reason) ? 'failed' : 'interrupted';
    this.record(boot.deployment, { replicaId, startedAt: boot.phases[0]!.at, endedAt: at, result, reason: result === 'ready' ? null : reason, phases: boot.phases });
  }

  activeIds(): string[] {
    return [...this.active.keys()];
  }

  view(deployment: string): { active: ActiveBoot[]; past: BootRecord[]; log: BootLogLine[] } {
    const placing = this.placing.get(deployment);
    return {
      active: [
        ...(placing !== undefined ? [{ replicaId: null, phases: [{ phase: 'placing' as const, at: placing }] }] : []),
        ...[...this.active].filter(([, b]) => b.deployment === deployment).map(([replicaId, b]) => ({ replicaId, phases: [...b.phases] })),
      ],
      past: [...(this.past.get(deployment) ?? [])].reverse(),
      log: [...(this.lines.get(deployment) ?? [])],
    };
  }

  history(): BootHistory {
    return { past: Object.fromEntries(this.past), lines: Object.fromEntries(this.lines) };
  }

  restore(h: Partial<BootHistory>): void {
    const merge = <T>(into: Map<string, T[]>, from: Record<string, T[]> | undefined, keep: number) => {
      for (const [deployment, list] of Object.entries(from ?? {})) {
        if (Array.isArray(list)) into.set(deployment, [...list.filter(x => x && typeof x === 'object'), ...(into.get(deployment) ?? [])].slice(-keep));
      }
    };
    merge(this.past, h.past, BOOTS_KEPT);
    merge(this.lines, h.lines, BOOT_LOG_LINES);
  }

  private record(deployment: string, boot: BootRecord): void {
    this.past.set(deployment, [...(this.past.get(deployment) ?? []), boot].slice(-BOOTS_KEPT));
  }
}

export function bootHistoryFile(path: string, source: { bootHistory(): BootHistory; restoreBootHistory(h: Partial<BootHistory>): void },
  log?: (msg: string, data?: Record<string, unknown>) => void) {
  let timer: ReturnType<typeof setInterval> | null = null;
  const save = () => writeStateFile(path, JSON.stringify(source.bootHistory())).catch(err => log?.('boot history: write failed', { error: String(err) }));
  return {
    async load(): Promise<void> {
      const read = await readStateFile<BootHistory>(path);
      if (read.data) source.restoreBootHistory(read.data);
    },
    save,
    start(intervalMs = BOOT_HISTORY_SAVE_MS): void {
      if (timer) return;
      timer = setInterval(() => void save(), intervalMs);
      timer.unref?.();
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      await save();
    },
  };
}

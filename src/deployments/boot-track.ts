import type { ProbeResult, ReplicaMachine } from './types';
import { readStateFile, writeStateFile } from './state-file';

export type BootPhase = 'placing' | 'provisioning' | 'pulling' | 'starting' | 'loading' | 'ready';
export type ActivePhase = Exclude<BootPhase, 'ready'>;

export const PHASE_DEFAULT_MINUTES: Record<ActivePhase, number> = { placing: 3, provisioning: 5, pulling: 15, starting: 15, loading: 10 };
export const BOOT_LOG_LINES = 100;
export const BOOTS_KEPT = 5;
const FAILURE_REASONS = new Set(['boot-timeout', 'boot-stuck', 'boot-failed', 'unhealthy', 'halted', 'too-far', 'gone']);

export interface PhaseMark { phase: BootPhase; at: number }
export interface BootRecord {
  replicaId: string | null; startedAt: number; endedAt: number; result: 'ready' | 'failed' | 'interrupted'; reason: string | null; phases: PhaseMark[];
  pulledBytes?: number;
}
export interface BootLogLine { at: number; replicaId: string | null; text: string }
export interface ActiveBoot { replicaId: string | null; phases: PhaseMark[]; report?: BootReport }
export interface BootHistory { past: Record<string, BootRecord[]>; lines: Record<string, BootLogLine[]> }
export const BOOT_HISTORY_SAVE_MS = 60_000;

export const REPORTED_PHASES = ['pulling-image', 'starting-container', 'loading-models', 'failed'] as const;
export type ReportedPhase = typeof REPORTED_PHASES[number];
export const REPORTED_AS: Record<Exclude<ReportedPhase, 'failed'>, ActivePhase> = { 'pulling-image': 'pulling', 'starting-container': 'starting', 'loading-models': 'loading' };
export const REPORT_FRESH_MS = 2 * 60_000;
export const REPORTED_LINES_KEPT = 60;
export const REPLICA_LINE = 'replica: ';
const PROGRESS_MIN_BYTES = 1_000_000;
const SEEN_LINES_KEPT = 500;

export interface BootEvent { phase: ReportedPhase; bytes: number | null; layers: [number, number] | null; exit: number | null; lines: string[] }
export interface BootReport {
  phase: ActivePhase | null; at: number; bytes: number | null; layers: [number, number] | null; progressAt: number;
  failed: { exit: number | null; at: number } | null;
}

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
  reported: boolean;
  progress: { bytes: number | null; totalBytes: number | null; layers: [number, number] | null } | null;
  failed: { exit: number | null } | null;
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
  const floor = phase === 'pulling' ? SLOW_PULL_FLOOR_MINUTES : 2;
  return typical === null ? PHASE_DEFAULT_MINUTES[phase] : Math.max(floor, Math.ceil(typical * 1.5));
}

/**
 * A pull slower than its host's measured bandwidth promises is retried on another offer before the clock-only rule:
 * the limit is `SLOW_PULL_FACTOR` × the download the host's `inet_down` promises, at least `SLOW_PULL_FLOOR_MINUTES`,
 * never later than the history rule. Calibration (15/10/2026): Poland, 894 Mbps, pulled the 22.3 GB speech-stack in
 * 10.4 min against 3.3 min promised (3.1×); two Bulgarian hosts sat 15 min in `pulling` and never finished.
 */
export const SLOW_PULL_FACTOR = 4;
export const SLOW_PULL_FLOOR_MINUTES = 8;

export function pullLimitMinutes(history: number, expectedPullMinutes: number | undefined): number {
  return expectedPullMinutes ? Math.min(history, Math.max(SLOW_PULL_FLOOR_MINUTES, Math.ceil(SLOW_PULL_FACTOR * expectedPullMinutes))) : history;
}

export function bootStates(
  active: ActiveBoot[], past: BootRecord[], now: number, timeoutMinutes: number, expectedPullOf?: (replicaId: string) => number | undefined,
): BootState[] {
  return active.flatMap((b) => {
    const last = b.phases.at(-1);
    if (!last || last.phase === 'ready') return [];
    const phase = last.phase as ActivePhase;
    const phaseMinutes = (now - last.at) / 60_000;
    const totalMinutes = (now - b.phases[0]!.at) / 60_000;
    const history = expectedPhaseMinutes(phase, past);
    const expectedMinutes = phase === 'pulling' && b.replicaId ? pullLimitMinutes(history, expectedPullOf?.(b.replicaId)) : history;
    const r = b.report;
    const pulling = phase === 'pulling' && r?.phase === 'pulling';
    const progressing = pulling && now - r.progressAt <= REPORT_FRESH_MS;
    const failed = r?.failed ? { exit: r.failed.exit } : null;
    return [{
      phase, replicaId: b.replicaId, startedAt: b.phases[0]!.at, since: last.at, phaseMinutes, totalMinutes, expectedMinutes, timeoutMinutes,
      stuck: failed !== null || totalMinutes > timeoutMinutes || (phaseMinutes > expectedMinutes && !progressing), phases: b.phases,
      reported: !!r && r.phase === phase && now - r.at <= REPORT_FRESH_MS,
      progress: pulling ? { bytes: r.bytes, totalBytes: past.find(p => p.result === 'ready' && p.pulledBytes)?.pulledBytes ?? null, layers: r.layers } : null,
      failed,
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
  private readonly reports = new Map<string, BootReport & { seen: Set<string> }>();

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

  report(deployment: string, replicaId: string, ev: BootEvent, at: number): void {
    const prev = this.reports.get(replicaId);
    const phase = ev.phase === 'failed' ? prev?.phase ?? null : REPORTED_AS[ev.phase];
    const bytes = ev.bytes ?? prev?.bytes ?? null;
    const moved = !prev || phase !== prev.phase || (bytes ?? 0) - (prev.bytes ?? 0) >= PROGRESS_MIN_BYTES || (ev.layers?.[0] ?? 0) > (prev.layers?.[0] ?? 0);
    const seen = prev?.seen ?? new Set<string>();
    this.reports.set(replicaId, {
      phase, at, bytes, layers: ev.layers ?? (phase === prev?.phase ? prev.layers : null), progressAt: moved ? at : prev?.progressAt ?? at,
      failed: ev.phase === 'failed' ? { exit: ev.exit, at } : prev?.failed ?? null, seen,
    });
    for (const text of ev.lines) {
      if (seen.has(text)) continue;
      seen.add(text);
      if (seen.size > SEEN_LINES_KEPT) seen.delete(seen.values().next().value!);
      this.line(deployment, replicaId, `${REPLICA_LINE}${text}`, at);
    }
    if (ev.phase === 'failed') this.line(deployment, replicaId, `${REPLICA_LINE}boot failed${ev.exit === null ? '' : ` (exit ${ev.exit})`}`, at);
    this.capReported(deployment, replicaId);
    if (phase && ev.phase !== 'failed') this.phase(deployment, replicaId, phase, at, at);
  }

  reportedPhase(replicaId: string, now: number): ActivePhase | null {
    const r = this.reports.get(replicaId);
    return r && now - r.at <= REPORT_FRESH_MS ? r.phase : null;
  }

  private capReported(deployment: string, replicaId: string): void {
    const list = this.lines.get(deployment) ?? [];
    const mine = (l: BootLogLine) => l.replicaId === replicaId && l.text.startsWith(REPLICA_LINE);
    let extra = list.filter(mine).length - REPORTED_LINES_KEPT;
    if (extra > 0) this.lines.set(deployment, list.filter(l => !(mine(l) && extra-- > 0)));
  }

  placingStart(deployment: string, at: number): void {
    if (!this.placing.has(deployment)) this.placing.set(deployment, at);
  }

  placingDone(deployment: string): void {
    this.placing.delete(deployment);
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
    const pulledBytes = this.reports.get(replicaId)?.bytes;
    this.reports.delete(replicaId);
    const result = reason === 'ready' ? 'ready' : FAILURE_REASONS.has(reason) ? 'failed' : 'interrupted';
    this.record(boot.deployment, {
      replicaId, startedAt: boot.phases[0]!.at, endedAt: at, result, reason: result === 'ready' ? null : reason, phases: boot.phases,
      ...(result === 'ready' && pulledBytes ? { pulledBytes } : {}),
    });
  }

  activeIds(): string[] {
    return [...this.active.keys()];
  }

  view(deployment: string): { active: ActiveBoot[]; past: BootRecord[]; log: BootLogLine[] } {
    const placing = this.placing.get(deployment);
    return {
      active: [
        ...(placing !== undefined ? [{ replicaId: null, phases: [{ phase: 'placing' as const, at: placing }] }] : []),
        ...[...this.active].filter(([, b]) => b.deployment === deployment).map(([replicaId, b]) => {
          const r = this.reports.get(replicaId);
          return { replicaId, phases: [...b.phases], ...(r ? { report: { phase: r.phase, at: r.at, bytes: r.bytes, layers: r.layers, progressAt: r.progressAt, failed: r.failed } } : {}) };
        }),
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

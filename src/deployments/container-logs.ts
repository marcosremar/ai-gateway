import { stripVTControlCharacters } from 'util';
import { redact } from '../telemetry/alert-email';
import type { ReplicaMachine } from './types';

export const CONTAINER_LOG_TTL_MS = 5 * 60_000;
export const CONTAINER_LOG_LINES = 200;
export const CONTAINER_LOG_BYTES = 32 * 1024;
const CONTAINER_LOGS_KEPT = 50;
export const PAGE_LOG_WAIT_MS = 4_000;
export const STUCK_LOG_WAIT_MS = 10_000;

export interface ContainerLog { deployment: string; replicaId: string; at: number; lines: string[]; error: string | null }
export interface ContainerLogView { reason: 'unsupported' | 'no-replica' | null; pending: boolean; log: ContainerLog | null }

export function capLog(text: string, secrets: string[]): string[] {
  const lines = stripVTControlCharacters(text).split('\n').map(l => l.split('\r').at(-1)!.trimEnd()).filter(Boolean);
  const kept = Buffer.from(redact(lines.slice(-CONTAINER_LOG_LINES).join('\n'), secrets));
  return kept.subarray(-CONTAINER_LOG_BYTES).toString('utf8').split('\n').filter(Boolean);
}

export function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<null>(r => { timer = setTimeout(r, ms, null); })]).finally(() => clearTimeout(timer));
}

export class ContainerLogCache {
  private readonly logs = new Map<string, ContainerLog>();
  private readonly reading = new Map<string, Promise<ContainerLog>>();

  constructor(private readonly now: () => number) {}

  latest(deployment: string): ContainerLog | null {
    return [...this.logs.values()].filter(l => l.deployment === deployment).sort((a, b) => b.at - a.at)[0] ?? null;
  }

  read(m: ReplicaMachine, fetchText: () => Promise<string>, secrets: string[]): Promise<ContainerLog> {
    const cached = this.logs.get(m.id);
    if (cached && this.now() - cached.at < CONTAINER_LOG_TTL_MS) return Promise.resolve(cached);
    const running = this.reading.get(m.id);
    if (running) return running;
    const done = fetchText().then(
      text => ({ lines: capLog(text, secrets), error: null }),
      (err: unknown) => ({ lines: [], error: redact(err instanceof Error ? err.message : String(err), secrets).slice(0, 300) }),
    ).then((got) => {
      const log = { deployment: m.deployment, replicaId: m.id, at: this.now(), ...got };
      this.logs.delete(m.id);
      this.logs.set(m.id, log);
      if (this.logs.size > CONTAINER_LOGS_KEPT) this.logs.delete(this.logs.keys().next().value!);
      return log;
    }).finally(() => this.reading.delete(m.id));
    this.reading.set(m.id, done);
    return done;
  }
}

import { readStateFile, writeStateFile } from '../deployments/state-file';

export type IncidentActionKind = 'park' | 'retry' | 'reorder';
export type IncidentResolution = 'cleared' | 'quiet';

export interface IncidentAlert { at: string; summary: string }
export interface IncidentAction { at: string; kind: IncidentActionKind; target: string; detail: string }

export interface Incident {
  id: string; event: string; key: string; startedAt: string; lastSeenAt: string; endedAt: string | null;
  alerts: IncidentAlert[]; alertCount: number; actions: IncidentAction[]; resolution: IncidentResolution | null; mailed: boolean;
}

export const INCIDENT_QUIET_MS = 30 * 60_000;
export const INCIDENTS_KEPT = 200;
const ENTRIES_KEPT = 20;
const TOKEN = /[\s|,;()[\]]+/;

const ACTION_LOGS: Record<string, IncidentActionKind> = {
  'deployments: parking replica (power off)': 'park',
  'deployments: stuck boot, releasing to retry': 'retry',
};

export const alertSummary = (data: Record<string, unknown>) => Object.entries(data).filter(([k]) => k !== 'at')
  .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ').slice(0, 300);

export function incidentQuietMs(env: Record<string, string | undefined>): number {
  const minutes = Number(env.INCIDENT_QUIET_MIN);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : INCIDENT_QUIET_MS;
}

export function createIncidents(opts: {
  path?: string | null; now?: () => number; quietMs?: number;
  onResolve?: (incident: Incident) => void;
  log?: (msg: string, data?: Record<string, unknown>) => void;
} = {}) {
  const now = opts.now ?? Date.now;
  const quietMs = opts.quietMs ?? INCIDENT_QUIET_MS;
  let list: Incident[] = [];
  const cleared = new Set<string>();
  const reorders = new Set<string>();
  let writing: Promise<void> = Promise.resolve();

  const iso = () => new Date(now()).toISOString();
  const open = () => list.filter(i => !i.endedAt);
  const openOf = (event: string, key: string) => list.find(i => !i.endedAt && i.event === event && i.key === key) ?? null;
  const tokens = (i: Incident) => new Set([i.key, ...i.alerts.map(a => a.summary)].join(' ').split(TOKEN));

  function save(): Promise<void> {
    if (!opts.path) return Promise.resolve();
    const path = opts.path;
    const text = JSON.stringify({ incidents: list });
    writing = writing.then(() => writeStateFile(path, text)).catch((err: unknown) => {
      opts.log?.('incidents: write failed', { error: err instanceof Error ? err.message : String(err) });
    });
    return writing;
  }

  function close(i: Incident, resolution: IncidentResolution): void {
    i.endedAt = iso();
    i.resolution = resolution;
    opts.onResolve?.(i);
  }

  function action(kind: IncidentActionKind, target: string, detail: string): void {
    const hit = open().filter(i => tokens(i).has(target));
    for (const i of hit) i.actions = [...i.actions, { at: iso(), kind, target, detail }].slice(-ENTRIES_KEPT);
    if (hit.length) void save();
  }

  return {
    async load(): Promise<void> {
      if (!opts.path) return;
      const read = await readStateFile<{ incidents?: Incident[] }>(opts.path);
      list = Array.isArray(read.data?.incidents) ? read.data.incidents : [];
      for (const i of open()) i.lastSeenAt = iso();
    },
    seen(alert: { event: string; key?: string; data: Record<string, unknown> }, sent: boolean): Incident {
      const key = alert.key ?? '';
      let i = openOf(alert.event, key);
      const at = iso();
      if (!i) {
        i = { id: `${alert.event}|${key}|${now()}`, event: alert.event, key, startedAt: at, lastSeenAt: at, endedAt: null, alerts: [], alertCount: 0, actions: [], resolution: null, mailed: false };
        list = [i, ...list].slice(0, INCIDENTS_KEPT);
      }
      i.lastSeenAt = at;
      if (sent || !i.alertCount) {
        i.alerts = [{ at, summary: alertSummary(alert.data) }, ...i.alerts].slice(0, ENTRIES_KEPT);
        i.alertCount++;
        void save();
      }
      return i;
    },
    clear(event: string, active: Set<string>): void {
      cleared.add(event);
      const gone = open().filter(i => i.event === event && !i.key.split(',').some(part => active.has(part)));
      for (const i of gone) close(i, 'cleared');
      if (gone.length) void save();
    },
    action,
    fromDeploymentLog(msg: string, data: Record<string, unknown> = {}): void {
      const kind = ACTION_LOGS[msg];
      if (kind && typeof data.deployment === 'string') action(kind, data.deployment, typeof data.id === 'string' ? `réplica ${data.id}` : '');
    },
    tick(promotions: Array<{ chainKey: string; since: number; leader: string; declared: string }> = []): void {
      for (const p of promotions) {
        const id = `${p.chainKey}|${p.since}`;
        if (reorders.has(id)) continue;
        reorders.add(id);
        action('reorder', p.chainKey.split('|').at(-1)!, `${p.leader} antes de ${p.declared}`);
      }
      const quiet = open().filter(i => !cleared.has(i.event) && now() - Date.parse(i.lastSeenAt) >= quietMs);
      for (const i of quiet) close(i, 'quiet');
      if (quiet.length) void save();
    },
    markMailed(id: string): void {
      const i = list.find(x => x.id === id);
      if (!i || i.mailed) return;
      i.mailed = true;
      void save();
    },
    openOf,
    list: (): Incident[] => list.map(i => ({ ...i })),
    flush: () => writing,
    quietMinutes: quietMs / 60_000,
  };
}

export type Incidents = ReturnType<typeof createIncidents>;

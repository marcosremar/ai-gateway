/**
 * Janitor: runs INSIDE the gateway process (every `intervalMs`, default 5 min) and deletes what only bills: leftovers
 * that no deployment owns, so the controller's own loop (idle scale-to-zero, orphan replicas, retried releases)
 * never sees them.
 *
 *   - Image build machines (`aigw-build`, scripts/build-image-on-scaleway.ts) older than `buildMaxMs` (3 h; a build
 *     takes ~15 min and the script deletes its machine — this catches the run that crashed or was killed).
 *   - SBS volumes Scaleway created with a server (`<image>_sbs_volume_<n>`) left detached for `volumeMaxMs` (1 h):
 *     Scaleway never deletes them with the server, and a release that died midway leaves them billing.
 *
 * Only these two shapes are touched: never a running replica (the controller's), never a named volume someone made
 * on purpose. The out-of-process reaper (reaper.ts, a Railway cron) stays: when the gateway itself is down, nothing
 * in this process runs. Decisions are pure (`janitorPlan`) and unit-tested; the I/O is a thin `JanitorCloud`.
 */

export const BUILD_TAG = 'aigw-build';
const AUTO_VOLUME_NAME = /_sbs_volume_\d+$/;

export interface JanitorServer { id: string; zone: string; name: string; tags: string[]; createdAt: number }
export interface JanitorVolume { id: string; zone: string; name: string; status: string; attached: boolean; updatedAt: number; sizeGb: number }

export interface JanitorCloud {
  listServersByTag(tag: string): Promise<JanitorServer[]>;
  listVolumes(): Promise<JanitorVolume[]>;
  deleteServer(server: JanitorServer): Promise<void>;
  deleteVolume(volume: JanitorVolume): Promise<void>;
}

export interface JanitorLimits { buildMaxMs: number; volumeMaxMs: number }
export const JANITOR_DEFAULTS: JanitorLimits & { intervalMs: number } = { buildMaxMs: 3 * 3_600_000, volumeMaxMs: 3_600_000, intervalMs: 5 * 60_000 };

export interface JanitorPlan { servers: JanitorServer[]; volumes: JanitorVolume[] }

export function janitorPlan(input: { builds: JanitorServer[]; volumes: JanitorVolume[]; now: number; limits: JanitorLimits }): JanitorPlan {
  const { now, limits } = input;
  return {
    servers: input.builds.filter(s => s.tags.includes(BUILD_TAG) && now - s.createdAt >= limits.buildMaxMs),
    volumes: input.volumes.filter(v => !v.attached && v.status === 'available' && AUTO_VOLUME_NAME.test(v.name)
      && now - v.updatedAt >= limits.volumeMaxMs),
  };
}

export interface JanitorResult { deleted: string[]; failed: string[] }

export async function runJanitor(opts: {
  cloud: JanitorCloud; limits?: JanitorLimits; now?: () => number; log?: (msg: string, data?: Record<string, unknown>) => void;
}): Promise<JanitorResult> {
  const log = opts.log ?? (() => {});
  const [builds, volumes] = await Promise.all([opts.cloud.listServersByTag(BUILD_TAG), opts.cloud.listVolumes()]);
  const plan = janitorPlan({ builds, volumes, now: (opts.now ?? Date.now)(), limits: opts.limits ?? JANITOR_DEFAULTS });
  const deleted: string[] = [];
  const failed: string[] = [];
  const attempt = async (id: string, what: Record<string, unknown>, del: () => Promise<void>) => {
    try {
      await del();
      deleted.push(id);
      log('janitor: deleted', what);
    } catch (err) {
      failed.push(id);
      log('janitor: delete failed', { ...what, error: err instanceof Error ? err.message : String(err) });
    }
  };
  for (const s of plan.servers) await attempt(s.id, { kind: 'build-server', id: s.id, name: s.name, zone: s.zone }, () => opts.cloud.deleteServer(s));
  for (const v of plan.volumes) await attempt(v.id, { kind: 'volume', id: v.id, name: v.name, zone: v.zone, sizeGb: v.sizeGb }, () => opts.cloud.deleteVolume(v));
  return { deleted, failed };
}

/** Starts the periodic sweep; returns a stop function. A sweep that throws (a zone that did not answer) is logged and retried next time. */
export function startJanitor(opts: Parameters<typeof runJanitor>[0] & { intervalMs?: number }): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runJanitor(opts); } catch (err) {
      opts.log?.('janitor: sweep failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? JANITOR_DEFAULTS.intervalMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

/**
 * Vast account sweep: runs INSIDE the gateway (every `intervalMs`, default 15 min) over EVERY instance of the Vast
 * account, the ones no gateway declared included (made by hand, by an old script, by another app). Owner, 24/10/2026:
 * «não pode deixar essas máquinas assim» — instance 54045930 (`voice-gpu@dev`) sat stopped 20 days billing its disk.
 *
 * Per instance (`sweepVerdicts`, pure):
 *   - label with the word `keep` → never touched;
 *   - running (or starting) → never destroyed; not declared by a gateway → alert only (it may be someone's work);
 *   - stopped/offline and the account credit under the floor (`VAST_MIN_CREDIT_USD`, or ≤ 0) → destroyed now, declared
 *     or not: the disk keeps billing and deepens the negative balance;
 *   - stopped/offline, declared by a gateway (label `aigw:` / `aigw-m:`) → left to that gateway's own rule (12 h parked);
 *   - stopped/offline, not declared, for `stoppedMaxMs` (24 h) → destroyed.
 * "Stopped since" is the first sweep that saw it stopped (Vast gives no stop date), kept in a state file so a redeploy
 * does not restart the clock. `destroy: false` (the default, `VAST_SWEEP_DESTROY` unset) only logs and alerts what it
 * would destroy.
 */

import { readStateFile, writeStateFile } from './state-file';
import type { VastAccountInstance, VastDeploymentBackend } from './vast-backend';

export interface VastSweepLimits { stoppedMaxMs: number; destroy: boolean; minCreditUsd: number }
export const VAST_SWEEP_DEFAULTS = { stoppedMaxMs: 24 * 3_600_000, intervalMs: 15 * 60_000 };

export type SweepAction = 'destroy' | 'alert' | 'none';
export interface SweepVerdict {
  id: string; label: string; state: string; gpu: string; declared: boolean; keep: boolean;
  stoppedHours: number | null; diskUsdPerDay: number; usdPerHour: number | null; action: SweepAction; reason: string;
}

const STOPPED = new Set(['stopped', 'exited']);
const isDeclared = (label: string) => label.startsWith('aigw:') || label.startsWith('aigw-m:');
const hasKeep = (label: string) => /(^|[^a-z])keep([^a-z]|$)/i.test(label);
const round = (n: number, step: number) => Math.round(n / step) * step;

export function sweepVerdicts(input: {
  instances: VastAccountInstance[]; stoppedSince: ReadonlyMap<string, number>; creditUsd: number | null; now: number; limits: VastSweepLimits;
}): SweepVerdict[] {
  const { limits, now, creditUsd } = input;
  const noCredit = creditUsd !== null && (creditUsd <= 0 || creditUsd < limits.minCreditUsd);
  return input.instances.map((i) => {
    const declared = isDeclared(i.label);
    const keep = hasKeep(i.label);
    const stopped = STOPPED.has(i.state);
    const since = stopped ? input.stoppedSince.get(i.id) ?? now : null;
    const stoppedMs = since === null ? null : now - since;
    const verdict = (action: SweepAction, reason: string): SweepVerdict => ({
      id: i.id, label: i.label, state: i.state, gpu: i.gpu, declared, keep,
      stoppedHours: stoppedMs === null ? null : round(stoppedMs / 3_600_000, 0.1),
      diskUsdPerDay: round((i.diskUsdPerHour ?? 0) * 24, 0.01), usdPerHour: i.usdPerHour, action, reason,
    });
    if (keep) return verdict('none', 'label keep');
    if (!stopped) return declared ? verdict('none', 'running, declared') : verdict('alert', 'running, not declared by a gateway');
    if (noCredit) return verdict('destroy', `stopped and the Vast credit $${creditUsd!.toFixed(2)} is under the floor $${limits.minCreditUsd}`);
    if (declared) return verdict('none', 'stopped, declared: its gateway parks/deletes it (12 h)');
    if (stoppedMs! >= limits.stoppedMaxMs) return verdict('destroy', `stopped, not declared, ${round(stoppedMs! / 3_600_000, 0.1)} h`);
    return verdict('none', `stopped, not declared, waits until ${limits.stoppedMaxMs / 3_600_000} h`);
  });
}

type SweepVast = Pick<VastDeploymentBackend, 'accountInstances' | 'destroyInstance' | 'refreshCredit'>;
type Log = (msg: string, data?: Record<string, unknown>) => void;

export interface VastSweepResult { creditUsd: number | null; verdicts: SweepVerdict[]; destroyed: string[]; failed: string[] }

export class VastSweep {
  private stoppedSince = new Map<string, number>();
  private loaded = false;
  private lowCredit = false;

  constructor(private readonly opts: {
    vast: SweepVast; limits: VastSweepLimits; statePath?: string; now?: () => number; log?: Log;
  }) {}

  private get log(): Log { return this.opts.log ?? (() => {}); }

  private async load(): Promise<void> {
    if (this.loaded || !this.opts.statePath) return;
    const { data } = await readStateFile<{ stoppedSince?: Record<string, number> }>(this.opts.statePath);
    this.stoppedSince = new Map(Object.entries(data?.stoppedSince ?? {}));
    this.loaded = true;
  }

  private async save(): Promise<void> {
    if (!this.opts.statePath) return;
    await writeStateFile(this.opts.statePath, JSON.stringify({ stoppedSince: Object.fromEntries(this.stoppedSince) }));
  }

  async run(): Promise<VastSweepResult> {
    await this.load();
    const now = (this.opts.now ?? Date.now)();
    const { limits } = this.opts;
    const [instances, creditUsd] = await Promise.all([this.opts.vast.accountInstances(), this.opts.vast.refreshCredit()]);
    const stoppedIds = new Set(instances.filter(i => STOPPED.has(i.state)).map(i => i.id));
    for (const id of stoppedIds) if (!this.stoppedSince.has(id)) this.stoppedSince.set(id, now);
    for (const id of [...this.stoppedSince.keys()]) if (!stoppedIds.has(id)) this.stoppedSince.delete(id);
    const verdicts = sweepVerdicts({ instances, stoppedSince: this.stoppedSince, creditUsd, now, limits });
    this.log('vast-sweep: swept', { creditUsd, destroy: limits.destroy, instances: verdicts });
    this.noteCredit(creditUsd, verdicts);
    const destroyed: string[] = [];
    const failed: string[] = [];
    for (const v of verdicts) {
      if (v.action === 'alert') this.log('vast-sweep: undeclared instance running', { ...v });
      if (v.action !== 'destroy') continue;
      if (!limits.destroy) { this.log('vast-sweep: would destroy instance', { ...v, dryRun: true }); continue; }
      this.log('vast-sweep: destroying instance', { ...v });
      try {
        await this.opts.vast.destroyInstance(v.id);
        destroyed.push(v.id);
        this.stoppedSince.delete(v.id);
        this.log('vast-sweep: instance destroyed', { ...v });
      } catch (err) {
        failed.push(v.id);
        this.log('vast-sweep: destroy failed', { ...v, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await this.save().catch(err => this.log('vast-sweep: state save failed', { error: err instanceof Error ? err.message : String(err) }));
    return { creditUsd, verdicts, destroyed, failed };
  }

  /** One alert when the credit falls under the floor (balance, instances, cost per day); again only after it came back. */
  private noteCredit(creditUsd: number | null, verdicts: SweepVerdict[]): void {
    if (creditUsd === null) return;
    const low = creditUsd <= 0 || creditUsd < this.opts.limits.minCreditUsd;
    if (low && !this.lowCredit) {
      const running = verdicts.filter(v => !STOPPED.has(v.state)).reduce((sum, v) => sum + (v.usdPerHour ?? 0) * 24, 0);
      const disks = verdicts.filter(v => STOPPED.has(v.state)).reduce((sum, v) => sum + v.diskUsdPerDay, 0);
      this.log('vast-sweep: no credit', {
        provider: 'vast', balanceUsd: creditUsd, floorUsd: this.opts.limits.minCreditUsd, usdPerDay: round(running + disks, 0.01),
        instances: verdicts.map(v => `${v.id} ${v.label || '(no label)'} ${v.state} → ${v.action}`).join('; '),
      });
    }
    this.lowCredit = low;
  }
}

export function startVastSweep(sweep: VastSweep, intervalMs: number, log?: Log): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sweep.run(); } catch (err) {
      log?.('vast-sweep: sweep failed', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

export function vastSweepFromEnv(env: Record<string, string | undefined>): { on: boolean; destroy: boolean; stoppedMaxMs: number; intervalMs: number } {
  const hours = Number(env.VAST_SWEEP_STOPPED_HOURS);
  const minutes = Number(env.VAST_SWEEP_INTERVAL_MINUTES);
  return {
    on: env.VAST_SWEEP !== '0',
    destroy: env.VAST_SWEEP_DESTROY === '1',
    stoppedMaxMs: Number.isFinite(hours) && hours >= 1 ? hours * 3_600_000 : VAST_SWEEP_DEFAULTS.stoppedMaxMs,
    intervalMs: Number.isFinite(minutes) && minutes >= 1 ? minutes * 60_000 : VAST_SWEEP_DEFAULTS.intervalMs,
  };
}

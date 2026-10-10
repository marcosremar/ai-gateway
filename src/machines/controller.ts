import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { portKeys } from './backends';
import { JOB_LOG_LIMIT, JOB_REPORT_PATH, jobScript } from './job-script';
import { MachineError, type JobInputSpec, type MachineInput } from './spec';
import type { MachineStore, MachineState } from './store';
import type {
  JobRecord, JobStatus, JobView, MachineBackend, MachineLimits, MachineProvider, MachineRecord, MachineView, ProviderMachine,
} from './types';

type Log = (msg: string, data?: Record<string, unknown>) => void;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEEP_ENDED_MS = 40 * DAY;
const ACTIVE = new Set(['creating', 'running']);

export interface MachineControllerOptions {
  backends: Partial<Record<MachineProvider, MachineBackend>>;
  store: MachineStore;
  namespace: string;
  limits: MachineLimits;
  publicUrl?: string;
  now?: () => number;
  log?: Log;
  lostGraceMs?: number;
  orphanGraceMs?: number;
}

export interface JobReport {
  status: string;
  exitCode: number | null;
  log: string;
  bytes: number | null;
  sha256: string | null;
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const monthStart = (now: number) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

export class MachineController {
  readonly namespace: string;
  readonly limits: MachineLimits;
  private state: MachineState = { machines: {}, jobs: {} };
  private readonly creating = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciling: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly log: Log;

  constructor(private readonly opts: MachineControllerOptions) {
    this.namespace = opts.namespace;
    this.limits = opts.limits;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  get providers(): MachineProvider[] {
    return Object.keys(this.opts.backends) as MachineProvider[];
  }

  async init(): Promise<void> {
    this.state = await this.opts.store.load();
    if (this.opts.store.recovered) this.log('machines: STATE FILE UNREADABLE, recovered from the last good backup', { problem: this.opts.store.recovered });
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.reconcile().catch(err => this.log('machines: reconcile failed', { error: errText(err) })); }, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.reconciling;
    await this.opts.store.settled();
  }

  private save(): Promise<void> {
    return this.opts.store.save(this.state);
  }

  private records(): MachineRecord[] {
    return Object.values(this.state.machines);
  }

  costUsd(m: MachineRecord, from = -Infinity, to = this.now()): number {
    if (m.startedAt == null || m.usdPerHour == null) return 0;
    const ms = Math.min(m.endedAt ?? to, to) - Math.max(m.startedAt, from);
    return ms > 0 ? (ms / HOUR) * m.usdPerHour : 0;
  }

  private committed(m: MachineRecord, now: number): number {
    if (!ACTIVE.has(m.status) || m.endReason) return 0;
    return (Math.max(0, m.deadlineAt - now) / HOUR) * (m.usdPerHour ?? m.request.maxUsdPerHour);
  }

  private spend(filter: (m: MachineRecord) => boolean, from: number): { spent: number; committed: number } {
    const now = this.now();
    const mine = this.records().filter(filter);
    return { spent: mine.reduce((s, m) => s + this.costUsd(m, from, now), 0), committed: mine.reduce((s, m) => s + this.committed(m, now), 0) };
  }

  private checkBudget(owner: string, holder: string | null, addUsd: number): void {
    const now = this.now();
    const caps: Array<[string, (m: MachineRecord) => boolean, number, number, string]> = [
      [`app '${owner}' in 24 h`, m => m.owner === owner, now - DAY, this.limits.ownerUsdPerDay, 'MACHINES_OWNER_USD_PER_DAY'],
      [`app '${owner}' this month`, m => m.owner === owner, monthStart(now), this.limits.ownerUsdPerMonth, 'MACHINES_OWNER_USD_PER_MONTH'],
      ...(holder ? [[`holder '${holder}' of '${owner}' in 24 h`, (m: MachineRecord) => m.owner === owner && m.holder === holder, now - DAY,
        this.limits.holderUsdPerDay, 'MACHINES_HOLDER_USD_PER_DAY'] as [string, (m: MachineRecord) => boolean, number, number, string]] : []),
      ['the gateway in 24 h', () => true, now - DAY, this.limits.globalUsdPerDay, 'MACHINES_USD_PER_DAY'],
    ];
    for (const [who, filter, from, cap, knob] of caps) {
      if (cap <= 0) continue;
      const { spent, committed } = this.spend(filter, from);
      if (spent + committed + addUsd <= cap + 1e-9) continue;
      throw new MachineError(402, `spend cap of ${who} reached: spent $${spent.toFixed(2)} + committed $${committed.toFixed(2)} (running leases`
        + ` to their deadline) + this request $${addUsd.toFixed(2)} > cap $${cap.toFixed(2)}. Release machines you no longer use`
        + ` (DELETE /v1/machines/:id), ask for fewer hours or a lower maxUsdPerHour, or ask the operator to raise ${knob}.`);
    }
  }

  private newId(prefix: string): string {
    return `${prefix}-${randomBytes(6).toString('hex')}`;
  }

  async create(owner: string, input: MachineInput, extra: { id?: string; jobId?: string } = {}): Promise<MachineRecord> {
    const { request } = input;
    const choices = request.provider === 'cheapest' ? this.providers : [request.provider];
    if (!choices.length || choices.some(p => !this.opts.backends[p])) {
      throw new MachineError(400, `provider ${request.provider} is not configured here (configured: ${this.providers.join(', ') || 'none'})`);
    }
    const now = this.now();
    if (this.records().filter(m => ACTIVE.has(m.status)).length >= this.limits.maxRunning) {
      throw new MachineError(429, `the gateway already runs ${this.limits.maxRunning} machines (MACHINES_MAX_RUNNING): release one first`);
    }
    this.checkBudget(owner, input.holder, request.maxUsdPerHour * input.maxHours);
    const record: MachineRecord = {
      id: extra.id ?? this.newId('m'), owner, holder: input.holder, namespace: this.namespace, request, provider: null, providerId: null,
      status: 'creating', ip: null, ports: {}, usdPerHour: null, createdAt: now, startedAt: null, endedAt: null,
      deadlineAt: now + input.maxHours * HOUR, idleMinutes: extra.jobId ? 0 : input.idleMinutes, lastSeenAt: now, endReason: null,
      jobId: extra.jobId ?? null, lastError: null,
    };
    this.state.machines[record.id] = record;
    this.creating.add(record.id);
    try {
      await this.save();
      const errors: string[] = [];
      for (const provider of await this.order(choices, input)) {
        try {
          const made = await this.opts.backends[provider]!.create({ machineId: record.id, namespace: this.namespace, request });
          if (record.status !== 'creating') {
            await this.opts.backends[provider]!.release(made.providerId).catch(() => {});
            throw new MachineError(409, `machine '${record.id}' was released while it was being created`);
          }
          this.adopt(record, made);
          await this.save();
          this.log('machines: created', { id: record.id, owner, provider, providerId: made.providerId, usdPerHour: record.usdPerHour });
          return record;
        } catch (err) {
          if (err instanceof MachineError) throw err;
          errors.push(`${provider}: ${errText(err)}`);
        }
      }
      record.status = 'failed';
      record.endedAt = this.now();
      record.lastError = errors.join('; ') || 'cancelled';
      await this.save();
      const stock = errors.length > 0 && errors.every(e => /out_of_stock/.test(e));
      throw new MachineError(stock ? 409 : 502, `no machine created: ${record.lastError}`);
    } finally {
      this.creating.delete(record.id);
    }
  }

  private async order(choices: MachineProvider[], input: MachineInput): Promise<MachineProvider[]> {
    if (choices.length === 1) return choices;
    const quotes = await Promise.all(choices.map(async p => ({ p, q: await this.opts.backends[p]!.quote(input.request).catch(() => null) })));
    return quotes.filter(x => x.q != null).sort((a, b) => a.q! - b.q!).map(x => x.p);
  }

  private adopt(record: MachineRecord, made: ProviderMachine): void {
    record.provider = made.provider;
    record.providerId = made.providerId;
    record.status = 'running';
    record.startedAt = record.startedAt ?? Math.min(this.now(), Math.max(record.createdAt, made.createdAt));
    record.usdPerHour = made.usdPerHour ?? record.usdPerHour ?? record.request.maxUsdPerHour;
    this.refresh(record, made);
  }

  private refresh(record: MachineRecord, seen: ProviderMachine): void {
    record.ip = seen.ip ?? record.ip;
    const identity = record.provider === 'scaleway' ? Object.fromEntries(portKeys(record.request).map(k => [k, Number(k.split('/')[0])])) : {};
    record.ports = Object.keys(seen.ports).length ? seen.ports : { ...identity, ...record.ports };
  }

  get(id: string): MachineRecord | null {
    return this.state.machines[id] ?? null;
  }

  list(owner: string | null): MachineRecord[] {
    return this.records().filter(m => owner === null || m.owner === owner).sort((a, b) => b.createdAt - a.createdAt);
  }

  async extend(id: string, hours: number | null): Promise<MachineRecord> {
    const m = this.mustActive(id);
    const now = this.now();
    if (hours !== null) {
      const deadline = Math.max(m.deadlineAt, now) + hours * HOUR;
      if (deadline - now > this.limits.maxHours * HOUR) throw new MachineError(400, `the lease may reach at most ${this.limits.maxHours} h from now (MACHINES_MAX_HOURS)`);
      if (deadline - m.createdAt > this.limits.maxLifetimeHours * HOUR) {
        throw new MachineError(400, `a machine lives at most ${this.limits.maxLifetimeHours} h from its creation (MACHINES_MAX_LIFETIME_HOURS): create a new one`);
      }
      this.checkBudget(m.owner, m.holder, ((deadline - Math.max(m.deadlineAt, now)) / HOUR) * (m.usdPerHour ?? m.request.maxUsdPerHour));
      m.deadlineAt = deadline;
    }
    m.lastSeenAt = now;
    await this.save();
    return m;
  }

  private mustActive(id: string): MachineRecord {
    const m = this.state.machines[id];
    if (!m) throw new MachineError(404, `machine '${id}' not found`);
    if (!ACTIVE.has(m.status) || m.endReason) throw new MachineError(409, `machine '${id}' is ${m.endReason ? 'being released' : m.status}`);
    return m;
  }

  async release(id: string, reason: string): Promise<MachineRecord> {
    const m = this.state.machines[id];
    if (!m) throw new MachineError(404, `machine '${id}' not found`);
    if (!ACTIVE.has(m.status)) return m;
    m.endReason = m.endReason ?? reason;
    if (m.status === 'creating' && !m.providerId) {
      m.status = 'failed';
      m.endedAt = this.now();
      m.lastError = m.lastError ?? `cancelled: ${reason}`;
      await this.save();
      return m;
    }
    try {
      await this.opts.backends[m.provider!]!.release(m.providerId!);
      m.status = 'released';
      m.endedAt = this.now();
      this.log('machines: released', { id, reason: m.endReason, provider: m.provider, providerId: m.providerId, costUsd: round(this.costUsd(m)) });
    } catch (err) {
      m.lastError = `release failed (retried): ${errText(err)}`;
      this.log('machines: release failed', { id, error: m.lastError });
    }
    await this.save();
    return m;
  }

  reconcile(): Promise<void> {
    this.reconciling ??= this.reconcileOnce().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  private async reconcileOnce(): Promise<void> {
    const now = this.now();
    const seen = new Map<string, ProviderMachine>();
    const listed = new Set<MachineProvider>();
    for (const provider of this.providers) {
      try {
        for (const pm of await this.opts.backends[provider]!.list(this.namespace)) seen.set(pm.machineId, pm);
        listed.add(provider);
      } catch (err) {
        this.log('machines: list failed', { provider, error: errText(err) });
      }
    }
    for (const m of this.records().filter(r => ACTIVE.has(r.status))) {
      const pm = seen.get(m.id);
      if (m.status === 'creating' && !this.creating.has(m.id)) {
        if (pm) {
          this.adopt(m, pm);
          this.log('machines: adopted after a restart', { id: m.id, provider: pm.provider, providerId: pm.providerId });
        } else if (now - m.createdAt >= this.limits.createTimeoutMs && this.providers.every(p => listed.has(p))) {
          this.endJob(m, 'failed', 'the gateway restarted while the machine was being created; no machine came up');
          m.status = 'failed';
          m.endedAt = now;
          m.lastError = 'create lost';
          continue;
        }
      }
      if (m.status !== 'running') continue;
      if (pm) this.refresh(m, pm);
      else if (listed.has(m.provider!) && now - (m.startedAt ?? m.createdAt) >= (this.opts.lostGraceMs ?? 3 * 60_000)) {
        m.status = 'released';
        m.endedAt = now;
        m.endReason = m.endReason ?? 'lost';
        this.endJob(m, 'failed', 'the machine disappeared from the provider');
        this.log('machines: lost (gone from the provider)', { id: m.id, provider: m.provider });
        continue;
      }
      const reason = m.endReason ?? (now >= m.deadlineAt ? 'deadline'
        : now - m.createdAt >= this.limits.maxLifetimeHours * HOUR ? 'lifetime'
          : m.idleMinutes > 0 && now - m.lastSeenAt >= m.idleMinutes * 60_000 ? 'idle' : null);
      if (!reason) continue;
      if (reason === 'deadline' || reason === 'lifetime') this.endJob(m, 'timeout', `the lease ended (${reason})`);
      if ((await this.release(m.id, reason)).status === 'released') seen.delete(m.id);
    }
    await this.reapOrphans(seen, now);
    for (const m of this.records()) {
      if (m.endedAt != null && now - m.endedAt > KEEP_ENDED_MS) delete this.state.machines[m.id];
    }
    for (const j of Object.values(this.state.jobs)) if (!this.state.machines[j.machineId]) delete this.state.jobs[j.id];
    await this.save();
  }

  private async reapOrphans(seen: Map<string, ProviderMachine>, now: number): Promise<void> {
    for (const pm of seen.values()) {
      const m = this.state.machines[pm.machineId];
      if ((m && ACTIVE.has(m.status)) || this.creating.has(pm.machineId)) continue;
      if (now - pm.createdAt < (this.opts.orphanGraceMs ?? 10 * 60_000)) continue;
      try {
        await this.opts.backends[pm.provider]!.release(pm.providerId);
        this.log('machines: orphan released', { machineId: pm.machineId, provider: pm.provider, providerId: pm.providerId, known: !!m });
      } catch (err) {
        this.log('machines: orphan release failed', { providerId: pm.providerId, error: errText(err) });
      }
    }
  }

  view(m: MachineRecord): MachineView {
    return {
      id: m.id, owner: m.owner, holder: m.holder, provider: m.provider, providerId: m.providerId, status: m.status,
      machineType: m.request.machineType, image: m.request.image, ip: m.ip, ports: m.ports, ssh: !!m.request.sshPublicKey,
      onstart: !!m.request.onstart, envKeys: Object.keys(m.request.env), usdPerHour: m.usdPerHour, costUsd: round(this.costUsd(m)),
      createdAt: iso(m.createdAt)!, deadlineAt: iso(m.deadlineAt)!, idleMinutes: m.idleMinutes, lastSeenAt: iso(m.lastSeenAt)!,
      endedAt: iso(m.endedAt), endReason: m.endReason, jobId: m.jobId, lastError: m.lastError,
    };
  }

  costs(owner: string | null) {
    const now = this.now();
    const mine = this.list(owner);
    const pairs = new Map<string, { owner: string; holder: string | null }>();
    for (const m of mine) pairs.set(`${m.owner}\n${m.holder ?? ''}`, { owner: m.owner, holder: m.holder });
    const owners = [...new Set(mine.map(m => m.owner))].map((o) => {
      const day = this.spend(m => m.owner === o, now - DAY);
      const month = this.spend(m => m.owner === o, monthStart(now));
      return {
        owner: o, dayUsd: round(day.spent), monthUsd: round(month.spent), committedUsd: round(day.committed),
        caps: { dayUsd: this.limits.ownerUsdPerDay, monthUsd: this.limits.ownerUsdPerMonth },
      };
    });
    const holders = [...pairs.values()].filter(p => p.holder).map(p => ({
      ...p, dayUsd: round(this.spend(m => m.owner === p.owner && m.holder === p.holder, now - DAY).spent), capDayUsd: this.limits.holderUsdPerDay,
    }));
    const global = this.spend(() => true, now - DAY);
    return {
      namespace: this.namespace,
      owners, holders,
      ...(owner === null ? { global: { dayUsd: round(global.spent), committedUsd: round(global.committed), capDayUsd: this.limits.globalUsdPerDay } } : {}),
      machines: mine.map(m => ({
        id: m.id, owner: m.owner, holder: m.holder, jobId: m.jobId, provider: m.provider, status: m.status, usdPerHour: m.usdPerHour,
        costUsd: round(this.costUsd(m)),
      })),
    };
  }

  async createJob(owner: string, input: MachineInput, job: JobInputSpec): Promise<JobRecord> {
    if (!this.opts.publicUrl) throw new MachineError(503, 'jobs need AIGW_PUBLIC_URL (the machine reports its end to the gateway)');
    const id = this.newId('j');
    const machineId = this.newId('m');
    const token = randomBytes(24).toString('base64url');
    const reportUrl = `${this.opts.publicUrl.replace(/\/+$/, '')}${JOB_REPORT_PATH}`;
    const record: JobRecord = {
      id, owner, holder: input.holder, machineId, command: job.command, inputs: job.inputs, output: job.output, status: 'starting',
      tokenHash: sha(token), exitCode: null, log: '', result: null, createdAt: this.now(), endedAt: null, error: null,
    };
    this.state.jobs[id] = record;
    const request = { ...input.request, onstart: jobScript({ ...job, id, token, reportUrl }) };
    try {
      await this.create(owner, { ...input, request }, { id: machineId, jobId: id });
    } catch (err) {
      record.status = 'failed';
      record.endedAt = this.now();
      record.error = errText(err);
      await this.save();
      throw err;
    }
    return record;
  }

  job(id: string): JobRecord | null {
    return this.state.jobs[id] ?? null;
  }

  jobs(owner: string | null): JobRecord[] {
    return Object.values(this.state.jobs).filter(j => owner === null || j.owner === owner).sort((a, b) => b.createdAt - a.createdAt);
  }

  async cancelJob(id: string): Promise<JobRecord> {
    const job = this.state.jobs[id];
    if (!job) throw new MachineError(404, `job '${id}' not found`);
    await this.finishJob(job, 'failed', 'cancelled by the caller');
    return job;
  }

  private endJob(m: MachineRecord, status: JobStatus, error: string): void {
    const job = m.jobId ? this.state.jobs[m.jobId] : null;
    if (!job || job.endedAt != null) return;
    job.status = status;
    job.endedAt = this.now();
    job.error = error;
  }

  private async finishJob(job: JobRecord, status: JobStatus, error: string | null): Promise<void> {
    if (job.endedAt == null) {
      job.status = status;
      job.endedAt = this.now();
      job.error = error;
    }
    const m = this.state.machines[job.machineId];
    if (m) await this.release(m.id, `job-${job.status}`);
    else await this.save();
  }

  async report(jobId: string, token: string, report: JobReport): Promise<boolean> {
    const job = this.state.jobs[jobId];
    if (!job) return false;
    const given = Buffer.from(sha(token));
    const expected = Buffer.from(job.tokenHash);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    if (job.endedAt != null) return true;
    job.log = report.log.slice(-JOB_LOG_LIMIT);
    const m = this.state.machines[job.machineId];
    if (m) m.lastSeenAt = this.now();
    if (report.status === 'running') {
      job.status = 'running';
      await this.save();
      return true;
    }
    job.exitCode = report.exitCode;
    if (job.output) job.result = { uploaded: report.bytes != null && report.sha256 != null, bytes: report.bytes, sha256: report.sha256 };
    const ok = report.status === 'succeeded';
    await this.finishJob(job, ok ? 'succeeded' : 'failed', ok ? null : `the command failed (exit ${report.exitCode ?? '?'})`);
    return true;
  }

  jobView(job: JobRecord): JobView {
    const m = this.state.machines[job.machineId];
    return {
      id: job.id, owner: job.owner, holder: job.holder, machineId: job.machineId, status: job.status, inputs: job.inputs.map(f => f.path),
      output: job.output ? { host: new URL(job.output.url).host, path: job.output.path } : null, exitCode: job.exitCode, result: job.result,
      createdAt: iso(job.createdAt)!, endedAt: iso(job.endedAt), error: job.error, machine: m ? this.view(m) : null,
    };
  }
}

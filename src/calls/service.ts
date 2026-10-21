export type CallPhase = 'ready' | 'waking' | 'parked' | 'down';
export type CallServer = 'own' | 'cloud';

export interface LivekitServer { url: string; apiKey: string; apiSecret: string }
export interface RoomLoad { rooms: number; participants: number; egress: number }

export interface TokenGrant {
  room: string; identity: string; name?: string; metadata?: string;
  canPublish: boolean; canSubscribe: boolean; ttlSeconds: number;
}

export interface CallsBackend {
    probe(server: LivekitServer, timeoutMs: number): Promise<RoomLoad>;
  sign(server: LivekitServer, grant: TokenGrant): Promise<string>;
}

export interface CallsPower {
  start(): Promise<string[]>;
  stop(): Promise<string[]>;
}

export interface Caller { user: string; admin: boolean; countsAsUse: boolean }

export interface CallsState {
  lastUseAt: number;
  parkedAt: number | null;
  cloud: { month: string; minutes: number };
}

export interface CallsServiceOptions {
  app: string;
  own: LivekitServer | null;
  cloud: LivekitServer | null;
  backend: CallsBackend;
    power: CallsPower | null;
  classOpen: (now: number) => boolean;
  idleMinutes: number;
  cloudBudgetMinutes: number;
  state?: Partial<CallsState>;
  save?: (state: CallsState) => Promise<void>;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class CallsError extends Error {
  constructor(readonly status: number, readonly type: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface OwnHealth {
  phase: CallPhase; url: string | null; checkedAt: string | null;
  rooms: number; participants: number; idleSince: string | null;
}

export const PROBE_TIMEOUT_MS = 2_500;
export const PROBE_CACHE_MS = 5_000;
export const WAKE_RETRY_MS = 8 * 60_000;
export const RETRY_AFTER_MS = 5_000;
export const MAX_TTL_SECONDS = 14_400;
const DEFAULT_TTL_SECONDS = 1_800;
const NAME_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MAX_METADATA_CHARS = 4_096;
const MAX_TICK_MINUTES = 2;

const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

export class CallsService {
  private state: CallsState;
  private readonly now: () => number;
  private last: { at: number; load: RoomLoad | null } | null = null;
  private wakingSince: number | null = null;
  private cloudUntil = 0;
  private cloudTickAt = 0;

  constructor(private readonly opts: CallsServiceOptions) {
    this.now = opts.now ?? Date.now;
    const t = this.now();
    this.state = {
      lastUseAt: t,
      parkedAt: opts.state?.parkedAt ?? null,
      cloud: opts.state?.cloud?.month === monthOf(t) ? opts.state.cloud : { month: monthOf(t), minutes: 0 },
    };
  }

  get app(): string { return this.opts.app; }
  snapshot(): CallsState { return structuredClone(this.state); }

  cloudMinutesLeft(): number {
    if (this.state.cloud.month !== monthOf(this.now())) return this.opts.cloudBudgetMinutes;
    return Math.max(0, this.opts.cloudBudgetMinutes - this.state.cloud.minutes);
  }

  async health(): Promise<{ own: OwnHealth; cloud: { configured: boolean; minutesLeft: number } }> {
    const load = await this.probe(true);
    return {
      own: {
        phase: this.phaseOf(load), url: this.opts.own?.url ?? null, checkedAt: iso(this.last?.at ?? null),
        rooms: load?.rooms ?? 0, participants: load?.participants ?? 0,
        idleSince: load && load.participants + load.egress > 0 ? null : iso(this.state.lastUseAt),
      },
      cloud: { configured: Boolean(this.opts.cloud), minutesLeft: this.cloudMinutesLeft() },
    };
  }

    async wake(caller: Caller, reason = 'wake'): Promise<{ phase: CallPhase }> {
    const load = await this.probe(false);
    if (!caller.admin && !caller.countsAsUse) return { phase: this.phaseOf(load) };
    this.touch();
    return { phase: load ? 'ready' : await this.start(`${reason}:${caller.user}`) };
  }

  async park(caller: Caller, reason = 'park'): Promise<{ phase: CallPhase; services: string[] }> {
    if (!caller.admin && !(caller.user === this.opts.app && caller.countsAsUse)) {
      throw new CallsError(403, 'forbidden', 'only an admin key or the app key may park its calls');
    }
    if (!caller.admin && this.opts.classOpen(this.now())) {
      throw new CallsError(409, 'class_window', 'the class window is open: calls stay up (an admin key parks anyway)');
    }
    const load = await this.probe(true);
    if (load && load.participants + load.egress > 0) {
      throw new CallsError(409, 'in_use', `someone is in a call (${load.participants} participant(s), ${load.egress} egress): not parked`);
    }
    return this.stop(`${reason}:${caller.user}`);
  }

  async token(caller: Caller, body: Record<string, unknown>): Promise<{ url: string; token: string; server: CallServer; room: string; expiresAt: string }> {
    const grant = this.grantOf(body);
    const app = body.app === undefined ? this.opts.app : body.app;
    if (app !== this.opts.app) throw new CallsError(404, 'not_found', `no calls configured for app '${String(app)}'`);
    if (!caller.admin && caller.user !== this.opts.app && caller.countsAsUse) {
      throw new CallsError(403, 'forbidden', `this key cannot open calls of app '${this.opts.app}'`);
    }
    const reserve = body.reserve ?? 'allow';
    if (reserve !== 'allow' && reserve !== 'deny') throw new CallsError(400, 'invalid_request', '"reserve" must be "allow" or "deny"');
    const expiresAt = new Date(this.now() + grant.ttlSeconds * 1000).toISOString();
    const own = this.opts.own;
    if (own && await this.probe(false)) {
      if (caller.countsAsUse) this.touch();
      return { url: own.url, token: await this.opts.backend.sign(own, grant), server: 'own', room: grant.room, expiresAt };
    }
    const phase = caller.countsAsUse ? (this.touch(), await this.start(`token:${caller.user}`)) : this.phaseOf(null);
    const cloud = this.opts.cloud;
    if (cloud && reserve === 'allow' && caller.countsAsUse && this.cloudMinutesLeft() > 0) {
      this.cloudUntil = Math.max(this.cloudUntil, this.now() + grant.ttlSeconds * 1000);
      this.log('calls.cloud', { room: grant.room, ownPhase: phase, minutesLeft: this.cloudMinutesLeft() });
      return { url: cloud.url, token: await this.opts.backend.sign(cloud, grant), server: 'cloud', room: grant.room, expiresAt };
    }
    throw new CallsError(503, 'call_starting', `the call server is ${phase}: try again shortly`, { retryAfterMs: RETRY_AFTER_MS, phase });
  }

    async tick(): Promise<void> {
    const now = this.now();
    const load = await this.probe(true);
    const classOpen = this.opts.classOpen(now);
    if (load && (load.participants + load.egress > 0 || classOpen)) this.touch();
    if (!load && classOpen) await this.start('class-window').catch(() => {});
    if (load && !classOpen && now - this.state.lastUseAt >= this.opts.idleMinutes * 60_000) {
      await this.stop('idle').catch(() => {});
    }
    await this.countCloud(now);
  }

  private async start(reason: string): Promise<CallPhase> {
    const power = this.opts.power;
    if (!power) return this.phaseOf(null);
    if (this.wakingSince !== null && this.now() - this.wakingSince < WAKE_RETRY_MS) return 'waking';
    try {
      const services = await power.start();
      this.wakingSince = this.now();
      this.state.parkedAt = null;
      this.log('calls.wake', { app: this.opts.app, reason, services });
      void this.persist();
      return 'waking';
    } catch (err) {
      this.log('calls.wake_failed', { app: this.opts.app, reason, error: (err as Error).message });
      return this.phaseOf(null);
    }
  }

  private async stop(reason: string): Promise<{ phase: CallPhase; services: string[] }> {
    const power = this.opts.power;
    if (!power) throw new CallsError(409, 'no_power', 'this gateway does not switch the call servers (off Railway or no RAILWAY_API_TOKEN)');
    const services = await power.stop();
    this.state.parkedAt = this.now();
    this.wakingSince = null;
    this.last = null;
    this.log('calls.park', { app: this.opts.app, reason, services, idleMinutes: Math.round((this.now() - this.state.lastUseAt) / 60_000) });
    await this.persist();
    return { phase: 'parked', services };
  }

  private phaseOf(load: RoomLoad | null): CallPhase {
    if (load) return 'ready';
    if (this.wakingSince !== null && this.now() - this.wakingSince < WAKE_RETRY_MS) return 'waking';
    return this.state.parkedAt !== null ? 'parked' : 'down';
  }

  private async probe(fresh: boolean): Promise<RoomLoad | null> {
    const own = this.opts.own;
    if (!own) return null;
    const now = this.now();
    if (!fresh && this.last && now - this.last.at < PROBE_CACHE_MS) return this.last.load;
    const load = await this.opts.backend.probe(own, PROBE_TIMEOUT_MS).catch(() => null);
    this.last = { at: now, load };
    if (load && this.wakingSince !== null) {
      this.log('calls.ready', { app: this.opts.app, wakeMs: now - this.wakingSince });
      this.wakingSince = null;
    }
    if (load && this.state.parkedAt !== null) { this.state.parkedAt = null; void this.persist(); }
    return load;
  }

  private async countCloud(now: number): Promise<void> {
    const cloud = this.opts.cloud;
    if (!cloud || now >= this.cloudUntil) { this.cloudTickAt = now; return; }
    const minutes = Math.min(MAX_TICK_MINUTES, (now - (this.cloudTickAt || now)) / 60_000);
    this.cloudTickAt = now;
    const load = await this.opts.backend.probe(cloud, PROBE_TIMEOUT_MS).catch(() => null);
    if (!load?.participants || minutes <= 0) return;
    if (this.state.cloud.month !== monthOf(now)) this.state.cloud = { month: monthOf(now), minutes: 0 };
    this.state.cloud.minutes += load.participants * minutes;
    await this.persist();
  }

  private grantOf(body: Record<string, unknown>): TokenGrant {
    const bad = (msg: string) => new CallsError(400, 'invalid_request', msg);
    const { room, identity, name, metadata } = body;
    if (typeof room !== 'string' || !NAME_RE.test(room)) throw bad('"room" must be 1-128 chars of [A-Za-z0-9_.:@-]');
    if (typeof identity !== 'string' || !NAME_RE.test(identity)) throw bad('"identity" must be 1-128 chars of [A-Za-z0-9_.:@-]');
    if (name !== undefined && (typeof name !== 'string' || name.length > 128)) throw bad('"name" must be a string of at most 128 chars');
    if (metadata !== undefined && (typeof metadata !== 'string' || metadata.length > MAX_METADATA_CHARS)) {
      throw bad(`"metadata" must be a string of at most ${MAX_METADATA_CHARS} chars`);
    }
    const ttl = body.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 60 || ttl > MAX_TTL_SECONDS) {
      throw bad(`"ttlSeconds" must be an integer from 60 to ${MAX_TTL_SECONDS}`);
    }
    for (const k of ['canPublish', 'canSubscribe'] as const) {
      if (body[k] !== undefined && typeof body[k] !== 'boolean') throw bad(`"${k}" must be a boolean`);
    }
    return {
      room, identity, ttlSeconds: ttl, canPublish: body.canPublish !== false, canSubscribe: body.canSubscribe !== false,
      ...(name ? { name } : {}), ...(metadata ? { metadata } : {}),
    };
  }

  private touch(): void { this.state.lastUseAt = this.now(); }
  private persist(): Promise<void> { return this.opts.save?.(this.snapshot()).catch(() => {}) ?? Promise.resolve(); }
  private log(msg: string, data: Record<string, unknown>): void { this.opts.log?.(msg, data); }
}

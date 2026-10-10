import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { readStateFile, writeStateFile } from '../deployments/state-file';
import { loadSandboxEnv, principalSandboxToken, SANDBOX_USER, TOKEN_ALIASES, type SandboxEnvResult } from './sandbox-env';

const USER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SANDBOX_TOKEN_RE = /^[^\s,:]{16,512}$/;
export const MAX_OVERLAP_MINUTES = 7 * 24 * 60;

export interface GpuPolicy { autoWake: boolean; canStartGpu: boolean; gpuDailyEur: number | null; startIdleMinutes: number }
export const DEFAULT_GPU_POLICY: GpuPolicy = { autoWake: false, canStartGpu: false, gpuDailyEur: 5, startIdleMinutes: 10 };
const CLASS_CLIENT = 'parle';
const CLASS_CLIENT_POLICY: Partial<GpuPolicy> = { autoWake: true, canStartGpu: true, gpuDailyEur: null };
const MAX_START_IDLE_MINUTES = 240;

const hashOf = (token: string) => createHmac('sha256', 'aigw-access-key-v1').update(token).digest('hex');

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface KeyMarks { revokedAt?: number; expiresAt?: number; lastUsedAt?: number }

export interface IssuedKey extends KeyMarks {
  id: string;
  hash: string;
  prefix: string;
  user: string;
  label?: string;
  createdAt: number;
  createdBy: string;
}

interface AccessState {
  version: 1;
  keys: IssuedKey[];
  env: Record<string, KeyMarks>;
  admins: string[] | null;
  sandbox: { token: string; retired: { token: string; until: number } | null } | null;
  policies?: Record<string, Partial<GpuPolicy>>;
}

interface EnvKey { id: string; key: string; prefix: string; user: string; label?: string }

export interface KeyView {
  id: string;
  source: 'env' | 'issued';
  user: string;
  role: 'admin' | 'client';
  admin: boolean;
  prefix: string;
  label: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
  policy: GpuPolicy;
}

export interface AccessKeysOptions {
  path?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const iso = (ms: number | undefined | null) => (ms ? new Date(ms).toISOString() : null);

function overlapMs(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > MAX_OVERLAP_MINUTES) {
    throw new AccessError(400, `overlapMinutes must be a number between 0 and ${MAX_OVERLAP_MINUTES}`);
  }
  return Math.round(raw * 60_000);
}

function parseEnvKeys(raw: string | undefined): EnvKey[] {
  const seen = new Map<string, number>();
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean).map((entry) => {
    const [key, owner, ...label] = entry.split(':');
    const user = owner || 'default';
    const n = (seen.get(user) ?? 0) + 1;
    seen.set(user, n);
    return { id: `env-${user}${n > 1 ? `-${n}` : ''}`, key: key!, prefix: key!.slice(0, 4), user, ...(label.length ? { label: label.join(':') } : {}) };
  }).filter(k => k.prefix.length > 0);
}

export class AccessKeys {
  readonly admins = new Set<string>();
  private state: AccessState = { version: 1, keys: [], env: {}, admins: null, sandbox: null };
  private envKeys: EnvKey[];
  private baseAdmins: string[] = [];
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly env: Record<string, string | undefined>, private readonly opts: AccessKeysOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.envKeys = parseEnvKeys(env.GATEWAY_API_KEYS);
  }

  async load(): Promise<void> {
    if (!this.opts.path) return;
    const read = await readStateFile<AccessState>(this.opts.path);
    if (read.from === 'backup') this.opts.log?.('access: STATE FILE UNREADABLE, recovered from the last good backup', { problem: read.problem });
    if (read.data) this.state = { ...this.state, ...read.data, env: read.data.env ?? {}, keys: read.data.keys ?? [] };
  }

  migratePolicies(): void {
    if (this.state.policies) return;
    const classKeys = [...this.envKeys, ...this.state.keys].filter(k => k.user === CLASS_CLIENT);
    this.state.policies = Object.fromEntries(classKeys.map(k => [k.id, { ...CLASS_CLIENT_POLICY }]));
    this.dirty = true;
    if (classKeys.length) this.opts.log?.('access: GPU policies created — the class client keeps waking GPUs on its own', { keys: classKeys.map(k => k.id) });
  }

  policyOf(keyId: string | undefined): GpuPolicy {
    const own = keyId && Object.prototype.hasOwnProperty.call(this.state.policies ?? {}, keyId) ? this.state.policies![keyId] : {};
    return { ...DEFAULT_GPU_POLICY, ...own };
  }

  async setPolicy(body: Record<string, unknown>): Promise<{ id: string; policy: GpuPolicy }> {
    const id = body.id;
    if (typeof id !== 'string' || (id !== SANDBOX_USER && !this.marksOf(id))) throw new AccessError(404, `key '${String(id)}' not found`);
    const next: Partial<GpuPolicy> = { ...this.state.policies?.[id] };
    for (const [field, value] of Object.entries(body)) {
      if (field === 'id') continue;
      if (field === 'autoWake' || field === 'canStartGpu') {
        if (typeof value !== 'boolean') throw new AccessError(400, `${field} must be a boolean`);
        next[field] = value;
      } else if (field === 'gpuDailyEur') {
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new AccessError(400, 'gpuDailyEur must be a number >= 0 (EUR per day) or null (no cap)');
        next.gpuDailyEur = value as number | null;
      } else if (field === 'startIdleMinutes') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_START_IDLE_MINUTES) {
          throw new AccessError(400, `startIdleMinutes must be an integer 1–${MAX_START_IDLE_MINUTES}`);
        }
        next.startIdleMinutes = value;
      } else {
        throw new AccessError(400, `unknown field '${field}' (allowed: autoWake, canStartGpu, gpuDailyEur, startIdleMinutes)`);
      }
    }
    this.state.policies = { ...this.state.policies, [id]: next };
    await this.save();
    return { id, policy: this.policyOf(id) };
  }

  setBaseAdmins(base: Iterable<string>): void {
    this.baseAdmins = [...base];
    this.applyAdmins();
  }

  private applyAdmins(): void {
    this.admins.clear();
    for (const user of this.state.admins ?? this.baseAdmins) if (user !== SANDBOX_USER) this.admins.add(user);
  }

  private active(marks: KeyMarks | undefined, now: number): boolean {
    return !marks?.revokedAt && !(marks?.expiresAt && marks.expiresAt <= now);
  }

  resolve(token: string): { key: string; userId: string; keyId: string } | null {
    if (!token) return null;
    const now = this.now();
    const envKey = this.envKeys.find(k => sameSecret(token, k.key));
    if (envKey && this.active(this.state.env[envKey.id], now)) {
      this.touch((this.state.env[envKey.id] ??= {}), now);
      return { key: token, userId: envKey.user, keyId: envKey.id };
    }
    const hash = hashOf(token);
    const issued = this.state.keys.find(k => k.hash === hash);
    if (issued && this.active(issued, now)) {
      this.touch(issued, now);
      return { key: token, userId: issued.user, keyId: issued.id };
    }
    if (this.env.ACCEPT_SANDBOX_TOKEN_AS_KEY?.trim() === '1' && this.isSandboxToken(token)) return { key: token, userId: SANDBOX_USER, keyId: SANDBOX_USER };
    return null;
  }

  get size(): number {
    const now = this.now();
    const sandbox = this.env.ACCEPT_SANDBOX_TOKEN_AS_KEY?.trim() === '1' && principalSandboxToken(this.env) ? 1 : 0;
    return this.envKeys.filter(k => this.active(this.state.env[k.id], now)).length
      + this.state.keys.filter(k => this.active(k, now)).length + sandbox;
  }

  private touch(marks: KeyMarks, now: number): void {
    if (marks.lastUsedAt && now - marks.lastUsedAt < 60_000) return;
    marks.lastUsedAt = now;
    this.dirty = true;
  }

  list(): KeyView[] {
    const now = this.now();
    const view = (source: KeyView['source'], k: EnvKey | IssuedKey, marks: KeyMarks | undefined): KeyView => ({
      id: k.id, source, user: k.user, role: this.admins.has(k.user) ? 'admin' : 'client', admin: this.admins.has(k.user), prefix: k.prefix, label: k.label ?? null,
      createdAt: iso('createdAt' in k ? k.createdAt : null), lastUsedAt: iso(marks?.lastUsedAt), expiresAt: iso(marks?.expiresAt),
      revokedAt: iso(marks?.revokedAt), active: this.active(marks, now), policy: this.policyOf(k.id),
    });
    return [...this.envKeys.map(k => view('env', k, this.state.env[k.id])), ...this.state.keys.map(k => view('issued', k, k))];
  }

  private marksOf(id: string): KeyMarks | null {
    if (this.envKeys.some(k => k.id === id)) return (this.state.env[id] ??= {});
    return this.state.keys.find(k => k.id === id) ?? null;
  }

  private viewOf(id: string): KeyView {
    return this.list().find(k => k.id === id)!;
  }

  async issue(body: Record<string, unknown>, actor: string): Promise<{ key: string; view: KeyView; replaced: KeyView | null }> {
    const replaces = typeof body.replaces === 'string' ? body.replaces : null;
    const old = replaces ? this.list().find(k => k.id === replaces) : null;
    if (replaces && !old) throw new AccessError(404, `key '${replaces}' not found`);
    const user = body.user ?? old?.user;
    if (typeof user !== 'string' || !USER_RE.test(user)) throw new AccessError(400, `user must match ${USER_RE}`);
    if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 100)) throw new AccessError(400, 'label must be a string (≤ 100 chars)');
    if (body.admin !== undefined && typeof body.admin !== 'boolean') throw new AccessError(400, 'admin must be a boolean');
    const overlap = overlapMs(body.overlapMinutes);
    const now = this.now();
    const key = `aigw_${randomBytes(24).toString('base64url')}`;
    const hash = hashOf(key);
    const issued: IssuedKey = {
      id: `key-${hash.slice(0, 12)}`, hash, prefix: key.slice(0, 9), user, createdAt: now, createdBy: actor,
      ...(typeof body.label === 'string' ? { label: body.label } : {}),
    };
    this.state.keys.push(issued);
    if (old && this.state.policies?.[old.id]) this.state.policies = { ...this.state.policies, [issued.id]: { ...this.state.policies[old.id] } };
    if (old) {
      const marks = this.marksOf(old.id)!;
      if (overlap > 0) marks.expiresAt = Math.min(marks.expiresAt ?? Infinity, now + overlap);
      else marks.revokedAt ??= now;
    }
    if (body.admin === true && !this.admins.has(user)) this.state.admins = [...(this.state.admins ?? this.baseAdmins), user];
    this.applyAdmins();
    await this.save();
    return { key, view: this.viewOf(issued.id), replaced: old ? this.viewOf(old.id) : null };
  }

  async revoke(id: unknown): Promise<KeyView> {
    if (typeof id !== 'string') throw new AccessError(400, 'id must be a string');
    const marks = this.marksOf(id);
    if (!marks) throw new AccessError(404, `key '${id}' not found`);
    marks.revokedAt ??= this.now();
    await this.save();
    return this.viewOf(id);
  }

  async setAdmins(users: unknown, actor: string): Promise<string[]> {
    if (!Array.isArray(users) || users.some(u => typeof u !== 'string' || !USER_RE.test(u))) {
      throw new AccessError(400, `users must be an array of user ids matching ${USER_RE}`);
    }
    const list = [...new Set(users as string[])];
    if (!list.includes(actor)) throw new AccessError(400, `'${actor}' must stay in the list (you would lock yourself out)`);
    this.state.admins = list;
    this.applyAdmins();
    await this.save();
    return [...this.admins];
  }

  isSandboxToken(token: string): boolean {
    if (!token) return false;
    const accepted = TOKEN_ALIASES.map(k => this.env[k]?.trim()).filter((v): v is string => Boolean(v));
    const retired = this.state.sandbox?.retired;
    if (retired && retired.until > this.now()) accepted.push(retired.token);
    return accepted.some(value => sameSecret(token, value));
  }

  private setSandboxToken(token: string): void {
    for (const alias of TOKEN_ALIASES) if (this.env[alias]?.trim()) this.env[alias] = token;
    this.env.SANDBOX_TOKEN = token;
  }

  private probe(token: string): Promise<SandboxEnvResult> {
    return loadSandboxEnv({ SANDBOX_TOKEN: token, ...(this.env.SANDBOX_ENV_URL ? { SANDBOX_ENV_URL: this.env.SANDBOX_ENV_URL } : {}) },
      { fetchImpl: this.opts.fetchImpl });
  }

  async bootSandboxEnv(): Promise<SandboxEnvResult> {
    const result = await this.loadWithStoredToken();
    this.envKeys = parseEnvKeys(this.env.GATEWAY_API_KEYS);
    return result;
  }

  private async loadWithStoredToken(): Promise<SandboxEnvResult> {
    const stored = this.state.sandbox?.token;
    const original = principalSandboxToken(this.env);
    if (stored && stored !== original) {
      this.setSandboxToken(stored);
      const r = await loadSandboxEnv(this.env, { fetchImpl: this.opts.fetchImpl });
      if (r.source || !original) return r;
      this.opts.log?.('access: the palco refused the stored SANDBOX_TOKEN — using the environment one');
      this.setSandboxToken(original);
    }
    return loadSandboxEnv(this.env, { fetchImpl: this.opts.fetchImpl });
  }

  async rotateSandboxToken(next: unknown, overlapMinutes: unknown): Promise<{ overlapUntil: string | null }> {
    if (typeof next !== 'string' || !SANDBOX_TOKEN_RE.test(next.trim())) throw new AccessError(400, 'token must be 16–512 chars, no spaces, commas or colons');
    const token = next.trim();
    const overlap = overlapMs(overlapMinutes);
    const current = principalSandboxToken(this.env);
    if (token === current) throw new AccessError(400, 'this is already the current token');
    const probe = await this.probe(token);
    if (!probe.source) throw new AccessError(400, `the palco refused the new token (${probe.errors.map(e => e.replace(/^\S+: /, '')).join('; ') || 'no answer'}) — keeping the current one`);
    this.setSandboxToken(token);
    const retired = current && overlap > 0 ? { token: current, until: this.now() + overlap } : null;
    this.state.sandbox = { token, retired };
    await this.save();
    return { overlapUntil: iso(retired?.until) };
  }

  start(flushMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { if (this.dirty) void this.save().catch(() => {}); }, flushMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.dirty) await this.save().catch(() => {});
  }

  private save(): Promise<void> {
    this.dirty = false;
    const path = this.opts.path;
    if (!path) return Promise.resolve();
    const snapshot = JSON.stringify(this.state, null, 2);
    this.chain = this.chain.catch(() => {}).then(() => writeStateFile(path, snapshot).catch((err: unknown) => {
      this.opts.log?.('access: STATE WRITE FAILED', { error: err instanceof Error ? err.message : String(err) });
      throw new AccessError(500, 'the access state could not be saved');
    }));
    return this.chain;
  }
}

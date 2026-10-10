// ── AI Gateway — ucast.me accounts: users, sessions, activation keys ───────
// The state (accounts.json) holds only hashes of every secret: session ids, activation keys and reset tokens are
// HMAC-SHA256(pepper, token) — high-entropy random tokens, so a fast keyed hash is the right tool; passwords are
// argon2id (password.ts). A full activation key is returned once, at creation, and never stored.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { readStateFile, writeStateFile } from '../deployments/state-file';
import type { AccountsConfig, Quota, QuotaMetric } from './config';
import type { EmailSender } from './email';
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from './password';
import { nextDayStart, nextMonthStart, type Counters, type UsageMeter } from './usage';

export const KEY_PREFIX = 'ucast_live_';
const KEY_RE = /^ucast_live_[A-Za-z0-9_-]{43}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DEVICE_MAX = 60;

export class AccountError extends Error {
  constructor(readonly status: number, message: string, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  plan: string;
  createdAt: number;
  passwordChangedAt: number;
  /** Per-user override of the default quota (plans, later). */
  quota?: Partial<Quota>;
  disabledAt?: number;
}

interface Session { hash: string; userId: string; csrf: string; createdAt: number; expiresAt: number; lastSeenAt: number }

export interface ActivationKey {
  id: string;
  userId: string;
  hash: string;
  /** First characters, for the user to recognise it (`ucast_live_AbCd`). */
  prefix: string;
  deviceName: string;
  createdAt: number;
  lastUsedAt?: number;
  lastActivatedAt?: number;
  appVersion?: string;
  revokedAt?: number;
}

interface ResetToken { hash: string; userId: string; expiresAt: number; usedAt?: number }

interface State { version: 1; users: User[]; sessions: Session[]; keys: ActivationKey[]; resets: ResetToken[] }

export interface KeyView {
  id: string; prefix: string; deviceName: string; createdAt: string; lastUsedAt: string | null;
  lastActivatedAt: string | null; appVersion: string | null; revokedAt: string | null; active: boolean;
}

export interface QuotaView { plan: string; limits: Quota; month: Counters; today: Counters; monthResetsAt: string; dayResetsAt: string }

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.normalize('NFC').trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function cleanDeviceName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, DEVICE_MAX) : '';
  return name || 'Meu computador';
}

export interface AccountServiceOptions {
  config: AccountsConfig;
  usage: UsageMeter;
  email: EmailSender;
  /** True when a gateway user id is an admin: the accounts app must never be one (keys then refused, fail closed). */
  isAdmin?: (userId: string) => boolean;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class AccountService {
  private state: State = { version: 1, users: [], sessions: [], keys: [], resets: [] };
  private readonly byKeyHash = new Map<string, ActivationKey>();
  private dirty = false;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private adminWarned = false;
  readonly now: () => number;

  constructor(private readonly opts: AccountServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  get config(): AccountsConfig { return this.opts.config; }

  private hash(token: string): string {
    return createHmac('sha256', this.opts.config.pepper).update(token).digest('hex');
  }

  async load(): Promise<void> {
    const path = this.opts.config.statePath;
    if (!path) return;
    const read = await readStateFile<State>(path);
    if (read.from === 'backup') this.opts.log?.('accounts: STATE FILE UNREADABLE, recovered from the last good backup', { problem: read.problem });
    if (read.data) this.state = { version: 1, users: read.data.users ?? [], sessions: read.data.sessions ?? [], keys: read.data.keys ?? [], resets: read.data.resets ?? [] };
    this.reindex();
  }

  private reindex(): void {
    this.byKeyHash.clear();
    for (const k of this.state.keys) if (!k.revokedAt) this.byKeyHash.set(k.hash, k);
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
    const now = this.now();
    this.state.sessions = this.state.sessions.filter(s => s.expiresAt > now);
    this.state.resets = this.state.resets.filter(r => r.expiresAt > now && !r.usedAt);
    const path = this.opts.config.statePath;
    if (!path) return Promise.resolve();
    const text = JSON.stringify(this.state, null, 2);
    this.chain = this.chain.catch(() => {}).then(() => writeStateFile(path, text).catch((err: unknown) => {
      this.opts.log?.('accounts: STATE WRITE FAILED', { error: err instanceof Error ? err.message : String(err) });
      throw new AccountError(500, 'Não foi possível salvar agora. Tente de novo.', 'state_write_failed');
    }));
    return this.chain;
  }

  private userById(id: string): User | undefined {
    return this.state.users.find(u => u.id === id && !u.disabledAt);
  }

  // ── Sign-up, login, sessions ──────────────────────────────────────────────

  /**
   * Creates the account and a session. An e-mail already registered: when the password is the account's, this is a
   * login; otherwise the same generic refusal as any other (the owner gets an e-mail about the attempt).
   */
  async signup(rawEmail: unknown, password: unknown): Promise<{ user: User; session: { token: string; csrf: string } }> {
    const email = normalizeEmail(rawEmail);
    if (!email) throw new AccountError(400, 'Informe um e-mail válido.', 'invalid_email');
    const problem = passwordProblem(password);
    if (problem) throw new AccountError(400, problem, 'weak_password');
    const pw = password as string;
    const existing = this.state.users.find(u => u.email === email);
    if (existing) {
      if (!existing.disabledAt && await verifyPassword(pw, existing.passwordHash)) return { user: existing, session: await this.openSession(existing) };
      void this.opts.email.send({
        to: email, subject: 'Tentativa de criar conta no ucast.me',
        text: `Alguém tentou criar uma conta no ucast.me com este e-mail, que já tem conta. Se foi você, entre em ${this.config.publicBaseUrl}/login ou recupere a senha em ${this.config.publicBaseUrl}/forgot.`,
        html: `<p>Alguém tentou criar uma conta no ucast.me com este e-mail, que já tem conta.</p><p>Se foi você, <a href="${this.config.publicBaseUrl}/login">entre</a> ou <a href="${this.config.publicBaseUrl}/forgot">recupere a senha</a>.</p>`,
      }).catch(() => {});
      throw new AccountError(400, 'Não foi possível criar a conta com estes dados. Se você já tem conta, entre ou recupere a senha.', 'signup_refused');
    }
    const now = this.now();
    const user: User = { id: `usr_${randomUUID().replace(/-/g, '')}`, email, passwordHash: await hashPassword(pw), plan: this.config.plan, createdAt: now, passwordChangedAt: now };
    this.state.users.push(user);
    const session = await this.openSession(user);
    this.opts.log?.('accounts: signup', { userId: user.id });
    return { user, session };
  }

  /** Same error and the same work (a password hash is always verified) whether the e-mail exists or not. */
  async login(rawEmail: unknown, password: unknown): Promise<{ user: User; session: { token: string; csrf: string } }> {
    const email = normalizeEmail(rawEmail);
    const user = email ? this.state.users.find(u => u.email === email && !u.disabledAt) : undefined;
    const pw = typeof password === 'string' ? password.slice(0, 1024) : '';
    const ok = await verifyPassword(pw, user?.passwordHash ?? await dummyHash());
    if (!user || !ok) throw new AccountError(401, 'E-mail ou senha incorretos.', 'invalid_credentials');
    return { user, session: await this.openSession(user) };
  }

  private async openSession(user: User): Promise<{ token: string; csrf: string }> {
    const now = this.now();
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    this.state.sessions.push({ hash: this.hash(token), userId: user.id, csrf, createdAt: now, expiresAt: now + this.config.sessionTtlMs, lastSeenAt: now });
    await this.save();
    return { token, csrf };
  }

  sessionOf(token: string | null): { user: User; csrf: string; token: string } | null {
    if (!token) return null;
    const hash = this.hash(token);
    const now = this.now();
    const s = this.state.sessions.find(x => x.hash === hash && x.expiresAt > now);
    const user = s ? this.userById(s.userId) : undefined;
    if (!s || !user || s.createdAt < user.passwordChangedAt) return null;
    if (now - s.lastSeenAt > 60_000) { s.lastSeenAt = now; this.dirty = true; }
    return { user, csrf: s.csrf, token };
  }

  checkCsrf(session: { csrf: string }, given: unknown): boolean {
    return typeof given === 'string' && given.length > 0 && sameText(given, session.csrf);
  }

  async logout(token: string | null): Promise<void> {
    if (!token) return;
    const hash = this.hash(token);
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter(s => s.hash !== hash);
    if (this.state.sessions.length !== before) await this.save();
  }

  // ── Password reset ────────────────────────────────────────────────────────

  /** Always resolves the same way; an e-mail goes out only when the account exists. */
  async requestReset(rawEmail: unknown): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const user = email ? this.state.users.find(u => u.email === email && !u.disabledAt) : undefined;
    if (!user) return;
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.state.resets = this.state.resets.filter(r => r.userId !== user.id);
    this.state.resets.push({ hash: this.hash(token), userId: user.id, expiresAt: now + this.config.resetTtlMs });
    await this.save();
    const link = `${this.config.publicBaseUrl}/reset#token=${token}`;
    const minutes = Math.round(this.config.resetTtlMs / 60_000);
    await this.opts.email.send({
      to: user.email, subject: 'Redefinir sua senha do ucast.me',
      text: `Para criar uma nova senha, abra: ${link}\nO link vale por ${minutes} minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail.`,
      html: `<p>Para criar uma nova senha, <a href="${link}">clique aqui</a>.</p><p>O link vale por ${minutes} minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail.</p>`,
    }).catch((err: unknown) => this.opts.log?.('accounts: reset e-mail failed', { error: err instanceof Error ? err.message : String(err) }));
  }

  /** Sets the new password, burns the token and ends every session of the account. */
  async resetPassword(token: unknown, password: unknown): Promise<void> {
    const problem = passwordProblem(password);
    if (problem) throw new AccountError(400, problem, 'weak_password');
    const now = this.now();
    const hash = typeof token === 'string' && token.length <= 128 ? this.hash(token) : '';
    const reset = this.state.resets.find(r => r.hash === hash && !r.usedAt && r.expiresAt > now);
    const user = reset ? this.userById(reset.userId) : undefined;
    if (!reset || !user) throw new AccountError(400, 'Este link de redefinição é inválido ou expirou. Peça um novo.', 'invalid_reset_token');
    reset.usedAt = now;
    user.passwordHash = await hashPassword(password as string);
    user.passwordChangedAt = now;
    this.state.sessions = this.state.sessions.filter(s => s.userId !== user.id);
    await this.save();
  }

  // ── Activation keys ───────────────────────────────────────────────────────

  private view(k: ActivationKey): KeyView {
    return {
      id: k.id, prefix: k.prefix, deviceName: k.deviceName, createdAt: iso(k.createdAt)!, lastUsedAt: iso(k.lastUsedAt),
      lastActivatedAt: iso(k.lastActivatedAt), appVersion: k.appVersion ?? null, revokedAt: iso(k.revokedAt), active: !k.revokedAt,
    };
  }

  listKeys(userId: string): KeyView[] {
    return this.state.keys.filter(k => k.userId === userId).sort((a, b) => b.createdAt - a.createdAt).map(k => this.view(k));
  }

  async createKey(userId: string, deviceName: unknown): Promise<{ key: string; view: KeyView }> {
    if (this.state.keys.filter(k => k.userId === userId && !k.revokedAt).length >= this.config.maxKeysPerUser) {
      throw new AccountError(409, `Você já tem ${this.config.maxKeysPerUser} chaves ativas. Revogue uma antes de criar outra.`, 'too_many_keys');
    }
    const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const hash = this.hash(key);
    const k: ActivationKey = { id: `akey_${hash.slice(0, 16)}`, userId, hash, prefix: key.slice(0, KEY_PREFIX.length + 4), deviceName: cleanDeviceName(deviceName), createdAt: this.now() };
    this.state.keys.push(k);
    this.byKeyHash.set(hash, k);
    await this.save();
    return { key, view: this.view(k) };
  }

  async revokeKey(userId: string, id: string): Promise<KeyView> {
    const k = this.state.keys.find(x => x.id === id && x.userId === userId);
    if (!k) throw new AccountError(404, 'Chave não encontrada.', 'key_not_found');
    k.revokedAt ??= this.now();
    this.byKeyHash.delete(k.hash);
    await this.save();
    return this.view(k);
  }

  /** The active key a bearer token is, with its user; null for anything else (other gateway keys included). */
  keyOf(token: string): { key: ActivationKey; user: User } | null {
    if (!token.startsWith(KEY_PREFIX) || !KEY_RE.test(token)) return null;
    const key = this.byKeyHash.get(this.hash(token));
    const user = key && !key.revokedAt ? this.userById(key.userId) : undefined;
    if (!key || !user) return null;
    if (this.opts.isAdmin?.(this.config.app)) {
      if (!this.adminWarned) this.opts.log?.(`accounts: app '${this.config.app}' is an ADMIN user — activation keys refused until it is removed from the admin list`);
      this.adminWarned = true;
      return null;
    }
    const now = this.now();
    if (!key.lastUsedAt || now - key.lastUsedAt > 60_000) { key.lastUsedAt = now; this.dirty = true; }
    return { key, user };
  }

  /** Gateway key registry entry: an activation key acts as the accounts app (its routes, limits; never admin). */
  resolveAppKey(token: string): { key: string; userId: string } | null {
    return this.keyOf(token) ? { key: token, userId: this.config.app } : null;
  }

  get activeKeyCount(): number { return this.byKeyHash.size; }

  get userCount(): number { return this.state.users.length; }

  async activate(token: unknown, deviceName: unknown, appVersion: unknown): Promise<{ user: User; key: ActivationKey }> {
    const found = typeof token === 'string' ? this.keyOf(token.trim()) : null;
    if (!found) throw new AccountError(401, 'Chave de ativação inválida ou revogada.', 'invalid_key');
    const { key, user } = found;
    key.lastActivatedAt = this.now();
    if (typeof deviceName === 'string' && deviceName.trim()) key.deviceName = cleanDeviceName(deviceName);
    if (typeof appVersion === 'string' && appVersion.trim()) key.appVersion = appVersion.replace(/[^\w.+-]/g, '').slice(0, 40);
    await this.save();
    return { user, key };
  }

  // ── Quota ─────────────────────────────────────────────────────────────────

  limitsOf(user: User): Quota {
    return { ...this.config.quota, ...user.quota };
  }

  quotaView(user: User): QuotaView {
    const now = this.now();
    return {
      plan: user.plan, limits: this.limitsOf(user), month: this.opts.usage.month(user.id), today: this.opts.usage.today(user.id),
      monthResetsAt: new Date(nextMonthStart(now)).toISOString(), dayResetsAt: new Date(nextDayStart(now)).toISOString(),
    };
  }

  /**
   * Admission of one metered request: the daily request cap (429) and the monthly limits of the metrics the request
   * uses (402). Usage is counted after the fact, so the request that crosses a limit is still served; the next is not.
   */
  checkQuota(user: User, metrics: QuotaMetric[]): AccountError | null {
    const limits = this.limitsOf(user);
    const now = this.now();
    if (limits.requestsPerDay > 0 && this.opts.usage.today(user.id).requests >= limits.requestsPerDay) {
      const resetAt = new Date(nextDayStart(now)).toISOString();
      return new AccountError(429, `Você atingiu o limite de ${limits.requestsPerDay} pedidos por dia. Ele renova à meia-noite (UTC).`,
        'daily_quota_exceeded', { metric: 'requests', limit: limits.requestsPerDay, reset_at: resetAt, retryAfterSeconds: Math.ceil((nextDayStart(now) - now) / 1000) });
    }
    if (!metrics.length) return null;
    const month = this.opts.usage.month(user.id);
    for (const m of metrics) {
      if (limits[m] > 0 && month[m] >= limits[m]) {
        const resetAt = new Date(nextMonthStart(now));
        const day = resetAt.toISOString().slice(0, 10).split('-').reverse().join('/');
        return new AccountError(402, `${QUOTA_LABEL[m](limits[m])} Ela renova em ${day}.`, 'quota_exceeded',
          { metric: m, limit: limits[m], used: month[m], reset_at: resetAt.toISOString() });
      }
    }
    return null;
  }
}

const QUOTA_LABEL: Record<QuotaMetric, (limit: number) => string> = {
  audioSeconds: (l) => `Sua cota mensal de transcrição acabou (${Math.round(l / 60)} min).`,
  llmTokens: (l) => `Sua cota mensal de tradução acabou (${l.toLocaleString('pt-BR')} tokens).`,
  ttsChars: (l) => `Sua cota mensal de dublagem acabou (${l.toLocaleString('pt-BR')} caracteres).`,
  rooms: (l) => `Sua cota mensal de salas ao vivo acabou (${l}).`,
};

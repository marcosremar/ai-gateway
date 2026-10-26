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
import { PAID_PLANS, higherPlan, nextPlan, planOf, type PlanId } from './plans';
import * as mails from './email-templates';
import type { PageLang } from './page-strings';

export const KEY_PREFIX = 'ucast_live_';
const KEY_RE = /^ucast_live_[A-Za-z0-9_-]{43}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DEVICE_MAX = 60;
const VERIFY_TTL_MS = 48 * 60 * 60_000;

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
  /** Set at sign-up until the link in the confirmation e-mail is opened; accounts from before verification have none. */
  emailUnverified?: boolean;
  stripeCustomerId?: string;
  planRenewsAt?: number;
  planCancelsAtPeriodEnd?: boolean;
  lang?: PageLang;
  /** Paid plan given by a coupon: valid until `endsAt`, never charged, never renewed. */
  grant?: PlanGrant;
}

export interface PlanGrant { plan: PlanId; endsAt: number; code: string }

export interface Coupon {
  code: string;
  plan: PlanId;
  months: number;
  maxUses: number;
  usedBy: string[];
  createdAt: number;
  expiresAt?: number;
  note?: string;
}

const COUPON_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const couponKey = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const addMonths = (ms: number, months: number) => {
  const date = new Date(ms);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
};

export type BillingFields = Partial<Pick<User, 'plan' | 'stripeCustomerId' | 'planRenewsAt' | 'planCancelsAtPeriodEnd'>>;

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

interface State { version: 1; users: User[]; sessions: Session[]; keys: ActivationKey[]; resets: ResetToken[]; verifications: ResetToken[]; coupons: Coupon[] }

export interface KeyView {
  id: string; prefix: string; deviceName: string; createdAt: string; lastUsedAt: string | null;
  lastActivatedAt: string | null; appVersion: string | null; revokedAt: string | null; active: boolean;
}

export interface QuotaView { plan: string; limits: Quota; month: Counters; today: Counters; monthResetsAt: string; dayResetsAt: string; grantEndsAt: string | null; viaCoupon: boolean; planRenewsAt: string | null; planCancelsAtPeriodEnd: boolean }

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
  /** Plan limits (plans.ts) apply: billing is configured. */
  planLimits?: boolean;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class AccountService {
  private state: State = { version: 1, users: [], sessions: [], keys: [], resets: [], verifications: [], coupons: [] };
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
    if (read.data) this.state = { version: 1, users: read.data.users ?? [], sessions: read.data.sessions ?? [], keys: read.data.keys ?? [], resets: read.data.resets ?? [], verifications: read.data.verifications ?? [], coupons: read.data.coupons ?? [] };
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
    this.state.verifications = this.state.verifications.filter(v => v.expiresAt > now && !v.usedAt);
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
  async signup(rawEmail: unknown, password: unknown, lang: PageLang = 'pt'): Promise<{ user: User; session: { token: string; csrf: string } }> {
    const email = normalizeEmail(rawEmail);
    if (!email) throw new AccountError(400, 'Informe um e-mail válido.', 'invalid_email');
    const problem = passwordProblem(password);
    if (problem) throw new AccountError(400, problem, 'weak_password');
    const pw = password as string;
    const existing = this.state.users.find(u => u.email === email);
    if (existing) {
      if (!existing.disabledAt && await verifyPassword(pw, existing.passwordHash)) return { user: existing, session: await this.openSession(existing) };
      void this.opts.email.send({ to: email, ...mails.signupAttempt(existing.lang ?? lang, `${this.config.publicBaseUrl}/login`, `${this.config.publicBaseUrl}/forgot`) }).catch(() => {});
      throw new AccountError(400, 'Não foi possível criar a conta com estes dados. Se você já tem conta, entre ou recupere a senha.', 'signup_refused');
    }
    const now = this.now();
    const user: User = { id: `usr_${randomUUID().replace(/-/g, '')}`, email, passwordHash: await hashPassword(pw), plan: this.config.plan, createdAt: now, passwordChangedAt: now, emailUnverified: true, lang };
    this.state.users.push(user);
    const session = await this.openSession(user);
    await this.sendVerification(user, true);
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
  async rememberLanguage(user: User, lang: PageLang | undefined): Promise<void> {
    if (!lang || user.lang === lang) return;
    user.lang = lang;
    await this.save();
  }

  async requestReset(rawEmail: unknown, lang?: PageLang): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const user = email ? this.state.users.find(u => u.email === email && !u.disabledAt) : undefined;
    if (!user) return;
    if (lang) user.lang = lang;
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.state.resets = this.state.resets.filter(r => r.userId !== user.id);
    this.state.resets.push({ hash: this.hash(token), userId: user.id, expiresAt: now + this.config.resetTtlMs });
    await this.save();
    const link = `${this.config.publicBaseUrl}/reset#token=${token}`;
    const minutes = Math.round(this.config.resetTtlMs / 60_000);
    await this.opts.email.send({ to: user.email, ...mails.resetPassword(user.lang ?? 'pt', link, minutes) }).catch((err: unknown) => this.opts.log?.('accounts: reset e-mail failed', { error: err instanceof Error ? err.message : String(err) }));
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
    void this.opts.email.send({ to: user.email, ...mails.passwordChanged(user.lang ?? 'pt', `${this.config.publicBaseUrl}/forgot`) }).catch(() => {});
  }

  // ── E-mail verification and account deletion ─────────────────────────────

  async sendVerification(user: User, welcome = false): Promise<void> {
    if (!user.emailUnverified) return;
    const token = randomBytes(32).toString('base64url');
    this.state.verifications = this.state.verifications.filter(v => v.userId !== user.id);
    this.state.verifications.push({ hash: this.hash(token), userId: user.id, expiresAt: this.now() + VERIFY_TTL_MS });
    await this.save();
    const link = `${this.config.publicBaseUrl}/verify#token=${token}`;
    await this.opts.email.send({ to: user.email, ...mails.verifyEmail(user.lang ?? 'pt', link, welcome, this.config.downloadUrl) }).catch((err: unknown) => this.opts.log?.('accounts: verification e-mail failed', { error: err instanceof Error ? err.message : String(err) }));
  }

  async verifyEmail(token: unknown): Promise<void> {
    const now = this.now();
    const hash = typeof token === 'string' && token.length <= 128 ? this.hash(token) : '';
    const v = this.state.verifications.find(x => x.hash === hash && !x.usedAt && x.expiresAt > now);
    const user = v ? this.userById(v.userId) : undefined;
    if (!v || !user) throw new AccountError(400, 'Este link de confirmação é inválido ou expirou. Peça um novo na sua conta.', 'invalid_verify_token');
    v.usedAt = now;
    delete user.emailUnverified;
    await this.save();
  }

  /** Needs the current password: removes the user, sessions, keys, pending links and usage rows. */
  async checkPassword(user: User, password: unknown): Promise<void> {
    const pw = typeof password === 'string' ? password.slice(0, 1024) : '';
    if (!await verifyPassword(pw, user.passwordHash)) throw new AccountError(401, 'Senha incorreta.', 'wrong_password');
  }

  async deleteAccount(user: User, password: unknown): Promise<void> {
    await this.checkPassword(user, password);
    const notMine = (x: { userId: string }) => x.userId !== user.id;
    this.state.users = this.state.users.filter(u => u.id !== user.id);
    this.state.sessions = this.state.sessions.filter(notMine);
    this.state.resets = this.state.resets.filter(notMine);
    this.state.verifications = this.state.verifications.filter(notMine);
    this.state.keys = this.state.keys.filter(notMine);
    this.reindex();
    this.opts.usage.forget(user.id);
    await this.save();
    this.opts.log?.('accounts: account deleted', { userId: user.id });
    void this.opts.email.send({ to: user.email, ...mails.accountDeleted(user.lang ?? 'pt') }).catch(() => {});
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
    if (this.userById(userId)?.emailUnverified) throw new AccountError(403, 'Confirme seu e-mail antes de criar uma chave.', 'email_not_verified');
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

  // ── Admin (ACCOUNTS_ADMIN_EMAILS) ─────────────────────────────────────────

  /** True when the account's e-mail is on the admin list. */
  isAdminUser(user: User): boolean {
    return this.opts.config.adminEmails.includes(user.email);
  }

  /** Every active account, newest first, with the last session activity of each. Admin routes only. */
  listUsers(): Array<{ id: string; email: string; createdAt: string; lastSeenAt: string | null }> {
    const seen = new Map<string, number>();
    for (const s of this.state.sessions) {
      const prev = seen.get(s.userId) ?? 0;
      if (s.lastSeenAt > prev) seen.set(s.userId, s.lastSeenAt);
    }
    return this.state.users
      .filter(u => !u.disabledAt)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(u => ({ id: u.id, email: u.email, createdAt: iso(u.createdAt)!, lastSeenAt: iso(seen.get(u.id)) }));
  }

  /**
   * Creates an activation key for another account and e-mails the full key to its owner (admin action). The key never
   * appears in the API answer — only in the e-mail. The per-user key limit does not apply here (an admin may replace a
   * lost key of an account already at the limit; revoking old ones stays the owner's job).
   */
  async sendAccessKey(targetId: string, deviceName: unknown): Promise<{ email: string; view: KeyView }> {
    const user = this.state.users.find(u => u.id === targetId);
    if (!user || user.disabledAt) throw new AccountError(404, 'Usuário não encontrado.', 'user_not_found');
    const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const hash = this.hash(key);
    const k: ActivationKey = {
      id: `akey_${hash.slice(0, 16)}`, userId: user.id, hash, prefix: key.slice(0, KEY_PREFIX.length + 4),
      deviceName: cleanDeviceName(deviceName), createdAt: this.now(),
    };
    this.state.keys.push(k);
    this.byKeyHash.set(hash, k);
    await this.save();
    await this.opts.email.send({ to: user.email, ...mails.accessKey(user.lang ?? 'pt', key) });
    this.opts.log?.('accounts: admin sent access key', { userId: user.id, keyId: k.id });
    return { email: user.email, view: this.view(k) };
  }

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
    const planQuota = this.opts.planLimits && !this.isAdminUser(user) ? planOf(this.effectivePlan(user)).quota : {};
    return { ...this.config.quota, ...planQuota, ...user.quota };
  }

  effectivePlan(user: User): PlanId {
    const own = planOf(user.plan).id;
    return user.grant && user.grant.endsAt > this.now() ? higherPlan(own, user.grant.plan) : own;
  }

  async createCoupons(input: { plan?: unknown; months?: unknown; count?: unknown; maxUses?: unknown; expiresAt?: unknown; note?: unknown }): Promise<Coupon[]> {
    const plan = PAID_PLANS.find(p => p.id === (input.plan ?? 'pro'));
    const integer = (value: unknown, fallback: number, min: number, max: number) => {
      const n = value === undefined ? fallback : Number(value);
      if (!Number.isInteger(n) || n < min || n > max) throw new AccountError(400, 'Valor inválido.', 'invalid_coupon_input');
      return n;
    };
    if (!plan) throw new AccountError(400, 'Plano inválido.', 'invalid_coupon_input');
    const months = integer(input.months, 3, 1, 24);
    const count = integer(input.count, 1, 1, 500);
    const maxUses = integer(input.maxUses, 1, 1, 100_000);
    const expiresAt = input.expiresAt === undefined ? undefined : Date.parse(String(input.expiresAt));
    if (expiresAt !== undefined && !(expiresAt > this.now())) throw new AccountError(400, 'Validade inválida.', 'invalid_coupon_input');
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 80) : undefined;
    const taken = new Set(this.state.coupons.map(c => couponKey(c.code)));
    const made: Coupon[] = [];
    while (made.length < count) {
      const letters = Array.from(randomBytes(8), b => COUPON_ALPHABET[b % COUPON_ALPHABET.length]).join('');
      const code = `UCAST-${letters.slice(0, 4)}-${letters.slice(4)}`;
      if (taken.has(couponKey(code))) continue;
      taken.add(couponKey(code));
      made.push({ code, plan: plan.id, months, maxUses, usedBy: [], createdAt: this.now(), ...(expiresAt ? { expiresAt } : {}), ...(note ? { note } : {}) });
    }
    this.state.coupons.push(...made);
    await this.save();
    return made;
  }

  private hasAccount(email: string): boolean {
    return this.state.users.some(u => u.email === email && !u.disabledAt);
  }

  private freeEmail(raw: unknown): string {
    const email = normalizeEmail(raw);
    if (!email) throw new AccountError(400, 'Informe um e-mail válido.', 'invalid_email');
    if (this.hasAccount(email)) throw new AccountError(409, 'Este e-mail já tem conta.', 'coupon_email_registered');
    return email;
  }

  async sendCoupon(code: unknown, rawEmail: unknown, lang: PageLang): Promise<string> {
    const email = this.freeEmail(rawEmail);
    const wanted = typeof code === 'string' ? couponKey(code) : '';
    const coupon = wanted ? this.state.coupons.find(c => couponKey(c.code) === wanted) : undefined;
    if (!coupon) throw new AccountError(404, 'Código inválido.', 'invalid_coupon');
    await this.opts.email.send({ to: email, ...mails.coupon(lang, coupon.code, coupon.months) });
    this.opts.log?.('accounts: admin sent coupon', { code: coupon.code });
    return email;
  }

  async issueCoupons(input: Parameters<AccountService['createCoupons']>[0], rawEmails: unknown, lang: PageLang): Promise<{ coupons: Coupon[]; skipped: string[] }> {
    const list = Array.isArray(rawEmails) ? rawEmails : [];
    if (list.length > 200) throw new AccountError(400, 'Informe até 200 e-mails.', 'invalid_email');
    const valid = list.map(normalizeEmail);
    if (valid.some(email => email === null)) throw new AccountError(400, 'Informe e-mails válidos.', 'invalid_email');
    const unique = [...new Set(valid as string[])];
    const skipped = unique.filter(email => this.hasAccount(email));
    const emails = unique.filter(email => !skipped.includes(email));
    if (unique.length && !emails.length) throw new AccountError(409, 'Todos esses e-mails já têm conta.', 'coupon_email_registered');
    const coupons = await this.createCoupons(unique.length ? { ...input, count: emails.length, maxUses: 1 } : input);
    for (const [index, email] of emails.entries()) await this.sendCoupon(coupons[index]!.code, email, lang);
    return { coupons, skipped };
  }

  listCoupons(): Array<Omit<Coupon, 'usedBy'> & { uses: number }> {
    return this.state.coupons.map(({ usedBy, ...coupon }) => ({ ...coupon, uses: usedBy.length }));
  }

  async redeemCoupon(user: User, raw: unknown): Promise<PlanGrant> {
    const wanted = typeof raw === 'string' ? couponKey(raw) : '';
    const coupon = wanted ? this.state.coupons.find(c => couponKey(c.code) === wanted) : undefined;
    if (!coupon) throw new AccountError(404, 'Código inválido.', 'invalid_coupon');
    if (coupon.expiresAt && coupon.expiresAt <= this.now()) throw new AccountError(410, 'Este código expirou.', 'coupon_expired');
    if (coupon.usedBy.length >= coupon.maxUses) throw new AccountError(409, 'Este código já foi usado.', 'coupon_used');
    if (user.grant) throw new AccountError(409, 'Esta conta já usou um código.', 'coupon_already_redeemed');
    user.grant = { plan: coupon.plan, endsAt: addMonths(this.now(), coupon.months), code: coupon.code };
    coupon.usedBy.push(user.id);
    await this.save();
    return user.grant;
  }

  userByStripeCustomer(customerId: string): User | undefined {
    return this.state.users.find(u => u.stripeCustomerId === customerId && !u.disabledAt);
  }

  async setBilling(user: User, fields: BillingFields): Promise<void> {
    for (const [k, v] of Object.entries(fields) as Array<[keyof BillingFields, unknown]>) {
      if (v === undefined) delete user[k];
      else (user as unknown as Record<string, unknown>)[k] = v;
    }
    if (!user.plan) user.plan = this.config.plan;
    await this.save();
  }

  quotaView(user: User): QuotaView {
    const now = this.now();
    return {
      plan: this.effectivePlan(user), limits: this.limitsOf(user),
      grantEndsAt: user.grant && user.grant.endsAt > now ? iso(user.grant.endsAt) : null,
      viaCoupon: Boolean(user.grant && user.grant.endsAt > now && this.effectivePlan(user) !== planOf(user.plan).id), month: this.opts.usage.month(user.id), today: this.opts.usage.today(user.id),
      monthResetsAt: new Date(nextMonthStart(now)).toISOString(), dayResetsAt: new Date(nextDayStart(now)).toISOString(),
      planRenewsAt: iso(user.planRenewsAt), planCancelsAtPeriodEnd: Boolean(user.planCancelsAtPeriodEnd),
    };
  }

  /**
   * Admission of one metered request worth `requests` (a realtime session: its whole charge): the daily request cap
   * (429) and the monthly limits of the metrics the request uses (402). Usage is counted after the fact, so the request
   * that crosses a monthly limit is still served; the next is not.
   */
  checkQuota(user: User, metrics: QuotaMetric[], requests = 1): AccountError | null {
    const limits = this.limitsOf(user);
    const now = this.now();
    if (limits.requestsPerDay > 0 && this.opts.usage.today(user.id).requests + requests > limits.requestsPerDay) {
      const resetAt = new Date(nextDayStart(now)).toISOString();
      return new AccountError(429, `Sua conta atingiu o limite de ${limits.requestsPerDay} pedidos por dia. Ele renova à meia-noite (UTC).`,
        'daily_quota_exceeded', { scope: 'account', metric: 'requests', limit: limits.requestsPerDay, reset_at: resetAt, retryAfterSeconds: Math.ceil((nextDayStart(now) - now) / 1000) });
    }
    if (!metrics.length) return null;
    const month = this.opts.usage.month(user.id);
    for (const m of metrics) {
      if (limits[m] > 0 && month[m] >= limits[m]) {
        const resetAt = new Date(nextMonthStart(now));
        const day = resetAt.toISOString().slice(0, 10).split('-').reverse().join('/');
        const upgrade = this.opts.planLimits ? nextPlan(user.plan) : null;
        return new AccountError(402, `${QUOTA_LABEL[m](limits[m])} Ela renova em ${day}.${upgrade ? ` Para continuar agora, mude de plano em ${this.config.publicBaseUrl}/account.` : ''}`, 'quota_exceeded',
          { metric: m, limit: limits[m], used: month[m], reset_at: resetAt.toISOString(), ...(upgrade ? { upgrade_url: `${this.config.publicBaseUrl}/account?plan=${upgrade}` } : {}) });
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

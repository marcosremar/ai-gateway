// ── AI Gateway — ucast.me accounts: configuration ───────────────────────────
// Every knob comes from the environment with a default (docs/accounts.md). Nothing about the public site (hosts, base
// URL, download link) is hardcoded elsewhere.

import { homedir } from 'os';
import { join } from 'path';

/** A metered quantity. `requests` is per UTC day; the others per UTC month. */
export type QuotaMetric = 'audioSeconds' | 'llmTokens' | 'ttsChars' | 'rooms';

/** Per-user limits; 0 = unlimited. */
export interface Quota {
  /** STT audio per UTC month, in seconds. */
  audioSeconds: number;
  /** LLM tokens per UTC month. */
  llmTokens: number;
  /** TTS input characters per UTC month. */
  ttsChars: number;
  /** Live rooms created per UTC month. */
  rooms: number;
  /** Metered requests per UTC day (429 when over), in the app budget's unit: a realtime session counts its whole charge. */
  requestsPerDay: number;
  /** Metered requests in flight at once (429 when over). */
  concurrentRequests: number;
}

export interface AccountsConfig {
  /** accounts.json (users, sessions, keys, reset tokens); null = memory only (tests). */
  statePath: string | null;
  /** account-usage.json (per day / user / key counters); null = memory only. */
  usagePath: string | null;
  /** Gateway app every activation key acts as (its routes, limits, devices). Never an admin user. */
  app: string;
  wakeDeployments: string[];
  /** Hosts whose `/`, `/signup`, `/login`, … serve the account pages (Host header match). */
  siteHosts: string[];
  /** Public base of the site, used in e-mailed links (`<base>/reset?token=…`). */
  publicBaseUrl: string;
  /** "Baixar o app" link on the dashboard. */
  downloadUrl: string;
  /** Secure session cookie (`__Host-` prefix). Off only for plain-http local development. */
  cookieSecure: boolean;
  sessionTtlMs: number;
  resetTtlMs: number;
  maxKeysPerUser: number;
  plan: string;
  quota: Quota;
  /** Days of daily usage rows kept. */
  usageRetentionDays: number;
  email: { resendApiKey: string; from: string; logLinks: boolean };
  /** E-mails with access to the admin routes (list users, send activation keys). Empty = no admins. */
  adminEmails: string[];
  /** HMAC pepper of the stored key / session / reset-token hashes. */
  pepper: string;
}

export const ACCOUNTS_DEFAULTS = {
  APP: 'babelcast',
  WAKE_DEPLOYMENTS: 'babelcast-tts-clone',
  SITE_HOSTS: 'ucast.me,www.ucast.me,app.ucast.me',
  PUBLIC_BASE_URL: 'https://ucast.me',
  DOWNLOAD_URL: 'https://github.com/marcosremar/babelcast/releases/latest',
  SESSION_DAYS: 30,
  RESET_MINUTES: 60,
  MAX_KEYS_PER_USER: 10,
  PLAN: 'free',
  USAGE_RETENTION_DAYS: 400,
  PEPPER: 'ucast-accounts-v1',
  QUOTA_REQUESTS_DAY: 0,
  QUOTA_CONCURRENT: 20,
} as const;

function nonNegative(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function positive(raw: string | undefined, fallback: number): number {
  const n = nonNegative(raw, fallback);
  return n > 0 ? n : fallback;
}

export function accountsConfigFromEnv(env: Record<string, string | undefined> = process.env): AccountsConfig {
  // Same durable dir as access.json and the rooms (the Railway volume).
  const stateDir = env.DEPLOYMENTS_STATE_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || join(homedir(), '.ai-gateway');
  const dir = env.ACCOUNTS_DIR?.trim() || stateDir;
  return {
    statePath: join(dir, 'accounts.json'),
    usagePath: join(dir, 'account-usage.json'),
    app: env.ACCOUNTS_APP?.trim() || ACCOUNTS_DEFAULTS.APP,
    wakeDeployments: (env.ACCOUNTS_WAKE_DEPLOYMENTS ?? ACCOUNTS_DEFAULTS.WAKE_DEPLOYMENTS).split(',').map(d => d.trim()).filter(Boolean),
    siteHosts: (env.ACCOUNTS_SITE_HOSTS ?? ACCOUNTS_DEFAULTS.SITE_HOSTS).split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
    publicBaseUrl: (env.ACCOUNTS_PUBLIC_BASE_URL?.trim() || ACCOUNTS_DEFAULTS.PUBLIC_BASE_URL).replace(/\/+$/, ''),
    downloadUrl: env.ACCOUNTS_DOWNLOAD_URL?.trim() || ACCOUNTS_DEFAULTS.DOWNLOAD_URL,
    cookieSecure: env.ACCOUNTS_COOKIE_SECURE?.trim() !== '0',
    sessionTtlMs: positive(env.ACCOUNTS_SESSION_DAYS, ACCOUNTS_DEFAULTS.SESSION_DAYS) * 86_400_000,
    resetTtlMs: positive(env.ACCOUNTS_RESET_MINUTES, ACCOUNTS_DEFAULTS.RESET_MINUTES) * 60_000,
    maxKeysPerUser: Math.floor(positive(env.ACCOUNTS_MAX_KEYS_PER_USER, ACCOUNTS_DEFAULTS.MAX_KEYS_PER_USER)),
    plan: env.ACCOUNT_DEFAULT_PLAN?.trim() || ACCOUNTS_DEFAULTS.PLAN,
    // Every account of the app shares the app's own daily budget (APP_DAILY_*) and its in-flight limit
    // (MAX_CONCURRENT_PER_USER): those stay the ceiling of the sum. On top, each account has its own daily request
    // budget (`ACCOUNT_QUOTA_REQUESTS_DAY`, default 0 = off) and in-flight limit (default 20),
    // so one account cannot spend the others' share (report 2026-10-12, T5). The monthly limits default to unlimited.
    // The daily request cap is OFF by default (owner, 2026-10-15): live subtitles cost ~40 metered requests a minute
    // (one STT per 2–3 s of speech + one LLM per line), so the old default of 2000 cut a talk after ~50 min with
    // `daily_quota_exceeded` until 00:00 UTC. Set the env var to bring a cap back.
    quota: {
      audioSeconds: Math.floor(nonNegative(env.ACCOUNT_QUOTA_AUDIO_MINUTES_MONTH, 0) * 60),
      llmTokens: Math.floor(nonNegative(env.ACCOUNT_QUOTA_LLM_TOKENS_MONTH, 0)),
      ttsChars: Math.floor(nonNegative(env.ACCOUNT_QUOTA_TTS_CHARS_MONTH, 0)),
      rooms: Math.floor(nonNegative(env.ACCOUNT_QUOTA_ROOMS_MONTH, 0)),
      requestsPerDay: Math.floor(nonNegative(env.ACCOUNT_QUOTA_REQUESTS_DAY, ACCOUNTS_DEFAULTS.QUOTA_REQUESTS_DAY)),
      concurrentRequests: Math.floor(nonNegative(env.ACCOUNT_QUOTA_CONCURRENT, ACCOUNTS_DEFAULTS.QUOTA_CONCURRENT)),
    },
    usageRetentionDays: Math.floor(positive(env.ACCOUNTS_USAGE_RETENTION_DAYS, ACCOUNTS_DEFAULTS.USAGE_RETENTION_DAYS)),
    email: {
      resendApiKey: env.RESEND_API_KEY?.trim() ?? '',
      from: env.EMAIL_FROM?.trim() ?? '',
      logLinks: env.ACCOUNTS_LOG_EMAIL_LINKS?.trim() === '1',
    },
    adminEmails: (env.ACCOUNTS_ADMIN_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
    pepper: env.ACCOUNTS_HASH_PEPPER?.trim() || ACCOUNTS_DEFAULTS.PEPPER,
  };
}

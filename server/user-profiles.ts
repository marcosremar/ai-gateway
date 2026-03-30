// ── AI Gateway — User Profile Store ─────────────────────────────────────────
// Per-user ProviderConfig stored in the AI Gateway's PostgreSQL / Neon database.
// Uses @neondatabase/serverless directly (tagged template syntax) for correct
// parameterized query support with the Neon HTTP driver.
//
// DB: DATABASE_URL env var (Neon serverless or local Postgres via pg fallback).
// Falls back gracefully when no DATABASE_URL is configured.
//
// Table: user_accounts
//   id            TEXT PRIMARY KEY (UUID)
//   name          TEXT
//   api_key       TEXT UNIQUE
//   profile_config TEXT   (JSON-encoded ProviderConfig)
//   is_default    BOOLEAN
//   created_at    TIMESTAMPTZ
//   updated_at    TIMESTAMPTZ

import type { ProviderConfig } from './config-persistence';

// ── DB client (lazy init) ─────────────────────────────────────────────────────

type NeonSql = ReturnType<typeof import('@neondatabase/serverless')['neon']>;
let _sql: NeonSql | null = null;
let _dbAvailable: boolean | null = null; // null = not checked yet

async function getSql(): Promise<NeonSql | null> {
  if (_dbAvailable === false) return null;
  if (_sql) return _sql;

  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!url) {
    _dbAvailable = false;
    return null;
  }

  try {
    const { neon } = await import('@neondatabase/serverless');
    _sql = neon(url);
    _dbAvailable = true;
    return _sql;
  } catch {
    _dbAvailable = false;
    return null;
  }
}

// ── DB init ───────────────────────────────────────────────────────────────────

/** Create the user_accounts table if it doesn't exist. Called once at startup. */
export async function initUserProfilesDb(): Promise<void> {
  const sql = await getSql();
  if (!sql) {
    console.log('[user-profiles] No DATABASE_URL — user profiles stored in JSON file only');
    console.log('[user-profiles] Set DATABASE_URL (Neon or Postgres) to enable DB-backed profiles');
    return;
  }
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS user_accounts (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL DEFAULT 'Default',
        api_key        TEXT UNIQUE NOT NULL,
        profile_config TEXT NOT NULL,
        is_default     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_api_key ON user_accounts(api_key)`;
    console.log('[user-profiles] PostgreSQL user_accounts table ready');
  } catch (err) {
    console.warn('[user-profiles] DB init failed:', err instanceof Error ? err.message : err);
    _dbAvailable = false;
  }
}

// ── In-memory cache ───────────────────────────────────────────────────────────

const _cache = new Map<string, { config: ProviderConfig; loadedAt: number }>();
const CACHE_TTL_MS = 30_000;

// ── Public API ────────────────────────────────────────────────────────────────

/** Load a user's ProviderConfig by API key. Returns null if DB unavailable or key not found. */
export async function getUserConfig(apiKey: string): Promise<ProviderConfig | null> {
  const cached = _cache.get(apiKey);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.config;

  const sql = await getSql();
  if (!sql) return null;

  try {
    const rows = await sql`SELECT profile_config FROM user_accounts WHERE api_key = ${apiKey}`;
    if (!rows.length) return null;
    const config = JSON.parse(rows[0].profile_config as string) as ProviderConfig;
    _cache.set(apiKey, { config, loadedAt: Date.now() });
    return config;
  } catch (err) {
    console.warn('[user-profiles] getUserConfig failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Persist a user's ProviderConfig (upsert by API key). No-op if DB unavailable. */
export async function saveUserConfig(apiKey: string, name: string, config: ProviderConfig): Promise<void> {
  const sql = await getSql();
  if (!sql) return;

  const profileConfig = JSON.stringify(config);
  try {
    await sql`
      INSERT INTO user_accounts (id, name, api_key, profile_config, is_default)
      VALUES (gen_random_uuid()::text, ${name}, ${apiKey}, ${profileConfig}, FALSE)
      ON CONFLICT (api_key) DO UPDATE
        SET name = EXCLUDED.name,
            profile_config = EXCLUDED.profile_config,
            updated_at = NOW()
    `;
    _cache.set(apiKey, { config, loadedAt: Date.now() });
  } catch (err) {
    console.warn('[user-profiles] saveUserConfig failed:', err instanceof Error ? err.message : err);
  }
}

/** List all user accounts (API keys masked for safety). */
export async function listUserAccounts(): Promise<Array<{
  id: string; name: string; apiKeyHint: string; isDefault: boolean; createdAt: string; updatedAt: string;
}>> {
  const sql = await getSql();
  if (!sql) return [];

  try {
    const rows = await sql`SELECT id, name, api_key, is_default, created_at, updated_at FROM user_accounts ORDER BY created_at ASC`;
    return rows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      apiKeyHint: `${(r.api_key as string).slice(0, 4)}…${(r.api_key as string).slice(-4)}`,
      isDefault: r.is_default as boolean,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  } catch {
    return [];
  }
}

/** Create a new user account. Returns false if API key already exists or DB unavailable. */
export async function createUserAccount(apiKey: string, name: string, config: ProviderConfig): Promise<boolean> {
  const sql = await getSql();
  if (!sql) return false;

  try {
    const profileConfig = JSON.stringify(config);
    await sql`
      INSERT INTO user_accounts (id, name, api_key, profile_config, is_default)
      VALUES (gen_random_uuid()::text, ${name}, ${apiKey}, ${profileConfig}, FALSE)
    `;
    return true;
  } catch {
    return false; // UNIQUE constraint or other error
  }
}

/** Invalidate cache so next request reloads from DB. */
export function invalidateUserCache(apiKey: string): void {
  _cache.delete(apiKey);
}

/**
 * Seed the default user account at startup.
 * If GATEWAY_API_KEY is set and no record exists in DB, creates one from the current JSON config.
 * Skips if key already in DB.
 */
export async function seedDefaultUserAccount(apiKey: string, name: string, config: ProviderConfig): Promise<boolean> {
  if (!apiKey) return false;
  const sql = await getSql();
  if (!sql) return false;

  try {
    const existing = await sql`SELECT id FROM user_accounts WHERE api_key = ${apiKey}`;
    if (existing.length > 0) return false; // already seeded

    const profileConfig = JSON.stringify(config);
    await sql`
      INSERT INTO user_accounts (id, name, api_key, profile_config, is_default)
      VALUES (gen_random_uuid()::text, ${name}, ${apiKey}, ${profileConfig}, TRUE)
    `;
    console.log(`[user-profiles] Default user seeded in Neon PostgreSQL (name="${name}", key=…${apiKey.slice(-4)})`);
    return true;
  } catch (err) {
    console.warn('[user-profiles] seedDefaultUserAccount failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

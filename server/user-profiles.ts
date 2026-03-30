// ── AI Gateway — User Profile Store ─────────────────────────────────────────
// Per-user ProviderConfig stored in the AI Gateway's PostgreSQL database
// (Neon serverless or local Postgres via DATABASE_URL).
//
// Uses the existing ai-gateway DatabaseService (src/database/service.ts).
// If DATABASE_URL is not configured, user profiles are kept in the JSON file only
// and a warning is logged at startup — no crash.
//
// Table: user_accounts
//   id            TEXT PRIMARY KEY
//   name          TEXT
//   api_key       TEXT UNIQUE
//   profile_config TEXT   -- JSON-encoded ProviderConfig
//   is_default    BOOLEAN
//   created_at    TIMESTAMPTZ
//   updated_at    TIMESTAMPTZ
//
// Flow:
//   1. Gateway starts → initUserProfilesDb() creates table if not exists
//   2. seedDefaultUserAccount() seeds DB from GATEWAY_API_KEY + current JSON config
//   3. Request with Bearer token → onAuth(apiKey) loads config from DB
//   4. applyUserConfig(config) updates in-memory cache → all handlers use it
//   5. PATCH /v1/config/providers → saveProviderConfig() persists to JSON + DB

import type { ProviderConfig } from './config-persistence';

// ── DB availability ───────────────────────────────────────────────────────────

let _dbAvailable: boolean | null = null; // null = not checked yet

async function getDb() {
  const { getDatabase } = await import('../src/database/service');
  return getDatabase();
}

/** Initialize the user_accounts table. Called once at gateway startup. */
export async function initUserProfilesDb(): Promise<void> {
  if (_dbAvailable !== null) return;
  try {
    const db = await getDb();
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_accounts (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL DEFAULT 'Default',
        api_key        TEXT UNIQUE NOT NULL,
        profile_config TEXT NOT NULL,
        is_default     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_api_key ON user_accounts(api_key)`
    );
    _dbAvailable = true;
    console.log('[user-profiles] PostgreSQL user_accounts table ready');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('DATABASE_URL')) {
      console.log('[user-profiles] No DATABASE_URL configured — user profiles stored in JSON file only');
      console.log('[user-profiles] Set DATABASE_URL (Neon or local Postgres) to enable DB-backed profiles');
    } else {
      console.warn('[user-profiles] DB init failed:', msg);
    }
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

  if (!_dbAvailable) return null;
  try {
    const db = await getDb();
    const result = await db.query<{ profile_config: string }>(
      'SELECT profile_config FROM user_accounts WHERE api_key = $1',
      [apiKey]
    );
    if (!result.rows.length) return null;
    const config = JSON.parse(result.rows[0].profile_config) as ProviderConfig;
    _cache.set(apiKey, { config, loadedAt: Date.now() });
    return config;
  } catch (err) {
    console.warn('[user-profiles] getUserConfig failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Persist a user's ProviderConfig to DB (upsert by API key). No-op if DB unavailable. */
export async function saveUserConfig(apiKey: string, name: string, config: ProviderConfig): Promise<void> {
  if (!_dbAvailable) return;
  try {
    const db = await getDb();
    const profileConfig = JSON.stringify(config);
    await db.query(
      `INSERT INTO user_accounts (id, name, api_key, profile_config, is_default)
       VALUES (gen_random_uuid()::text, $1, $2, $3, FALSE)
       ON CONFLICT (api_key) DO UPDATE
         SET name = EXCLUDED.name,
             profile_config = EXCLUDED.profile_config,
             updated_at = NOW()`,
      [name, apiKey, profileConfig]
    );
    _cache.set(apiKey, { config, loadedAt: Date.now() });
  } catch (err) {
    console.warn('[user-profiles] saveUserConfig failed:', err instanceof Error ? err.message : err);
  }
}

/** List all user accounts (API keys masked for safety). */
export async function listUserAccounts(): Promise<Array<{
  id: string; name: string; apiKeyHint: string; isDefault: boolean; createdAt: string; updatedAt: string;
}>> {
  if (!_dbAvailable) return [];
  try {
    const db = await getDb();
    const result = await db.query<{
      id: string; name: string; api_key: string; is_default: boolean; created_at: string; updated_at: string;
    }>('SELECT id, name, api_key, is_default, created_at, updated_at FROM user_accounts ORDER BY created_at ASC');
    return result.rows.map(r => ({
      id: r.id,
      name: r.name,
      apiKeyHint: `${r.api_key.slice(0, 4)}…${r.api_key.slice(-4)}`,
      isDefault: r.is_default,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch {
    return [];
  }
}

/** Create a new user account. Returns false if API key already exists or DB unavailable. */
export async function createUserAccount(apiKey: string, name: string, config: ProviderConfig): Promise<boolean> {
  if (!_dbAvailable) return false;
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO user_accounts (id, name, api_key, profile_config, is_default)
       VALUES (gen_random_uuid()::text, $1, $2, $3, FALSE)`,
      [name, apiKey, JSON.stringify(config)]
    );
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
 * Seed the default user account at gateway startup.
 * If GATEWAY_API_KEY is set and no record exists in DB, creates one from the current JSON config.
 * Skips if key already in DB (config already managed via API).
 * No-op if DB is not available.
 */
export async function seedDefaultUserAccount(apiKey: string, name: string, config: ProviderConfig): Promise<boolean> {
  if (!apiKey || !_dbAvailable) return false;
  try {
    const db = await getDb();
    // Check if already exists
    const existing = await db.query<{ id: string }>(
      'SELECT id FROM user_accounts WHERE api_key = $1',
      [apiKey]
    );
    if (existing.rows.length > 0) return false; // already seeded

    await db.query(
      `INSERT INTO user_accounts (id, name, api_key, profile_config, is_default)
       VALUES (gen_random_uuid()::text, $1, $2, $3, TRUE)`,
      [name, apiKey, JSON.stringify(config)]
    );
    console.log(`[user-profiles] Default user seeded in PostgreSQL (name="${name}", key=…${apiKey.slice(-4)})`);
    return true;
  } catch (err) {
    console.warn('[user-profiles] seedDefaultUserAccount failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

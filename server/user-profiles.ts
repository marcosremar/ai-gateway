/**
 * User profile DB — stub for local/desktop usage.
 *
 * In production (with PostgreSQL), this would persist per-user AI settings.
 * For the desktop app, profiles are stored in the local SQLite config DB,
 * so these functions are no-ops.
 */

export async function initUserProfilesDb(): Promise<void> {
  // No-op for local usage — profiles live in SQLite config
}

export async function getUserConfig(_apiKey: string): Promise<Record<string, unknown> | null> {
  return null; // No DB — caller falls back to in-memory config
}

export async function saveUserConfig(
  _apiKey: string,
  _name: string,
  _config: Record<string, unknown>,
): Promise<void> {
  // No-op for local usage — config saved to disk by config-persistence.ts
}

export async function seedDefaultUserAccount(
  _apiKey: string,
  _name: string,
  _config: Record<string, unknown>,
): Promise<void> {
  // No-op for local usage
}

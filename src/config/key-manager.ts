/**
 * Provider keys that change at runtime, without a deploy.
 *
 *   - `reload()` re-reads the palco (`loadSandboxEnv`): new/changed keys are written into the environment, keys
 *     the palco stopped returning (and that came from it) are removed. A failed reload keeps the current keys.
 *   - `start()` reloads every `RELOAD_INTERVAL_MS` (5 min).
 *   - `write({NAME: value})` stores keys on the palco (`PUT <palco>/api/sandbox-env`, Bearer SANDBOX_TOKEN — the
 *     single home of the keys) and reloads.
 *
 * Providers read their key from the environment on every request (see openai-compat client handling), and
 * `onChange` lets the server re-mount providers / reset circuits, so a key that appears or disappears takes effect
 * on the next request. Results and logs carry key NAMES only, never values.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { CustomRoute } from '../gateway/proxy/types';
import { isEnvPinned, loadSandboxEnv, principalSandboxToken, sandboxEnvUrls } from './sandbox-env';

export const RELOAD_INTERVAL_MS = 5 * 60_000;

const KEY_NAME = /^[A-Z][A-Z0-9_]*$/;

export interface ReloadResult {
  ok: boolean;
  source: string | null;
  /** Keys added or whose value changed. */
  changed: string[];
  /** Keys removed because the palco no longer returns them. */
  removed: string[];
  errors: string[];
}

export interface KeyManagerOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Called after a reload that changed or removed at least one key (names only). */
  onChange?: (names: string[]) => void | Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class KeyManagerError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class KeyManager {
  /** Keys whose current value came from the palco (only these are removed when the palco drops them). */
  private readonly fromPalco = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<ReloadResult> | null = null;

  constructor(private readonly env: Record<string, string | undefined>, private readonly opts: KeyManagerOptions = {}) {}

  /** Records the keys the boot-time `loadSandboxEnv` received, so later reloads can remove them. */
  adopt(names: string[]): void {
    for (const name of names) this.fromPalco.add(name);
  }

  reload(): Promise<ReloadResult> {
    // Coalesce concurrent reloads (timer + admin call).
    this.inflight ??= this.reloadOnce().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async reloadOnce(): Promise<ReloadResult> {
    const r = await loadSandboxEnv(this.env, { fetchImpl: this.opts.fetchImpl, timeoutMs: this.opts.timeoutMs });
    if (!r.source) {
      this.opts.log?.('Key reload failed — keeping the current keys', { errors: r.errors });
      return { ok: false, source: null, changed: [], removed: [], errors: r.errors };
    }
    const received = new Set(r.received);
    const removed: string[] = [];
    for (const name of this.fromPalco) {
      if (received.has(name)) continue;
      delete this.env[name];
      this.fromPalco.delete(name);
      removed.push(name);
    }
    for (const name of received) this.fromPalco.add(name);
    const result: ReloadResult = { ok: true, source: r.source, changed: r.applied, removed, errors: r.errors };
    if (result.changed.length || removed.length) {
      this.opts.log?.('Keys reloaded from the palco', { changed: result.changed, removed });
      try {
        await this.opts.onChange?.([...result.changed, ...removed]);
      } catch (err) {
        this.opts.log?.('Re-mounting providers after a key reload failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  start(intervalMs = RELOAD_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.reload(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Stores keys on the palco, then reloads. Rejects (400) pinned names (SANDBOX_TOKEN and aliases, PORT, …),
   * malformed names and non-string values; 502 when the palco refuses or is unreachable.
   */
  async write(values: unknown): Promise<{ written: string[]; reload: ReloadResult }> {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new KeyManagerError(400, 'body must be a JSON object {NAME: value}');
    const entries = Object.entries(values as Record<string, unknown>);
    if (entries.length === 0) throw new KeyManagerError(400, 'no keys given');
    for (const [name, value] of entries) {
      if (!KEY_NAME.test(name)) throw new KeyManagerError(400, `invalid key name '${name}'`);
      if (isEnvPinned(name)) throw new KeyManagerError(400, `'${name}' is protected and cannot be written through the gateway`);
      if (typeof value !== 'string' || !value.trim()) throw new KeyManagerError(400, `value of '${name}' must be a non-empty string`);
    }
    const token = principalSandboxToken(this.env);
    if (!token) throw new KeyManagerError(503, 'SANDBOX_TOKEN is not set — the gateway cannot write to the palco');
    const url = sandboxEnvUrls(this.env)[0];
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(Object.fromEntries(entries.map(([n, v]) => [n, (v as string).trim()]))),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new KeyManagerError(502, `palco unreachable: ${err instanceof Error ? err.name : 'error'}`);
    }
    if (!res.ok) throw new KeyManagerError(502, `palco refused the write: HTTP ${res.status}`);
    const written = entries.map(([n]) => n);
    this.opts.log?.('Keys written to the palco', { written });
    return { written, reload: await this.reload() };
  }
}

const MAX_KEYS_BODY = 64 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_KEYS_BODY) throw new KeyManagerError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new KeyManagerError(400, 'body must be JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Admin routes (mounted as proxy custom routes, i.e. after the API-key check):
 *   POST /v1/admin/keys/reload   re-read the palco now          → { ok, changed, removed, errors }
 *   PUT  /v1/admin/keys          {NAME: value} → palco, reload   → { written, changed, removed }
 * `authorize(bearer)` restricts them to admin keys (DEPLOYMENTS_ADMIN_USERS).
 */
export function createKeyAdminRoutes(manager: KeyManager, authorize: (bearerToken: string) => boolean): CustomRoute[] {
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token && authorize(token)) return true;
    sendJson(res, 403, { error: { message: 'this API key cannot manage gateway keys', type: 'permission_error' } });
    return false;
  };
  const fail = (res: ServerResponse, err: unknown) => {
    const status = err instanceof KeyManagerError ? err.status : 500;
    const message = err instanceof KeyManagerError ? err.message : 'key operation failed';
    sendJson(res, status, { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error' } });
  };
  return [
    {
      method: 'POST',
      path: '/v1/admin/keys/reload',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          const r = await manager.reload();
          sendJson(res, r.ok ? 200 : 502, { ok: r.ok, changed: r.changed, removed: r.removed, errors: r.errors });
        } catch (err) { fail(res, err); }
      },
    },
    {
      method: 'PUT',
      path: '/v1/admin/keys',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          const { written, reload } = await manager.write(await readJsonBody(req));
          sendJson(res, 200, { written, reloaded: reload.ok, changed: reload.changed, removed: reload.removed });
        } catch (err) { fail(res, err); }
      },
    },
  ];
}

import type { AppLimitDenial } from '../gateway/proxy/app-limits';
import { AppError, isAppId, type AppDevice, type AppRegistry } from './apps';

export const DEVICE_HEADER = 'x-gateway-device';
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:-]{7,63}$/;
const SECRET_LIKE_RE = /^(sk|pk|rk)[-_]|^eyJ|^(key|token|secret|bearer|password)[-_:]/i;
const APP_DEVICE_DEFAULTS = { maxPerApp: 2000, flushMs: 30_000, listLimit: 500 } as const;

const DAY_MS = 86_400_000;
const SORTS = ['lastSeen', 'firstSeen', 'requestsToday', 'requests'] as const;
type Sort = typeof SORTS[number];

export interface AppDeviceView extends Omit<AppDevice, 'day'> { id: string }

export interface AppDevicesOptions {
  now?: () => number;
  maxPerApp?: number;
  flushMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export function deviceIdOf(raw: unknown): string | null {
  return typeof raw === 'string' && DEVICE_ID_RE.test(raw) && !SECRET_LIKE_RE.test(raw) ? raw : null;
}

function safeDecode(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

const fresh = (now: number): AppDevice =>
  ({ firstSeen: now, lastSeen: now, day: Math.floor(now / DAY_MS), requestsToday: 0, requests: 0, lastKind: null });

const INVALID: AppLimitDenial = {
  status: 400, type: 'invalid_request_error', code: 'invalid_device',
  message: `device id must match ${DEVICE_ID_RE} and must not be a key or token`,
};

export class AppDevices {
  onBlock: ((app: string, device: string) => void) | null = null;
  private readonly byApp = new Map<string, Map<string, AppDevice>>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly maxPerApp: number;
  private readonly flushMs: number;

  constructor(private readonly registry: AppRegistry, private readonly opts: AppDevicesOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxPerApp = opts.maxPerApp ?? APP_DEVICE_DEFAULTS.maxPerApp;
    this.flushMs = opts.flushMs ?? APP_DEVICE_DEFAULTS.flushMs;
  }

  private devicesOf(app: string): Map<string, AppDevice> {
    let devices = this.byApp.get(app);
    if (!devices) {
      const stored = Object.entries(this.registry.get(app)?.devices ?? {});
      devices = new Map(stored.sort((a, b) => a[1].lastSeen - b[1].lastSeen));
      this.byApp.set(app, devices);
    }
    return devices;
  }

  private makeRoom(devices: Map<string, AppDevice>): boolean {
    if (devices.size < this.maxPerApp) return true;
    for (const [id, d] of devices) {
      if (d.blocked) continue;
      devices.delete(id);
      return true;
    }
    return false;
  }

  private touched(app: string): void {
    this.dirty.add(app);
    if (this.timer || this.flushMs <= 0) return;
    this.timer = setTimeout(() => {
      void this.flush().catch(err => this.opts.log?.('app devices: flush failed', { error: (err as Error).message }));
    }, this.flushMs);
    this.timer.unref?.();
  }

  admit(app: string | null, raw: unknown, kind: string): AppLimitDenial | null {
    const known = app !== null && isAppId(app) ? app : null;
    if (raw === undefined || raw === null || raw === '') {
      if (!known || !this.registry.get(known)?.requireDevice) return null;
      return {
        status: 403, type: 'permission_error', code: 'device_required',
        message: `app '${known}' requires a device id (X-Gateway-Device header, or "device" when opening a realtime session)`,
      };
    }
    const device = deviceIdOf(raw);
    if (!device) return INVALID;
    if (!known) return null;
    const devices = this.devicesOf(known);
    const now = this.now();
    const day = Math.floor(now / DAY_MS);
    const seen = devices.get(device);
    if (seen?.blocked) {
      seen.lastSeen = now;
      this.touched(known);
      return { status: 403, type: 'permission_error', code: 'device_blocked', message: `this device is blocked for app '${known}'` };
    }
    if (seen) devices.delete(device);
    else if (!this.makeRoom(devices)) return null;
    const d = seen ?? fresh(now);
    if (d.day !== day) { d.day = day; d.requestsToday = 0; }
    d.lastSeen = now;
    d.requestsToday++;
    d.requests++;
    d.lastKind = kind;
    devices.set(device, d);
    this.touched(known);
    return null;
  }

  isBlocked(app: string, device: string): boolean {
    return this.devicesOf(app).get(device)?.blocked !== undefined;
  }

  private view(id: string, d: AppDevice, day: number): AppDeviceView {
    const { day: seenDay, ...rest } = d;
    return { id, ...rest, requestsToday: seenDay === day ? d.requestsToday : 0 };
  }

  list(app: string, query: URLSearchParams = new URLSearchParams()) {
    const sort = (query.get('sort') ?? 'lastSeen') as Sort;
    if (!SORTS.includes(sort)) throw new AppError(400, `sort must be one of ${SORTS.join(', ')}`);
    const order = query.get('order') ?? 'desc';
    if (order !== 'asc' && order !== 'desc') throw new AppError(400, 'order must be asc or desc');
    const limit = Number(query.get('limit') ?? APP_DEVICE_DEFAULTS.listLimit);
    if (!Number.isInteger(limit) || limit < 1) throw new AppError(400, 'limit must be a positive integer');
    const day = Math.floor(this.now() / DAY_MS);
    const all = [...this.devicesOf(app)].map(([id, d]) => this.view(id, d, day));
    const shown = query.get('blocked') === '1' ? all.filter(d => d.blocked) : all;
    shown.sort((a, b) => (order === 'asc' ? a[sort] - b[sort] : b[sort] - a[sort]));
    return {
      app, requireDevice: this.registry.get(app)?.requireDevice ?? false,
      total: all.length, blocked: all.filter(d => d.blocked).length, max: this.maxPerApp,
      devices: shown.slice(0, limit),
    };
  }

  async block(app: string, rawDevice: string, rawReason: unknown, by: string): Promise<AppDeviceView> {
    const device = deviceIdOf(rawDevice);
    if (!device) throw new AppError(400, INVALID.message);
    if (rawReason !== undefined && rawReason !== null && (typeof rawReason !== 'string' || rawReason.length > 200)) {
      throw new AppError(400, 'reason must be a string (≤ 200 chars)');
    }
    this.registry.account(app);
    const devices = this.devicesOf(app);
    const now = this.now();
    let d = devices.get(device);
    if (!d) {
      if (!this.makeRoom(devices)) throw new AppError(409, `app '${app}' already has ${this.maxPerApp} blocked devices: unblock one first`);
      d = fresh(now);
      devices.set(device, d);
    }
    d.blocked = { reason: typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : null, by, at: now };
    this.dirty.add(app);
    await this.flush();
    this.opts.log?.('app devices: device blocked', { app, by });
    this.onBlock?.(app, device);
    return this.view(device, d, Math.floor(now / DAY_MS));
  }

  async unblock(app: string, rawDevice: string, by: string): Promise<AppDeviceView> {
    const d = this.devicesOf(app).get(rawDevice);
    if (!d) throw new AppError(404, `app '${app}' has no such device`);
    delete d.blocked;
    this.dirty.add(app);
    await this.flush();
    this.opts.log?.('app devices: device unblocked', { app, by });
    return this.view(rawDevice, d, Math.floor(this.now() / DAY_MS));
  }

  async route(app: string, method: string, rest: string[], query: URLSearchParams, by: string, readJson: () => Promise<Record<string, unknown>>) {
    const [encoded, action, extra] = rest;
    const device = encoded && (encoded.includes('%') ? safeDecode(encoded) : encoded);
    if (!device) return method === 'GET' ? { status: 200, body: this.list(app, query) } : { status: 405, body: { error: 'method not allowed' } };
    if (action !== 'block' || extra) return { status: 404, body: { error: 'unknown device path' } };
    if (method === 'POST') return { status: 200, body: await this.block(app, device, (await readJson()).reason, by) };
    if (method === 'DELETE') return { status: 200, body: await this.unblock(app, device, by) };
    return { status: 405, body: { error: 'method not allowed' } };
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty.size) return;
    for (const app of this.dirty) this.registry.account(app).devices = Object.fromEntries(this.devicesOf(app));
    this.dirty.clear();
    await this.registry.save();
  }
}

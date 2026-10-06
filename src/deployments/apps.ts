/**
 * App accounts: the gateway serves many apps (parle, …), each with its own account holding the addresses of its
 * Docker images, so a deploy can name an image ("speech-stack") instead of carrying a registry address, and the app
 * finds its images again later (scale up for a class, roll back, rebuild).
 *
 *   app account ─ images: name → { image (registry ref), digest, port, healthPath, defaults, history[≤5] }
 *
 * Who is the app: the user id of the calling key (GATEWAY_API_KEYS `key:app`). An admin key (the SANDBOX_TOKEN user,
 * DEPLOYMENTS_ADMIN_USERS) may act for any app with `X-App: <app>`. Persisted as one JSON file next to the
 * deployments (`DEPLOYMENTS_STATE_DIR/apps.json`, atomic writes). No secrets here: registry credentials stay out
 * (the gateway logs in to its own Scaleway registry with its own key), env values are not stored.
 */

import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { parseModelRoutes, type ModelRoutesSpec } from '../config/serve-providers';
import type { FallbackKeyStore, ProvisionedKeyRecord } from './app-fallback';

export const APP_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const IMAGE_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const IMAGE_REF_RE = /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)+(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;
export const IMAGE_HISTORY = 5;

/** Spec fields an image may preset for its deploys (no env values: those may be secrets and belong to the deploy). */
const DEFAULT_FIELDS = new Set([
  'machineType', 'zone', 'gpu', 'volumeGb', 'minReplicas', 'maxReplicas', 'minActiveReplicas', 'targetInflightPerReplica',
  'idleMinutes', 'bootTimeoutMinutes', 'coldStartWaitSeconds', 'maxEurPerHour', 'maxHours', 'args', 'entrypoint',
]);

export interface AppImageVersion { image: string; digest: string | null; at: number }

export interface AppImage {
  name: string;
  /** Registry reference, e.g. `rg.fr-par.scw.cloud/aigw/speech-stack:20261006-0107`. */
  image: string;
  digest: string | null;
  port: number | null;
  healthPath: string | null;
  description: string | null;
  /** Deployment spec fields this image's deploys start from (machineType, zone, volumeGb, …). */
  defaults: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** Previous addresses, newest first (≤ IMAGE_HISTORY): a deploy can pin one with `appImageVersion`. */
  history: AppImageVersion[];
}

export interface AppAccount {
  id: string;
  createdAt: number;
  images: Record<string, AppImage>;
  /**
   * The app's model aliases (`parle-stt` → deployment, then OpenRouter…), in the MODEL_ROUTES shape. The gateway's code
   * names no app: each app sends its own chains (`PUT /v1/apps/:app/routes`) and they are mounted at once.
   */
  routes?: ModelRoutesSpec;
  /** The app's provisioned OpenRouter key for the direct fallback (app-fallback.ts): its hash, never the key. */
  fallbackKey?: ProvisionedKeyRecord;
}

export class AppError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface AppStore {
  load(): Promise<Record<string, AppAccount>>;
  save(apps: Record<string, AppAccount>): Promise<void>;
}

export class MemoryAppStore implements AppStore {
  private data: Record<string, AppAccount> = {};
  async load() { return structuredClone(this.data); }
  async save(apps: Record<string, AppAccount>) { this.data = structuredClone(apps); }
}

export class FileAppStore implements AppStore {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  static inDir(dir: string): FileAppStore { return new FileAppStore(join(dir, 'apps.json')); }
  async load(): Promise<Record<string, AppAccount>> {
    try {
      return (JSON.parse(await readFile(this.path, 'utf8')) as { apps?: Record<string, AppAccount> }).apps ?? {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }
  save(apps: Record<string, AppAccount>): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, apps }, null, 2);
    this.chain = this.chain.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    return this.chain;
  }
}

function str(v: unknown, field: string, max = 300): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new AppError(400, `${field} must be a non-empty string (≤ ${max} chars)`);
  return v.trim();
}

export class AppRegistry implements FallbackKeyStore {
  private apps: Record<string, AppAccount> = {};
  constructor(private readonly store: AppStore, private readonly now: () => number = Date.now) {}

  async init(): Promise<void> { this.apps = await this.store.load(); }

  list(): Array<{ id: string; images: number; createdAt: number }> {
    return Object.values(this.apps).map(a => ({ id: a.id, images: Object.keys(a.images).length, createdAt: a.createdAt }));
  }

  get(app: string): AppAccount | null { return this.apps[app] ?? null; }

  image(app: string, name: string): AppImage | null { return this.apps[app]?.images[name] ?? null; }

  fallbackKey(app: string): ProvisionedKeyRecord | null { return this.apps[app]?.fallbackKey ?? null; }

  async setFallbackKey(app: string, record: ProvisionedKeyRecord): Promise<void> {
    this.account(app).fallbackKey = record;
    await this.store.save(this.apps);
  }

  private account(app: string): AppAccount {
    if (!APP_ID_RE.test(app)) throw new AppError(400, `app id must match ${APP_ID_RE}`);
    return (this.apps[app] ??= { id: app, createdAt: this.now(), images: {} });
  }

  /** Saves (or moves to a new address) an image of the app; the previous address goes to the history. */
  async putImage(app: string, name: string, body: Record<string, unknown>): Promise<{ image: AppImage; created: boolean }> {
    if (!IMAGE_NAME_RE.test(name)) throw new AppError(400, `image name must match ${IMAGE_NAME_RE}`);
    const known = new Set(['image', 'digest', 'port', 'healthPath', 'description', 'defaults']);
    for (const key of Object.keys(body)) if (!known.has(key)) throw new AppError(400, `unknown field '${key}'`);
    const prev = this.apps[app]?.images[name];
    const imageRef = str(body.image, 'image', 255) ?? prev?.image;
    if (!imageRef || !IMAGE_REF_RE.test(imageRef)) throw new AppError(400, 'image must be a registry reference (host/path[:tag][@sha256:…])');
    const digest = body.digest === undefined ? (imageRef === prev?.image ? prev.digest : null) : str(body.digest, 'digest', 100);
    if (digest && !/^(\S+@)?sha256:[a-f0-9]{64}$/.test(digest)) throw new AppError(400, 'digest must be sha256:<64 hex>');
    const port = body.port === undefined ? prev?.port ?? null : Number(body.port);
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new AppError(400, 'port must be 1..65535');
    const defaults = (body.defaults ?? prev?.defaults ?? {}) as Record<string, unknown>;
    if (typeof defaults !== 'object' || Array.isArray(defaults)) throw new AppError(400, 'defaults must be an object');
    for (const key of Object.keys(defaults)) {
      if (!DEFAULT_FIELDS.has(key)) throw new AppError(400, `defaults.${key} is not allowed (allowed: ${[...DEFAULT_FIELDS].join(', ')})`);
    }
    const account = this.account(app);
    const t = this.now();
    const history = prev ? [...prev.history] : [];
    if (prev && prev.image !== imageRef) history.unshift({ image: prev.image, digest: prev.digest, at: prev.updatedAt });
    const image: AppImage = {
      name, image: imageRef, digest, port,
      healthPath: body.healthPath === undefined ? prev?.healthPath ?? null : str(body.healthPath, 'healthPath', 200),
      description: body.description === undefined ? prev?.description ?? null : str(body.description, 'description', 500),
      defaults, createdAt: prev?.createdAt ?? t, updatedAt: t, history: history.slice(0, IMAGE_HISTORY),
    };
    account.images[name] = image;
    await this.store.save(this.apps);
    return { image, created: !prev };
  }

  /**
   * Replaces the app's routes. An alias belongs to one app: an alias another app already routes is refused (409), so
   * no app can take over another app's model names. Validation is MODEL_ROUTES' (`parseModelRoutes`).
   */
  async putRoutes(app: string, body: unknown): Promise<ModelRoutesSpec> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'routes must be an object { chat?, stt?, tts? }');
    const { routes, errors } = parseModelRoutes(JSON.stringify(body));
    if (errors.length) throw new AppError(400, errors.join('; '));
    for (const [stage, byModel] of Object.entries(routes) as Array<[keyof ModelRoutesSpec, Record<string, unknown> | undefined]>) {
      for (const model of Object.keys(byModel ?? {})) {
        const owner = Object.values(this.apps).find(a => a.id !== app && a.routes?.[stage]?.[model]);
        if (owner) throw new AppError(409, `${stage} alias '${model}' belongs to app '${owner.id}'`);
      }
    }
    this.account(app).routes = routes;
    await this.store.save(this.apps);
    return routes;
  }

  /** Every app's routes, merged (aliases are unique across apps). */
  allRoutes(): ModelRoutesSpec {
    const out: ModelRoutesSpec = {};
    for (const account of Object.values(this.apps)) {
      for (const [stage, byModel] of Object.entries(account.routes ?? {}) as Array<[keyof ModelRoutesSpec, ModelRoutesSpec[keyof ModelRoutesSpec]]>) {
        out[stage] = { ...(out[stage] ?? {}), ...(byModel ?? {}) };
      }
    }
    return out;
  }

  async deleteImage(app: string, name: string): Promise<boolean> {
    const account = this.apps[app];
    if (!account?.images[name]) return false;
    delete account.images[name];
    await this.store.save(this.apps);
    return true;
  }

  /**
   * Deployment body fields from a saved image: `{appImage: "speech-stack"}` (optionally `appImageVersion`: an index
   * into the history, 1 = previous) becomes image, port, healthPath and the image defaults; the body's own fields win.
   */
  resolveDeployBody(app: string, body: Record<string, unknown>): Record<string, unknown> {
    if (body.appImage === undefined) return body;
    const name = body.appImage;
    if (typeof name !== 'string') throw new AppError(400, 'appImage must be an image name of the app');
    const saved = this.image(app, name);
    if (!saved) throw new AppError(404, `app '${app}' has no image '${name}' (PUT /v1/apps/${app}/images/${name} first)`);
    const version = body.appImageVersion === undefined ? 0 : Number(body.appImageVersion);
    if (!Number.isInteger(version) || version < 0 || version > saved.history.length) {
      throw new AppError(400, `appImageVersion must be 0..${saved.history.length} (0 = current)`);
    }
    const ref = version === 0 ? saved.image : saved.history[version - 1].image;
    const { appImage: _a, appImageVersion: _v, ...rest } = body;
    return {
      ...saved.defaults,
      image: ref,
      ...(saved.port !== null ? { port: saved.port } : {}),
      ...(saved.healthPath ? { healthPath: saved.healthPath } : {}),
      ...rest,
    };
  }
}

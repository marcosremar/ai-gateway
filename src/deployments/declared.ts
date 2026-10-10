/**
 * Declared deployments — specs that live in the repo (`src/deployments/declared/*.json`, no secrets) and that the
 * gateway keeps registered by itself, at boot and periodically, through the same idempotent `controller.put` the
 * `PUT /v1/deployments/:name` route uses.
 *
 * What a declaration holds besides the plain spec fields:
 *   - `profile`: the profile a deployment that does not exist yet is created from (image from the declaration). An
 *     existing deployment is never reset to it: only the declared fields are patched over the stored spec.
 *   - `image`: `{ env, repository, default }` — the image comes from env `<env>` (a full reference, or just a tag of
 *     `repository`), else `default`. No default and no env → pending.
 *   - `registryAuth`: `{ server, username, passwordEnv }` — the password is read from env `<passwordEnv>` at every
 *     reconcile (so a rotated token reaches the spec). Missing → pending: a replica without the credential would only
 *     fail to pull a private image, i.e. a billed machine that never serves.
 *   - `generatedSecrets`: container env keys generated ONCE (32 chars of [A-Za-z0-9_-]) and persisted with the spec in
 *     the deployment store; never logged, never returned by the API (spec env is write-only).
 *
 * Registering never starts a machine: declared specs keep `minReplicas: 0` and the reconciler never calls `wake`.
 * Replicas start when a request needs them, or inside a declared `warmSchedule` window, as for any other deployment.
 *
 * A declaration without `image` and `profile` belongs to another registrant (the parle client's backend PUTs
 * `parle-qwen-tts`): it never creates the deployment (pending until it exists) and only puts its own fields back.
 *
 * A declared field the operator changed by hand (PUT/PATCH) is put back at the next reconcile; fields the declaration
 * does not hold (e.g. `paused`, and `env` when it declares neither `env` nor `generatedSecrets`) are left as the
 * operator set them. `envByMachineType` and `scaling` are merged per key: the declared keys are put back, the stored ones stay.
 */

import { randomBytes } from 'crypto';
import parleLivekit from './declared/parle-livekit.json';
import parleQwenTts from './declared/parle-qwen-tts.json';
import parleSpeech from './declared/parle-speech.json';
import parleSpeechS2s from './declared/parle-speech-s2s.json';
import parleSpeechTest from './declared/parle-speech-test.json';
import { DEFAULT_SCALING_MODE } from './scaling-spec';
import type { DeploymentSpec, ScalingSpec } from './types';

export interface DeclaredDeployment {
  name: string;
  app?: string;
  description?: string;
  profile?: string;
  image?: { env?: string; repository?: string; default?: string | null };
  registryAuth?: { server?: string; username: string; passwordEnv: string };
  generatedSecrets?: string[];
  /** Plain spec fields (validated by `buildSpec` when applied). */
  spec: Record<string, unknown>;
}

/**
 * `parle-speech`: the `speech-stack` image in the gateway's own Scaleway registry (pulled with the key the gateway
 * already has, no registry secret). The declaration owns the image, the placements, the command, `realtime`, the class
 * window and the edge's `RT_MAX_SESSIONS` per machine type; sizing, limits, env and files stay as registered (a new
 * gateway starts from the `speech-stack` profile). The other three own only their class window and monthly ceiling.
 */
export const DECLARED_DEPLOYMENTS: DeclaredDeployment[] = [parleSpeech, parleSpeechTest, parleQwenTts, parleSpeechS2s, parleLivekit] as DeclaredDeployment[];

/** Reconcile period. The boot run happens before the providers are mounted (serve.ts). */
export const DECLARED_RECONCILE_MS = 5 * 60_000;

export type DeclaredState = 'in_sync' | 'applied' | 'pending' | 'error' | 'disabled';

export interface DeclaredStatus {
  name: string;
  state: DeclaredState;
  /** Why it is pending / failed, in words an operator can act on. Never contains a secret value. */
  reason: string | null;
  image: string | null;
  checkedAt: string | null;
}

type Env = Record<string, string | undefined>;

/** Image reference from env (full ref or a tag of `repository`), else the declared default. */
export function declaredImage(decl: DeclaredDeployment, env: Env): string | null {
  const raw = decl.image?.env ? env[decl.image.env]?.trim() : '';
  if (raw) {
    if (raw.includes('/') || !decl.image?.repository) return raw;
    return `${decl.image.repository}:${raw}`;
  }
  return decl.image?.default?.trim() || null;
}

const GENERATED_SECRET_RE = /^[A-Za-z0-9_-]{16,}$/;

export function generateSecret(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * The PUT body for a declaration, or why it cannot be registered yet. `previous` is the stored spec (reused for the
 * generated secrets so they stay stable across restarts).
 */
export function declaredBody(
  decl: DeclaredDeployment, env: Env, previous: DeploymentSpec | null, gen: () => string = generateSecret,
): { body: Record<string, unknown> } | { pending: string } {
  const image = declaredImage(decl, env);
  if (!image && decl.image) {
    return { pending: `${decl.image.env ?? 'image'} is not set and the declaration has no default image` };
  }
  if (!decl.image && !previous) {
    return { pending: `'${decl.name}' is registered by its owner, not here: the declared fields apply once it exists` };
  }
  let registryAuth: Record<string, string> | undefined;
  if (decl.registryAuth) {
    const password = env[decl.registryAuth.passwordEnv]?.trim();
    if (!password) {
      return { pending: `${decl.registryAuth.passwordEnv} is not set (registry credential for ${decl.registryAuth.server ?? 'the image registry'})` };
    }
    registryAuth = {
      username: decl.registryAuth.username, password, ...(decl.registryAuth.server ? { server: decl.registryAuth.server } : {}),
    };
  }
  const declaredEnv = decl.spec.env as Record<string, string> | undefined;
  const declaredByType = decl.spec.envByMachineType as Record<string, Record<string, string>> | undefined;
  const storedByType = previous?.envByMachineType ?? {};
  const secrets: Record<string, string> = {};
  for (const key of decl.generatedSecrets ?? []) {
    const kept = previous?.env?.[key];
    secrets[key] = kept && GENERATED_SECRET_RE.test(kept) ? kept : gen();
  }
  return {
    body: {
      ...decl.spec,
      ...(image ? { image } : {}),
      ...(declaredEnv || decl.generatedSecrets?.length ? { env: { ...declaredEnv, ...secrets } } : {}),
      ...(declaredByType ? {
        envByMachineType: {
          ...storedByType,
          ...Object.fromEntries(Object.entries(declaredByType).map(([type, vars]) => [type, { ...storedByType[type], ...vars }])),
        },
      } : {}),
      ...(decl.spec.scaling ? { scaling: mergedScaling(previous?.scaling, decl.spec.scaling as Partial<ScalingSpec>) } : {}),
      ...(registryAuth ? { registryAuth } : {}),
      ...(decl.description ? { description: decl.description } : {}),
    },
  };
}

function testCopyFiles(target: DeclaredTarget, decl: DeclaredDeployment): Record<string, unknown> {
  const sourceName = decl.spec.testFor;
  if (typeof sourceName !== 'string') return {};
  const source = target.specOf(sourceName);
  const own = target.specOf(decl.name);
  const out: Record<string, unknown> = {};
  for (const key of ['files', 'fileUrls'] as const) {
    if (source?.[key] && !own?.[key]) out[key] = source[key];
  }
  return out;
}

function mergedScaling(stored: ScalingSpec | undefined, declared: Partial<ScalingSpec>): ScalingSpec {
  const budget = stored?.budget || declared.budget ? { ...stored?.budget, ...declared.budget } : undefined;
  return { ...stored, ...declared, mode: declared.mode ?? stored?.mode ?? DEFAULT_SCALING_MODE, ...(budget ? { budget } : {}) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]));
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** True when every field of `body` already has that value in `spec` (the PUT would change nothing). */
export function specMatches(spec: DeploymentSpec, body: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(body)) {
    if (key === 'description') continue; // profile-only field, not stored on the spec
    if (!sameValue((spec as unknown as Record<string, unknown>)[key], value)) return false;
  }
  return true;
}

/** What the reconciler needs from the controller. */
export interface DeclaredTarget {
  specOf(name: string): DeploymentSpec | null;
  put(name: string, body: Record<string, unknown>, meta?: { app?: string }): Promise<unknown>;
  get?(name: string): { app: string | null } | null;
}

export interface DeclaredReconcilerOptions {
  /** null = deployments are off on this gateway (no SCW key): every declaration reports `disabled`. */
  target: DeclaredTarget | null;
  env: Env;
  declarations?: DeclaredDeployment[];
  intervalMs?: number;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** Called after a reconcile that registered or changed a deployment (the routes must be remounted). */
  onChange?: (names: string[]) => void | Promise<void>;
  generateSecret?: () => string;
}

export class DeclaredDeploymentReconciler {
  private readonly statuses = new Map<string, DeclaredStatus>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<DeclaredStatus[]> | null = null;
  private readonly declarations: DeclaredDeployment[];

  constructor(private readonly opts: DeclaredReconcilerOptions) {
    this.declarations = opts.declarations ?? DECLARED_DEPLOYMENTS;
    for (const d of this.declarations) {
      this.statuses.set(d.name, {
        name: d.name, state: opts.target ? 'pending' : 'disabled',
        reason: opts.target ? 'not reconciled yet' : 'deployments are disabled on this gateway (SCW_SECRET_KEY is not set)',
        image: null, checkedAt: null,
      });
    }
  }

  start(): void {
    if (this.timer || !this.opts.target) return;
    this.timer = setInterval(() => void this.reconcile(), this.opts.intervalMs ?? DECLARED_RECONCILE_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): DeclaredStatus[] {
    return this.declarations.map(d => ({ ...this.statuses.get(d.name)! }));
  }

  statusOf(name: string): DeclaredStatus | null {
    const s = this.statuses.get(name);
    return s ? { ...s } : null;
  }

  /** Coalesced: a call during a run waits for that run. */
  reconcile(): Promise<DeclaredStatus[]> {
    this.running ??= this.reconcileOnce().finally(() => { this.running = null; });
    return this.running;
  }

  private async reconcileOnce(): Promise<DeclaredStatus[]> {
    const target = this.opts.target;
    if (!target) return this.status();
    const checkedAt = new Date((this.opts.now ?? Date.now)()).toISOString();
    const changed: string[] = [];
    for (const decl of this.declarations) {
      const previous = target.specOf(decl.name);
      const resolved = declaredBody(decl, this.opts.env, previous, this.opts.generateSecret);
      const image = declaredImage(decl, this.opts.env);
      if ('pending' in resolved) {
        // An existing deployment keeps serving with its stored spec; only registration/updates wait.
        const reason = previous ? `${resolved.pending} — keeping the registered spec` : resolved.pending;
        this.set(decl.name, { state: 'pending', reason, image, checkedAt });
        continue;
      }
      const appMatches = !decl.app || target.get?.(decl.name)?.app === decl.app;
      if (previous && specMatches(previous, resolved.body) && appMatches && !Object.keys(testCopyFiles(target, decl)).length) {
        this.set(decl.name, { state: 'in_sync', reason: null, image, checkedAt });
        continue;
      }
      const meta = decl.app ? { app: decl.app } : {};
      try {
        let body = resolved.body;
        if (!previous && decl.profile) {
          await target.put(decl.name, { profile: decl.profile, image }, meta);
          const patch = declaredBody(decl, this.opts.env, target.specOf(decl.name), this.opts.generateSecret);
          if ('body' in patch) body = patch.body;
        }
        body = { ...body, ...testCopyFiles(target, decl) };
        await target.put(decl.name, body, meta);
        changed.push(decl.name);
        this.set(decl.name, { state: 'applied', reason: null, image, checkedAt });
        // Names of keys only — never their values.
        this.opts.log?.('declared deployment registered', { name: decl.name, image, created: !previous });
      } catch (err) {
        this.set(decl.name, { state: 'error', reason: err instanceof Error ? err.message : String(err), image, checkedAt });
        this.opts.log?.('declared deployment failed', { name: decl.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (changed.length) {
      try { await this.opts.onChange?.(changed); } catch (err) {
        this.opts.log?.('declared deployments: onChange failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return this.status();
  }

  private set(name: string, s: Omit<DeclaredStatus, 'name'>): void {
    this.statuses.set(name, { name, ...s });
  }
}

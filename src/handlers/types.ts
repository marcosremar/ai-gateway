import type { Autoscaler } from '../factory';
import type { SettingsStore, CredentialStore, LifecycleLogStore, UserRoleResolver, BenchmarkStore } from '../deps';

/** Generic handler result — handlers return this instead of framework-specific responses. */
export interface HandlerResult<T = unknown> {
  status: number;
  body: T;
}

/** Dependencies injected into route handlers by the host app. */
export interface HandlerDeps {
  autoscaler: Autoscaler;
  settingsStore: SettingsStore;
  credentialStore: CredentialStore;
  lifecycleLogStore?: LifecycleLogStore;
  userRoleResolver?: UserRoleResolver;
  benchmarkStore?: BenchmarkStore;
  signGpuToken?: (userId: string) => string | undefined;
}

/** Return a successful response. */
export function ok<T>(body: T, status = 200): HandlerResult<T> {
  return { status, body };
}

/** Return an error response. */
export function err(message: string, status = 400): HandlerResult<{ error: string }> {
  return { status, body: { error: message } };
}

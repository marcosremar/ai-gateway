import type { Autoscaler } from '../factory';
import type { SettingsStore, CredentialStore, LifecycleLogStore, UserRoleResolver, BenchmarkStore } from '../deps';
import type { DeploySessionRecord } from '../types';

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
  deploySessionStore?: {
    create(data: { userId: string; provider: string; gpuModel: string; dockerImage?: string; region?: string }): Promise<string>;
    update(id: string, data: Partial<{ status: string; serverReadyAt: Date; stoppedAt: Date; provisionTimeS: number; errorMessage: string; providerInstanceId: string; endpoint: string; metadata: Record<string, unknown> }>): Promise<void>;
    query(params: { userIds: string[]; limit: number; sortOrder: 'asc' | 'desc' }): Promise<DeploySessionRecord[]>;
  };
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

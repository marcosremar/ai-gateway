/**
 * Canonical instance status vocabulary shared across GPU and CPU providers.
 *
 * Provider APIs return heterogeneous raw strings (RUNNING, started, SUCCESS,
 * CREATING, EXITED, …). Callers should normalize via `normalizeInstanceStatus`
 * before storing on `GpuInstance.status` or branching on readiness.
 */

export type InstanceStatus = 'running' | 'booting' | 'stopped' | 'error' | 'unknown';

const RUNNING = new Set([
  'running',
  'started',
  'success',
  'active',
  'deployed', // Modal: app is live / wakes on request
]);

const BOOTING = new Set([
  'creating',
  'starting',
  'pending',
  'provisioning',
  'building',
  'deploying',
  'loading', // Vast: image/container still coming up
  'initializing',
  'created', // Fly: machine created but not started
]);

const STOPPED = new Set([
  'exited',
  'stopped',
  'destroyed',
  'removed',
  'offline',
  'deleted',
  'terminated',
  'stopping',
  'destroying',
  'shutdown',
]);

const ERROR = new Set(['failed', 'crashed', 'error']);

/**
 * Map a provider-raw status string onto the shared InstanceStatus vocabulary.
 * Case-insensitive; null/undefined/empty → 'unknown'.
 */
export function normalizeInstanceStatus(raw: string | null | undefined): InstanceStatus {
  if (raw == null) return 'unknown';
  const key = String(raw).trim().toLowerCase();
  if (!key) return 'unknown';
  if (RUNNING.has(key)) return 'running';
  if (BOOTING.has(key)) return 'booting';
  if (STOPPED.has(key)) return 'stopped';
  if (ERROR.has(key)) return 'error';
  return 'unknown';
}

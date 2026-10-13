/**
 * Only the production gateway (on Railway) creates, starts or rents real machines with the providers' keys. A gateway
 * on a dev box or in an agent's sandbox got the same keys from the palco, and on 07/10/2026 a local `dev-marmos`
 * namespace left two Scaleway servers behind; off Railway the provider backends stay off unless
 * `AIGW_REAL_MACHINES=1` says otherwise, explicitly.
 */
export function onRailway(env: Record<string, string | undefined>): boolean {
  return Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
}

export function realMachinesAllowed(env: Record<string, string | undefined>): boolean {
  return onRailway(env) || env.AIGW_REAL_MACHINES?.trim() === '1';
}

export const REAL_MACHINES_OFF = 'Real machines disabled: off Railway this gateway never creates, starts or rents a provider machine (AIGW_REAL_MACHINES=1 to override)';

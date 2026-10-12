/**
 * 07/10/2026: a local gateway (namespace `dev-marmos`) created two real Scaleway servers that stayed behind. Off Railway
 * a gateway never creates, starts or rents a provider machine, whatever keys it got, unless AIGW_REAL_MACHINES=1.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { deploymentsFromEnv } from '../../../src/deployments';
import { realMachinesAllowed } from '../../../src/deployments/real-machines';
import { machineBackendsFromEnv, machinesFromEnv } from '../../../src/machines';

const keys = { SCW_SECRET_KEY: 's', VAST_API_KEY: 'v', RUNPOD_API_KEY: 'r' };
const opts = { userOf: () => null };

describe('real machines only from the production gateway', () => {
  it('a dev namespace off Railway gets no deployments, no machines and no provider backend', () => {
    const logs: string[] = [];
    const env = { ...keys, DEPLOYMENTS_NAMESPACE: 'dev-marmos', DEPLOYMENTS_STATE_DIR: mkdtempSync(join(tmpdir(), 'aigw-real-')) };
    expect(realMachinesAllowed(env)).toBe(false);
    expect(deploymentsFromEnv(env, { ...opts, log: m => logs.push(m) })).toBeNull();
    expect(logs.join()).toMatch(/Real machines disabled/);
    expect(machineBackendsFromEnv(env)).toEqual({});
    expect(machinesFromEnv(env, { ...opts, isAdmin: () => false, onRailway: false })).toBeNull();
  });

  it('on Railway, or with AIGW_REAL_MACHINES=1 said explicitly, the backends are built', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aigw-real-'));
    expect(Object.keys(machineBackendsFromEnv({ ...keys, RAILWAY_ENVIRONMENT_ID: 'e' })).sort()).toEqual(['runpod', 'scaleway', 'vast']);
    expect(Object.keys(machineBackendsFromEnv({ ...keys, AIGW_REAL_MACHINES: '1' }))).toHaveLength(3);
    expect(machineBackendsFromEnv({ ...keys, AIGW_REAL_MACHINES: 'true' })).toEqual({});
    const prod = deploymentsFromEnv({ ...keys, RAILWAY_ENVIRONMENT_ID: 'e', DEPLOYMENTS_STATE_DIR: dir }, opts);
    expect(prod).not.toBeNull();
    prod?.stopJanitor?.();
  });
});

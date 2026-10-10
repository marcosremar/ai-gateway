import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '../../../scripts/build-image-on-scaleway.ts');

function run(extra: Record<string, string>) {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SCW_SECRET_KEY: 'scw-master-key', SCW_PROJECT_ID: 'proj', ...extra };
  return spawnSync('bun', [SCRIPT, '--from', 'ghcr.io/x/y:1', 'y'], { env, encoding: 'utf8', timeout: 30_000 });
}

describe('S12: the build machine never gets the Scaleway API secret', () => {
  it('logs in to the registry with SCW_REGISTRY_PUSH_SECRET_KEY, never SCW_SECRET_KEY', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const login = source.split('\n').filter(l => l.includes('docker login'));
    expect(login).toHaveLength(1);
    expect(login[0]).toContain('${pushSecret}');
    expect(login[0]).not.toContain('${secret}');
  });

  it('refuses to start without a distinct push key, before any machine exists', () => {
    for (const extra of [{}, { SCW_REGISTRY_PUSH_SECRET_KEY: 'scw-master-key' }]) {
      const r = run(extra);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/SCW_REGISTRY_PUSH_SECRET_KEY/);
      expect(r.stdout).not.toMatch(/creating/);
    }
  });
});

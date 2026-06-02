import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectEnv, resetProjectEnvLoaderForTests } from '../../src/env/project-env';

describe('project env loader', () => {
  const touchedKeys = ['AIGW_TEST_ENV_LOADER_KEY', 'AIGW_TEST_ENV_LOADER_KEEP'];

  afterEach(() => {
    for (const key of touchedKeys) delete process.env[key];
    resetProjectEnvLoaderForTests();
  });

  it('loads the project .env even when the process cwd is nested elsewhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'aigw-env-root-'));
    try {
      const nested = join(root, 'nested', 'worker');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, '.env'), [
        'AIGW_TEST_ENV_LOADER_KEY=from-project-env',
        'AIGW_TEST_ENV_LOADER_KEEP=from-file',
      ].join('\n'));

      process.env.AIGW_TEST_ENV_LOADER_KEEP = 'from-parent-env';
      const result = loadProjectEnv({ cwd: nested, projectRoot: root });

      expect(result.loaded).toBe(true);
      expect(result.path).toBe(join(root, '.env'));
      expect(process.env.AIGW_TEST_ENV_LOADER_KEY).toBe('from-project-env');
      expect(process.env.AIGW_TEST_ENV_LOADER_KEEP).toBe('from-parent-env');
      expect(result.keys).toContain('AIGW_TEST_ENV_LOADER_KEY');
      expect(result.keys).not.toContain('AIGW_TEST_ENV_LOADER_KEEP');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can prefer the project .env over an unrelated cwd .env', () => {
    const root = mkdtempSync(join(tmpdir(), 'aigw-env-root-'));
    const other = mkdtempSync(join(tmpdir(), 'aigw-env-other-'));
    try {
      writeFileSync(join(root, '.env'), 'AIGW_TEST_ENV_LOADER_KEY=from-project-root\n');
      writeFileSync(join(other, '.env'), 'AIGW_TEST_ENV_LOADER_KEY=from-cwd\n');

      const result = loadProjectEnv({ cwd: other, projectRoot: root, preferProjectRoot: true });

      expect(result.loaded).toBe(true);
      expect(result.path).toBe(join(root, '.env'));
      expect(process.env.AIGW_TEST_ENV_LOADER_KEY).toBe('from-project-root');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});

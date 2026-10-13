import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

export function useTempHome(): string {
  const realHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'aigw-home-'));
  process.env.HOME = home;
  afterAll(() => {
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

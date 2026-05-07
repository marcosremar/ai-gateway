/**
 * Bug: persistDailySpend() was exported but never called.
 *
 * The monitor loop (gpu-monitor-loop.ts:290) accumulates dailyGpuSpendUsd
 * via setDailyGpuSpendUsd(), but that setter never wrote to daily_spend.json.
 * On restart, loadPersistedDailySpend() finds no file (or stale data) and
 * resets to $0, so canAffordDeploy() allows deploys that should be blocked.
 *
 * Fix: setDailyGpuSpendUsd now triggers a debounced persistDailySpend().
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DAILY_SPEND_FILE = join(homedir(), '.babelcast', 'daily_spend.json');

beforeAll(() => {
  try { mkdirSync(join(homedir(), '.babelcast'), { recursive: true }); } catch { /* exists */ }
  if (existsSync(DAILY_SPEND_FILE)) unlinkSync(DAILY_SPEND_FILE);
});

afterAll(() => {
  if (existsSync(DAILY_SPEND_FILE)) unlinkSync(DAILY_SPEND_FILE);
});

// Helper: wait for the debounced persist (10s timer in cost-state.ts).
// Padded to 11s so we don't race the timer flush.
const waitForPersist = () => new Promise<void>(r => setTimeout(r, 11_000));

test('setDailyGpuSpendUsd persists the value to daily_spend.json after debounce', async () => {
  const mod = await import('../../src/gateway/state/cost-state');

  if (existsSync(DAILY_SPEND_FILE)) unlinkSync(DAILY_SPEND_FILE);

  // Simulate the monitor loop accumulating spend
  mod.setDailyGpuSpendUsd(42.5);

  // Wait for debounced persist to fire
  await waitForPersist();

  // The file MUST exist and contain the spend value.
  expect(existsSync(DAILY_SPEND_FILE)).toBe(true);

  const data = JSON.parse(readFileSync(DAILY_SPEND_FILE, 'utf-8'));
  expect(data.spendUsd).toBe(42.5);

  // Verify loadPersistedDailySpend can recover the value
  mod.setDailyGpuSpendUsd(0); // reset in-memory
  mod.loadPersistedDailySpend();
  expect(mod.dailyGpuSpendUsd).toBe(42.5);

  if (existsSync(DAILY_SPEND_FILE)) unlinkSync(DAILY_SPEND_FILE);
});

test('setDailyGpuSpendUsd(0) persists correctly for day-reset scenario', async () => {
  const mod = await import('../../src/gateway/state/cost-state');

  if (existsSync(DAILY_SPEND_FILE)) unlinkSync(DAILY_SPEND_FILE);

  mod.setDailyGpuSpendUsd(0);

  await waitForPersist();

  expect(existsSync(DAILY_SPEND_FILE)).toBe(true);
  const data = JSON.parse(readFileSync(DAILY_SPEND_FILE, 'utf-8'));
  expect(data.spendUsd).toBe(0);

  if (existsSync(DAILY_SPEND_FILE)) unlinkSync(DAILY_SPEND_FILE);
});

test('loadPersistedDailySpend ignores stale data from previous day', async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  try { mkdirSync(join(homedir(), '.babelcast'), { recursive: true }); } catch { /* exists */ }
  writeFileSync(DAILY_SPEND_FILE, JSON.stringify({
    date: yesterdayStr,
    spendUsd: 99.99,
    savedAt: Date.now() - 1000,
  }));

  const mod = await import('../../src/gateway/state/cost-state');
  mod.setDailyGpuSpendUsd(0); // reset in-memory
  mod.loadPersistedDailySpend();

  // Should ignore yesterday's data and stay at 0
  expect(mod.dailyGpuSpendUsd).toBe(0);

  if (existsSync(DAILY_SPEND_FILE)) unlinkSync(DAILY_SPEND_FILE);
});

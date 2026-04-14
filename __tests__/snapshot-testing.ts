/**
 * Snapshot testing configuration for AI Gateway.
 *
 * Fixes: #40 (snapshot testing)
 *
 * Usage in tests:
 * ```ts
 * import { snapshotTest } from './snapshot-testing';
 *
 * it('should match snapshot', () => {
 *   const result = computeSomething(input);
 *   snapshotTest('my-feature', result);
 * });
 * ```
 *
 * Update snapshots:
 *   UPDATE_SNAPSHOTS=1 bun run test
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

const SNAPSHOTS_DIR = '__tests__/__snapshots__';

/**
 * Create a snapshot test — fails if snapshot doesn't match.
 */
export function snapshotTest(name: string, value: unknown): void {
  const snapshotPath = join(process.cwd(), SNAPSHOTS_DIR, `${name}.snap.json`);
  const actual = JSON.stringify(value, null, 2);

  if (process.env.UPDATE_SNAPSHOTS === '1') {
    // Update mode
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, actual);
    console.log(`✅ Snapshot updated: ${name}`);
    return;
  }

  // Verify mode
  if (!existsSync(snapshotPath)) {
    throw new Error(
      `Snapshot not found: ${name}\nRun with UPDATE_SNAPSHOTS=1 to create it.\n\nActual:\n${actual}`,
    );
  }

  const expected = readFileSync(snapshotPath, 'utf-8');
  if (actual !== expected) {
    throw new Error(
      `Snapshot mismatch: ${name}\n\nExpected:\n${expected}\n\nActual:\n${actual}`,
    );
  }
}

/**
 * Create a snapshot with hash verification.
 */
export function snapshotTestWithHash(name: string, value: unknown): void {
  const snapshotPath = join(process.cwd(), SNAPSHOTS_DIR, `${name}.snap.json`);
  const hashPath = `${snapshotPath}.sha256`;

  if (process.env.UPDATE_SNAPSHOTS === '1') {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    const actual = JSON.stringify(value, null, 2);
    writeFileSync(snapshotPath, actual);
    const hash = createHash('sha256').update(actual).digest('hex');
    writeFileSync(hashPath, hash);
    console.log(`✅ Snapshot updated: ${name} (hash: ${hash.slice(0, 16)})`);
    return;
  }

  if (!existsSync(snapshotPath)) {
    throw new Error(`Snapshot not found: ${name}. Run with UPDATE_SNAPSHOTS=1.`);
  }

  const actual = JSON.stringify(value, null, 2);
  const expected = readFileSync(snapshotPath, 'utf-8');
  const expectedHash = readFileSync(hashPath, 'utf-8').trim();
  const actualHash = createHash('sha256').update(actual).digest('hex');

  if (actual !== expected || actualHash !== expectedHash) {
    throw new Error(
      `Snapshot mismatch: ${name}\nExpected hash: ${expectedHash.slice(0, 16)}\nActual hash: ${actualHash.slice(0, 16)}`,
    );
  }
}

#!/usr/bin/env bun
// Bundle size ratchet (CI "Bundle Size Budget"). Measures every tsup entry in dist/ (raw and gzip -9) against
// quality-bundle-baseline.json; see scripts/bundle-size-lib.ts for the rules and why.
//
//   bun run build && bun run quality:bundle                         # check (CI)
//   bun run quality:bundle:update                                    # tighten after something shrank
//   bun run quality:bundle:update -- --accept-growth "<why>"         # deliberate growth / new entry, reason recorded

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import tsupConfig from '../tsup.config';
import { compareSizes, formatTable, nextBaseline, type Baseline, type EntrySize } from './bundle-size-lib';

const ROOT = resolve(import.meta.dir, '..');
const BASELINE_PATH = resolve(ROOT, 'quality-bundle-baseline.json');
const args = process.argv.slice(2);
const update = args.includes('--update');
const growthIdx = args.indexOf('--accept-growth');
const acceptGrowth = growthIdx >= 0 ? args[growthIdx + 1]?.trim() : undefined;
if (growthIdx >= 0 && !acceptGrowth) {
  console.error('--accept-growth needs a reason, e.g. --accept-growth "deployments: Vast backend (#37)"');
  process.exit(2);
}

const config = (Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig) as { entry?: Record<string, string> };
const entries = Object.keys(config.entry ?? {});
if (!entries.length) throw new Error('tsup.config.ts has no named entries');

const measured: Record<string, EntrySize | null> = {};
for (const entry of entries) {
  const file = resolve(ROOT, 'dist', `${entry}.js`);
  if (!existsSync(file)) { measured[entry] = null; continue; }
  const bytes = readFileSync(file);
  measured[entry] = { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
}
const baseline: Baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};

console.log(formatTable(baseline, measured));

if (update) {
  const built = Object.fromEntries(Object.entries(measured).filter(([, s]) => s)) as Record<string, EntrySize>;
  if (Object.keys(built).length !== entries.length) {
    console.error('\nsome entries were not built; run `bun run build` first');
    process.exit(1);
  }
  const { baseline: next, refused } = nextBaseline(baseline, built, acceptGrowth);
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  if (refused.length) {
    console.error(`\nnot written for: ${refused.join(', ')} — new or grown entries need --accept-growth "<why>"`);
    process.exit(1);
  }
  console.log(`\n${BASELINE_PATH} updated`);
  process.exit(0);
}

const problems = compareSizes(baseline, measured);
if (problems.length) {
  console.error('');
  for (const p of problems) console.error(`::error::${p.message}`);
  process.exit(1);
}
console.log('\nall entries within the bundle size ratchet');

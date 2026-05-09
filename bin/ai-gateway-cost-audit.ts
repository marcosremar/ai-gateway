#!/usr/bin/env bun
/**
 * Standalone vast.ai orphan-pod sweep.
 *
 * Lives next to `bin/ai-gateway.ts` rather than as a `gpu` subcommand so
 * operators can wire it into cron / a systemd timer / a k8s CronJob without
 * touching the main CLI. Designed for the May 2026 leak pattern: pods left
 * running on a shared vast key from another machine/session quietly burn
 * the per-hour rate, then vast.ai goes negative and every new deploy fails
 * with the misleading "All 3 race slots failed to create instances".
 *
 * Usage:
 *   ai-gateway-cost-audit --allowlist marcosremar/trellis2,marcosremar/hunyuan3d
 *   ai-gateway-cost-audit --allowlist trellis2 --autoterminate --json
 *
 * Reads VAST_API_KEY from the environment. Exits with code 2 when orphans
 * are found and `--autoterminate` was NOT passed (so cron jobs page on
 * detection without nuking pods unattended).
 */

import {
  listVastInstancesDirect,
  runOrphanSweep,
  terminateVastInstanceDirect,
} from '../server/orphan-sweep-vast.js';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0 || i === process.argv.length - 1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const apiKey = process.env.VAST_API_KEY ?? '';
  if (!apiKey) {
    console.error('VAST_API_KEY missing — set it before running cost-audit.');
    process.exit(1);
  }

  const allowlistArg = getFlag('--allowlist');
  const allowlist = allowlistArg
    ? allowlistArg.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  if (allowlist.length === 0) {
    console.error('--allowlist <prefix>[,<prefix>...] required (image prefixes considered owned).');
    process.exit(1);
  }

  const autoTerminate = hasFlag('--autoterminate');
  const json = hasFlag('--json');

  const report = await runOrphanSweep({
    listInstances: () => listVastInstancesDirect(apiKey),
    terminate: (id) => terminateVastInstanceDirect(id, apiKey),
    allowlistImagePrefixes: allowlist,
    autoTerminate,
    log: (line) => console.log(line),
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `orphans=${report.orphans.length}  burn=$${report.burnPerHourUsd.toFixed(2)}/h  terminated=${report.terminatedIds.length}  errors=${report.errors.length}`,
    );
  }

  // Page-friendly exit codes:
  //   0 = nothing to do
  //   2 = orphans found, --autoterminate NOT set (cron should alert)
  //   3 = orphans found, terminate calls partially failed
  if (report.errors.length > 0) process.exit(3);
  if (report.orphans.length > 0 && !autoTerminate) process.exit(2);
}

await main();

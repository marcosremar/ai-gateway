/**
 * Fault bench, round 2 (2026-10-07): failure scenarios nobody had executed — replica death mid-answer, everything
 * down, gateway restart under load, slow / vanishing clients, a compressed soak with random faults, and a burst of
 * cold requests against the spend guards. Report: docs/reports/2026-10-07-fault-scenarios.md.
 *
 *   bun scripts/fault-bench/scenarios.ts              # every scenario (soak: SOAK_MINUTES, default 30)
 *   bun scripts/fault-bench/scenarios.ts S1 S6        # only these
 *   BENCH_BUN=/path/to/bun-1.4.2 …                    # the Bun that runs serve.ts (default: this one)
 *
 * Nothing leaves the machine: fake keys, fake upstream and fake cloud on 127.0.0.1, proxy env on a closed port.
 */

import { startFakeUpstream, type FakeUpstream } from './fake-upstream';
import { scenario1, scenario2Deployment, scenario3Controller, scenario6, type Record_ } from './deployment-scenarios';
import { scenario2, scenario3Gateway, scenario4, scenario5 } from './gateway-scenarios';

type Verdict = 'PASS' | 'FAIL' | 'INFO' | 'N/A';
const results: Array<{ item: string; check: string; verdict: Verdict; evidence: string }> = [];
const record: Record_ = (item, check, verdict, evidence) => {
  results.push({ item, check, verdict, evidence });
  console.log(`[${verdict}] ${item} ${check} — ${evidence}`);
};

const scenarios: Record<string, (fake: FakeUpstream) => Promise<void>> = {
  S1: fake => scenario1(fake, record),
  S2: async (fake) => { await scenario2(fake, record); await scenario2Deployment(fake, record); },
  S3: async (fake) => { await scenario3Gateway(fake, record); await scenario3Controller(record); },
  S4: fake => scenario4(fake, record),
  S5: fake => scenario5(fake, record),
  S6: () => scenario6(record),
};

console.log(`bun ${Bun.version} (gateway: ${process.env.BENCH_BUN ?? process.execPath})`);
const fake = await startFakeUpstream();
const wanted = process.argv.slice(2);
for (const id of Object.keys(scenarios)) {
  if (wanted.length && !wanted.includes(id)) continue;
  const t0 = performance.now();
  try { await scenarios[id](fake); } catch (err) {
    const text = String((err as Error).stack ?? err);
    console.error(text.slice(-4000));
    record(id, 'scenario crashed', 'FAIL', `${text.slice(0, 300)} … ${text.slice(-300)}`);
  }
  console.log(`   (${id}: ${Math.round((performance.now() - t0) / 1000)} s)`);
}
await Promise.race([fake.close(), new Promise(r => setTimeout(r, 2000))]);
console.log('\nJSON ' + JSON.stringify(results));
process.exit(0);

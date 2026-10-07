/**
 * Prints the timeline of every autoscaling scenario (or the ones named): `bun scripts/autoscale-sim/run.ts [name…]`.
 * Deterministic: virtual clock, simulated cloud and clients (`engine.ts`), the real controller.
 */

import { formatTimeline, simulate } from './engine';
import { SCENARIOS } from './scenarios';

const wanted = process.argv.slice(2);
for (const [key, scenario] of Object.entries(SCENARIOS)) {
  if (wanted.length && !wanted.includes(key)) continue;
  const result = await simulate(scenario);
  console.log(formatTimeline(`${key}: ${scenario.name}`, result.rows));
  const served = Object.entries(result.served).map(([d, s]) => `${d}: gpu ${s.gpu}, fallback ${s.fallback}, failed ${s.failed}`).join('; ');
  const events = result.events.map(e => `${Math.round((e.t - result.events[0].t) / 1000)}s ${e.deployment} ${e.type}${e.reason ? ` (${e.reason})` : ''}`);
  console.log(`served — ${served}`);
  console.log(`scale events (${events.length}): ${events.join(', ')}`);
  console.log(`busy replicas killed: ${result.killedBusy.length}\n`);
}

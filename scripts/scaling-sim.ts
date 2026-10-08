/**
 * Replica autoscaling simulator: the real deployments controller on a virtual clock, a simulated cloud and a scripted
 * class (students holding a realtime slot, HTTP turns, anonymous requests). No network, no sleep, deterministic.
 *
 *   bun scripts/scaling-sim.ts                      every scenario, one summary row each
 *   bun scripts/scaling-sim.ts class-arrival burst  only these
 *   bun scripts/scaling-sim.ts class-arrival --timeline --events
 *   flags: --boot 600 --resume 180 --ceiling 8 --price 1.47 --max-replicas 4 --idle-minutes 2 --idle-action delete|stop
 *          --wasted-below 20 --no-fallback --seed 1
 */

import { simulateClass, summaryRow, table, type SimParams } from './scaling-sim/engine';
import { CLASS_SCENARIOS } from './scaling-sim/scenarios';

const NUMERIC: Record<string, keyof SimParams> = {
  '--boot': 'bootSeconds', '--resume': 'resumeSeconds', '--ceiling': 'ceiling', '--price': 'price', '--max-replicas': 'maxReplicas',
  '--idle-minutes': 'idleMinutes', '--wasted-below': 'wastedBelow', '--seed': 'seed',
};

const args = process.argv.slice(2);
const overrides: Partial<SimParams> = {};
const wanted: string[] = [];
const flags = new Set<string>();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (NUMERIC[a]) Object.assign(overrides, { [NUMERIC[a]]: Number(args[++i]) });
  else if (a === '--idle-action') overrides.idleAction = args[++i] === 'stop' ? 'stop' : 'delete';
  else if (a === '--no-fallback') overrides.fallback = false;
  else if (a.startsWith('--')) flags.add(a);
  else wanted.push(a);
}
const unknown = wanted.filter(k => !CLASS_SCENARIOS[k]);
if (unknown.length) {
  console.error(`unknown scenario: ${unknown.join(', ')} (known: ${Object.keys(CLASS_SCENARIOS).join(', ')})`);
  process.exit(1);
}

const summary = [];
for (const [key, scenario] of Object.entries(CLASS_SCENARIOS)) {
  if (wanted.length && !wanted.includes(key)) continue;
  const result = await simulateClass(scenario, overrides);
  summary.push(summaryRow(key, result));
  if (flags.has('--timeline')) console.log(`### ${key}: ${scenario.name}\n${table(result.rows as unknown as Array<Record<string, string | number>>)}\n`);
  if (flags.has('--events')) console.log(`${key} events: ${result.events.map(e => `${e.s}s ${e.type}${e.reason ? ` (${e.reason})` : ''}`).join(', ')}\n`);
}
console.log(table(summary));

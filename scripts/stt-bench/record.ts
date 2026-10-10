import { readFileSync } from 'node:fs';

const [file, url = process.env.AI_GATEWAY_URL ?? 'http://localhost:4000'] = process.argv.slice(2);
const key = process.env.AI_GATEWAY_ADMIN_KEY;
if (!file || !key) {
  console.error('usage: AI_GATEWAY_ADMIN_KEY=… bun scripts/stt-bench/record.ts <benchmarks.json> [gateway url]');
  process.exit(2);
}

const benchmarks = JSON.parse(readFileSync(file, 'utf8')) as Array<{ task: string; dataset: string }>;
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const saved = await fetch(`${url}/v1/admin/benchmarks`, { method: 'POST', headers, body: JSON.stringify({ benchmarks }) });
if (!saved.ok) {
  console.error(`POST ${saved.status}: ${await saved.text()}`);
  process.exit(1);
}
console.log(`saved ${(await saved.json() as { saved: string[] }).saved.length} benchmarks to ${url}`);

for (const { task, dataset } of new Map(benchmarks.map(b => [`${b.task}|${b.dataset}`, b])).values()) {
  const res = await fetch(`${url}/v1/admin/benchmarks/ranking?task=${task}&dataset=${encodeURIComponent(dataset)}`, { headers });
  const { ranking } = await res.json() as { ranking: Array<{ provider: string; model: string; score: number }> };
  console.log(`\n${task} ${dataset}`);
  ranking.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${r.score.toFixed(3)}  ${r.provider}:${r.model}`));
}

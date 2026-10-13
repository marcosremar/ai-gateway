import { z } from 'zod';

const unit = z.number().finite().min(0).max(1);
const nonNegative = z.number().finite().min(0);
const name = z.string().trim().min(1).max(200);

export const BENCHMARK_TASKS = ['stt', 'llm', 'tts'] as const;
export type BenchmarkTask = (typeof BENCHMARK_TASKS)[number];

export const ModelBenchmarkInputSchema = z.object({
  model: name,
  provider: name,
  task: z.enum(BENCHMARK_TASKS),
  dataset: name,
  measuredAt: z.string().datetime({ offset: true }),
  n: z.number().int().positive(),
  werSilver: unit,
  werConsensus: unit.nullable().default(null),
  fidelity: unit.nullable().default(null),
  ttftP50Ms: nonNegative,
  ttftP95Ms: nonNegative,
  ttftStreaming: z.boolean(),
  latencyP50Ms: nonNegative,
  latencyP95Ms: nonNegative,
  costPer1kUsd: nonNegative,
  emptyRate: unit,
  rulerVersion: name,
  notes: z.string().max(2000).optional(),
}).strict();

export type ModelBenchmarkInput = z.infer<typeof ModelBenchmarkInputSchema>;
export type ModelBenchmark = ModelBenchmarkInput & { id: string };

export const benchmarkId = (b: Pick<ModelBenchmark, 'provider' | 'model' | 'task' | 'dataset' | 'rulerVersion'>): string =>
  [b.provider, b.model, b.task, b.dataset, b.rulerVersion].join('|');

export const benchmarkTarget = (b: Pick<ModelBenchmark, 'provider' | 'model'>): string => `${b.provider}:${b.model}`;

export interface RankWeights { accuracy: number; fidelity: number; ttft: number; cost: number }
export const DEFAULT_RANK_WEIGHTS: RankWeights = { accuracy: 0.35, fidelity: 0.35, ttft: 0.2, cost: 0.1 };
export const EMPTY_RATE_TOLERANCE = 0.05;

export type RankedBenchmark = ModelBenchmark & { score: number };

function minMax(values: number[], higherIsBetter = false): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (v) => (max === min ? 1 : (higherIsBetter ? v - min : max - v) / (max - min));
}

export function rankBenchmarks(rows: ModelBenchmark[], weights: RankWeights = DEFAULT_RANK_WEIGHTS): RankedBenchmark[] {
  if (!rows.length) return [];
  const useConsensus = rows.every(r => r.werConsensus !== null);
  const werOf = (r: ModelBenchmark) => (useConsensus ? r.werConsensus as number : r.werSilver);
  const fidelityMeasured = rows.every(r => r.fidelity !== null);
  const accuracy = minMax(rows.map(werOf));
  const ttft = minMax(rows.map(r => r.ttftP50Ms));
  const cost = minMax(rows.map(r => r.costPer1kUsd));
  const fidelity = fidelityMeasured ? minMax(rows.map(r => r.fidelity as number), true) : () => 0;
  const fidelityWeight = fidelityMeasured ? weights.fidelity : 0;
  const total = weights.accuracy + fidelityWeight + weights.ttft + weights.cost;
  const ranked = rows.map(r => {
    const sum = weights.accuracy * accuracy(werOf(r)) + fidelityWeight * fidelity(r.fidelity as number)
      + weights.ttft * ttft(r.ttftP50Ms) + weights.cost * cost(r.costPer1kUsd);
    const base = total > 0 ? sum / total : 0;
    return { ...r, score: r.emptyRate > EMPTY_RATE_TOLERANCE ? base * (1 - r.emptyRate) : base };
  });
  return ranked.sort((a, b) => (Math.abs(b.score - a.score) > 1e-12 ? b.score - a.score : werOf(a) - werOf(b)));
}

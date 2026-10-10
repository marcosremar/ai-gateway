import { readStateFile, writeStateFile } from '../deployments/state-file';
import { benchmarkTarget, rankBenchmarks, type BenchmarkTask, type ModelBenchmark } from './benchmark';

export interface BenchmarkFilter { task?: string; dataset?: string }

export class ModelBenchmarkStore {
  private rows = new Map<string, ModelBenchmark>();
  private chain: Promise<void> = Promise.resolve();
  recovered: string | null = null;

  constructor(private readonly path: string | null) {}

  async load(): Promise<void> {
    if (!this.path) return;
    const read = await readStateFile<{ benchmarks?: ModelBenchmark[] }>(this.path);
    if (read.from === 'backup') this.recovered = read.problem ?? 'unreadable';
    this.rows = new Map((read.data?.benchmarks ?? []).map(b => [b.id, b]));
  }

  list(filter: BenchmarkFilter = {}): ModelBenchmark[] {
    return [...this.rows.values()].filter(b => (!filter.task || b.task === filter.task) && (!filter.dataset || b.dataset === filter.dataset));
  }

  ranking(task: string, dataset: string) {
    return rankBenchmarks(this.list({ task, dataset }));
  }

  rankOrder(task: BenchmarkTask, dataset: string): Map<string, number> {
    const order = new Map<string, number>();
    this.ranking(task, dataset).forEach((b, i) => { if (!order.has(benchmarkTarget(b))) order.set(benchmarkTarget(b), i); });
    return order;
  }

  async upsert(benchmarks: ModelBenchmark[]): Promise<void> {
    for (const b of benchmarks) this.rows.set(b.id, b);
    await this.save();
  }

  async delete(id: string): Promise<boolean> {
    if (!this.rows.delete(id)) return false;
    await this.save();
    return true;
  }

  private save(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    const text = JSON.stringify({ version: 1, benchmarks: [...this.rows.values()] }, null, 2);
    this.chain = this.chain.catch(() => {}).then(() => writeStateFile(path, text));
    return this.chain;
  }
}

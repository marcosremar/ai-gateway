import type { IncomingMessage } from 'http';
import type { CustomRoute } from '../gateway/proxy/types';
import { AdminRouteError, readJsonBody, type AdminGate } from '../config/admin-gate';
import { benchmarkId, DEFAULT_RANK_WEIGHTS, ModelBenchmarkInputSchema, type ModelBenchmark } from './benchmark';
import type { ModelBenchmarkStore } from './store';

const PATH = '/v1/admin/benchmarks';

const queryOf = (req: IncomingMessage) => new URL(req.url ?? '/', 'http://gateway').searchParams;

function parseBenchmarks(body: Record<string, unknown>): ModelBenchmark[] {
  const items = Array.isArray(body.benchmarks) ? body.benchmarks : [body];
  if (!items.length) throw new AdminRouteError(400, 'benchmarks must not be empty');
  return items.map((item, i) => {
    const parsed = ModelBenchmarkInputSchema.safeParse(item);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      throw new AdminRouteError(400, `benchmarks[${i}] invalid: ${issues}`);
    }
    return { id: benchmarkId(parsed.data), ...parsed.data };
  });
}

export function createModelBenchmarkRoutes(opts: { store: ModelBenchmarkStore; gate: AdminGate; onChange?: () => void }): CustomRoute[] {
  const { store, gate } = opts;
  return [
    {
      method: 'GET', path: PATH,
      handler: (req, res) => gate.run(req, res, 'benchmarks.list', async () => {
        const q = queryOf(req);
        return { status: 200, body: { benchmarks: store.list({ task: q.get('task') ?? undefined, dataset: q.get('dataset') ?? undefined }) } };
      }),
    },
    {
      method: 'POST', path: PATH,
      handler: (req, res) => gate.run(req, res, 'benchmarks.upsert', async (_actor, note) => {
        const benchmarks = parseBenchmarks(await readJsonBody(req));
        note.names = benchmarks.map(b => b.id);
        await store.upsert(benchmarks);
        opts.onChange?.();
        return { status: 200, body: { saved: benchmarks.map(b => b.id), benchmarks } };
      }),
    },
    {
      method: 'DELETE', path: PATH,
      handler: (req, res) => gate.run(req, res, 'benchmarks.delete', async (_actor, note) => {
        const id = queryOf(req).get('id');
        if (!id) throw new AdminRouteError(400, 'id query parameter is required');
        note.names = [id];
        if (!await store.delete(id)) return { status: 404, body: { error: { message: `benchmark '${id}' not found`, type: 'invalid_request_error' } } };
        opts.onChange?.();
        return { status: 200, body: { deleted: id } };
      }),
    },
    {
      method: 'GET', path: `${PATH}/ranking`,
      handler: (req, res) => gate.run(req, res, 'benchmarks.ranking', async () => {
        const q = queryOf(req);
        const task = q.get('task');
        const dataset = q.get('dataset');
        if (!task || !dataset) throw new AdminRouteError(400, 'task and dataset query parameters are required');
        return { status: 200, body: { task, dataset, weights: DEFAULT_RANK_WEIGHTS, ranking: store.ranking(task, dataset) } };
      }),
    },
  ];
}

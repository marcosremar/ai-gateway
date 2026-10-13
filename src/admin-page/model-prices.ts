import { readStateFile, writeStateFile } from '../deployments/state-file';

export const MODEL_PRICES_URL = 'https://openrouter.ai/api/v1/models?output_modalities=all';
export const MODEL_PRICES_MAX_AGE_MS = 86_400_000;
export const MODEL_PRICES_CHECK_MS = 3_600_000;
const FETCH_TIMEOUT_MS = 15_000;

export interface ModelPrice { prompt: number; completion: number }
export interface ModelPrices { at: string; models: Record<string, ModelPrice> }

const usd = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
const known = (v: number) => Number.isFinite(v) && v >= 0;

export function parseModelPrices(body: unknown): Record<string, ModelPrice> {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('lista de modelos sem data[]');
  const out: Record<string, ModelPrice> = {};
  for (const m of data as Array<{ id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } } | null>) {
    const prompt = usd(m?.pricing?.prompt);
    const completion = usd(m?.pricing?.completion);
    if (typeof m?.id === 'string' && known(prompt) && known(completion)) out[m.id] = { prompt, completion };
  }
  return out;
}

export function createModelPrices(opts: {
  path?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
} = {}) {
  const now = opts.now ?? Date.now;
  let prices: ModelPrices | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<boolean> {
    try {
      const res = await (opts.fetch ?? fetch)(MODEL_PRICES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const models = parseModelPrices(await res.json());
      if (!Object.keys(models).length) throw new Error('nenhum preço na lista');
      prices = { at: new Date(now()).toISOString(), models };
    } catch (err) {
      opts.log?.('model prices: refresh failed, keeping the last prices', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    if (opts.path) await writeStateFile(opts.path, JSON.stringify(prices)).catch(err => opts.log?.('model prices: cache write failed', { error: String(err) }));
    return true;
  }

  const due = () => !prices || now() - Date.parse(prices.at) >= MODEL_PRICES_MAX_AGE_MS;
  const tick = () => (due() ? refresh() : Promise.resolve(false));

  return {
    async load(): Promise<void> {
      if (!opts.path) return;
      const read = await readStateFile<ModelPrices>(opts.path);
      if (read.data?.models && typeof read.data.at === 'string') prices = read.data;
    },
    refresh,
    tick,
    snapshot: () => prices,
    start(intervalMs = MODEL_PRICES_CHECK_MS): void {
      if (timer) return;
      void tick();
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; },
  };
}

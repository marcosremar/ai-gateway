import { readStateFile, writeStateFile } from '../deployments/state-file';

export const MODEL_PRICES_URL = 'https://openrouter.ai/api/v1/models?output_modalities=all';
export const MODEL_PRICES_MAX_AGE_MS = 86_400_000;
export const MODEL_PRICES_CHECK_MS = 3_600_000;
const FETCH_TIMEOUT_MS = 15_000;

export interface ModelPrice { prompt: number; completion: number }
export interface ModelPrices { at: string; models: Record<string, ModelPrice> }
export interface ListedPrice extends ModelPrice { minUnits?: number; source?: string }

export const CLOUD_PRICES_CHECKED = '2026-10-13';
export const CLOUD_PRICES: Record<string, ListedPrice> = {
  'groq:whisper-large-v3': { prompt: 0.111 / 3600, completion: 0, minUnits: 10, source: 'https://console.groq.com/docs/speech-to-text' },
  'groq:whisper-large-v3-turbo': { prompt: 0.04 / 3600, completion: 0, minUnits: 10, source: 'https://console.groq.com/docs/speech-to-text' },
  'groq:canopylabs/orpheus-v1-english': { prompt: 22e-6, completion: 0, source: 'https://console.groq.com/docs/model/canopylabs/orpheus-v1-english' },
  'groq:canopylabs/orpheus-arabic-saudi': { prompt: 40e-6, completion: 0, source: 'https://console.groq.com/docs/model/canopylabs/orpheus-arabic-saudi' },
  'openai:whisper-1': { prompt: 0.006 / 60, completion: 0, source: 'https://developers.openai.com/api/docs/pricing' },
};

export const linkPrice = (prices: Record<string, ModelPrice>, provider: string, model: string): ListedPrice | undefined =>
  (provider === 'openrouter' ? prices[model] : CLOUD_PRICES[`${provider}:${model}`]);

export function usageCost(attrs: Record<string, unknown>, prices: Record<string, ModelPrice>): { usd: number; estimated: boolean } | null {
  const actual = Number(attrs.costUsd);
  if (actual > 0) return { usd: actual, estimated: false };
  const units = Number(attrs.audioSeconds ?? attrs.chars);
  const price = linkPrice(prices, String(attrs.provider), String(attrs.model));
  if (!price || price.completion > 0 || !Number.isFinite(units) || units < 0) return null;
  return { usd: price.prompt * Math.max(units, price.minUnits ?? 0), estimated: true };
}

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

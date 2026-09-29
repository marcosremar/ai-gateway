/**
 * RunPod REST v1 (`rest.runpod.io/v1`) and GraphQL GPU catalog for callers that run their own create policy (the
 * parle test hub: warm Chrome pool with park/wake). No retry loop here beyond one patient wait on 429: RunPod
 * rate-limits per API key, so a 429 on stop/delete/status is not about that pod and blind retries dig the key deeper
 * into cooldown (docs.runpod.io, TooManyRequestsError, RateLimit-Policy example `minute;q=60;w=60`).
 * Standalone on purpose (no logger, injectable fetch resolved per call).
 */

export type RunpodFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type RunpodPod = {
  id?: string;
  name?: string;
  env?: Record<string, string> | null;
  lastStartedAt?: string;
  createdAt?: string;
  desiredStatus?: string;
  costPerHr?: number;
  publicIp?: string;
  portMappings?: Record<string, number> | null;
  runtime?: {
    publicIp?: string;
    ports?: Array<{ privatePort?: number; publicPort?: number; ip?: string; isIpPublic?: boolean }>;
  } | null;
  [key: string]: unknown;
};

export type RunpodGpuType = {
  id: string;
  displayName: string;
  memoryInGb: number;
  pricePerHr: number;
  stockStatus: string;
  communityCloud: boolean;
  secureCloud: boolean;
};

export const RUNPOD_REST = "https://rest.runpod.io/v1";
export const RUNPOD_GRAPHQL = "https://api.runpod.io/graphql";
/** Longest `Retry-After` worth sitting through; longer hands the 429 back to the caller. */
export const RUNPOD_MAX_RETRY_AFTER_S = 20;

/** `Retry-After` in seconds (RunPod sends seconds), or null when absent or unreadable. */
export function runpodRetryAfterS(headers: Headers | Record<string, string | undefined>): number | null {
  const raw = headers instanceof Headers ? headers.get("retry-after") : headers["retry-after"];
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** REST times come in Go format (`2026-09-22 20:21:47.876 +0000 UTC`), which `Date.parse` does not read. */
export function runpodTime(raw: string): number | null {
  const iso = raw.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?) \+0000 UTC$/, "$1T$2Z");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export type RunpodRest = ReturnType<typeof createRunpodRest>;

export function createRunpodRest(opts: {
  apiKey: string; fetch?: RunpodFetch; sleep?: (ms: number) => Promise<void>; maxRetryAfterS?: number;
}) {
  const fetcher = (): RunpodFetch => opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const budget = opts.maxRetryAfterS ?? RUNPOD_MAX_RETRY_AFTER_S;

  const request = (path: string, init: RequestInit = {}): Promise<Response> => fetcher()(`${RUNPOD_REST}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${opts.apiKey}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });

  /** One wait on 429, only when `Retry-After` fits the budget; otherwise the 429 goes back to the caller. */
  const requestPatiently = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await request(path, init);
    if (res.status !== 429) return res;
    const wait = runpodRetryAfterS(res.headers) ?? budget + 1;
    if (wait > budget) return res;
    await sleep(wait * 1000);
    return request(path, init);
  };

  const pods = async (): Promise<RunpodPod[] | null> => {
    const res = await requestPatiently("/pods");
    if (!res.ok) return null;
    const rows = await res.json() as RunpodPod[];
    return Array.isArray(rows) ? rows : [];
  };

  return {
    request,
    requestPatiently,
    /** Every pod of the key, or null when RunPod did not answer 2xx (the caller decides what "unknown" means). */
    listPods: pods,
    async getPod(id: string): Promise<{ status: number; pod: RunpodPod | null }> {
      const res = await requestPatiently(`/pods/${encodeURIComponent(id)}`);
      return { status: res.status, pod: res.ok ? await res.json() as RunpodPod : null };
    },
    /** 404 counts as deleted. */
    async deletePod(id: string): Promise<void> {
      const res = await requestPatiently(`/pods/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`RunPod delete ${id}: HTTP ${res.status}`);
    },
    /** Releases the GPU and wipes the container disk (docs.runpod.io/pods/manage-pods). */
    async stopPod(id: string): Promise<number> {
      return (await requestPatiently(`/pods/${encodeURIComponent(id)}/stop`, { method: "POST" })).status;
    },
    /** May come back with 0 GPUs (docs.runpod.io/pods/manage-pods): the caller proves the endpoint before use. */
    async startPod(id: string, env?: Record<string, string>): Promise<number> {
      return (await requestPatiently(`/pods/${encodeURIComponent(id)}/start`, {
        method: "POST", ...(env ? { body: JSON.stringify({ env }) } : {}),
      })).status;
    },
    /**
     * `POST /pods` once (no patient wait: a create 429 is the caller's policy). On failure the body comes back cut
     * to 160 characters, enough to classify "no instances available" without carrying secrets around.
     */
    async createPod(body: Record<string, unknown>): Promise<
      { ok: true; status: number; pod: RunpodPod; retryAfterS: number | null } | { ok: false; status: number; body: string; retryAfterS: number | null }
    > {
      const res = await request("/pods", { method: "POST", body: JSON.stringify(body) });
      const raw = await res.text();
      const retryAfterS = runpodRetryAfterS(res.headers);
      if (!res.ok) return { ok: false, status: res.status, body: raw.slice(0, 160), retryAfterS };
      const pod = JSON.parse(raw) as RunpodPod;
      if (!pod.id) return { ok: false, status: res.status, body: "sem id", retryAfterS };
      return { ok: true, status: res.status, pod, retryAfterS };
    },
    /** GPU catalog with the cheapest on-demand price and stock (GraphQL `gpuTypes.lowestPrice`); types without a price are skipped. */
    async gpuTypes(): Promise<RunpodGpuType[]> {
      const res = await fetcher()(RUNPOD_GRAPHQL, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          query: `query { gpuTypes { id displayName memoryInGb secureCloud communityCloud
            lowestPrice(input: { gpuCount: 1 }) { uninterruptablePrice stockStatus } } }`,
        }),
      });
      const body = await res.json() as { data?: { gpuTypes?: Array<{
        id: string; displayName: string; memoryInGb: number; secureCloud?: boolean; communityCloud?: boolean;
        lowestPrice?: { uninterruptablePrice?: number | null; stockStatus?: string | null } | null;
      }> } };
      const out: RunpodGpuType[] = [];
      for (const g of body.data?.gpuTypes ?? []) {
        const price = g.lowestPrice?.uninterruptablePrice;
        if (price == null || !Number.isFinite(price)) continue;
        out.push({ id: g.id, displayName: g.displayName, memoryInGb: g.memoryInGb, pricePerHr: price,
          stockStatus: g.lowestPrice?.stockStatus ?? "", communityCloud: !!g.communityCloud, secureCloud: !!g.secureCloud });
      }
      return out;
    },
  };
}

/**
 * Poll a pod until `check` returns a value. `ghost(pod, elapsedMs)` true throws at once (RunPod said RUNNING but never
 * scheduled the container); a non-2xx read is just "not yet".
 */
export async function waitForRunpodPod<T>(
  rest: Pick<RunpodRest, "getPod">, id: string, check: (pod: RunpodPod) => Promise<T | null>,
  opts: { deadline: number; pollMs?: number; ghost?: (pod: RunpodPod, elapsedMs: number) => boolean;
    sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = now();
  while (now() < opts.deadline) {
    const { pod } = await rest.getPod(id);
    if (pod) {
      if (opts.ghost?.(pod, now() - started)) throw new Error(`pod ${id} fantasma (sem ip/porta)`);
      const ready = await check(pod);
      if (ready !== null) return ready;
    }
    await sleep(opts.pollMs ?? 3000);
  }
  throw new Error(`pod ${id} sem SSH`);
}

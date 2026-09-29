/**
 * Vast.ai marketplace primitives for callers that run their own offer policy and pacing (the parle test hub:
 * warm Chrome pool, cloud-play, batch GPU jobs). One HTTP attempt per call, every outcome classified, nothing
 * retried behind the caller's back: the caller decides whether to try the next offer, wait, or reconcile.
 *
 * Contracts: docs.vast.ai/api-reference/{search/search-offers,instances/create-instance,instances/show-instances}
 * and github.com/vast-ai/vast-cli/blob/master/vast.py (attach__ssh), checked 2026-09-24. Outcomes below were observed
 * on the live API by the parle hub (dates inline). Standalone on purpose (no logger, injectable fetch): provider error
 * bodies and create responses can carry `instance_api_key`, so nothing here logs a body or returns one raw.
 */

export type VastFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The fields callers rank on; the API returns many more and they pass through untouched. */
export type VastMarketOffer = {
  id: number;
  dph_total: number;
  reliability2?: number;
  inet_down?: number;
  gpu_name: string;
  geolocation?: string;
  gpu_ram?: number;
  [key: string]: unknown;
};

export type VastMarketInstance = {
  id: number;
  label?: string;
  actual_status?: string;
  public_ipaddr?: string;
  start_date?: number;
  geolocation?: string;
  gpu_name?: string;
  ssh_host?: string;
  ssh_port?: number;
  dph_total?: number;
  ports?: Record<string, Array<{ HostPort?: string }>>;
  [key: string]: unknown;
};

/** Error shape the hub's lease control reads: `noInstanceCreated` is what lets it try another provider. */
export type VastMarketError = Error & {
  status?: number;
  providerStatus?: number;
  reason?: "TRANSPORT" | "INVALID_JSON" | "HTTP_ERROR" | "INSUFFICIENT_CREDIT" | "RATE_LIMIT" | "UNKNOWN_CREATE_OUTCOME";
  code?: "CAPACITY_WAIT" | "INSUFFICIENT_CREDIT";
  noInstanceCreated?: boolean;
  terminal?: boolean;
  retryAfterMs?: number;
};

/** One accept attempt: a contract, or proof that this exact ask was gone before we got it. */
export type VastAcceptOutcome = { kind: "created"; contractId: number } | { kind: "gone" };

export const VAST_ORIGIN = "https://console.vast.ai";
export const VAST_RETRY_AFTER_MIN_MS = 2000;
export const VAST_RETRY_AFTER_MAX_MS = 60_000;

const fail = (message: string, props: Partial<VastMarketError>): VastMarketError => Object.assign(new Error(message), props);

/** A read failure that says nothing about the instance: network, broken JSON, 408/429/5xx. */
export function transientVastError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as VastMarketError;
  if (e.reason === "TRANSPORT" || e.reason === "INVALID_JSON") return true;
  const status = Number(e.status);
  return e.reason === "HTTP_ERROR" && (status === 408 || status === 429 || status >= 500);
}

/** `Retry-After` (seconds or HTTP date) clamped to [2 s, 60 s]; 2 s when absent or unreadable. */
export function vastRetryAfterMs(header: string | null, now = Date.now()): number {
  const ms = header && Number.isFinite(Number(header)) ? Number(header) * 1000 : header ? Date.parse(header) - now : VAST_RETRY_AFTER_MIN_MS;
  return Math.min(VAST_RETRY_AFTER_MAX_MS, Math.max(VAST_RETRY_AFTER_MIN_MS, Number.isFinite(ms) ? ms : VAST_RETRY_AFTER_MIN_MS));
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw fail("invalid Vast API JSON", { status: response.status, reason: "INVALID_JSON" }); }
}

export type VastMarketplace = ReturnType<typeof createVastMarketplace>;

export function createVastMarketplace(opts: { apiKey: string; fetch?: VastFetch; timeoutMs?: number }) {
  /* Resolved per call, so a caller (or a test) that swaps the global fetch later is honoured. */
  const fetcher = (): VastFetch => opts.fetch ?? globalThis.fetch;
  const request = async (path: string, method = "GET", body?: unknown, allowError = false): Promise<Response> => {
    const response = await fetcher()(`${VAST_ORIGIN}${path}`, {
      method, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => { throw fail("Vast API request failed", { reason: "TRANSPORT" }); });
    if (!response.ok && !allowError) throw fail(`Vast API HTTP ${response.status}`, { status: response.status, reason: "HTTP_ERROR" });
    return response;
  };

  return {
    /** `POST /api/v0/bundles/` with the caller's filter body; the policy (price cap, reliability, bandwidth) is theirs. */
    async searchOffers(body: Record<string, unknown>): Promise<VastMarketOffer[]> {
      const res = await request("/api/v0/bundles/", "POST", body);
      const out = await json(res) as { offers?: VastMarketOffer[] };
      if (!Array.isArray(out.offers)) throw new Error("invalid Vast offers");
      return out.offers;
    },

    /**
     * `PUT /api/v0/asks/<id>/` once. `gone` only with proof that no contract was made for THIS ask; anything else
     * without a contract throws, and an unreadable outcome is `UNKNOWN_CREATE_OUTCOME` (the caller must reconcile
     * from inventory before trusting that nothing is running).
     */
    async acceptOffer(askId: number, body: Record<string, unknown>): Promise<VastAcceptOutcome> {
      const res = await request(`/api/v0/asks/${askId}/`, "PUT", body, true);
      const out = await json(res) as { success?: boolean; new_contract?: number; error?: string; msg?: string; ask_id?: number; detail?: string };
      const noContract = out.new_contract == null && out.success !== true;
      // Observed HTTP 400 refusal: insufficient_credit with no contract and no success.
      if (res.status === 400 && out.error === "insufficient_credit" && noContract) {
        throw fail("Vast account has insufficient credit; review the Vast billing page before requesting another GPU.", {
          noInstanceCreated: true, terminal: true, status: 402, providerStatus: 400, reason: "INSUFFICIENT_CREDIT", code: "INSUFFICIENT_CREDIT",
        });
      }
      if (res.status === 429 && noContract && typeof out.detail === "string"
        && /^API requests too frequent endpoint threshold=\d+(?:\.\d+)?$/.test(out.detail)) {
        throw fail("Vast create HTTP 429: rate limit rejected acceptance", {
          noInstanceCreated: true, code: "CAPACITY_WAIT", status: 429, reason: "RATE_LIMIT", retryAfterMs: vastRetryAfterMs(res.headers.get("retry-after")),
        });
      }
      // Official 410 no_such_ask / 404 invalid_args+no_such_ask means no contract accepted. Observed 24/09/2026: HTTP 400
      // invalid_args, no ask_id, msg "error 404/3603: no_such_ask  Instance type by id <id> is not available." (the
      // offer was rented between search and accept); the id in the message is the proof it is this ask.
      const namesThisAsk = out.ask_id === askId || (out.ask_id == null && new RegExp(`\\bby id ${askId}\\b`).test(out.msg ?? ""));
      if (out.success === false && out.new_contract == null && namesThisAsk
        && ((out.error === "no_such_ask" && [200, 410].includes(res.status))
          || ([400, 404].includes(res.status) && out.error === "invalid_args" && /\bno_such_ask\b/.test(out.msg ?? "")))) return { kind: "gone" };
      if (out.success !== true || !Number.isSafeInteger(out.new_contract) || out.new_contract! <= 0) {
        throw fail(`Vast create HTTP ${res.status}: outcome unknown; reserved until inventory recovery`, { status: res.status, reason: "UNKNOWN_CREATE_OUTCOME" });
      }
      return { kind: "created", contractId: out.new_contract! };
    },

    /** Every instance of the account (`/api/v1/instances/`, paged by `next_token`), or a throw: never a partial list. */
    async listInstances(): Promise<VastMarketInstance[]> {
      const all: VastMarketInstance[] = [];
      let token = "";
      const seen = new Set<string>();
      do {
        const query = new URLSearchParams({ limit: "25", order_by: JSON.stringify([{ col: "id", dir: "asc" }]) });
        if (token) query.set("after_token", token);
        const out = await json(await request(`/api/v1/instances/?${query}`)) as { success?: boolean; instances?: VastMarketInstance[]; next_token?: string };
        if (out.success === false || !Array.isArray(out.instances) || out.instances.some((x) => !Number.isSafeInteger(x.id))) {
          throw new Error("invalid Vast inventory");
        }
        all.push(...out.instances);
        token = out.next_token ?? "";
        if (token && seen.has(token)) throw new Error("incomplete Vast inventory pagination");
        seen.add(token);
      } while (token);
      return all;
    },

    async attachSshKey(instanceId: string, publicKey: string): Promise<void> {
      const out = await json(await request(`/api/v0/instances/${encodeURIComponent(instanceId)}/ssh/`, "POST", { ssh_key: publicKey })) as { success?: boolean };
      if (out.success !== true) throw new Error("Vast SSH key attachment failed");
    },

    /** Missing (404) counts as destroyed, so a caller can retry safely after a restart. */
    async destroyInstance(instanceId: string): Promise<void> {
      try {
        const out = await json(await request(`/api/v0/instances/${encodeURIComponent(instanceId)}/`, "DELETE")) as { success?: boolean };
        if (out.success !== true) throw new Error("Vast deletion not confirmed");
      } catch (error) { if (!(error instanceof Error && (error as VastMarketError).status === 404)) throw error; }
    },
  };
}

export type VastReadyOptions = {
  /** Absolute deadline (ms since epoch). */
  deadline: number;
  pollMs?: number;
  backoffMaxMs?: number;
  /** Price ceiling the running instance must stay under (the offer can be repriced after accept). */
  maxPerHr?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Poll an instance until `check` returns a value. A transient inventory failure backs off and never counts against
 * the instance; the instance vanishing or being repriced over the ceiling throws (the caller destroys it). `check`
 * throwing means "not yet" (e.g. the Chrome install has not finished), never "broken".
 */
export async function waitForVastInstance<T>(
  inventory: () => Promise<VastMarketInstance[]>, instanceId: string,
  check: (instance: VastMarketInstance) => Promise<T | null>, opts: VastReadyOptions,
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const poll = opts.pollMs ?? 3000;
  let failures = 0;
  while (now() < opts.deadline) {
    let fleet: VastMarketInstance[];
    try { fleet = await inventory(); failures = 0; }
    catch (error) {
      if (!transientVastError(error)) throw error;
      failures++;
      await sleep(Math.min(opts.backoffMaxMs ?? 30_000, poll * 2 ** (failures - 1), Math.max(0, opts.deadline - now())));
      continue;
    }
    const instance = fleet.find((x) => String(x.id) === instanceId);
    if (!instance) throw new Error("Vast instance missing during readiness");
    if (opts.maxPerHr !== undefined && (!Number.isFinite(instance.dph_total) || instance.dph_total! <= 0 || instance.dph_total! > opts.maxPerHr)) {
      throw new Error("Vast actual instance price outside policy");
    }
    const ready = await check(instance).catch(() => null);
    if (ready !== null) return ready;
    await sleep(poll);
  }
  throw new Error("Vast instance readiness timed out");
}

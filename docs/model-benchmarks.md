# Model benchmarks and ranking

The gateway keeps the measured quality, latency and cost of each model (`provider:model`) per task and dataset, and
can order a route's fallbacks by that ranking. Code: `src/model-benchmarks/` (record, store, admin routes) and
`orderByBenchmark` in `src/config/serve-providers.ts`.

## Record (`ModelBenchmark`)

| Field | Meaning |
|---|---|
| `id` | derived: `provider\|model\|task\|dataset\|rulerVersion` — posting the same id again replaces the record |
| `model`, `provider` | the target as a route names it (`openrouter` + `openai/whisper-large-v3-turbo`) |
| `task` | `stt` (open to `llm`, `tts`) |
| `dataset` | e.g. `elevenlabs-pt-l2-v1` |
| `measuredAt` | ISO 8601 |
| `n` | turns measured |
| `werSilver`, `werConsensus` | 0..1; `werConsensus` may be `null` |
| `fidelity` | 0..1, `null` = not measured |
| `ttftP50Ms`, `ttftP95Ms`, `ttftStreaming` | time to first token; `ttftStreaming: false` when TTFT = total latency |
| `latencyP50Ms`, `latencyP95Ms` | total latency |
| `costPer1kUsd` | USD per 1000 turns |
| `emptyRate` | 0..1, share of empty transcripts |
| `rulerVersion` | version of the scoring ruler |
| `notes` | optional |

Stored in `MODEL_BENCHMARKS_PATH` (default `<DEPLOYMENTS_STATE_DIR or ~/.ai-gateway>/model-benchmarks.json`), atomic
writes with a `.bak` copy, loaded at boot. An unreadable file with no good backup disables the feature (logged).

## Admin routes

Admin key only (`Authorization: Bearer <admin key>`, same gate as `/v1/admin/keys`: rate limited, mutations audited).

| Method | Path | |
|---|---|---|
| `POST` | `/v1/admin/benchmarks` | body: one record, or `{ "benchmarks": [ … ] }`; upsert by id → `{ saved: [ids], benchmarks }`; remounts the routes |
| `GET` | `/v1/admin/benchmarks?task=&dataset=` | `{ benchmarks }`, both filters optional |
| `GET` | `/v1/admin/benchmarks/ranking?task=stt&dataset=…` | `{ task, dataset, weights, ranking: [ {…record, score} ] }`, best first |
| `DELETE` | `/v1/admin/benchmarks?id=…` | `{ deleted }`, `404` when unknown |

## Ranking (`rankBenchmarks(rows, weights?)`)

Within the rows of one task + dataset, each component is normalised min-max over the set (all equal → 1 for all):

- lower is better: `n = (max − v) / (max − min)` for WER, TTFT p50 and cost;
- higher is better: `n = (v − min) / (max − min)` for fidelity.

```
score = Σ wᵢ·nᵢ / Σ wᵢ
```

| Component | Weight | Value |
|---|---|---|
| accuracy | 0.35 | `werConsensus` when every row has it, else `werSilver` |
| fidelity | 0.35 | `fidelity`; when any row has `null`, fidelity is dropped for every row, so its weight goes to the others in proportion (the division by `Σ wᵢ`) |
| ttft | 0.20 | `ttftP50Ms` |
| cost | 0.10 | `costPer1kUsd` |

Penalty: `emptyRate > 0.05` → `score × (1 − emptyRate)`. Ties: lower WER first. All rows of the task + dataset are
ranked together, whatever their `rulerVersion`.

## Route order `"benchmark"`

A route's **first** entry may carry `"order": "benchmark"` and `"benchmarkDataset"`. When the providers are mounted
(boot, routes PUT, key reload, benchmark POST/DELETE), the entries **after** the first are sorted by the ranking of
that dataset (task = the stage: `stt`, `chat` → `llm`, `tts`), matching each entry by `provider:model`. Entries with
no benchmark keep their relative order after the ranked ones. The first entry never moves. Without the option, or with
the feature disabled, the declared order is kept.

```json
{ "stt": { "parle-stt": [
  { "provider": "deployment", "deployment": "parle-speech", "model": "whisper-large-v3-turbo",
    "order": "benchmark", "benchmarkDataset": "elevenlabs-pt-l2-v1" },
  { "provider": "openrouter", "model": "openai/whisper-large-v3-turbo" },
  { "provider": "groq", "model": "whisper-large-v3-turbo" }
] } }
```

`order` without a `benchmarkDataset`, or any other `order` value, is an invalid entry (`400` on the routes PUT).

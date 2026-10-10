# Desktop-app field telemetry

Opt-in usage and performance events from the ucast.me desktop app (off by default in the app), so field problems —
slow stages, crashes, error codes, versions in use — are visible. Code: `src/app-telemetry/`, wired in `serve.ts`.

This is separate from the unified, trace-correlated telemetry (`docs/api/telemetry.md`), which already owns
`POST /v1/telemetry/events` with a different event shape and limits; the app endpoints live under `/v1/telemetry/app/`.

## Endpoints

| Method | Path | Auth | |
|---|---|---|---|
| POST | `/v1/telemetry/app/events` | gateway key (`Authorization: Bearer …`, proxy auth) | ingest a batch |
| GET | `/v1/telemetry/app/summary?days=7` | admin key | aggregates over the last `days` (1–366) |
| GET | `/v1/telemetry/app/events?installId=&kind=&since=&until=&limit=` | admin key | raw rows, newest first (`since` default 24 h; `15m`/`2h`/`7d`, ms epoch or ISO; `limit` ≤ 1000) |

## Batch

```json
{
  "installId": "3f2b8c1e-9d4a-4e6b-8f00-1a2b3c4d5e6f",
  "appVersion": "0.9.3",
  "os": "windows",
  "events": [{ "ts": 1760090000000, "kind": "utterance", "fields": { "session": "19a…", "total_ms": 812, "stt_ms": 300 } }]
}
```

- `installId`: random UUID created by the app (no machine or user identity). `appVersion` `[0-9A-Za-z.+_-]{1,32}`,
  `os` `[A-Za-z0-9._-]{1,32}`.
- `kind` ∈ `session_start, session_end, utterance, crash, app_start, app_exit, gpu_wait, stream, direction_changed, error`
  — anything else → 400.
- `fields`: JSON object; scalars, arrays (≤ 64 items) and objects (≤ 64 keys, keys ≤ 64 chars) nested at most 4 deep;
  strings ≤ 256 chars, fields ≤ 16 KB serialized. A breach → 400 (the whole batch).
- **No transcript text**: keys named `original`, `translated`, `translated_N`, `text`, `transcript`, `transcription`
  (any case, any depth) are dropped before storage.
- ≤ 500 events and ≤ 256 KB per batch (413 above). Per install ≤ `APP_TELEMETRY_BATCHES_PER_MIN` (30) batches/min,
  then 429 + `Retry-After: 60`.
- Response `200 {"accepted": n}`. 507 when the day file reached its cap, 503 on a storage error (both with `Retry-After`).

## Summary

`sessions` (started / ended / total and average duration), `crashes.byLocation` (`fields.location`, else
`fields.thread`), `utteranceDelay` p50/p95 per stage (`total`, `stt`, `stt_gateway`, `llm` = slowest of `llm[].ms` or
`llm_ms`, `tts`, `audio`), `errors.byCode` (`stage:code`) with the rate per 100 utterances, `versions` and `os` (distinct
installs), `dubbing` (sessions started with `dubbing: true`), `swap` (`direction_changed` events / installs / sessions),
`gpuWait` (p50/p95 of `ms`, failures), `appStarts`, `appExits`.

## Storage and configuration

Day files `<dir>/YYYY-MM-DD.jsonl` by server receive day (UTC), on the same volume as rooms. A sweep (at start and every
6 h) deletes files older than the retention.

| Env | Default |
|---|---|
| `APP_TELEMETRY` | on; `0` disables the routes |
| `APP_TELEMETRY_RETENTION_DAYS` | `TELEMETRY_RETENTION_DAYS`, else 365 |
| `APP_TELEMETRY_DIR` | `<DEPLOYMENTS_STATE_DIR \| RAILWAY_VOLUME_MOUNT_PATH \| ~/.ai-gateway>/app-telemetry` |
| `APP_TELEMETRY_MAX_DAY_MB` | 512 |
| `APP_TELEMETRY_BATCHES_PER_MIN` | 30 (per install) |

Note: `TELEMETRY_RETENTION_DAYS` is also read by the unified telemetry (default 14 there); set
`APP_TELEMETRY_RETENTION_DAYS` to tune the app store alone.

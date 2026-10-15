"""
Latency bench of /v1/s2s: N students at once, each sending a recorded utterance and timing the streamed answer.

    python3 bench.py --url https://gw/v1/deployments/<name>/invoke --key <bearer> --audio clip.wav --voice br-m-08 \
        --concurrency 1,4,8 --rounds 3 --out result.json

Per request: client-side time to first audio byte and to the end, plus the server-side events (stt_ms, llm_first_token,
first sentence cut, first_audio). Prints p50/p95 per concurrency level, and how each stream ended (`outcome`): ok ·
truncated (no `done`: the connection broke, the stream closed early, or `done` reports sentences not voiced) · stalled
(nothing for --timeout seconds) · error (an in-band `error` event, by stage) · http_error (no 200).
"""

import argparse
import asyncio
import json
import statistics
import struct
import time

import httpx


def pct(values, p):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    k = max(0, min(len(values) - 1, round(p / 100 * (len(values) - 1))))
    return values[k]


def outcome(rec):
    ev = {e["type"]: e for e in rec["events"]}
    done = ev.get("done")
    if rec["status"] != 200:
        return "http_error"
    if "error" in ev:
        return f"error:{ev['error'].get('stage') or ev['error'].get('code') or 'unknown'}"
    if rec["broken"] and "Timeout" in rec["broken"]:
        return "stalled"
    if not done or done.get("partial") or done.get("skipped") or done.get("missing_audio") \
            or done.get("spoken", 0) < done.get("sentences", 0):
        return "truncated"
    return "ok"


async def one(client, url, key, audio, config, wait=0, timeout=None):
    t0 = time.perf_counter()
    ms = lambda: round((time.perf_counter() - t0) * 1000)  # noqa: E731
    rec = {"events": [], "audio_bytes": 0, "client_first_audio_ms": None, "status": None, "broken": None}
    try:
        files = {"file": ("clip.wav", audio, "audio/wav")}
        async with client.stream("POST", f"{url}/v1/s2s", files=files, data={"config": json.dumps(config)},
                                 headers={"Authorization": f"Bearer {key}", "X-Aigw-Wait": str(wait)},
                                 **({"timeout": timeout} if timeout else {})) as res:
            rec["status"] = res.status_code
            buf = b""
            async for chunk in res.aiter_bytes():
                buf += chunk
                while len(buf) >= 5:
                    kind, size = buf[:1], struct.unpack(">I", buf[1:5])[0]
                    if len(buf) < 5 + size:
                        break
                    payload, buf = buf[5:5 + size], buf[5 + size:]
                    if kind == b"A":
                        if rec["client_first_audio_ms"] is None:
                            rec["client_first_audio_ms"] = ms()
                        rec["audio_bytes"] += len(payload)
                    else:
                        rec["events"].append(json.loads(payload))
    except httpx.HTTPError as error:  # one broken stream is a data point, not the end of the bench
        rec["broken"] = f"{type(error).__name__}: {error}"[:200]
    rec["client_total_ms"] = ms()
    ev = {e["type"]: e for e in rec["events"]}
    rec["stt_ms"] = ev.get("transcript", {}).get("stt_ms")
    rec["transcript"] = ev.get("transcript", {}).get("text")
    rec["llm_first_token_ms"] = ev.get("llm_first_token", {}).get("at_ms")
    first_sentence = next((e for e in rec["events"] if e["type"] == "sentence"), {})
    rec["first_sentence"] = first_sentence.get("text")
    rec["first_cut_ms"] = first_sentence.get("cut_at_ms")
    rec["server_first_audio_ms"] = ev.get("first_audio", {}).get("at_ms")
    rec["server_total_ms"] = ev.get("done", {}).get("total_ms")
    rec["stages"] = ev.get("done", {}).get("stages") or {}
    rec["reply"] = ev.get("done", {}).get("reply")
    rec["error"] = ev.get("error", {}).get("message") or rec["broken"]
    rec["audio_seconds"] = round(rec["audio_bytes"] / 2 / 24000, 2)
    rec["outcome"] = outcome(rec)
    return rec


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--voice", required=True)
    ap.add_argument("--concurrency", default="1,4,8")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--out", default="bench.json")
    ap.add_argument("--timeout", type=float, default=60.0, help="seconds without a byte before a stream counts as stalled")
    ap.add_argument("--wait", type=int, default=840, help="seconds the warm-up request may wait through a cold start")
    ap.add_argument("--config", help="JSON file merged over the /v1/s2s config (system, messages, response_format, speak_field)")
    args = ap.parse_args()
    audio = open(args.audio, "rb").read()
    config = {
        "language": "pt", "voice": args.voice, "max_tokens": 120, "temperature": 0.6,
        "system": "Você é o Seu Jorge, padeiro em Copacabana. Responda em português do Brasil, em uma ou duas frases curtas "
                  "e simples (nível A1), como numa conversa de balcão.",
    }
    if args.config:
        config.update(json.load(open(args.config)))
    results = {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(args.timeout, connect=10.0)) as client:
        await one(client, args.url, args.key, audio, config, args.wait, args.wait + 60)  # warm the path (connections, caches)
        for n in [int(x) for x in args.concurrency.split(",")]:
            runs = []
            for _ in range(args.rounds):
                runs += await asyncio.gather(*[one(client, args.url, args.key, audio, config) for _ in range(n)])
            results[n] = runs
            keys = ["stt_ms", "llm_first_token_ms", "first_cut_ms", "server_first_audio_ms", "client_first_audio_ms",
                    "client_total_ms", "audio_seconds"]
            row = {k: (pct([r[k] for r in runs], 50), pct([r[k] for r in runs], 95)) for k in keys}
            for message in sorted({r["error"] for r in runs if r["error"]}):
                print(f"  error: {message}")
            outcomes = sorted((o, sum(1 for r in runs if r["outcome"] == o)) for o in {r["outcome"] for r in runs})
            print(f"\n== {n} at once ({len(runs)} requests: {', '.join(f'{c} {o}' for o, c in outcomes)})")
            for k, (p50, p95) in row.items():
                print(f"  {k:24s} p50 {p50}  p95 {p95}")
            for k in sorted({k for r in runs for k in r["stages"]}):
                values = [r["stages"].get(k) for r in runs]
                print(f"  stage {k:24s} p50 {pct(values, 50)}  p95 {pct(values, 95)}")
            sample = runs[0]
            print(f"  heard: {sample['transcript']!r}\n  first sentence: {sample['first_sentence']!r}\n  reply: {sample['reply']!r}")
    json.dump(results, open(args.out, "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    asyncio.run(main())

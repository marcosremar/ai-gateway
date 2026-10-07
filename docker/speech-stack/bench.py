"""
Latency bench of /v1/s2s: N students at once, each sending a recorded utterance and timing the streamed answer.

    python3 bench.py --url https://gw/v1/deployments/<name>/invoke --key <bearer> --audio clip.wav --voice br-m-08 \
        --concurrency 1,4,8 --rounds 3 --out result.json

Per request: client-side time to first audio byte and to the end, plus the server-side events (stt_ms, llm_first_token,
first sentence cut, first_audio). Prints p50/p95 per concurrency level.
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


async def one(client, url, key, audio, config):
    try:
        return await _one(client, url, key, audio, config)
    except httpx.HTTPError as error:  # one broken stream is a data point, not the end of the bench
        return {"status": None, "error": f"{type(error).__name__}: {error}"[:200], "events": [], "audio_bytes": 0,
                **{k: None for k in ("client_first_audio_ms", "client_total_ms", "stt_ms", "transcript", "llm_first_token_ms",
                                     "first_sentence", "first_cut_ms", "server_first_audio_ms", "server_total_ms", "reply")},
                "stages": {}}


async def _one(client, url, key, audio, config):
    t0 = time.perf_counter()
    ms = lambda: round((time.perf_counter() - t0) * 1000)  # noqa: E731
    rec = {"events": [], "audio_bytes": 0, "client_first_audio_ms": None}
    files = {"file": ("clip.wav", audio, "audio/wav")}
    async with client.stream("POST", f"{url}/v1/s2s", files=files, data={"config": json.dumps(config)},
                             headers={"Authorization": f"Bearer {key}", "X-Aigw-Wait": "840"}) as res:
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
    rec["error"] = ev.get("error", {}).get("message")
    rec["audio_seconds"] = round(rec["audio_bytes"] / 2 / 24000, 2)
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
    args = ap.parse_args()
    audio = open(args.audio, "rb").read()
    config = {
        "language": "pt", "voice": args.voice, "max_tokens": 120, "temperature": 0.6,
        "system": "Você é o Seu Jorge, padeiro em Copacabana. Responda em português do Brasil, em uma ou duas frases curtas "
                  "e simples (nível A1), como numa conversa de balcão.",
    }
    results = {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(900.0)) as client:
        await one(client, args.url, args.key, audio, config)  # warm the path (connections, caches)
        for n in [int(x) for x in args.concurrency.split(",")]:
            runs = []
            for _ in range(args.rounds):
                runs += await asyncio.gather(*[one(client, args.url, args.key, audio, config) for _ in range(n)])
            results[n] = runs
            keys = ["stt_ms", "llm_first_token_ms", "first_cut_ms", "server_first_audio_ms", "client_first_audio_ms",
                    "client_total_ms"]
            row = {k: (pct([r[k] for r in runs], 50), pct([r[k] for r in runs], 95)) for k in keys}
            errors = sum(1 for r in runs if r["error"] or r["status"] != 200)
            for message in sorted({r["error"] for r in runs if r["error"]}):
                print(f"  error: {message}")
            print(f"\n== {n} at once ({len(runs)} requests, {errors} errors)")
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

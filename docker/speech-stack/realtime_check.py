import argparse
import asyncio
import base64
import io
import json
import os
import re
import statistics
import time
import unicodedata
import wave
from pathlib import Path

import httpx
import numpy as np
import websockets

AUTH = {"Authorization": f"Bearer {os.environ['CHECK_TOKEN']}"} if os.environ.get("CHECK_TOKEN") else {}

LANG_NAME = {"pt": "Portuguese", "fr": "French", "en": "English", "es": "Spanish", "de": "German", "it": "Italian"}
DUB_TARGET = {"pt": "en", "fr": "pt", "en": "fr"}
FRAME = 512
RATE = 16000
TTS_RATE = 24000
REF_MAX_S = 8.0


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def wav_bytes(pcm: np.ndarray, rate: int) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.astype(np.int16).tobytes())
    return out.getvalue()


def data_url(pcm: np.ndarray) -> str:
    return "data:audio/wav;base64," + base64.b64encode(wav_bytes(pcm[: int(REF_MAX_S * RATE)], RATE)).decode()


def words(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text.lower()).replace("’", "'")
    return re.findall(r"[\w']+", text)


def wer(reference: str, hypothesis: str) -> float:
    ref, hyp = words(reference), words(hypothesis)
    row = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, row[0] = row[0], i
        for j, h in enumerate(hyp, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (r != h))
    return row[-1] / max(1, len(ref))


def chrf(hypothesis: str, reference: str) -> float:
    import sacrebleu

    return sacrebleu.sentence_chrf(hypothesis, [reference]).score


def p(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(q * len(ordered)))], 3)


async def stream_stt(ws_base: str, pcm: np.ndarray, language: str) -> dict:
    url = f"{ws_base}/ws/audio-stream?language={language}&segments=1"
    finals: list[str] = []
    async with websockets.connect(url, max_size=None, additional_headers=AUTH) as ws:
        assert json.loads(await ws.recv()).get("type") == "ready"

        async def receive():
            async for message in ws:
                event = json.loads(message)
                if event.get("type") == "final":
                    finals.append(event.get("text", "").strip())
                    received.append(time.perf_counter())

        received: list[float] = []
        listener = asyncio.create_task(receive())
        start = time.perf_counter()
        padded = np.concatenate([pcm, np.zeros(int(0.3 * RATE), dtype=np.int16)])
        for n, at in enumerate(range(0, len(padded), FRAME)):
            await asyncio.sleep(max(0.0, start + n * FRAME / RATE - time.perf_counter()))
            await ws.send(padded[at:at + FRAME].tobytes())
        speech_end = start + len(pcm) / RATE
        await ws.send(json.dumps({"type": "flush"}))
        deadline = time.perf_counter() + 15
        count = len(finals)
        while time.perf_counter() < deadline:
            await asyncio.sleep(0.05)
            if len(finals) > count and time.perf_counter() - received[-1] > 0.6:
                break
        listener.cancel()
    text = " ".join(t for t in finals if t)
    return {"text": text, "final_after_s": round(received[-1] - speech_end, 3) if received else None}


async def translate(client: httpx.AsyncClient, base: str, text: str, source: str, target: str) -> dict:
    started = time.perf_counter()
    res = await client.post(f"{base}/v1/translate", json={"text": text, "source": source, "target": target})
    res.raise_for_status()
    return {**res.json(), "wall_s": round(time.perf_counter() - started, 3)}


async def speak(client: httpx.AsyncClient, base: str, model: str, text: str, language: str, reference: str) -> dict:
    body = {"model": model, "input": text, "task_type": "Base", "ref_audio": reference, "x_vector_only_mode": True,
            "language": LANG_NAME[language], "response_format": "pcm", "stream": True, "stream_format": "audio"}
    started = time.perf_counter()
    first, chunks = None, []
    async with client.stream("POST", f"{base}/v1/audio/speech", json=body) as res:
        if res.status_code != 200:
            raise RuntimeError(f"tts http {res.status_code}: {(await res.aread())[:300]!r}")
        async for chunk in res.aiter_bytes():
            if chunk and first is None:
                first = time.perf_counter() - started
            chunks.append(chunk)
    raw = b"".join(chunks)
    pcm = np.frombuffer(raw[: len(raw) // 2 * 2], dtype=np.int16)
    total = time.perf_counter() - started
    audio_s = len(pcm) / TTS_RATE
    return {"pcm": pcm, "first_audio_s": round(first or total, 3), "synth_s": round(total, 3), "audio_s": round(audio_s, 3),
            "rtf": round(total / audio_s, 3) if audio_s else None}


async def dub_one(client, base, model, item, heard, started_at) -> dict:
    source, target = item["src"], DUB_TARGET[item["src"]]
    out = {"id": f"{item['src']}-{item['id']}", "source": source, "target": target, "heard": heard["text"],
           "stt_final_after_s": heard["final_after_s"]}
    try:
        mt = await translate(client, base, heard["text"], source, target)
        out.update(translation=mt["text"], mt_s=mt["wall_s"], mt_device=mt.get("device"))
        voice = await speak(client, base, model, mt["text"], target, item["reference"])
        out.update({k: v for k, v in voice.items() if k != "pcm"}, pcm=voice["pcm"])
        out["speech_end_to_dub_s"] = round(time.perf_counter() - voice["synth_s"] + voice["first_audio_s"] - started_at, 3)
    except Exception as error:  # noqa: BLE001
        out["error"] = repr(error)[:300]
    return out


async def simulate(base: str, ws_base: str, model: str, items: list[dict]) -> list[dict]:
    pending: list[asyncio.Task] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0), headers=AUTH) as client:
        for item in items:
            heard = await stream_stt(ws_base, item["pcm"], item["src"])
            speech_end = time.perf_counter() - (heard["final_after_s"] or 0)
            pending.append(asyncio.create_task(dub_one(client, base, model, item, heard, speech_end)))
        return list(await asyncio.gather(*pending))


async def back_transcribe(base: str, results: list[dict]) -> None:
    async with httpx.AsyncClient(timeout=120.0, headers=AUTH) as client:
        for r in results:
            if r.get("pcm") is None or not len(r["pcm"]):
                continue
            files = {"file": ("dub.wav", wav_bytes(r["pcm"], TTS_RATE), "audio/wav")}
            res = await client.post(f"{base}/v1/audio/transcriptions", files=files, data={"language": r["target"]})
            if res.status_code == 200:
                r["dub_heard"] = res.json().get("text", "").strip()


def speaker_similarity(results: list[dict], items: dict[str, dict]) -> None:
    import torch
    import torchaudio
    from speechbrain.inference.speaker import EncoderClassifier

    encoder = EncoderClassifier.from_hparams("speechbrain/spkrec-ecapa-voxceleb", savedir="/tmp/ecapa", run_opts={"device": "cpu"})

    def embed(pcm: np.ndarray, rate: int) -> torch.Tensor:
        wave_ = torch.from_numpy(pcm.astype(np.float32) / 32768).unsqueeze(0)
        if rate != RATE:
            wave_ = torchaudio.functional.resample(wave_, rate, RATE)
        return torch.nn.functional.normalize(encoder.encode_batch(wave_).squeeze(), dim=0)

    refs = {key: embed(item["pcm"][: int(REF_MAX_S * RATE)], RATE) for key, item in items.items()}
    keys = list(refs)
    for r in results:
        if r.get("pcm") is None or len(r["pcm"]) < TTS_RATE // 2:
            continue
        dub = embed(r["pcm"], TTS_RATE)
        r["sim_own"] = round(float(dub @ refs[r["id"]]), 3)
        others = [float(dub @ refs[k]) for k in keys if k != r["id"]]
        r["sim_others_mean"] = round(statistics.mean(others), 3)


def summarize(results: list[dict], items: dict[str, dict], health: dict) -> dict:
    ok = [r for r in results if "error" not in r]
    speech_s = sum(len(items[r["id"]]["pcm"]) / RATE for r in results)
    synth_s = sum(r["synth_s"] for r in ok)
    for r in ok:
        item = items[r["id"]]
        r["stt_wer"] = round(wer(item["text"][r["source"]], r["heard"]), 3)
        r["mt_chrf"] = round(chrf(r["translation"], item["text"][r["target"]]), 1)
        if "dub_heard" in r:
            r["dub_wer"] = round(wer(r["translation"], r["dub_heard"]), 3)
    col = lambda key: [r[key] for r in ok if r.get(key) is not None]  # noqa: E731
    summary = {
        "items": len(results), "errors": len(results) - len(ok),
        "stt_wer_mean": round(statistics.mean(col("stt_wer")), 3) if col("stt_wer") else None,
        "stt_final_after_s_p50": p(col("stt_final_after_s"), 0.5), "stt_final_after_s_p90": p(col("stt_final_after_s"), 0.9),
        "mt_chrf_mean": round(statistics.mean(col("mt_chrf")), 1) if col("mt_chrf") else None,
        "mt_s_p50": p(col("mt_s"), 0.5), "mt_s_p90": p(col("mt_s"), 0.9),
        "tts_first_audio_s_p50": p(col("first_audio_s"), 0.5), "tts_first_audio_s_p90": p(col("first_audio_s"), 0.9),
        "tts_rtf_p50": p(col("rtf"), 0.5), "tts_rtf_p90": p(col("rtf"), 0.9),
        "dub_wer_mean": round(statistics.mean(col("dub_wer")), 3) if col("dub_wer") else None,
        "sim_own_mean": round(statistics.mean(col("sim_own")), 3) if col("sim_own") else None,
        "sim_others_mean": round(statistics.mean(col("sim_others_mean")), 3) if col("sim_others_mean") else None,
        "speech_end_to_dub_s_p50": p(col("speech_end_to_dub_s"), 0.5), "speech_end_to_dub_s_p90": p(col("speech_end_to_dub_s"), 0.9),
        "synth_over_speech": round(synth_s / speech_s, 3) if speech_s else None,
        "mt_cpu_fallbacks": health.get("mt", {}).get("cpu_calls"),
    }
    lag = summary["speech_end_to_dub_s_p90"]
    summary["realtime_dub"] = bool(not summary["errors"] and lag is not None and lag <= 3.0 and (summary["synth_over_speech"] or 9) <= 0.8)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixtures", type=Path)
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-0.6B-Base")
    parser.add_argument("--per-language", type=int, default=4)
    parser.add_argument("--out", type=Path, default=Path("/tmp/realtime_check"))
    parser.add_argument("--no-similarity", action="store_true")
    args = parser.parse_args()

    bench = json.loads((args.fixtures / "bench.json").read_text())
    chosen: dict[str, int] = {}
    items: dict[str, dict] = {}
    for entry in bench:
        if entry["src"] in DUB_TARGET and chosen.get(entry["src"], 0) < args.per_language:
            chosen[entry["src"]] = chosen.get(entry["src"], 0) + 1
            pcm = read_wav(args.fixtures / entry["audio"])
            items[f"{entry['src']}-{entry['id']}"] = {**entry, "pcm": pcm, "reference": data_url(pcm)}
    order = sorted(items.values(), key=lambda x: (int(x["id"]) % 7, x["src"]))
    ws_base = args.base.replace("http", "ws", 1)

    results = asyncio.run(simulate(args.base, ws_base, args.model, order))
    asyncio.run(back_transcribe(args.base, results))
    if not args.no_similarity:
        speaker_similarity(results, items)
    health = httpx.get(f"{args.base}/health", timeout=10, headers=AUTH).json()
    summary = summarize(results, items, health)

    args.out.mkdir(parents=True, exist_ok=True)
    for r in results:
        if r.get("pcm") is not None:
            (args.out / f"{r['id']}.wav").write_bytes(wav_bytes(r.pop("pcm"), TTS_RATE))
    (args.out / "items.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    (args.out / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()

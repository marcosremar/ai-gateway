import asyncio
import hashlib
import json

import numpy as np

MAX_LINES = 8
MAX_CACHED = 256
cache: dict[str, asyncio.Task] = {}


def lines_of(cfg: dict) -> list[str]:
    opener = cfg.get("opener")
    lines = opener.get("lines") if isinstance(opener, dict) else None
    if not isinstance(lines, list):
        return []
    return [line.strip() for line in lines if isinstance(line, str) and line.strip()][:MAX_LINES]


def key_of(cfg: dict, line: str) -> str:
    identity = [cfg.get("voice"), cfg.get("fallback_voice"), (cfg.get("language") or "pt")[:2], line]
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def trim_lead(pcm: bytes, rate: int) -> bytes:
    samples = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype=np.int16)
    loud = np.flatnonzero(np.abs(samples.astype(np.int32)) > 328)
    return pcm if not len(loud) else samples[max(0, int(loud[0]) - rate // 100):].tobytes()


def warm(cfg: dict, synth) -> None:
    for line in lines_of(cfg):
        key = key_of(cfg, line)
        if key in cache:
            continue
        while len(cache) >= MAX_CACHED:
            cache.pop(next(iter(cache)))
        task = cache[key] = asyncio.create_task(synth(line))
        task.add_done_callback(lambda done, key=key: _forget_failed(key, done))


def _forget_failed(key: str, task: asyncio.Task) -> None:
    if (task.cancelled() or task.exception() is not None) and cache.get(key) is task:
        del cache[key]


def pick(cfg: dict, start: int) -> tuple[int, str, bytes] | None:
    lines = lines_of(cfg)
    for step in range(len(lines)):
        index = (start + step) % len(lines)
        task = cache.get(key_of(cfg, lines[index]))
        if task is not None and task.done() and not task.cancelled() and task.exception() is None and task.result():
            return index, lines[index], task.result()
    return None

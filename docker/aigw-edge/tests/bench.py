"""
CPU cost of the edge per concurrent session, with the fake model container (the GPU side costs nothing here, so what is
measured is the edge alone: Opus decode + resample in, Opus encode out, SRTP/DTLS, VAD, JSON events, HTTP to the models).

Every learner talks like a class: 1.2 s of speech every 5 s (the NPC answers each turn with ~3 s of audio), so both
directions carry audio most of the time. The edge's process CPU (user+sys, psutil) is sampled over a 20 s window once
all sessions are up; learners run in separate worker processes so their own Opus work does not share the edge's core.

    tests/run.sh bench [transport=webrtc|ws] [counts=1,4,8,16]      (RT_RTC_WORKERS=0 for one process; default 3)
"""

import asyncio
import json
import multiprocessing as mp
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

import aiohttp
import psutil

from clients import REPLICA_TOKEN, RtcLearner, WsLearner, mint

ROOT = Path(__file__).resolve().parents[1]
UP_PORT, EDGE_PORT = 8900, 8930
BASE = f"http://127.0.0.1:{EDGE_PORT}"
RUN_SECONDS = 34


def worker(count: int, transport: str, out: mp.Queue) -> None:
    async def run():
        learners = []
        for _ in range(count):
            learner = await (RtcLearner(BASE) if transport == "webrtc" else WsLearner(BASE)).connect(mint())
            learners.append(learner)
        end = time.monotonic() + RUN_SECONDS
        phase = 0
        while time.monotonic() < end:
            for i, learner in enumerate(learners):
                if (phase + i) % 5 == 0:
                    (learner.mic.say if transport == "webrtc" else learner.say)(1.2)
            phase += 1
            await asyncio.sleep(1)
        ttfa = [e["ttfa_ms"] for learner in learners for e in learner.events.of("metrics") if e.get("ttfa_ms")]
        out.put({"ttfa": ttfa, "turns": sum(len(learner.events.of("done")) for learner in learners)})
        for learner in learners:
            await learner.close()

    asyncio.run(run())


async def active() -> int:
    async with aiohttp.ClientSession() as http:
        async with http.get(f"{BASE}/__aigw/rt/status") as r:
            return (await r.json())["active"]


def measure(n: int, transport: str, edge: psutil.Process) -> dict:
    out: mp.Queue = mp.Queue()
    workers_n = min(n, 3)
    split = [n // workers_n + (1 if i < n % workers_n else 0) for i in range(workers_n)]
    procs = [mp.Process(target=worker, args=(k, transport, out)) for k in split]
    for p in procs:
        p.start()
    deadline = time.monotonic() + 30
    while asyncio.run(active()) < n and time.monotonic() < deadline:
        time.sleep(0.2)
    time.sleep(4)
    tree = [edge, *edge.children(recursive=True)]
    t0, c0 = time.monotonic(), {p.pid: sum(p.cpu_times()[:2]) for p in tree}
    rss = []
    for _ in range(20):
        time.sleep(1)
        rss.append(sum(p.memory_info().rss for p in tree))
    cpu_by = {p.pid: (sum(p.cpu_times()[:2]) - c0[p.pid]) / (time.monotonic() - t0) * 100 for p in tree}
    cpu = sum(cpu_by.values())
    results = [out.get(timeout=60) for _ in procs]
    for p in procs:
        p.join(timeout=10)
    ttfa = [t for r in results for t in r["ttfa"]]
    time.sleep(2)
    return {"sessions": n, "transport": transport, "edge_cpu_pct": round(cpu, 1), "cpu_pct_per_session": round(cpu / n, 2),
            "busiest_process_pct": round(max(cpu_by.values()), 1), "processes": len(tree),
            "edge_rss_mb": round(max(rss) / 2**20), "turns": sum(r["turns"] for r in results),
            "ttfa_ms_p50": statistics.median(ttfa) if ttfa else None, "ttfa_ms_max": max(ttfa) if ttfa else None}


def main() -> None:
    transport = sys.argv[1] if len(sys.argv) > 1 else "webrtc"
    counts = [int(c) for c in (sys.argv[2] if len(sys.argv) > 2 else "1,4,8,16").split(",")]
    up = subprocess.Popen([sys.executable, str(ROOT / "tests" / "fake_upstream.py"), "--port", str(UP_PORT)])
    env = {**os.environ, "RT_PORT": str(EDGE_PORT), "EDGE_UPSTREAM": f"http://127.0.0.1:{UP_PORT}", "AIGW_REPLICA_TOKEN": REPLICA_TOKEN,
           "AIGW_REPLICA_ID": "replica-1", "AIGW_DEPLOYMENT": "parle-speech", "RT_MAX_SESSIONS": "16",
           "RT_RTC_WORKERS": os.environ.get("RT_RTC_WORKERS", "3"), "EDGE_TELEMETRY_STDOUT": "0",
           "RT_UDP_PORTS": "50000-50200", "EDGE_STT_PARTIALS": "1"}
    edge_proc = subprocess.Popen([sys.executable, "-m", "aigw_edge"], cwd=ROOT, env=env)
    try:
        time.sleep(3)
        edge = psutil.Process(edge_proc.pid)
        print(f"host: {os.cpu_count()} vCPU, {psutil.cpu_freq().current if psutil.cpu_freq() else '?'} MHz", flush=True)
        for n in counts:
            row = measure(n, transport, edge)
            print(json.dumps(row), flush=True)
    finally:
        edge_proc.terminate()
        up.terminate()


if __name__ == "__main__":
    main()

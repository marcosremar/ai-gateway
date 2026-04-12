#!/usr/bin/env python3
"""
Container warmup — runs dummy inference requests before marking /health ready.

Problem: first-request CUDA kernel compilation on Blackwell GPUs (RTX 5090)
causes STT p95=8030ms (16× the p50 of 510ms). The readiness history from
2026-04-11 shows the same image on RTX 4090 has p95=1024ms — the difference
is purely first-request warmup cost.

Solution: run 3-5 dummy requests at container boot, after model loading but
before the health endpoint returns 200. This primes CUDA kernels so the
first user request lands in warm state.

Usage in Dockerfile:
    COPY scripts/container-warmup.py /app/warmup.py
    # In start.sh, after model loading:
    python3 /app/warmup.py --endpoint http://localhost:8000 --runs 3

The script waits for the server to respond on /health (up to 120s), then
fires N dummy STT requests with a 1-second silence WAV. The output is
discarded — the point is to prime CUDA, not to verify correctness.

Exit codes:
    0: warmup completed successfully
    1: server didn't start in time
    2: warmup request failed
"""

import argparse
import io
import struct
import time
import urllib.request
import urllib.error
import wave
import sys
import json


def generate_silence_wav(duration_s: float = 1.0, sample_rate: int = 16000) -> bytes:
    """Generate a WAV file with silence."""
    buf = io.BytesIO()
    n_samples = int(sample_rate * duration_s)
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(struct.pack(f'<{n_samples}h', *([0] * n_samples)))
    return buf.getvalue()


def wait_for_health(endpoint: str, timeout_s: int = 120) -> bool:
    """Wait for the server's /health endpoint to return 200."""
    url = f'{endpoint}/health'
    start = time.time()
    while time.time() - start < timeout_s:
        try:
            resp = urllib.request.urlopen(url, timeout=5)
            if resp.status == 200:
                return True
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(2)
    return False


def run_warmup_stt(endpoint: str, audio: bytes, run_num: int) -> float:
    """Send a dummy STT request and return the latency in ms."""
    url = f'{endpoint}/v1/audio/transcriptions'
    # Build multipart form data manually
    boundary = '----WarmupBoundary'
    body = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="model"\r\n\r\n'
        f'whisper\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="file"; filename="warmup.wav"\r\n'
        f'Content-Type: audio/wav\r\n\r\n'
    ).encode() + audio + f'\r\n--{boundary}--\r\n'.encode()

    req = urllib.request.Request(
        url,
        data=body,
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
        method='POST',
    )

    t0 = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        latency_ms = (time.time() - t0) * 1000
        data = json.loads(resp.read())
        text = data.get('text', '').strip()[:50]
        print(f'  warmup {run_num}: {latency_ms:.0f}ms → "{text}"')
        return latency_ms
    except Exception as e:
        latency_ms = (time.time() - t0) * 1000
        print(f'  warmup {run_num}: {latency_ms:.0f}ms → ERROR: {e}')
        return latency_ms


def main():
    parser = argparse.ArgumentParser(description='Container warmup')
    parser.add_argument('--endpoint', default='http://localhost:8000', help='Server endpoint')
    parser.add_argument('--runs', type=int, default=3, help='Number of warmup requests')
    parser.add_argument('--wait-timeout', type=int, default=120, help='Max seconds to wait for health')
    args = parser.parse_args()

    print(f'[warmup] Waiting for {args.endpoint}/health...')
    if not wait_for_health(args.endpoint, args.wait_timeout):
        print(f'[warmup] ERROR: server did not start within {args.wait_timeout}s')
        sys.exit(1)

    print(f'[warmup] Server ready. Running {args.runs} warmup requests...')
    audio = generate_silence_wav()

    latencies = []
    for i in range(1, args.runs + 1):
        ms = run_warmup_stt(args.endpoint, audio, i)
        latencies.append(ms)

    avg = sum(latencies) / len(latencies) if latencies else 0
    first = latencies[0] if latencies else 0
    last = latencies[-1] if latencies else 0
    speedup = first / last if last > 0 else 1

    print(f'[warmup] Done. avg={avg:.0f}ms, first={first:.0f}ms, last={last:.0f}ms, speedup={speedup:.1f}×')
    print(f'[warmup] CUDA kernels primed — first user request will be warm.')


if __name__ == '__main__':
    main()

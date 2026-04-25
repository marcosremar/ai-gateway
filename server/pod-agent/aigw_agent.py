#!/usr/bin/env python3
"""
ai-gateway pod agent — heartbeat daemon.

Provisionado pelo ai-gateway via SSH em cada pod (pod-provisioner.ts).
Roda em background, lê telemetria local e POSTa pro gateway a cada N segundos.

Sem deps externas — usa só stdlib pra não conflitar com o ambiente do modelo.

Env vars (passadas pelo install.sh):
  AIGW_URL          URL base do gateway (ex: https://gateway.example.com)
  AIGW_POD_ID       ID do pod (vast instance ID ou hostname)
  AIGW_TOKEN        bearer token pra autenticar
  AIGW_INTERVAL     segundos entre heartbeats (default 30)
  AIGW_LOG_FILE     caminho do log da app pra fazer tail (opcional)
  AIGW_LOG_LINES    quantas linhas de log mandar (default 20)
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

GATEWAY_URL = os.environ.get("AIGW_URL", "").rstrip("/")
POD_ID = os.environ.get("AIGW_POD_ID") or os.environ.get("VAST_CONTAINERLABEL") or socket.gethostname()
TOKEN = os.environ.get("AIGW_TOKEN", "")
INTERVAL = int(os.environ.get("AIGW_INTERVAL", "30"))
LOG_FILE = os.environ.get("AIGW_LOG_FILE", "/tmp/container.log")
LOG_LINES = int(os.environ.get("AIGW_LOG_LINES", "20"))
AGENT_LOG = "/var/log/aigw-agent/agent.log"

Path(AGENT_LOG).parent.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(AGENT_LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def gpu_stats() -> list[dict]:
    """nvidia-smi → lista de GPUs. Retorna [] se sem GPU."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return []
    gpus = []
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 7:
            continue
        try:
            gpus.append({
                "index": int(parts[0]),
                "name": parts[1],
                "util_pct": float(parts[2]),
                "mem_used_mb": float(parts[3]),
                "mem_total_mb": float(parts[4]),
                "temp_c": float(parts[5]),
                "power_w": float(parts[6]) if parts[6].replace(".", "").isdigit() else None,
            })
        except ValueError:
            pass
    return gpus


def memory_stats() -> dict:
    """/proc/meminfo → dict mais relevante."""
    info = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                key, _, rest = line.partition(":")
                val = rest.strip().split()[0]
                try:
                    info[key.strip()] = int(val) * 1024  # kB → bytes
                except ValueError:
                    pass
    except OSError:
        return {}
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable", info.get("MemFree", 0))
    return {
        "total_bytes": total,
        "available_bytes": available,
        "used_bytes": total - available,
        "used_pct": round((1 - available / total) * 100, 1) if total else 0,
    }


def disk_stats(paths: list[str]) -> dict:
    """statvfs() → uso de disco por mount."""
    out = {}
    for p in paths:
        try:
            s = os.statvfs(p)
            total = s.f_blocks * s.f_frsize
            free = s.f_bavail * s.f_frsize
            out[p] = {
                "total_bytes": total,
                "free_bytes": free,
                "used_pct": round((1 - free / total) * 100, 1) if total else 0,
            }
        except OSError:
            pass
    return out


def uptime_seconds() -> float:
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except OSError:
        return 0.0


def tail_log(path: str, n: int) -> list[str]:
    """Últimas N linhas — best-effort."""
    if not path or not os.path.exists(path):
        return []
    try:
        out = subprocess.run(
            ["tail", "-n", str(n), path],
            capture_output=True, text=True, timeout=2, check=False,
        ).stdout
        return out.strip().splitlines()
    except (subprocess.TimeoutExpired, OSError):
        return []


def active_ssh_sessions() -> int:
    """Conta sessões SSH estabelecidas na porta 22.

    Usado pelo gateway pra NÃO classificar o pod como idle enquanto tem alguém
    mexendo via SSH (instalando deps, debugando) — evita scale-down durante
    trabalho humano ativo.
    """
    try:
        out = subprocess.run(
            ["ss", "-tn", "state", "established", "( sport = :22 )"],
            capture_output=True, text=True, timeout=2, check=False,
        ).stdout
        lines = [ln for ln in out.strip().splitlines() if ln and not ln.startswith("Recv-Q")]
        return len(lines)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    # Fallback: /proc/net/tcp — parse manual (ss nem sempre está)
    try:
        count = 0
        with open("/proc/net/tcp") as f:
            next(f, None)  # skip header
            for line in f:
                parts = line.split()
                if len(parts) < 4:
                    continue
                # local_addr hex :hex_port; 22 = 0x16
                local = parts[1]
                state = parts[3]  # 01 = established
                if state == "01" and local.endswith(":0016"):
                    count += 1
        return count
    except OSError:
        return 0


def collect() -> dict:
    return {
        "pod_id": POD_ID,
        "ts": time.time(),
        "uptime_s": uptime_seconds(),
        "hostname": socket.gethostname(),
        "active_ssh_sessions": active_ssh_sessions(),
        "gpus": gpu_stats(),
        "memory": memory_stats(),
        "disk": disk_stats(["/", "/workspace"]),
        "log_tail": tail_log(LOG_FILE, LOG_LINES),
    }


def send(payload: dict) -> bool:
    if not GATEWAY_URL:
        return False
    url = f"{GATEWAY_URL}/v1/agent/heartbeat"
    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, socket.timeout) as e:
        log(f"heartbeat failed: {e}")
        return False


def main() -> int:
    if not GATEWAY_URL:
        log("AIGW_URL not set — agent exiting (no gateway to report to)")
        return 0
    log(f"agent starting — pod={POD_ID} url={GATEWAY_URL} interval={INTERVAL}s")
    consecutive_failures = 0
    while True:
        try:
            payload = collect()
            ok = send(payload)
            if ok:
                consecutive_failures = 0
            else:
                consecutive_failures += 1
                if consecutive_failures % 10 == 1:
                    log(f"heartbeat failing for {consecutive_failures} cycles")
        except Exception as e:
            log(f"collect/send loop error: {e}")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    sys.exit(main())

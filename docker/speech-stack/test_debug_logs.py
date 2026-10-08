"""Unit test of GET /debug/logs (no GPU): python3 docker/speech-stack/test_debug_logs.py"""
import asyncio
import ipaddress
import os
import re
import tempfile
from pathlib import Path
from types import SimpleNamespace

src = Path(__file__).with_name("server.py").read_text()
os.environ["REPLICA_API_KEY"] = "s3cr3t-value-from-env"


class Refused(Exception):
    def __init__(self, status, detail):
        self.status = status


class App:
    def get(self, _path):
        return lambda fn: fn


ns: dict = {"asyncio": asyncio, "ipaddress": ipaddress, "os": os, "re": re, "Path": Path, "app": App(), "Request": object,
            "HTTPException": Refused, "PlainTextResponse": lambda text: text}
exec(src[src.index("# ── Engine logs"):src.index('@app.get("/health")')], ns)

logs = Path(tempfile.mkdtemp())
ns["LOG_DIR"] = logs
(logs / "tts.log.1").write_text("old 1\nold 2\n")
(logs / "tts.log").write_text("\n".join(
    [f"line {i}" for i in range(5000)]
    + ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "env s3cr3t-value-from-env end", 'HF_TOKEN="hf_abcdefghijklmnopqrstuv"',
       "x" * 5000, "[SpeechE2E] request_id=speech-1 status=error error=budget (192/192 codec tokens) max_tokens=192"]) + "\n")


def call(host, **query):
    return asyncio.run(ns["debug_logs"](SimpleNamespace(client=SimpleNamespace(host=host)), **query))


def refused(host, **query):
    try:
        call(host, **query)
    except Refused as error:
        return error.status
    return None


assert refused("51.15.20.7") == 403 and refused(None) == 403 and refused("not-an-ip") == 403
assert refused("172.17.0.1", engine="../etc/passwd") == 400 and refused("127.0.0.1", engine="ctl") == 400
out = call("172.17.0.1", engine="tts", tail=10**9).splitlines()
assert len(out) == ns["LOG_MAX_TAIL"], len(out)
assert len(call("127.0.0.1", tail=-5).splitlines()) == 1
text = "\n".join(out)
assert "abcdefghijklmnopqrstuvwxyz012345" not in text and "s3cr3t-value-from-env" not in text and "hf_abcdefghij" not in text
assert "Bearer [redacted]" in text and max(len(line) for line in out) == ns["LOG_MAX_LINE"]
assert out[-1].endswith("(192/192 codec tokens) max_tokens=192"), out[-1]
assert call("127.0.0.1", match="old").splitlines() == ["old 1", "old 2"]
assert call("127.0.0.1", engine="llm") == "\n"
print("ok: /debug/logs refuses a public client and an unknown engine, caps the tail and the line, scrubs secrets, reads the rotated file")

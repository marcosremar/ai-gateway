import asyncio
import json
import time
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

src = Path(__file__).with_name("server.py").read_text()
GAP, DEADLINE, STEP = 0.4, 1.5, 0.05
DELTAS = [f'data: {{"choices": [{{"delta": {{"content": "t{i} "}}}}]}}\n\n'.encode() for i in range(6)]
SSE = DELTAS + [b"data: [DONE]\n\n"]
PCM = [bytes([i]) * 2400 for i in range(6)]


async def engine(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    head = await reader.readuntil(b"\r\n\r\n")
    length = int(next(line.split(b":")[1] for line in head.split(b"\r\n") if line.lower().startswith(b"content-length")))
    body = json.loads(await reader.readexactly(length))
    mode, chunks = body.get("mode"), SSE if b"/chat/" in head else PCM
    kind = b"text/event-stream" if b"/chat/" in head else b"audio/pcm"

    async def send(chunk: bytes):
        writer.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
        await writer.drain()
    try:
        if mode == "silent":
            await asyncio.sleep(30)
        if mode == "whole":
            await asyncio.sleep(GAP * 2)
            answer = b'{"choices": [{"message": {"content": "oi"}}]}'
            writer.write(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: %d\r\n\r\n%s" % (len(answer), answer))
            return
        writer.write(b"HTTP/1.1 200 OK\r\ncontent-type: " + kind + b"\r\ntransfer-encoding: chunked\r\n\r\n")
        for i in range(600 if mode == "endless" else len(chunks)):
            await send(chunks[i % len(chunks)])
            await asyncio.sleep(STEP)
            if i == 2 and mode == "break":
                return
            if i == 2 and mode == "stall":
                await asyncio.sleep(30)
        writer.write(b"0\r\n\r\n")
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def call(http: httpx.AsyncClient, path: str, mode: str | None = None, stream: bool = True):
    started = time.perf_counter()
    got, arrivals, error, status = b"", [], None, None
    try:
        async with http.stream("POST", path, json={"stream": stream, "mode": mode}) as res:
            status = res.status_code
            async for chunk in res.aiter_raw():
                got += chunk
                arrivals.append(time.perf_counter() - started)
    except httpx.HTTPError as raised:
        error = raised
    return status, got, arrivals, error, time.perf_counter() - started


def last_event(body: bytes) -> dict:
    return json.loads(body.strip().split(b"\n\n")[-1][6:])


async def main():
    fake = await asyncio.start_server(engine, "127.0.0.1", 0)
    engine_url = f"http://127.0.0.1:{fake.sockets[0].getsockname()[1]}"
    app = FastAPI()
    ns: dict = {"app": app, "Request": Request, "StreamingResponse": StreamingResponse, "JSONResponse": JSONResponse,
                "asyncio": asyncio, "json": json, "time": time, "httpx": httpx, "LLM_URL": engine_url, "TTS_URL": engine_url,
                "client": httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=5.0)),
                "PROXY_MAX_GAP_S": GAP, "PROXY_DEADLINE_S": DEADLINE,
                "proxied": {stage: {"started": 0, "done": 0, "failed": 0, "stalled": 0} for stage in ("chat", "speech")}}
    exec(src[src.index("def wants_stream("):src.index('@app.get("/refs/{name}")')], ns)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="critical"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    chat, speech = "/v1/chat/completions", "/v1/audio/speech"
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=20) as http:
        for path, whole in ((chat, b"".join(SSE)), (speech, b"".join(PCM))):
            status, got, arrivals, error, _ = await call(http, path)
            assert status == 200 and error is None and got == whole, (path, status, error, got[-80:])
            assert arrivals[-1] - arrivals[0] >= STEP * 3 and arrivals[0] < STEP * 3, (path, arrivals)

        status, got, _, error, _ = await call(http, chat, "break")
        assert error is None and got.startswith(b"".join(DELTAS[:3])) and b"[DONE]" not in got, (error, got)
        assert last_event(got)["error"]["code"] == "stage_failed", got
        status, got, _, error, took = await call(http, chat, "stall")
        assert error is None and last_event(got)["error"]["code"] == "upstream_stalled" and took < GAP + 1, (error, got, took)
        assert "no data for" in last_event(got)["error"]["message"], got

        status, got, _, error, _ = await call(http, speech, "break")
        assert isinstance(error, httpx.RemoteProtocolError) and got == b"".join(PCM[:3]), (error, len(got))
        status, got, _, error, took = await call(http, speech, "stall")
        assert isinstance(error, httpx.RemoteProtocolError) and got == b"".join(PCM[:3]) and took < GAP + 1, (error, len(got), took)

        status, got, _, error, took = await call(http, chat, "endless")
        assert error is None and "request longer than" in last_event(got)["error"]["message"], got[-200:]
        assert DEADLINE <= took < DEADLINE + 1, took
        status, got, _, error, took = await call(http, speech, "endless")
        assert isinstance(error, httpx.RemoteProtocolError) and DEADLINE <= took < DEADLINE + 1, (error, took)

        status, got, _, error, took = await call(http, speech, "silent")
        assert status == 504 and json.loads(got)["error"]["code"] == "upstream_stalled" and took < GAP + 1, (status, got, took)
        status, got, _, error, took = await call(http, chat, "whole", stream=False)
        assert status == 200 and error is None and json.loads(got)["choices"][0]["message"]["content"] == "oi", (status, got)
        status, got, _, error, took = await call(http, chat, "silent", stream=False)
        assert status == 504 and "request longer than" in json.loads(got)["error"]["message"] and took >= DEADLINE, (status, got)
        fake.close()
        ns["LLM_URL"] = "http://127.0.0.1:9"
        status, got, _, error, _ = await call(http, chat)
        assert status == 502 and json.loads(got)["error"]["code"] == "stage_failed", (status, got)

    assert ns["proxied"] == {"chat": {"started": 7, "done": 2, "failed": 2, "stalled": 3},
                             "speech": {"started": 5, "done": 1, "failed": 1, "stalled": 3}}, ns["proxied"]
    server.should_exit = True
    await serving
    print("ok: a healthy proxied stream is untouched and arrives as produced; a break, a stall or an overlong request"
          " ends chat with an SSE error event and speech with an aborted connection, and each is counted")


asyncio.run(main())

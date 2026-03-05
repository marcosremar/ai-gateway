/**
 * Reusable Python WebSocket benchmark client.
 *
 * Usage:
 *   python3 script.py <audio_path> [ws_url]
 *
 * - SSH mode (no ws_url): connects to ws://localhost:8000/ws/stream (on cluster)
 * - Direct mode (ws_url provided): connects to given public WebSocket URL
 *
 * Used by:
 *  - src/app/api/users/benchmark-ws/route.ts (API endpoint)
 *  - __tests__/integration/helpers.ts (test suite)
 *
 * Output JSON:
 *  { ok, connect_ms, ttfa_ms, total_ms, chunks,
 *    stt_ms, llm_ms, tts_ms, transcript, response }
 */
export const WS_CLIENT_PY = `
import asyncio, time, json, sys, subprocess

try:
    import websockets
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "websockets"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import websockets

async def run(audio_path, ws_url):
    try:
        t0 = time.time()
        async with websockets.connect(
            ws_url,
            open_timeout=10,
            close_timeout=5,
        ) as ws:
            connect_ms = int((time.time() - t0) * 1000)
            with open(audio_path, "rb") as f:
                audio = f.read()
            t1 = time.time()
            await ws.send(audio)
            chunks = 0
            ttfa_ms = None
            stt_ms = None
            llm_ms = None
            tts_ms = None
            transcript = ""
            response = ""
            completed = False
            timed_out = False
            while True:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=20)
                    if isinstance(msg, (bytes, bytearray)) and len(msg) > 0:
                        chunks += 1
                        if ttfa_ms is None:
                            ttfa_ms = int((time.time() - t1) * 1000)
                    elif isinstance(msg, str):
                        data = json.loads(msg)
                        stage = data.get("stage", data.get("status", ""))
                        if stage == "stt":
                            transcript = data.get("transcript", data.get("text", ""))
                            stt_ms = data.get("stt_ms")
                        elif stage == "llm":
                            response = data.get("response", "")
                            llm_ms = data.get("llm_ms")
                        elif stage == "tts":
                            tts_ms = data.get("tts_ms")
                        elif stage == "complete" or data.get("status") == "complete":
                            timing = data.get("timing", {})
                            stt_ms = stt_ms or timing.get("stt_ms")
                            llm_ms = llm_ms or timing.get("llm_ms")
                            tts_ms = tts_ms or timing.get("tts_ms")
                            response = response or data.get("response", "")
                            transcript = transcript or data.get("transcript", "")
                            completed = True
                            break
                except asyncio.TimeoutError:
                    timed_out = True
                    break
                except Exception:
                    break
            total_ms = int((time.time() - t1) * 1000)
            ok = completed or chunks > 0
            error = ("Timeout: servidor nao respondeu em 20s" if timed_out and not ok else None)
            print(json.dumps({
                "ok": ok,
                **({"error": error} if error else {}),
                "connect_ms": connect_ms,
                "ttfa_ms": ttfa_ms,
                "total_ms": total_ms,
                "chunks": chunks,
                "stt_ms": stt_ms,
                "llm_ms": llm_ms,
                "tts_ms": tts_ms,
                "transcript": transcript,
                "response": response,
            }))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))

ws_url = sys.argv[2] if len(sys.argv) > 2 else "ws://localhost:8000/ws/stream"
asyncio.run(run(sys.argv[1], ws_url))
`.trim();

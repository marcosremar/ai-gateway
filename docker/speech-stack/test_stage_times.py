"""Unit test of the per-stage metrics (no GPU): python3 docker/speech-stack/test_stage_times.py"""
import json
from pathlib import Path

src = Path(__file__).with_name("server.py").read_text()
ns: dict = {"json": json}
exec(src[src.index("LLM_TIMINGS ="):src.index("async def llm_stream")], ns)
llm_chunk, stage_times = ns["llm_chunk"], ns["stage_times"]

timings: dict = {}
assert llm_chunk("", timings) is None and llm_chunk(": keep-alive", timings) is None and llm_chunk("data: [DONE]", timings) is None
first = {"choices": [{"delta": {"content": "Bom"}}],
         "timings": {"cache_n": 236, "prompt_n": 12, "prompt_ms": 30.9, "predicted_n": 1, "predicted_ms": 18.8, "prompt_per_second": 388.0}}
assert llm_chunk("data: " + json.dumps(first), timings) == "Bom"
assert timings == {"cache_n": 236, "prompt_n": 12, "prompt_ms": 30.9, "predicted_n": 1, "predicted_ms": 18.8}
assert llm_chunk('data: {"choices": [{"delta": {"role": "assistant", "content": null}}]}', timings) is None
assert llm_chunk('data: {"choices": [{"delta": {}, "finish_reason": "stop"}], "timings": {"predicted_n": 35}}', timings) is None
assert llm_chunk('data: {"choices": [], "usage": {"total_tokens": 9}}', timings) is None
assert timings["predicted_n"] == 35 and timings["cache_n"] == 236

heard = {"text": "segredo", "ms": 240, "audio_ms": 1, "queue_ms": 4, "decode_ms": 230, "batch": 2, "no_speech_prob": 0.01}
stages = stage_times(heard, 245, 300, 390, 560, timings)
assert stages == {"stt_audio_ms": 1, "stt_queue_ms": 4, "stt_decode_ms": 230, "stt_batch": 2, "llm_first_token_ms": 55,
                  "llm_cache_n": 236, "llm_prompt_n": 12, "llm_prompt_ms": 30.9, "llm_predicted_n": 35, "llm_predicted_ms": 18.8,
                  "text_wait_ms": 90, "tts_first_chunk_ms": 170}, stages
assert all(isinstance(v, (int, float)) for v in stages.values())
silent = stage_times({"text": "", "ms": 9}, 10, None, None, None, {})
assert silent == {"llm_first_token_ms": None, "text_wait_ms": None, "tts_first_chunk_ms": None}
print("stage times: ok")

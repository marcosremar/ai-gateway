"""
BabelCast Subtitle Server: Portuguese Whisper STT + Gemma bridge.

Endpoints:
  GET  /health
  GET  /version
  POST /v1/transcribe
  POST /v1/audio/transcriptions
  POST /v1/audio/encoder
  POST /v1/translate/text
  POST /v1/chat/completions
  POST /v1/chain/pipeline
  POST /v1/chain/llm
"""

import asyncio
import base64
import json
import logging
import os
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("babelcast-subtitle")


# -- Config ------------------------------------------------------------------

FALSE_VALUES = {"0", "false", "no", "off", ""}


def _bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in FALSE_VALUES


COMPUTE_TYPE = os.environ.get("COMPUTE_TYPE", "float16")
STT_MODEL = os.environ.get("STT_MODEL", "yuriyvnv/whisper-large-v3-cv-capes-filtered-pt")
STT_BACKEND = os.environ.get("STT_BACKEND", "auto").strip().lower()
STT_LANGUAGE = os.environ.get("STT_LANGUAGE", "pt")
STT_CHUNK_LENGTH_S = float(os.environ.get("STT_CHUNK_LENGTH_S", "30"))
LLM_MODEL = os.environ.get("LLM_MODEL", "google/translate-gemma-12b-it")
SERVICE_ROLE = os.environ.get("SERVICE_ROLE", "all").strip().lower()
CHAIN_HTTP_TIMEOUT_S = float(os.environ.get("CHAIN_HTTP_TIMEOUT_S", "120"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

ENABLE_STT = _bool_env("ENABLE_STT", SERVICE_ROLE in {"all", "stt", "chain", "stt-llm"})
ENABLE_LLM = _bool_env("ENABLE_LLM", SERVICE_ROLE in {"all", "llm", "chain", "stt-llm"})


# -- Global model state ------------------------------------------------------

stt_model = None
stt_processor = None
stt_pipe = None
stt_backend = None
llm_model = None
llm_tokenizer = None
boot_time = time.time()

service_status = {
    "whisper": "pending" if ENABLE_STT else "disabled",
    "llm": "pending" if ENABLE_LLM else "disabled",
}


def _detect_compute_type() -> str:
    """Auto-detect optimal compute type based on GPU architecture."""
    if DEVICE != "cuda":
        return "float32"
    cap = torch.cuda.get_device_capability()
    arch = cap[0] * 10 + cap[1]
    if arch >= 120:
        # Blackwell (sm_120): INT8 tensor cores have kernel issues, use float16.
        log.info(f"Detected Blackwell GPU (sm_{arch}); using float16")
        return "float16"
    if COMPUTE_TYPE != "float16":
        return COMPUTE_TYPE
    return "float16"


def _torch_dtype() -> torch.dtype:
    if DEVICE != "cuda":
        return torch.float32
    compute_type = _detect_compute_type()
    if compute_type == "bfloat16":
        return torch.bfloat16
    return torch.float16


def _should_use_faster_whisper() -> bool:
    if STT_BACKEND in {"faster", "faster-whisper"}:
        return True
    if STT_BACKEND in {"hf", "huggingface", "transformers"}:
        return False
    return "/" not in STT_MODEL


def _model_device(model: Any) -> torch.device:
    device = getattr(model, "device", None)
    if device is not None:
        return torch.device(device)
    return next(model.parameters()).device


async def _load_models():
    """Load selected STT and LLM models in the background."""
    global stt_model, stt_processor, stt_pipe, stt_backend, llm_model, llm_tokenizer

    if ENABLE_STT:
        try:
            if _should_use_faster_whisper():
                stt_backend = "faster-whisper"
                service_status["whisper"] = "downloading"
                log.info(f"Loading Faster Whisper ({STT_MODEL}) on {DEVICE} with {_detect_compute_type()}...")
                from faster_whisper import WhisperModel

                stt_model = WhisperModel(
                    STT_MODEL,
                    device=DEVICE,
                    compute_type=_detect_compute_type(),
                )
            else:
                stt_backend = "transformers"
                service_status["whisper"] = "downloading"
                log.info(f"Loading Transformers Whisper ({STT_MODEL}) on {DEVICE}...")
                from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

                dtype = _torch_dtype()
                stt_processor = AutoProcessor.from_pretrained(STT_MODEL)
                stt_model = AutoModelForSpeechSeq2Seq.from_pretrained(
                    STT_MODEL,
                    torch_dtype=dtype,
                    low_cpu_mem_usage=True,
                    use_safetensors=True,
                )
                stt_model.to(DEVICE)
                if hasattr(stt_model, "generation_config"):
                    stt_model.generation_config.language = STT_LANGUAGE
                    stt_model.generation_config.task = "transcribe"
                stt_pipe = pipeline(
                    "automatic-speech-recognition",
                    model=stt_model,
                    tokenizer=stt_processor.tokenizer,
                    feature_extractor=stt_processor.feature_extractor,
                    torch_dtype=dtype,
                    device=0 if DEVICE == "cuda" else -1,
                )
            service_status["whisper"] = "loaded"
            log.info(f"STT ready ({STT_MODEL}, backend={stt_backend})")
        except Exception as e:
            service_status["whisper"] = f"error: {e}"
            log.error(f"STT load failed: {e}")

    if ENABLE_LLM:
        try:
            service_status["llm"] = "downloading"
            log.info(f"Loading {LLM_MODEL} on {DEVICE}...")
            from transformers import AutoModelForCausalLM, AutoTokenizer

            llm_tokenizer = AutoTokenizer.from_pretrained(LLM_MODEL)
            model_kwargs: dict[str, Any] = {"torch_dtype": _torch_dtype()}
            if DEVICE == "cuda":
                model_kwargs["device_map"] = "auto"
            llm_model = AutoModelForCausalLM.from_pretrained(LLM_MODEL, **model_kwargs)
            if DEVICE != "cuda":
                llm_model.to(DEVICE)
            service_status["llm"] = "loaded"
            log.info(f"LLM ready ({LLM_MODEL})")
        except Exception as e:
            service_status["llm"] = f"error: {e}"
            log.error(f"LLM load failed: {e}")


def _load_models_sync():
    asyncio.run(_load_models())


# -- App ---------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(asyncio.to_thread(_load_models_sync))
    yield


app = FastAPI(title="BabelCast Subtitle", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "uptime": round(time.time() - boot_time, 1),
        "device": DEVICE,
        "gpu": torch.cuda.get_device_name(0) if DEVICE == "cuda" else None,
        "compute_type": _detect_compute_type(),
        "service_role": SERVICE_ROLE,
        "enabled": {"stt": ENABLE_STT, "llm": ENABLE_LLM},
        "services": service_status,
        "model_warmth": {
            "stt": {"warm": service_status["whisper"] == "loaded"},
            "llm": {"warm": service_status["llm"] == "loaded"},
        },
    }


@app.get("/version")
async def version():
    cap = torch.cuda.get_device_capability() if DEVICE == "cuda" else (0, 0)
    return {
        "version": "subtitle-1.1",
        "type": "subtitle-chain",
        "cuda_arch": f"sm_{cap[0] * 10 + cap[1]}",
        "compute_type": _detect_compute_type(),
        "service_role": SERVICE_ROLE,
        "models": {"stt": STT_MODEL, "stt_backend": stt_backend, "llm": LLM_MODEL},
    }


# -- Shared helpers ----------------------------------------------------------

def _json_error(status_code: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": message})


def _suffix_from_name(filename: str | None) -> str:
    if not filename or "." not in filename:
        return ".wav"
    suffix = os.path.splitext(filename)[1].lower()
    if len(suffix) > 12 or "/" in suffix or "\\" in suffix:
        return ".wav"
    return suffix or ".wav"


def _audio_duration_seconds(audio_path: str) -> float | None:
    try:
        import soundfile as sf

        info = sf.info(audio_path)
        if info.samplerate:
            return round(info.frames / info.samplerate, 3)
    except Exception:
        return None
    return None


def _transcribe_audio_file(audio_path: str, language: str | None = None) -> dict[str, Any]:
    if stt_model is None:
        raise RuntimeError("STT model not loaded yet")

    lang = language or STT_LANGUAGE
    t0 = time.time()

    if stt_backend == "faster-whisper":
        segments, info = stt_model.transcribe(
            audio_path,
            language=lang,
            beam_size=1,
            vad_filter=True,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        latency_ms = round((time.time() - t0) * 1000)
        return {
            "text": text,
            "language": info.language,
            "language_probability": round(info.language_probability, 3)
            if info.language_probability is not None else None,
            "duration": round(info.duration, 2) if info.duration is not None else None,
            "latency_ms": latency_ms,
            "backend": stt_backend,
            "model": STT_MODEL,
        }

    if stt_pipe is None:
        raise RuntimeError("Transformers STT pipeline not loaded yet")

    generate_kwargs: dict[str, Any] = {"task": "transcribe"}
    if lang:
        generate_kwargs["language"] = lang
    pipe_kwargs: dict[str, Any] = {
        "generate_kwargs": generate_kwargs,
        "return_timestamps": False,
    }
    if STT_CHUNK_LENGTH_S > 0:
        pipe_kwargs["chunk_length_s"] = STT_CHUNK_LENGTH_S

    result = stt_pipe(audio_path, **pipe_kwargs)
    latency_ms = round((time.time() - t0) * 1000)
    return {
        "text": str(result.get("text", "")).strip(),
        "language": lang,
        "language_probability": None,
        "duration": _audio_duration_seconds(audio_path),
        "latency_ms": latency_ms,
        "backend": stt_backend,
        "model": STT_MODEL,
    }


def _encode_audio_file(
    audio_path: str,
    return_pooled: bool,
    return_hidden_b64: bool,
) -> dict[str, Any]:
    if stt_model is None or stt_processor is None or stt_backend != "transformers":
        raise RuntimeError("Encoder output requires STT_BACKEND=transformers with a Hugging Face Whisper model")

    import librosa

    t0 = time.time()
    audio, _ = librosa.load(audio_path, sr=16000, mono=True)
    inputs = stt_processor(audio, sampling_rate=16000, return_tensors="pt")
    input_features = inputs.input_features.to(device=_model_device(stt_model), dtype=_torch_dtype())

    with torch.no_grad():
        hidden = stt_model.get_encoder()(input_features).last_hidden_state

    hidden_cpu = hidden.squeeze(0).float().cpu()
    latency_ms = round((time.time() - t0) * 1000)
    response: dict[str, Any] = {
        "model": STT_MODEL,
        "backend": stt_backend,
        "sample_rate": 16000,
        "audio_seconds": round(len(audio) / 16000, 3),
        "encoder_window_seconds": 30.0,
        "shape": list(hidden.shape),
        "dtype": str(hidden.dtype).replace("torch.", ""),
        "latency_ms": latency_ms,
    }

    if return_pooled:
        response["pooled"] = hidden_cpu.mean(dim=0).tolist()

    if return_hidden_b64:
        hidden_f16 = hidden.squeeze(0).detach().cpu().to(torch.float16).numpy()
        response["hidden_b64"] = base64.b64encode(hidden_f16.tobytes()).decode("ascii")
        response["hidden_dtype"] = "float16"
        response["hidden_shape"] = list(hidden_f16.shape)

    return response


def _llm_device() -> torch.device:
    if llm_model is None:
        return torch.device("cpu")
    return _model_device(llm_model)


def _generate_text(prompt: str, max_new_tokens: int = 512, temperature: float = 0.0) -> tuple[str, dict[str, int]]:
    if llm_model is None or llm_tokenizer is None:
        raise RuntimeError("LLM model not loaded yet")

    encoded = llm_tokenizer(prompt, return_tensors="pt")
    device = _llm_device()
    inputs = {key: value.to(device) for key, value in encoded.items()}

    generate_kwargs: dict[str, Any] = {
        "max_new_tokens": max_new_tokens,
        "do_sample": temperature > 0,
    }
    if temperature > 0:
        generate_kwargs["temperature"] = temperature
    if llm_tokenizer.eos_token_id is not None:
        generate_kwargs["pad_token_id"] = llm_tokenizer.eos_token_id

    t0 = time.time()
    with torch.no_grad():
        outputs = llm_model.generate(**inputs, **generate_kwargs)
    latency_ms = round((time.time() - t0) * 1000)

    prompt_tokens = inputs["input_ids"].shape[1]
    response_text = llm_tokenizer.decode(outputs[0][prompt_tokens:], skip_special_tokens=True).strip()
    completion_tokens = len(outputs[0]) - prompt_tokens
    return response_text, {
        "latency_ms": latency_ms,
        "prompt_tokens": int(prompt_tokens),
        "completion_tokens": int(completion_tokens),
    }


def _chain_prompt(transcription: str, chain: dict[str, Any]) -> str:
    source_lang = chain.get("source_lang") or STT_LANGUAGE
    target_lang = chain.get("target_lang") or source_lang
    system_prompt = (chain.get("system_prompt") or "").strip()
    if system_prompt:
        return (
            f"{system_prompt}\n\n"
            f"Input transcript ({source_lang}): {transcription}\n"
            f"Response ({target_lang}):"
        )
    return f"Translate from {source_lang} to {target_lang}: {transcription}"


def _join_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}{path}"


def _post_json(url: str, payload: dict[str, Any], timeout_s: float = CHAIN_HTTP_TIMEOUT_S) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{url} returned {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"{url} unreachable: {e.reason}") from e


def _run_chain_llm_local(transcription: str, chain: dict[str, Any]) -> dict[str, Any]:
    prompt = _chain_prompt(transcription, chain)
    response_text, stats = _generate_text(
        prompt,
        max_new_tokens=int(chain.get("max_new_tokens") or 512),
        temperature=float(chain.get("temperature") or 0.0),
    )
    result: dict[str, Any] = {
        "response": response_text,
        "timing": {"llm_ms": stats["latency_ms"]},
    }

    tts_url = (chain.get("tts_url") or "").strip()
    if tts_url:
        tts_result = _post_json(
            _join_url(tts_url, "/v1/chain/tts"),
            {"text": response_text, "chain": chain, "speaker": chain.get("speaker")},
        )
        result["audio_base64"] = tts_result.get("audio_base64", "")
        result["content_type"] = tts_result.get("content_type", "audio/wav")
        result["timing"].update(tts_result.get("timing", {}))

    return result


# -- STT endpoints -----------------------------------------------------------

@app.post("/v1/transcribe")
@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form(None),
    model: str = Form(None),
):
    del model
    if stt_model is None:
        return _json_error(503, "STT model not loaded yet")

    audio_bytes = await file.read()
    with tempfile.NamedTemporaryFile(suffix=_suffix_from_name(file.filename), delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        try:
            return _transcribe_audio_file(tmp.name, language)
        except RuntimeError as e:
            return _json_error(503, str(e))


@app.post("/v1/audio/encoder")
async def audio_encoder(
    file: UploadFile = File(...),
    return_pooled: bool = Form(True),
    return_hidden_b64: bool = Form(False),
):
    if stt_model is None:
        return _json_error(503, "STT model not loaded yet")

    audio_bytes = await file.read()
    with tempfile.NamedTemporaryFile(suffix=_suffix_from_name(file.filename), delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        try:
            return _encode_audio_file(tmp.name, return_pooled, return_hidden_b64)
        except RuntimeError as e:
            return _json_error(400, str(e))


# -- LLM endpoints -----------------------------------------------------------

@app.post("/v1/translate/text")
async def translate_text(request: Request):
    if llm_model is None or llm_tokenizer is None:
        return _json_error(503, "LLM model not loaded yet")

    body = await request.json()
    text = body.get("text", "")
    source_lang = body.get("source_lang", "en")
    target_lang = body.get("target_lang", "es")

    prompt = f"Translate from {source_lang} to {target_lang}: {text}"
    translated, stats = _generate_text(
        prompt,
        max_new_tokens=int(body.get("max_new_tokens") or 512),
        temperature=float(body.get("temperature") or 0.0),
    )

    return {
        "translated_text": translated,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "latency_ms": stats["latency_ms"],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    if llm_model is None or llm_tokenizer is None:
        return _json_error(503, "LLM model not loaded yet")

    body = await request.json()
    messages = body.get("messages", [])

    prompt_parts = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        prompt_parts.append(f"{role}: {content}")
    prompt = "\n".join(prompt_parts)

    response_text, stats = _generate_text(
        prompt,
        max_new_tokens=int(body.get("max_tokens") or 512),
        temperature=float(body.get("temperature") or 0.0),
    )

    return {
        "id": f"chatcmpl-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": LLM_MODEL,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": response_text},
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": stats["prompt_tokens"],
            "completion_tokens": stats["completion_tokens"],
        },
        "latency_ms": stats["latency_ms"],
    }


# -- Chain endpoints ---------------------------------------------------------

@app.post("/v1/chain/pipeline")
async def chain_pipeline(request: Request):
    if stt_model is None:
        return _json_error(503, "STT model not loaded yet")

    body = await request.json()
    chain = body.get("chain") or {}
    audio_b64 = body.get("audio_b64") or ""
    if not audio_b64:
        return _json_error(400, "audio_b64 is required")

    try:
        audio_bytes = base64.b64decode(audio_b64, validate=True)
    except Exception as e:
        return _json_error(400, f"invalid audio_b64: {e}")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        try:
            stt_result = _transcribe_audio_file(tmp.name, chain.get("source_lang") or STT_LANGUAGE)
        except RuntimeError as e:
            return _json_error(503, str(e))

    timing = {"stt_ms": stt_result["latency_ms"]}
    llm_url = (chain.get("llm_url") or "").strip()
    try:
        if llm_url:
            llm_result = _post_json(
                _join_url(llm_url, "/v1/chain/llm"),
                {"transcription": stt_result["text"], "chain": chain},
            )
        else:
            llm_result = _run_chain_llm_local(stt_result["text"], chain)
    except RuntimeError as e:
        return _json_error(503, str(e))

    timing.update(llm_result.get("timing", {}))
    return {
        "transcription": stt_result["text"],
        "response": llm_result.get("response", ""),
        "audio_base64": llm_result.get("audio_base64", ""),
        "content_type": llm_result.get("content_type", "audio/wav"),
        "timing": timing,
        "stt": {
            "language": stt_result.get("language"),
            "duration": stt_result.get("duration"),
            "model": stt_result.get("model"),
            "backend": stt_result.get("backend"),
        },
    }


@app.post("/v1/chain/llm")
async def chain_llm(request: Request):
    if llm_model is None or llm_tokenizer is None:
        return _json_error(503, "LLM model not loaded yet")

    body = await request.json()
    chain = body.get("chain") or {}
    transcription = (body.get("transcription") or body.get("text") or "").strip()
    if not transcription:
        return _json_error(400, "transcription is required")

    try:
        return _run_chain_llm_local(transcription, chain)
    except RuntimeError as e:
        return _json_error(503, str(e))


# -- Main --------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    log.info(f"Starting BabelCast Subtitle server on :{port}")
    log.info(f"Service role: {SERVICE_ROLE}; STT={ENABLE_STT}; LLM={ENABLE_LLM}")
    if DEVICE == "cuda":
        log.info(f"GPU: {torch.cuda.get_device_name(0)}")
        cap = torch.cuda.get_device_capability()
        log.info(f"CUDA arch: sm_{cap[0] * 10 + cap[1]}, compute_type: {_detect_compute_type()}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")

# One image, three models, streamed speech-to-speech (see server.py). Models are baked in: a cold start pulls from the
# registry next to the GPU instead of downloading from Hugging Face at boot (a boot-time HF download failed on a real
# L4 on 2026-10-04).
ARG LLAMA_TAG=server-cuda-b11382
ARG LLAMA_DIGEST=sha256:ef08b5a98b1170f2b62177be0a4027c88a84043c55afbf190dd18b9e7cdcfebf
ARG EDGE_TAG=ed885ef5
ARG EDGE_DIGEST=sha256:5c67faa165a3fdb00d4d2157229a2b981bbcc6efe1e7b2f7f6349f96998da209
FROM ghcr.io/ggml-org/llama.cpp:${LLAMA_TAG}@${LLAMA_DIGEST} AS llama
FROM ghcr.io/marcosremar/aigw-edge:${EDGE_TAG}@${EDGE_DIGEST} AS edge

FROM vllm/vllm-omni:v0.28.0@sha256:6f8be103eaf0055448cf7578cfd621405fd669079d4361bd58896326b2bf722a
ENV DEBIAN_FRONTEND=noninteractive
RUN F=/usr/local/lib/python3.12/dist-packages/vllm_omni/model_executor/models/qwen3_tts \
 && python3 -c "import pathlib, sys; f = pathlib.Path(sys.argv[1]); s = f.read_text(); a = '        self._embedding_dtype = torch.bfloat16\n'; \
      assert s.count(a) == 1; f.write_text(s.replace(a, '        self._embedding_dtype = ' + sys.argv[2] + '\n'))" "$F/prompt_embeds_builder.py" tts_pad_embed.dtype \
 && python3 -c "import pathlib, sys; f = pathlib.Path(sys.argv[1]); s = f.read_text(); a = '        self._embedding_dtype = torch.bfloat16\n'; \
      assert s.count(a) == 1; f.write_text(s.replace(a, '        self._embedding_dtype = ' + sys.argv[2] + '\n'))" "$F/qwen3_tts_talker.py" model_dtype \
 && grep -n "_embedding_dtype = " "$F/prompt_embeds_builder.py" "$F/qwen3_tts_talker.py"
# nginx + openssl + curl: the replica front the gateway's boot script writes (src/deployments/cloud-init.ts) — it installs
# them with apt-get only when missing, which cost every Vast boot an apt update + install before the health loop.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl libgomp1 espeak-ng nginx openssl \
 && rm -rf /var/lib/apt/lists/* && nginx -v && openssl version
# llama.cpp is built on CUDA 12.8; this base is CUDA 13: llama-server runs with its own CUDA 12 libs (below)…
COPY --from=llama /app /opt/llama
# …and the exact CUDA 12 libs it was built against, NCCL included: without libnccl.so.2 its CUDA backend does not load
# and llama-server silently falls back to the CPU (2026-10-04 on an L4: 7 tokens/s). start.sh refuses to start without CUDA0.
COPY --from=llama /usr/local/cuda/lib64/libcudart.so.12.8.90 /usr/local/cuda/lib64/libcublas.so.12.8.4.1 \
     /usr/local/cuda/lib64/libcublasLt.so.12.8.4.1 /lib/x86_64-linux-gnu/libnccl.so.2.25.1 /opt/llama-cu12/
RUN cd /opt/llama-cu12 && ln -s libcudart.so.12.8.90 libcudart.so.12 && ln -s libcublas.so.12.8.4.1 libcublas.so.12 \
 && ln -s libcublasLt.so.12.8.4.1 libcublasLt.so.12 && ln -s libnccl.so.2.25.1 libnccl.so.2
# Python 3.12 venv via uv (in the base), wheels only. huggingface_hub 2.x pulled `tokenizers` back to 0.13.3, which has no
# wheel for 3.12 and needs Rust to build (both 2026-10-04 builds failed there): pin the pair that resolves to wheels.
RUN uv venv --python 3.12 /opt/wenv && uv pip install --python /opt/wenv/bin/python --no-cache --only-binary :all: \
    'faster-whisper==1.2.1' 'tokenizers>=0.21' 'huggingface_hub[hf_xet]<1' fastapi 'uvicorn[standard]' python-multipart httpx \
    numpy nvidia-cublas-cu12 'nvidia-cudnn-cu12==9.*' nvidia-cuda-runtime-cu12 'kokoro-onnx==0.6.1' 'sentencepiece==0.2.1'

ARG LLM_REPO=unsloth/Qwen3.5-9B-GGUF
ARG LLM_FILE=Qwen3.5-9B-Q4_K_M.gguf
ARG LLM_REVISION=3885219b6810b007914f3a7950a8d1b469d598a5
ARG LLM_SHA256=03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8
ARG TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-Base
ARG TTS_REVISION=5d83992436eae1d760afd27aff78a71d676296fc
ARG STT_REVISION=edaa852ec7e145841d8ffdb056a99866b5f0a478
ENV HF_HOME=/models/hf LLM_FILE=${LLM_FILE} TTS_MODEL=${TTS_MODEL} STT_MODEL=large-v3 STT_COMPUTE=float16
RUN /opt/wenv/bin/hf download "$LLM_REPO" "$LLM_FILE" --revision "$LLM_REVISION" --local-dir /models/llm \
 && echo "$LLM_SHA256  /models/llm/$LLM_FILE" | sha256sum -c - \
 && /opt/wenv/bin/hf download "$TTS_MODEL" \
 && /opt/wenv/bin/hf download Systran/faster-whisper-large-v3 \
 && test "$(cat /models/hf/hub/models--${TTS_MODEL%%/*}--${TTS_MODEL#*/}/refs/main)" = "$TTS_REVISION" \
 && test "$(cat /models/hf/hub/models--Systran--faster-whisper-large-v3/refs/main)" = "$STT_REVISION" \
 && rm -rf /models/hf/xet
# Kokoro-82M (ONNX, fp32) beside Qwen3-TTS: on the CPU in the orchestrator, so it takes no GPU memory from vLLM. espeak-ng
# from apt phonemizes (the macOS espeakng-loader wheel ignores its data path; the apt build is the known one). The 54 stock
# voices are packed into the npz kokoro-onnx reads; one line is spoken at build so a broken phonemizer fails here.
ARG KOKORO_REPO=onnx-community/Kokoro-82M-v1.0-ONNX
ARG KOKORO_REVISION=1939ad2a8e416c0acfeecc08a694d14ef25f2231
ARG KOKORO_SHA256=8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb
ENV KOKORO_DIR=/models/kokoro PHONEMIZER_ESPEAK_LIBRARY=/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1 \
    KOKORO_ESPEAK_DATA=/usr/lib/x86_64-linux-gnu/espeak-ng-data
RUN /opt/wenv/bin/hf download "$KOKORO_REPO" --include 'onnx/model.onnx' 'voices/*.bin' --revision "$KOKORO_REVISION" \
      --local-dir /tmp/kokoro \
 && echo "$KOKORO_SHA256  /tmp/kokoro/onnx/model.onnx" | sha256sum -c - \
 && mkdir -p "$KOKORO_DIR" && mv /tmp/kokoro/onnx/model.onnx "$KOKORO_DIR/" \
 && /opt/wenv/bin/python -c "import glob, os, numpy as np; np.savez(os.environ['KOKORO_DIR'] + '/voices.npz', \
      **{os.path.basename(p)[:-4]: np.fromfile(p, dtype=np.float32).reshape(-1, 1, 256) for p in glob.glob('/tmp/kokoro/voices/*.bin')})" \
 && rm -rf /tmp/kokoro \
 && /opt/wenv/bin/python -c "import os; from kokoro_onnx import EspeakConfig, Kokoro; d = os.environ['KOKORO_DIR']; \
      k = Kokoro(d + '/model.onnx', d + '/voices.npz', espeak_config=EspeakConfig(data_path=os.environ['KOKORO_ESPEAK_DATA'])); \
      a, sr = k.create('Olá, bom dia.', voice='pf_dora', lang='pt-br'); print(len(k.get_voices()), 'voices', len(a) / sr, 's'); \
      assert len(k.get_voices()) >= 50 and sr == 24000 and len(a) > sr // 2"

# Pocket TTS (Kyutai) on the base image's own Python and CUDA torch — no second torch (the CPU voice server's
# requirements-pocket.txt pins a CPU torch; not here). pocket-tts and num2words are installed with every package the base
# already has pinned (constraints), so vLLM-Omni's environment does not move; when pocket-tts's own pins do not resolve
# against the base, it goes in with --no-deps plus whichever of its dependencies are missing. It runs as its own process
# (pocket_server.py), started only when Pocket is the chosen TTS engine (tts_engines.py).
ARG POCKET_TTS_VERSION=3.3.0
ARG POCKET_BAKE=pt,en,fr,es,it,de
RUN PY=$(command -v python3) && "$PY" -c "import torch; print('base torch', torch.__version__, 'cuda', torch.version.cuda)" \
 && uv pip freeze --python "$PY" | grep -E '^[A-Za-z0-9_.-]+==[^ ]+$' > /tmp/base-pins.txt \
 && { uv pip install --python "$PY" --break-system-packages --no-cache -c /tmp/base-pins.txt "pocket-tts==$POCKET_TTS_VERSION" 'num2words==0.5.14' \
   || { echo "pocket-tts pins do not resolve against the base: --no-deps + the missing dependencies" \
     && uv pip install --python "$PY" --break-system-packages --no-cache --no-deps "pocket-tts==$POCKET_TTS_VERSION" \
     && uv pip install --python "$PY" --break-system-packages --no-cache -c /tmp/base-pins.txt einops sentencepiece safetensors scipy \
          typer 'num2words==0.5.14'; }; } \
 && "$PY" -c "import torch, pocket_tts, num2words, fastapi, uvicorn; print('pocket-tts on torch', torch.__version__)" \
 && rm -f /tmp/base-pins.txt
# Weights and default voices of the POCKET_BAKE languages (~220 MB each) baked at build: no download at start.
COPY pocket.py normalize.py /opt/s2s/
RUN cd /opt/s2s && python3 -X utf8 pocket.py bake "$POCKET_BAKE" && rm -rf /models/hf/xet

ARG MT_REVISIONS="en-itc=1159ef376d48fd8d4a11b88917e7a8a1022beb6f roa-en=4d4757865ab116b39daa3b4ca3cfe1e7daf43cbe itc-multi=4bcdcc2580bef62cae46ec574655c22219f3aaf3 gem-multi=d67b7e7ee532ad4791ffec5692651f87770a6ebe"
COPY mt.py /opt/s2s/
RUN CT2=$(/opt/wenv/bin/python -c 'import ctranslate2; print(ctranslate2.__version__)') \
 && uv venv --python 3.12 /tmp/ct2conv && uv pip install --python /tmp/ct2conv/bin/python --no-cache \
      --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple \
      "ctranslate2==$CT2" 'torch==2.5.1' 'transformers>=4.56,<5' 'sentencepiece==0.2.1' 'huggingface_hub<1' sacremoses \
 && for pair in $MT_REVISIONS; do name=${pair%%=*}; rev=${pair#*=}; \
      repo=$(cd /opt/s2s && /opt/wenv/bin/python -c "import sys; from mt import MODELS; print(MODELS[sys.argv[1]])" "$name") \
      && /tmp/ct2conv/bin/hf download "$repo" --revision "$rev" --include '*.json' '*.spm' 'model.safetensors' --local-dir "/tmp/hf-$name" \
      && /tmp/ct2conv/bin/ct2-transformers-converter --model "/tmp/hf-$name" --output_dir "/models/mt/$name" --quantization float16 \
           --copy_files source.spm target.spm \
      && rm -rf "/tmp/hf-$name" || exit 1; done \
 && rm -rf /tmp/ct2conv /root/.cache \
 && cd /opt/s2s && /opt/wenv/bin/python -c "from pathlib import Path; from mt import Translator; \
      t = Translator(Path('/models/mt'), ['en-itc', 'roa-en', 'itc-multi', 'gem-multi'], gpu_compute=''); \
      r = [t.translate(*x) for x in [('Bom dia a todos.', 'pt', 'en'), ('Good morning, everyone.', 'en', 'fr'), \
      ('Bonjour à tous.', 'fr', 'pt'), ('Goedemorgen allemaal.', 'nl', 'de')]]; print(r); \
      assert all(x['text'] and x['device'] == 'cpu' for x in r)" \
 && rm -rf /opt/s2s/__pycache__ && du -sh /models/mt/*

COPY --from=edge /app /opt/aigw-edge
RUN uv venv --python 3.12 /opt/aigw-edge/venv && uv pip install --python /opt/aigw-edge/venv/bin/python --no-cache \
    --only-binary :all: aiortc==1.15.0 aiohttp==3.14.4 'numpy>=1.26,<3'
COPY start.sh server.py mt.py stt_batch.py stt_stream.py tts_engines.py pocket_server.py pocket.py normalize.py qwen3_tts.yaml /opt/s2s/
RUN cd /opt/aigw-edge && venv/bin/python -c 'import aigw_edge.server' && ls -l /opt/aigw-edge /opt/aigw-edge/aigw_edge \
 && grep -n repetition_penalty /opt/s2s/qwen3_tts.yaml && sha256sum /opt/s2s/*
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=900s CMD curl -sf http://127.0.0.1:8000/health || exit 1
CMD ["bash", "/opt/s2s/start.sh"]

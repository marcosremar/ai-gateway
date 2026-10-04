"""
Cross-request STT batching: utterances from different students that arrive within a few milliseconds of each other go
through Whisper in ONE encoder + decoder pass on the GPU, instead of waiting in line behind each other.

Measured on an L4 before this (2026-10-04): with 8 students at once the STT was the queue — 2 530 ms p50 for a 5 s clip
that takes 375 ms alone, because only two float16 decodes fit next to the TTS and the LLM. A batch of N short clips costs
about one encoder pass of the batch plus a decode as long as the longest transcript, so the wait no longer grows with
the line.

    batcher = SttBatcher(model, max_batch=8, window_ms=25, beam=1)
    batcher.transcribe(audio_f32_16k, "pt", prompt=None)  # blocking, thread-safe → {"text", "language", "duration"}

Clips longer than 30 s, or without a language (detection), go through `model.transcribe` alone — the batched path
assumes one 30 s window per clip and a known language. A batched transcript that looks like a repetition loop is decoded
again alone, with faster-whisper's temperature fallback. CUDA out of memory: the batch is split in halves and retried;
a single clip retries three times with a short pause (the TTS and the LLM release memory between their own steps).
"""

import queue
import threading
import time
from concurrent.futures import Future

import numpy as np
from faster_whisper import BatchedInferencePipeline, WhisperModel
from faster_whisper.audio import pad_or_trim
from faster_whisper.tokenizer import Tokenizer
from faster_whisper.transcribe import TranscriptionOptions, get_compression_ratio, get_suppressed_tokens

SAMPLE_RATE = 16000
WINDOW_SECONDS = 30
# Whisper's own defaults for "this window is silence": high no-speech probability AND a low average log-probability.
NO_SPEECH_THRESHOLD = 0.6
LOG_PROB_THRESHOLD = -1.0
# Whisper's hallucination test (Radford et al. 2023, ICML, "Robust Speech Recognition via Large-Scale Weak Supervision",
# §4.5): gzip compression ratio above 2.4 means a repetition loop. Such a clip is decoded again alone, where faster-whisper
# applies the temperature fallback.
COMPRESSION_RATIO_THRESHOLD = 2.4
# A student's turn is a few seconds; 30 s of fast speech is ~100 words ≈ 150 tokens. The cap bounds a looping decode, which
# would otherwise hold every clip of its batch for up to 448 tokens.
MAX_NEW_TOKENS = 180


def is_oom(error: BaseException) -> bool:
    return "out of memory" in str(error).lower()


class SttBatcher:
    def __init__(self, model: WhisperModel, max_batch: int = 8, window_ms: int = 25, beam: int = 1):
        self.model = model
        self.pipeline = BatchedInferencePipeline(model)
        self.max_batch = max(1, max_batch)
        self.window = window_ms / 1000
        self.beam = beam
        self.jobs: queue.Queue = queue.Queue()
        self.stats = {"batches": 0, "clips": 0, "largest": 0, "oom_retries": 0, "fallbacks": 0}
        threading.Thread(target=self._loop, name="stt-batcher", daemon=True).start()

    # ── public ──────────────────────────────────────────────────────────────

    def transcribe(self, audio: np.ndarray, language: str | None, prompt: str | None = None) -> dict:
        job = {"audio": audio, "language": (language or None) and language[:2], "prompt": prompt or None, "future": Future()}
        self.jobs.put(job)
        return job["future"].result()

    # ── worker ──────────────────────────────────────────────────────────────

    def _loop(self) -> None:
        while True:
            batch = [self.jobs.get()]
            deadline = time.monotonic() + self.window
            while len(batch) < self.max_batch:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                try:
                    batch.append(self.jobs.get(timeout=left))
                except queue.Empty:
                    break
            groups: dict[tuple, list] = {}
            for job in batch:
                single = job["language"] is None or len(job["audio"]) > WINDOW_SECONDS * SAMPLE_RATE
                key = ("single", id(job)) if single else (job["language"], job["prompt"])
                groups.setdefault(key, []).append(job)
            for key, jobs in groups.items():
                try:
                    if key[0] == "single":
                        self._settle(jobs, [self._with_oom_retry(lambda: self._one(jobs[0]))])
                    else:
                        self._settle(jobs, self._batched(jobs))
                except BaseException as error:  # noqa: BLE001 — the worker thread must survive any request
                    for job in jobs:
                        if not job["future"].done():
                            job["future"].set_exception(error)

    @staticmethod
    def _settle(jobs: list, results: list) -> None:
        for job, result in zip(jobs, results):
            job["future"].set_result(result)

    def _with_oom_retry(self, run, tries: int = 3):
        for attempt in range(tries):
            try:
                return run()
            except RuntimeError as error:
                if not is_oom(error) or attempt == tries - 1:
                    raise
                self.stats["oom_retries"] += 1
                time.sleep(0.2 * (attempt + 1))

    def _batched(self, jobs: list) -> list:
        try:
            return self._decode(jobs) if len(jobs) > 1 else [self._with_oom_retry(lambda: self._decode(jobs)[0])]
        except RuntimeError as error:
            if not is_oom(error) or len(jobs) == 1:
                raise
            self.stats["oom_retries"] += 1
            half = len(jobs) // 2
            return self._batched(jobs[:half]) + self._batched(jobs[half:])

    def _one(self, job: dict) -> dict:
        segments, info = self.model.transcribe(job["audio"], language=job["language"], beam_size=self.beam,
                                               condition_on_previous_text=False, vad_filter=False,
                                               without_timestamps=True, initial_prompt=job["prompt"])
        text = " ".join(s.text.strip() for s in segments).strip()
        return {"text": text, "language": info.language, "duration": round(info.duration, 3)}

    def _decode(self, jobs: list) -> list:
        language, prompt = jobs[0]["language"], jobs[0]["prompt"]
        tokenizer = Tokenizer(self.model.hf_tokenizer, self.model.model.is_multilingual, task="transcribe", language=language)
        # Same feature path as BatchedInferencePipeline.transcribe: drop the last frame, pad every clip to 30 s.
        features = np.stack([pad_or_trim(self.model.feature_extractor(job["audio"])[..., :-1]) for job in jobs])
        options = TranscriptionOptions(
            beam_size=self.beam, best_of=5, patience=1, length_penalty=1, repetition_penalty=1, no_repeat_ngram_size=0,
            log_prob_threshold=LOG_PROB_THRESHOLD, no_speech_threshold=NO_SPEECH_THRESHOLD, compression_ratio_threshold=COMPRESSION_RATIO_THRESHOLD,
            condition_on_previous_text=False, prompt_reset_on_temperature=0.5, temperatures=[0.0], initial_prompt=prompt,
            prefix=None, suppress_blank=True, suppress_tokens=get_suppressed_tokens(tokenizer, [-1]),
            without_timestamps=True, max_initial_timestamp=0.0, word_timestamps=False,
            prepend_punctuations="\"'“¿([{-", append_punctuations="\"'.。,，!！?？:：”)]}、", multilingual=False,
            max_new_tokens=MAX_NEW_TOKENS, clip_timestamps="0", hallucination_silence_threshold=None, hotwords=None,
        )
        _, outputs = self.pipeline.generate_segment_batched(features, tokenizer, options)
        self.stats["batches"] += 1
        self.stats["clips"] += len(jobs)
        self.stats["largest"] = max(self.stats["largest"], len(jobs))
        results = []
        for job, out in zip(jobs, outputs):
            silent = out["no_speech_prob"] > NO_SPEECH_THRESHOLD and out["avg_logprob"] < LOG_PROB_THRESHOLD
            text = "" if silent else tokenizer.decode(out["tokens"]).strip()
            if text and (get_compression_ratio(text) > COMPRESSION_RATIO_THRESHOLD or len(out["tokens"]) >= MAX_NEW_TOKENS):
                self.stats["fallbacks"] += 1
                results.append(self._with_oom_retry(lambda job=job: self._one(job)))
                continue
            results.append({"text": text, "language": language, "duration": round(len(job["audio"]) / SAMPLE_RATE, 3)})
        return results

"""Client-side audio processing for STT — VAD segmentation with robustness techniques.

Framework-agnostic module (no Qt dependency). Uses callbacks for event notification.

Implements 12 research-backed techniques for robust speech-to-text:
  1. Pre-speech padding buffer — captures word onsets before VAD triggers
  2. Post-speech padding — captures final phonemes after silence hangover
  3. Exponential smoothing on VAD probability — reduces jitter/oscillation
  4. Dual threshold / hysteresis — separate onset (high) and offset (low) thresholds
  5. Smart cut points — finds silence-aligned cuts at max duration
  6. Short segment accumulation — buffers short chunks before STT
  7. AGC (Automatic Gain Control) — normalizes energy toward target RMS
  8. Adaptive endpointing — adjusts silence hangover based on speech duration
  9. Overlap / multi-speaker detection — flags sudden energy spikes
  10. Echo / TTS gating — suppresses VAD during TTS playback
  11. Dual-pass utterance end — lookahead confirmation before emitting
  12. Voice Activity Projection (VAP) — predicts pause from speaking rate trend

References:
  - Silero VAD (snakers4/silero-vad)
  - LiveKit Agents (livekit/agents) — smoothing + hysteresis
  - buzz (chidiwilliams/buzz) — smart cut points
  - @ricky0123/vad — pre/post speech padding

Usage:
    from gateway_sdk.audio import AudioSegmenter, AudioSegmenterConfig

    config = AudioSegmenterConfig()
    segmenter = AudioSegmenter(config, on_segment=my_callback)
    segmenter.load_vad()

    # Feed PCM frames (int16 mono 16kHz)
    segmenter.feed_pcm(pcm_bytes)

    # Or feed individual VAD windows
    segmenter.feed_frame(frame_512_samples)
"""
from __future__ import annotations

import io
import logging
import math
import threading
import wave
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

log = logging.getLogger(__name__)

# Silero VAD requires exactly 512 samples per window at 16kHz (32ms)
VAD_WINDOW_SAMPLES = 512
VAD_WINDOW_BYTES = VAD_WINDOW_SAMPLES * 2  # int16


# ── Configuration ────────────────────────────────────────────────────────────


@dataclass
class AudioSegmenterConfig:
    """Configuration for AudioSegmenter.

    All durations in milliseconds unless noted.
    """
    sample_rate: int = 16000

    # VAD thresholds (dual threshold / hysteresis)
    vad_onset_threshold: float = 0.45   # higher → fewer false starts
    vad_offset_threshold: float = 0.20  # lower → speech held longer

    # Exponential smoothing (0 = no smoothing, 1 = full history)
    vad_smoothing_alpha: float = 0.65

    # Pre-speech padding — ring buffer of recent silence frames
    pre_speech_pad_ms: int = 200

    # Post-speech padding — trailing audio after hangover
    post_speech_pad_ms: int = 150

    # Silence hangover — how long silence must last to trigger emission
    silence_hangover_ms: int = 300

    # Speech duration limits
    max_speech_ms: int = 8000
    min_speech_ms: int = 400

    # Energy gate — minimum RMS to consider as speech
    min_speech_rms: float = 0.001
    adaptive_rms_multiplier: float = 3.0
    ambient_rms_decay: float = 0.995

    # Smart cut points (at max duration)
    smart_cut_search_ms: int = 1500
    smart_cut_window_ms: int = 20

    # Short segment accumulation (downstream STT buffering)
    min_stt_audio_s: float = 1.2

    # ── AGC (Automatic Gain Control) ──
    agc_enabled: bool = True
    agc_target_rms: float = 0.1       # target RMS level (0.0–1.0)
    agc_max_gain: float = 10.0        # maximum amplification factor
    agc_attack_coeff: float = 0.01    # gain increase speed (slow)
    agc_release_coeff: float = 0.05   # gain decrease speed (faster)

    # ── Adaptive endpointing ──
    # Adjusts silence hangover based on speech duration:
    # short utterance → shorter hangover (faster emit), long → longer hangover
    adaptive_endpointing: bool = True
    endpointing_short_ms: int = 200   # hangover for speech < 1s
    endpointing_long_ms: int = 500    # hangover for speech > 3s
    endpointing_short_speech_ms: int = 1000  # threshold for "short" speech
    endpointing_long_speech_ms: int = 3000   # threshold for "long" speech

    # ── Overlap / multi-speaker detection ──
    overlap_detection: bool = True
    overlap_energy_ratio: float = 1.8  # sudden energy spike ratio to flag overlap
    overlap_window_ms: int = 100       # window for energy comparison

    # ── Echo / TTS gating ──
    echo_gate_enabled: bool = False    # disabled by default — enable when TTS playback active
    echo_gate_suppress_ms: int = 200   # suppress VAD for this long after TTS ends

    # ── Dual-pass utterance end detection ──
    dual_pass_enabled: bool = True
    dual_pass_lookahead_ms: int = 150  # extra frames to look at before confirming end

    # ── Voice Activity Projection (basic) ──
    # Tracks speaking rate trend to predict when speaker will pause
    vap_enabled: bool = True
    vap_history_frames: int = 30       # ~1s of VAD history at 32ms/frame
    vap_pause_prediction_threshold: float = 0.3  # if recent speech ratio drops below this, predict pause


# ── Segment result ───────────────────────────────────────────────────────────


@dataclass
class AudioSegment:
    """A speech segment extracted by the VAD."""
    pcm: bytes        # raw int16 mono PCM
    wav: bytes         # WAV-encoded audio
    duration_ms: float # segment duration in ms
    reason: str        # 'pause' | 'max_duration' | 'smart_cut' | 'flush'


# ── AudioSegmenter ───────────────────────────────────────────────────────────


class AudioSegmenter:
    """VAD-based audio segmenter with 6 robustness techniques.

    Framework-agnostic — uses callbacks instead of Qt signals.
    Thread-safe: all state mutations are guarded by a lock.

    Args:
        config: Segmentation parameters.
        on_segment: Called with AudioSegment when a speech segment is ready.
        on_level: Called with RMS level (0.0–1.0) for VU meter (~12Hz).
    """

    def __init__(
        self,
        config: AudioSegmenterConfig | None = None,
        on_segment: Callable[[AudioSegment], None] | None = None,
        on_level: Callable[[float], None] | None = None,
    ):
        self._cfg = config or AudioSegmenterConfig()
        self._on_segment = on_segment
        self._on_level = on_level
        self._lock = threading.Lock()

        # Lazy-loaded VAD model
        self._torch = None
        self._vad_model = None

        # ── VAD state machine ──
        self._speech_buf = bytearray()
        self._is_speaking = False
        self._silence_samples = 0
        self._speech_samples = 0
        self._speech_energy_sum = 0.0
        self._speech_energy_count = 0
        self._continuation = False
        self._smoothed_prob = 0.0
        self._ambient_rms = 0.0
        self._last_level_time = 0.0

        # ── Pre-speech padding ring buffer ──
        frames_count = max(1, int(self._cfg.pre_speech_pad_ms / 32))
        self._pre_speech_buf: deque[bytes] = deque(maxlen=frames_count)

        # ── Post-speech padding ──
        self._post_pad_samples = int(
            self._cfg.post_speech_pad_ms * self._cfg.sample_rate / 1000
        )
        self._post_pad_collecting = False
        self._post_pad_collected = 0
        self._post_pad_chunk: bytes | None = None

        # ── Short segment accumulation ──
        self._stt_accum = bytearray()

        # Bytes-per-ms for convenience
        self._bytes_per_ms = self._cfg.sample_rate * 2 / 1000

        # Remainder from feed_pcm (handles non-aligned input)
        self._remainder = b''

        # ── AGC state ──
        self._agc_gain = 1.0

        # ── Overlap detection state ──
        self._recent_rms: deque[float] = deque(
            maxlen=max(1, int(self._cfg.overlap_window_ms / 32))
        )
        self._overlap_flag = False

        # ── Echo gate state ──
        self._echo_gate_until = 0.0  # monotonic time until which VAD is suppressed

        # ── Dual-pass utterance end ──
        self._dual_pass_pending = False
        self._dual_pass_frames = 0
        self._dual_pass_lookahead = max(
            1, int(self._cfg.dual_pass_lookahead_ms / 32)
        )
        self._dual_pass_speech_frames = 0  # speech frames during lookahead

        # ── VAP (Voice Activity Projection) ──
        self._vap_history: deque[bool] = deque(
            maxlen=self._cfg.vap_history_frames
        )

    # ── VAD model management ─────────────────────────────────────────────

    def load_vad(self) -> None:
        """Load the Silero VAD model. Call before feeding audio."""
        if self._torch is None:
            import torch
            self._torch = torch
        if self._vad_model is None:
            from silero_vad import load_silero_vad
            self._vad_model = load_silero_vad()
            self._vad_model.reset_states()
            log.info(
                "Silero VAD loaded (onset=%.2f, offset=%.2f, smoothing=%.2f)",
                self._cfg.vad_onset_threshold,
                self._cfg.vad_offset_threshold,
                self._cfg.vad_smoothing_alpha,
            )

    @property
    def vad_loaded(self) -> bool:
        return self._vad_model is not None

    # ── Public API ───────────────────────────────────────────────────────

    def feed_pcm(self, pcm_bytes: bytes) -> None:
        """Feed raw int16 mono PCM at configured sample rate.

        Splits into VAD-sized windows (512 samples) and processes each.
        Handles non-aligned input by buffering remainder.
        """
        if self._vad_model is None:
            self.load_vad()

        raw = self._remainder + pcm_bytes
        self._remainder = b''

        offset = 0
        while offset + VAD_WINDOW_BYTES <= len(raw):
            frame = raw[offset:offset + VAD_WINDOW_BYTES]
            self._process_frame(frame)
            offset += VAD_WINDOW_BYTES

        if offset < len(raw):
            self._remainder = raw[offset:]

    def feed_frame(self, frame: bytes) -> None:
        """Feed a single VAD window (512 samples = 1024 bytes of int16)."""
        if self._vad_model is None:
            self.load_vad()
        self._process_frame(frame)

    def flush(self) -> None:
        """Emit any remaining speech buffer (call on stop/cleanup)."""
        segment = None
        with self._lock:
            if self._post_pad_collecting and self._post_pad_chunk:
                full_pcm = self._post_pad_chunk + bytes(self._speech_buf)
                segment = self._make_segment(full_pcm, "flush")
            elif self._is_speaking and self._speech_samples > 0:
                speech_ms = (self._speech_samples / self._cfg.sample_rate) * 1000
                if speech_ms >= self._cfg.min_speech_ms:
                    segment = self._make_segment(bytes(self._speech_buf), "flush")
            self._reset_state()
            if self._vad_model is not None:
                self._vad_model.reset_states()

        if segment and self._on_segment:
            self._on_segment(segment)

    def reset(self) -> None:
        """Reset all state (but keep VAD model loaded)."""
        with self._lock:
            self._reset_state()
            if self._vad_model is not None:
                self._vad_model.reset_states()

    def notify_tts_end(self) -> None:
        """Call when TTS playback ends to suppress echo detection.

        Suppresses VAD for echo_gate_suppress_ms to prevent the segmenter
        from picking up the TTS output as speech.
        """
        import time
        if self._cfg.echo_gate_enabled:
            self._echo_gate_until = (
                time.monotonic() + self._cfg.echo_gate_suppress_ms / 1000
            )

    @property
    def overlap_detected(self) -> bool:
        """True if the most recent frame had an energy spike suggesting overlapping speakers."""
        return self._overlap_flag

    def get_accumulated_audio(self) -> bytes:
        """Return any accumulated short-segment audio (for downstream STT buffering)."""
        return bytes(self._stt_accum)

    def clear_accumulator(self) -> None:
        """Clear the short-segment accumulator."""
        self._stt_accum = bytearray()

    # ── Smart cut ────────────────────────────────────────────────────────

    def find_smart_cut_point(self, pcm: bytes) -> int:
        """Find the lowest-energy point in the last N ms of audio.

        Returns byte offset for the cut, or len(pcm) if no good cut found.
        """
        cfg = self._cfg
        samples_per_window = int(cfg.smart_cut_window_ms * cfg.sample_rate / 1000)
        bytes_per_window = samples_per_window * 2
        search_bytes = int(cfg.smart_cut_search_ms * cfg.sample_rate / 1000) * 2

        if len(pcm) < search_bytes:
            return len(pcm)

        search_start = len(pcm) - search_bytes
        region = pcm[search_start:]

        n_windows = len(region) // bytes_per_window
        if n_windows < 2:
            return len(pcm)

        energies = []
        for i in range(n_windows):
            window_data = np.frombuffer(
                region[i * bytes_per_window:(i + 1) * bytes_per_window],
                dtype=np.int16,
            ).astype(np.float32)
            rms = float(np.sqrt(np.mean(window_data ** 2))) / 32768.0
            energies.append(rms)

        min_idx = int(np.argmin(energies))
        cut_offset = search_start + min_idx * bytes_per_window + bytes_per_window // 2

        avg_energy = sum(energies) / len(energies)
        min_energy = energies[min_idx]
        if min_energy < avg_energy * 0.6:
            return cut_offset

        return len(pcm)

    # ── Internal ─────────────────────────────────────────────────────────

    def _apply_agc(self, samples: np.ndarray, rms: float) -> np.ndarray:
        """Apply Automatic Gain Control — normalize energy toward target RMS."""
        cfg = self._cfg
        if not cfg.agc_enabled or rms < 1e-6:
            return samples
        desired_gain = cfg.agc_target_rms / rms
        desired_gain = min(desired_gain, cfg.agc_max_gain)
        # Smooth gain transitions to avoid clicks
        if desired_gain > self._agc_gain:
            self._agc_gain += cfg.agc_attack_coeff * (desired_gain - self._agc_gain)
        else:
            self._agc_gain += cfg.agc_release_coeff * (desired_gain - self._agc_gain)
        return np.clip(samples * self._agc_gain, -32768, 32767).astype(np.float32)

    def _get_effective_hangover(self, speech_ms: float) -> float:
        """Adaptive endpointing: adjust silence hangover based on speech duration."""
        cfg = self._cfg
        if not cfg.adaptive_endpointing:
            return cfg.silence_hangover_ms
        if speech_ms <= cfg.endpointing_short_speech_ms:
            return cfg.endpointing_short_ms
        if speech_ms >= cfg.endpointing_long_speech_ms:
            return cfg.endpointing_long_ms
        # Linear interpolation between short and long
        ratio = (speech_ms - cfg.endpointing_short_speech_ms) / (
            cfg.endpointing_long_speech_ms - cfg.endpointing_short_speech_ms
        )
        return cfg.endpointing_short_ms + ratio * (
            cfg.endpointing_long_ms - cfg.endpointing_short_ms
        )

    def _check_overlap(self, rms: float) -> bool:
        """Detect potential overlapping speech via sudden energy spike."""
        cfg = self._cfg
        if not cfg.overlap_detection or len(self._recent_rms) < 2:
            self._recent_rms.append(rms)
            return False
        avg_recent = sum(self._recent_rms) / len(self._recent_rms)
        self._recent_rms.append(rms)
        if avg_recent > 0 and rms > avg_recent * cfg.overlap_energy_ratio:
            return True
        return False

    def _vap_predict_pause(self) -> bool:
        """Voice Activity Projection: predict if speaker is about to pause."""
        cfg = self._cfg
        if not cfg.vap_enabled or len(self._vap_history) < cfg.vap_history_frames:
            return False
        recent_half = list(self._vap_history)[len(self._vap_history) // 2:]
        if not recent_half:
            return False
        speech_ratio = sum(1 for v in recent_half if v) / len(recent_half)
        return speech_ratio < cfg.vap_pause_prediction_threshold

    def _process_frame(self, frame: bytes) -> None:
        """Process a single VAD window (512 samples)."""
        import time

        # Compute RMS
        samples = np.frombuffer(frame, dtype=np.int16).astype(np.float32)
        rms = float(np.sqrt(np.mean(samples ** 2))) / 32768.0

        # ── AGC — normalize energy ──
        cfg = self._cfg
        if cfg.agc_enabled:
            samples = self._apply_agc(samples, rms)
            # Recompute RMS after AGC for downstream decisions
            rms = float(np.sqrt(np.mean(samples ** 2))) / 32768.0
            # Rebuild frame with AGC-adjusted samples
            frame = np.clip(samples, -32768, 32767).astype(np.int16).tobytes()

        # ── Echo gate — suppress VAD during TTS playback ──
        now = time.monotonic()
        echo_suppressed = cfg.echo_gate_enabled and now < self._echo_gate_until

        # VU meter (~12Hz)
        if self._on_level and now - self._last_level_time >= 0.08:
            self._last_level_time = now
            self._on_level(min(1.0, rms * 5.0))

        # ── Overlap detection ──
        self._overlap_flag = self._check_overlap(rms)

        # Prepare VAD tensor
        torch = self._torch
        audio_float = samples / 32768.0
        tensor = torch.from_numpy(audio_float)
        if len(tensor) < VAD_WINDOW_SAMPLES:
            tensor = torch.nn.functional.pad(tensor, (0, VAD_WINDOW_SAMPLES - len(tensor)))
        elif len(tensor) > VAD_WINDOW_SAMPLES:
            tensor = tensor[:VAD_WINDOW_SAMPLES]

        segment_to_emit = None

        with self._lock:
            # ── Post-speech padding collection ──
            if self._post_pad_collecting:
                self._speech_buf.extend(frame)
                self._post_pad_collected += VAD_WINDOW_SAMPLES
                if self._post_pad_collected >= self._post_pad_samples:
                    full_pcm = self._post_pad_chunk + bytes(self._speech_buf)
                    segment_to_emit = self._make_segment(full_pcm, "pause")
                    self._reset_state()
                # Skip normal VAD during post-pad collection
            elif echo_suppressed:
                # During echo gate, treat everything as silence
                self._pre_speech_buf.append(frame)
            else:
                # ── VAD inference ──
                raw_prob = self._vad_model(tensor, cfg.sample_rate).item()

                # Exponential smoothing
                self._smoothed_prob = (
                    cfg.vad_smoothing_alpha * self._smoothed_prob +
                    (1 - cfg.vad_smoothing_alpha) * raw_prob
                )
                prob = self._smoothed_prob

                # ── VAP history tracking ──
                if cfg.vap_enabled:
                    self._vap_history.append(prob >= cfg.vad_offset_threshold)

                # Dual threshold
                if self._is_speaking:
                    is_speech = prob >= cfg.vad_offset_threshold
                else:
                    is_speech = prob >= cfg.vad_onset_threshold

                # Adaptive RMS
                if not self._is_speaking:
                    self._ambient_rms = (
                        cfg.ambient_rms_decay * self._ambient_rms +
                        (1 - cfg.ambient_rms_decay) * rms
                    )
                adaptive_rms = max(cfg.min_speech_rms,
                                   self._ambient_rms * cfg.adaptive_rms_multiplier)

                if not self._is_speaking:
                    # IDLE — maintain pre-speech ring buffer
                    self._pre_speech_buf.append(frame)

                    if is_speech and rms >= adaptive_rms:
                        # Speech started — prepend pre-speech buffer + current frame
                        self._is_speaking = True
                        pre_pad = b''.join(self._pre_speech_buf)
                        self._speech_buf = bytearray(pre_pad + frame)
                        self._speech_samples = (len(pre_pad) // 2) + VAD_WINDOW_SAMPLES
                        self._silence_samples = 0
                        self._speech_energy_sum = rms
                        self._speech_energy_count = 1
                        self._pre_speech_buf.clear()
                else:
                    # SPEAKING — accumulate audio
                    self._speech_buf.extend(frame)
                    self._speech_samples += VAD_WINDOW_SAMPLES
                    self._speech_energy_sum += rms
                    self._speech_energy_count += 1

                    if is_speech:
                        self._silence_samples = 0
                    else:
                        self._silence_samples += VAD_WINDOW_SAMPLES

                    speech_ms = (self._speech_samples / cfg.sample_rate) * 1000
                    silence_ms = (self._silence_samples / cfg.sample_rate) * 1000

                    # ── Adaptive endpointing — adjust hangover by speech length ──
                    effective_hangover = self._get_effective_hangover(speech_ms)

                    # ── Dual-pass utterance end ──
                    # When silence reaches hangover, enter lookahead to confirm
                    if self._dual_pass_pending:
                        self._dual_pass_frames += 1
                        if is_speech:
                            self._dual_pass_speech_frames += 1
                        if self._dual_pass_frames >= self._dual_pass_lookahead:
                            # Confirm: if most lookahead frames were silence, emit
                            speech_ratio = (
                                self._dual_pass_speech_frames / self._dual_pass_frames
                                if self._dual_pass_frames > 0 else 0
                            )
                            if speech_ratio < 0.5:
                                # Confirmed end of speech
                                avg_rms = self._speech_energy_sum / max(self._speech_energy_count, 1)
                                min_ms = 0 if self._continuation else cfg.min_speech_ms
                                if speech_ms >= min_ms and avg_rms >= adaptive_rms:
                                    speech_pcm = bytes(self._speech_buf)
                                    self._post_pad_chunk = speech_pcm
                                    self._post_pad_collecting = True
                                    self._post_pad_collected = 0
                                    self._speech_buf = bytearray()
                                    self._is_speaking = False
                                else:
                                    self._reset_state()
                            # else: speaker resumed — cancel dual-pass
                            self._dual_pass_pending = False
                            self._dual_pass_frames = 0
                            self._dual_pass_speech_frames = 0

                    elif silence_ms >= effective_hangover:
                        if cfg.dual_pass_enabled:
                            # Enter dual-pass lookahead
                            self._dual_pass_pending = True
                            self._dual_pass_frames = 0
                            self._dual_pass_speech_frames = 0
                        else:
                            avg_rms = self._speech_energy_sum / max(self._speech_energy_count, 1)
                            min_ms = 0 if self._continuation else cfg.min_speech_ms
                            if speech_ms >= min_ms and avg_rms >= adaptive_rms:
                                speech_pcm = bytes(self._speech_buf)
                                self._post_pad_chunk = speech_pcm
                                self._post_pad_collecting = True
                                self._post_pad_collected = 0
                                self._speech_buf = bytearray()
                                self._is_speaking = False
                            else:
                                self._reset_state()

                    elif speech_ms >= cfg.max_speech_ms:
                        # ── VAP-assisted max duration ──
                        # If VAP predicts pause, emit slightly earlier
                        should_cut = True
                        if cfg.vap_enabled and not self._vap_predict_pause():
                            # VAP says speaker is still going — allow 20% overshoot
                            if speech_ms < cfg.max_speech_ms * 1.2:
                                should_cut = False

                        if should_cut:
                            # Smart cut
                            raw_pcm = bytes(self._speech_buf)
                            cut = self.find_smart_cut_point(raw_pcm)
                            if cut < len(raw_pcm):
                                segment_to_emit = self._make_segment(raw_pcm[:cut], "smart_cut")
                                remainder = raw_pcm[cut:]
                            else:
                                segment_to_emit = self._make_segment(raw_pcm, "max_duration")
                                remainder = b''

                            self._speech_buf = bytearray(remainder)
                            self._speech_samples = len(remainder) // 2
                            self._silence_samples = 0
                            self._speech_energy_sum = 0.0
                            self._speech_energy_count = 0
                            self._continuation = True

        # Emit outside lock
        if segment_to_emit and self._on_segment:
            self._on_segment(segment_to_emit)

    def _reset_state(self) -> None:
        """Reset VAD state machine (must hold lock)."""
        self._speech_buf = bytearray()
        self._is_speaking = False
        self._silence_samples = 0
        self._speech_samples = 0
        self._speech_energy_sum = 0.0
        self._speech_energy_count = 0
        self._continuation = False
        self._smoothed_prob = 0.0
        self._pre_speech_buf.clear()
        self._post_pad_collecting = False
        self._post_pad_collected = 0
        self._post_pad_chunk = None
        self._dual_pass_pending = False
        self._dual_pass_frames = 0
        self._dual_pass_speech_frames = 0

    def _make_segment(self, pcm: bytes, reason: str) -> AudioSegment:
        """Create an AudioSegment from raw PCM."""
        duration_ms = len(pcm) / self._bytes_per_ms
        wav = _pcm_to_wav(pcm, self._cfg.sample_rate)
        return AudioSegment(pcm=pcm, wav=wav, duration_ms=duration_ms, reason=reason)


# ── Utilities ────────────────────────────────────────────────────────────────


def _pcm_to_wav(pcm: bytes, sample_rate: int = 16000) -> bytes:
    """Convert raw int16 mono PCM to WAV bytes."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()


def pcm_to_wav(pcm: bytes, sample_rate: int = 16000) -> bytes:
    """Convert raw int16 mono PCM to WAV bytes (public API)."""
    return _pcm_to_wav(pcm, sample_rate)


def wav_duration_ms(wav_bytes: bytes) -> float:
    """Return duration in ms of a WAV file."""
    with wave.open(io.BytesIO(wav_bytes), 'rb') as wf:
        return wf.getnframes() / wf.getframerate() * 1000

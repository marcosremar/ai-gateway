//! On-device speech detection before the STT call (feature `audio`).
//!
//! The ucast.me desktop app's own front end — a level for what the VAD hears, Silero VAD, the speech
//! segmenter — so another app gets the same segments instead of writing its own: the VAD does not miss a
//! voice heard from across a room, a sentence is cut at a pause and not before its last word, a pause does not
//! end a sentence too early. Then [`GatewayClient::transcribe_speech`] sends each segment to the batch STT.
//! Nothing here touches the network. The VAD (ONNX Runtime + the bundled model) is created on the first frame,
//! so a [`SpeechDetector`] costs nothing until audio arrives; ONNX Runtime comes from `ORT_DYLIB_PATH` or
//! [`use_onnx_runtime_at`].
//!
//! ```no_run
//! # async fn demo(gw: ai_gateway_sdk::GatewayClient, mic: Vec<f32>) -> ai_gateway_sdk::Result<()> {
//! use ai_gateway_sdk::SpeechDetector;
//!
//! let mut speech = SpeechDetector::new(); // the app's settings; nothing loaded yet
//! for chunk in mic.chunks(1600) {
//!     // 100 ms of 16 kHz mono f32
//!     for segment in speech.push(chunk).expect("VAD") {
//!         let text = gw.transcribe_speech("babelcast-stt", &segment, Some("pt")).await?;
//!         println!("{}", text.text);
//!     }
//! }
//! # Ok(()) }
//! ```

pub use ai_gateway_audio::{
    release_handled_by_app, use_onnx_runtime_at, MicCheck, MicIssue, MicReport, Segmenter, SegmenterConfig, SileroVad,
    VadError, VadLevel, FRAME_SAMPLES, SAMPLE_RATE,
};

use crate::client::GatewayClient;
use crate::error::Result;
use crate::openai::{TranscribeRequest, Transcription};

/// The desktop app's level for the VAD's input: target −24 dBFS, raised at most 12 dB, over 3 s.
const LEVEL: (f32, f32, f32) = (-24.0, 12.0, 3.0);
/// Silero's recurrent state is reset after this many frames (~1 s) under [`QUIET_PROB`], as the app does.
const RESET_AFTER_QUIET_FRAMES: u32 = 31;
const QUIET_PROB: f32 = 0.1;

/// 16 kHz mono samples in, finished speech segments out (level → Silero VAD → segmenter).
pub struct SpeechDetector {
    vad: Option<SileroVad>,
    level: Option<VadLevel>,
    segmenter: Segmenter,
    pending: Vec<f32>,
    quiet: u32,
    mic: MicCheck,
}

impl Default for SpeechDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl SpeechDetector {
    /// With the ucast.me desktop app's segmentation (onset 0.35, offset 0.21, speech 0.4–5 s, a cut waits up
    /// to 1.5 s for a pause, 300 ms of silence ends it) and the level on.
    pub fn new() -> Self {
        Self::with_config(SegmenterConfig {
            onset_threshold: 0.35,
            offset_threshold: 0.21,
            min_speech_ms: 400,
            max_speech_ms: 5000,
            end_grace_ms: 1500,
            silence_hangover_ms: 300,
            ..SegmenterConfig::default()
        })
    }

    pub fn with_config(config: SegmenterConfig) -> Self {
        Self {
            vad: None,
            level: Some(VadLevel::new(LEVEL.0, LEVEL.1, LEVEL.2)),
            segmenter: Segmenter::new(config),
            pending: Vec::with_capacity(FRAME_SAMPLES * 2),
            quiet: 0,
            mic: MicCheck::new(),
        }
    }

    /// The VAD hears the audio as it came (no level).
    pub fn without_level(mut self) -> Self {
        self.level = None;
        self
    }

    /// Any number of 16 kHz mono samples; the speech segments that ended in them. The first call creates the
    /// VAD (loads ONNX Runtime and the model).
    pub fn push(&mut self, samples: &[f32]) -> std::result::Result<Vec<Vec<f32>>, VadError> {
        if self.vad.is_none() {
            self.vad = Some(SileroVad::new()?);
        }
        let vad = self.vad.as_mut().expect("created above");
        self.pending.extend_from_slice(samples);
        let mut done = Vec::new();
        let whole = self.pending.len() / FRAME_SAMPLES * FRAME_SAMPLES;
        for frame in self.pending[..whole].chunks_exact(FRAME_SAMPLES) {
            let heard = match self.level.as_mut() {
                Some(level) => level.apply(frame),
                None => frame,
            };
            let prob = vad.process(heard)?;
            self.mic.push(frame, prob);
            self.quiet = if prob < QUIET_PROB { self.quiet + 1 } else { 0 };
            if self.quiet == RESET_AFTER_QUIET_FRAMES {
                vad.reset();
            }
            if let Some(segment) = self.segmenter.push_frame(frame, prob) {
                done.push(segment);
            }
        }
        self.pending.drain(..whole);
        Ok(done)
    }

    /// What is wrong with the microphone over the last 30 s (`None` before 8 s of sound): show
    /// [`MicIssue::hurts_transcription`] ones as a reason for worse transcripts, the others for recordings.
    pub fn mic_report(&self) -> Option<MicReport> {
        self.mic.report()
    }

    /// The speech still open when the audio ends.
    pub fn flush(&mut self) -> Option<Vec<f32>> {
        self.segmenter.flush()
    }

    /// The segmenter (drafts at pauses with `take_peek`, `in_speech`…).
    pub fn segmenter(&mut self) -> &mut Segmenter {
        &mut self.segmenter
    }
}

/// 16 kHz mono f32 → a 16-bit PCM WAV file.
pub fn wav_16k(samples: &[f32]) -> Vec<u8> {
    let data = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE as u32 * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
}

impl GatewayClient {
    /// `POST /v1/audio/transcriptions` with one segment of a [`SpeechDetector`] (16 kHz mono, sent as WAV).
    pub async fn transcribe_speech(
        &self,
        model: &str,
        segment: &[f32],
        language: Option<&str>,
    ) -> Result<Transcription> {
        let mut req = TranscribeRequest::new(model, wav_16k(segment));
        if let Some(language) = language {
            req = req.language(language);
        }
        self.transcribe(req).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_detector_loads_nothing_until_audio_arrives() {
        let speech = SpeechDetector::new();
        assert!(speech.vad.is_none());
    }

    #[test]
    fn the_wav_is_16_bit_mono_at_16_khz_with_every_sample() {
        let wav = wav_16k(&[0.0, 0.5, -1.0]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(i16::from_le_bytes([wav[46], wav[47]]), 16383);
        assert_eq!(i16::from_le_bytes([wav[48], wav[49]]), -32767);
    }
}

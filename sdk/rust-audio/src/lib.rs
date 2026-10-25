//! On-device speech detection, shared by the apps that talk to the ai-gateway.
//!
//! - [`SileroVad`]: Silero VAD v5 (model bundled in the binary, ~2 MB) on ONNX Runtime, 512-sample frames at
//!   16 kHz → speech probability.
//! - [`VadLevel`]: what the VAD hears, put at the level of normal speech (a voice from across a room was taken
//!   for noise — ucast.me benchmark `room`, 2026-10-25).
//! - [`Segmenter`]: probabilities → speech segments (hysteresis, padding, smart cut at the quietest point,
//!   drafts at pauses), the ucast.me desktop app's own.
//!
//! Nothing here touches the network: it runs offline and before any audio goes to the gateway. The ONNX
//! Runtime library is loaded at run time (`ort` `load-dynamic`): set `ORT_DYLIB_PATH` or call
//! [`use_onnx_runtime_at`] before the first [`SileroVad::new`]. On macOS the VAD also releases ONNX Runtime at
//! `exit()` (its 1.22 destructors abort otherwise); an app that does it itself calls [`release_handled_by_app`]. `ai-gateway-sdk` exposes all of it behind its
//! `audio` feature (with a lazily created VAD), so an app that only calls the API never links ONNX Runtime.

pub mod segmenter;
pub mod vad;

pub use segmenter::{Segmenter, SegmenterConfig};
pub use vad::{
    release_handled_by_app, use_onnx_runtime_at, SileroVad, VadError, VadLevel, FRAME_SAMPLES,
    SAMPLE_RATE,
};

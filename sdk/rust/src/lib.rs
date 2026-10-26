//! `ai-gateway-sdk` — typed async Rust client of the ai-gateway HTTP API (`serve.ts`).
//!
//! Rust counterpart of the Node SDK's `GatewayClient` (`sdk/node/gateway-client.ts`): OpenAI-compatible STT / chat
//! (buffered and SSE) / TTS (buffered and streamed), speech-to-speech frames, live rooms, deployments, app accounts,
//! activation, desktop-app telemetry and health. Built on reqwest + tokio with rustls (no OpenSSL).
//!
//! ```no_run
//! use ai_gateway_sdk::{GatewayClient, TranscribeRequest};
//!
//! # async fn demo(wav: Vec<u8>) -> ai_gateway_sdk::Result<()> {
//! // AI_GATEWAY_URL / GATEWAY_URL and AI_GATEWAY_API_KEY / GATEWAY_API_KEY
//! let gw = GatewayClient::from_env()?;
//! let t = gw.transcribe(TranscribeRequest::new("parle-stt", wav).language("pt").verbose()).await?;
//! println!("{} (detected {:?}, via {:?})", t.text, t.language, t.served.provider);
//! # Ok(()) }
//! ```
//!
//! Semantics shared with the Node SDK:
//! - talks only to the base URL; never reads a provider key;
//! - every failure is a [`GatewayError`] (status, gateway code, body, `Retry-After`, `X-Gateway-*`, unreachable flag);
//! - per-group timeouts ([`Timeouts`]), overridable per call ([`CallOptions`]); for streams they bound the headers;
//! - only idempotent calls are retried by default ([`RetryPolicy`]); paid calls are never retried;
//! - an opt-in breaker on the gateway itself ([`BreakerConfig`]).
//!
//! See the crate README for the parity table with the Node and Python SDKs.

pub mod account;
pub mod apps;
pub mod audio;
pub mod breaker;
mod client;
pub mod deployments;
mod error;
mod http;
pub mod openai;
pub mod rooms;
pub mod s2s;
#[cfg(feature = "audio")]
pub mod speech;
mod stream;
pub mod stt_stream;
pub mod telemetry;
pub mod tts_engine;
pub mod types;

pub use account::{Activation, UsageReport};
pub use apps::{
    AppDeploymentRef, AppImage, AppImageVersion, AppView, Apps, FallbackCredential, FallbackEntry, FallbackPlan, ModelRoutesSpec,
    RouteEntrySpec, RouteTarget, VoiceByGender,
};
pub use audio::fix_streaming_wav;
pub use breaker::{BreakerConfig, BreakerPosition, GatewayState};
pub use client::{GatewayClient, GatewayClientBuilder, DEFAULT_BASE_URL, ENV_API_KEY, ENV_APP, ENV_BASE_URL};
pub use deployments::{DeploymentList, DeploymentView, Deployments, ReplicaView};
pub use error::{GatewayError, Result, StatusError};
pub use http::RetryPolicy;
pub use openai::{
    audio_part_meta, ChatChoice, ChatCompletion, ChatMessage, ChatRequest, ChatUsage, MessageContent, ResponseFormat,
    ResponseMessage, SpeechRequest, SpeechResult, TranscribeRequest, Transcription, TtsClone,
};
pub use rooms::{CreateRoom, Room, RoomLine, RoomSnapshot, RoomUpdate, Rooms};
pub use s2s::{
    S2SConfig, S2SEvent, S2SFrame, S2SFrameDecoder, S2SMessage, S2SModels, S2SRequest, S2SStream, S2S_MAX_FRAME_BYTES,
};
#[cfg(feature = "audio")]
pub use speech::{wav_16k, MicIssue, MicReport, SpeechDetector};
pub use stream::{ChatStream, SpeechStream};
pub use stt_stream::{
    SttStreamEvent, SttStreamReceiver, SttStreamSender, StreamFinal, StreamPartial, StreamReady, TranscribeStreamRequest,
    TranscriptionStream, STT_STREAM_PATH,
};
pub use telemetry::AppEventsBatch;
pub use tts_engine::{TtsEngineChoice, TTS_ENGINE_PATH};
pub use types::{CallOptions, HealthReport, Served, TimeoutGroup, Timeouts};

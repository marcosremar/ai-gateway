//! `POST /v1/audio/speech/engine`: which TTS engine the GPU behind a TTS alias keeps loaded.
//!
//! The speech-stack GPU loads ONE of Qwen3-TTS / Kokoro / Pocket TTS at a time (the others are unloaded to give their
//! RAM and VRAM back). Call [`GatewayClient::select_tts_engine`] with the session's TTS alias when a session starts (and
//! when the user changes the voice engine): the GPU switches now instead of on the first line. Without it the GPU still
//! follows the requests once the engine it has has been idle for a while (`TTS_SWITCH_IDLE_S`, 120 s), and meanwhile
//! the gateway speaks each line with the alias's next link — nothing breaks, it only takes longer.
//!
//! ```no_run
//! # async fn demo(gw: ai_gateway_sdk::GatewayClient) -> ai_gateway_sdk::Result<()> {
//! let choice = gw.select_tts_engine("babelcast-tts-pocket", false).await?;
//! println!("{:?} on {:?} (selected: {})", choice.engine, choice.deployment, choice.selected);
//! // Err with code "engine_in_use" (409): another engine is in use there — `force: true` switches anyway;
//! // Err with code "gpu_not_ready" (503): the GPU is cold; the session's requests fall back meanwhile.
//! # Ok(()) }
//! ```

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::GatewayClient;
use crate::error::Result;
use crate::http::{Body, Spec};
use crate::types::{CallOptions, TimeoutGroup};

/// Path of the route.
pub const TTS_ENGINE_PATH: &str = "/v1/audio/speech/engine";

/// The gateway's answer.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct TtsEngineChoice {
    #[serde(default)]
    pub ok: bool,
    /// The deployment of the alias's first GPU link, when it has one.
    #[serde(default)]
    pub deployment: Option<String>,
    /// `qwen` | `kokoro` | `pocket`.
    #[serde(default)]
    pub engine: Option<String>,
    /// False when there was nothing to choose (`reason`: `no_gpu_link`, `no_engine_choice`).
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub reason: Option<String>,
    /// The replica's engine state (`active`, `switching_to`, `engines`…).
    #[serde(default)]
    pub replica: Option<Value>,
}

#[derive(Serialize)]
struct Ask<'a> {
    model: &'a str,
    force: bool,
}

impl GatewayClient {
    /// `POST /v1/audio/speech/engine {"model", "force"}`: the TTS engine the alias's GPU keeps loaded (see the module).
    /// Refusals are [`crate::GatewayError::Status`]: 409 `engine_in_use`, 503 `gpu_not_ready` (with `Retry-After`), 403
    /// for an alias of another app. Not retried.
    pub async fn select_tts_engine(&self, model: &str, force: bool) -> Result<TtsEngineChoice> {
        let call = CallOptions::default();
        let spec = Spec::new(Method::POST, TTS_ENGINE_PATH, TimeoutGroup::Tts, &call)
            .body(Body::json(&Ask { model, force })?)
            .idempotent(false);
        self.guarded(TTS_ENGINE_PATH, async { self.fetch(&spec).await?.json(TTS_ENGINE_PATH) }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_parses_with_and_without_a_choice() {
        let v: TtsEngineChoice = serde_json::from_str(
            r#"{"ok":true,"model":"babelcast-tts-pocket","deployment":"babelcast-3090","engine":"pocket","selected":true,
                "replica":{"active":"qwen","switching_to":"pocket"}}"#,
        )
        .unwrap();
        assert_eq!((v.engine.as_deref(), v.selected), (Some("pocket"), true));
        assert_eq!(v.replica.unwrap()["switching_to"], "pocket");
        let none: TtsEngineChoice = serde_json::from_str(r#"{"ok":true,"selected":false,"reason":"no_gpu_link"}"#).unwrap();
        assert_eq!((none.selected, none.reason.as_deref(), none.deployment), (false, Some("no_gpu_link"), None));
    }
}

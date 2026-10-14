//! Speech-to-speech: `POST /v1/s2s` and its frame stream (`application/x-aigw-s2s`, port of
//! `sdk/node/s2s-frames.ts`):
//!
//! `[1 byte kind][4 bytes big-endian length][payload]` — kind `E` = one JSON event, kind `A` = raw PCM s16le mono.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::{Buf, Bytes, BytesMut};
use futures_util::stream::{BoxStream, Stream, StreamExt};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::GatewayClient;
use crate::error::{GatewayError, Result};
use crate::http::{Body, FormField, Spec};
use crate::openai::{audio_part_meta, call_options_setters, part_filename};
use crate::types::{CallOptions, TimeoutGroup};

/// Per-stage aliases of a composed turn.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct S2SModels {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tts: Option<String>,
}

/// One history message of a turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct S2SMessage {
    pub role: String,
    pub content: String,
}

/// Mirror of `S2SConfig` (`src/s2s/composite.ts`); `extra` carries newer fields.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct S2SConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<S2SMessage>>,
    /// `{{transcript}}` is replaced by what was heard.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_voice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speak_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stt_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<S2SModels>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// `POST /v1/s2s` request: one utterance + the turn config.
#[derive(Debug, Clone)]
pub struct S2SRequest {
    pub file: Bytes,
    pub filename: Option<String>,
    pub config: S2SConfig,
    pub call: CallOptions,
}

impl S2SRequest {
    /// Request with this audio and config.
    pub fn new(file: impl Into<Bytes>, config: S2SConfig) -> Self {
        Self { file: file.into(), filename: None, config, call: CallOptions::default() }
    }

    call_options_setters!();
}

/// A typed s2s event (the `type` field). Unknown or newer shapes arrive as [`S2SFrame::UnknownEvent`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum S2SEvent {
    Route {
        provider: String,
        #[serde(default)]
        fallback: Option<String>,
        #[serde(default)]
        from: Option<String>,
    },
    Transcript {
        text: String,
        #[serde(default)]
        stt_ms: Option<f64>,
        #[serde(default)]
        at_ms: Option<f64>,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        fallback: Option<String>,
    },
    LlmFirstToken {
        at_ms: f64,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        fallback: Option<String>,
    },
    Sentence {
        text: String,
        #[serde(default)]
        cut_at_ms: Option<f64>,
    },
    AudioFormat {
        encoding: String,
        #[serde(default)]
        sample_rate: Option<u32>,
        #[serde(default)]
        provider: Option<String>,
    },
    FirstAudio {
        at_ms: f64,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        fallback: Option<String>,
    },
    SentenceFailed { text: String, message: String },
    /// In-band error: yielded, not returned as `Err` (with `partial: true` what was sent is valid).
    Error {
        message: String,
        /// Why it broke (`upstream_error`, `upstream_truncated`, `upstream_stalled`…), when the gateway knows.
        #[serde(default)]
        code: Option<String>,
        #[serde(default)]
        stage: Option<String>,
        #[serde(default)]
        partial: Option<bool>,
        #[serde(default)]
        at_ms: Option<f64>,
    },
    Done {
        #[serde(default)]
        reply: Option<String>,
        #[serde(default)]
        transcript: Option<String>,
        #[serde(default)]
        first_audio_ms: Option<f64>,
        #[serde(default)]
        total_ms: f64,
        #[serde(default)]
        stt_ms: Option<f64>,
        #[serde(default)]
        reply_raw: Option<String>,
        #[serde(default)]
        missing_audio: Option<u32>,
        #[serde(default)]
        partial: Option<bool>,
        #[serde(default)]
        empty: Option<bool>,
    },
}

/// One frame of the s2s stream.
#[derive(Debug, Clone, PartialEq)]
pub enum S2SFrame {
    Event(S2SEvent),
    /// An event this crate does not know (raw JSON).
    UnknownEvent(Value),
    /// PCM s16le mono, 24 kHz unless an `audio_format` event says otherwise.
    Audio(Bytes),
}

/// Largest frame payload [`S2SFrameDecoder`] accepts by default: 16 MiB. The gateway writes one JSON event per
/// frame and one PCM chunk per frame (a sentence of 24 kHz s16le audio is ~48 KB a second), so real frames are far
/// smaller; a bigger length prefix means a corrupt stream, and is refused instead of buffering up to 4 GiB.
pub const S2S_MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Incremental decoder of the s2s frames (chunks may split a frame anywhere).
#[derive(Debug)]
pub struct S2SFrameDecoder {
    buf: BytesMut,
    max_frame: usize,
}

impl Default for S2SFrameDecoder {
    fn default() -> Self {
        Self { buf: BytesMut::new(), max_frame: S2S_MAX_FRAME_BYTES }
    }
}

impl S2SFrameDecoder {
    /// A decoder that refuses frames whose payload is longer than `max_frame` bytes.
    pub fn with_max_frame(max_frame: usize) -> Self {
        Self { buf: BytesMut::new(), max_frame }
    }

    /// Bytes of an incomplete frame held back (non-zero at the end of a stream = the stream was cut).
    pub fn pending(&self) -> usize {
        self.buf.len()
    }

    /// Feeds a chunk; returns the whole frames it completed.
    pub fn push(&mut self, chunk: &[u8]) -> std::result::Result<Vec<S2SFrame>, String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while self.buf.len() >= 5 {
            let len = u32::from_be_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
            if len > self.max_frame {
                return Err(format!("s2s: frame of {len} bytes is larger than the {} bytes allowed (corrupt stream?)", self.max_frame));
            }
            if self.buf.len() < 5 + len {
                break;
            }
            let kind = self.buf[0];
            self.buf.advance(5);
            let payload = self.buf.split_to(len).freeze();
            out.push(match kind {
                b'A' => S2SFrame::Audio(payload),
                b'E' => {
                    let v: Value = serde_json::from_slice(&payload).map_err(|e| format!("s2s: bad event JSON: {e}"))?;
                    match serde_json::from_value::<S2SEvent>(v.clone()) {
                        Ok(ev) => S2SFrame::Event(ev),
                        Err(_) => S2SFrame::UnknownEvent(v),
                    }
                }
                k => return Err(format!("s2s: unknown frame kind 0x{k:02x}")),
            });
        }
        Ok(out)
    }
}

/// The frames of one s2s turn. Dropping it closes the connection and the gateway aborts the turn.
pub struct S2SStream {
    path: String,
    body: BoxStream<'static, reqwest::Result<Bytes>>,
    decoder: S2SFrameDecoder,
    ready: std::collections::VecDeque<S2SFrame>,
    done: bool,
}

impl std::fmt::Debug for S2SStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S2SStream").field("pending", &self.decoder.pending()).field("done", &self.done).finish()
    }
}

impl S2SStream {
    fn err(&mut self, message: String) -> Poll<Option<Result<S2SFrame>>> {
        self.done = true;
        Poll::Ready(Some(Err(GatewayError::Stream { path: self.path.clone(), code: "stream_error".into(), message, served: None, details: None })))
    }
}

impl Stream for S2SStream {
    type Item = Result<S2SFrame>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        loop {
            if let Some(f) = this.ready.pop_front() {
                return Poll::Ready(Some(Ok(f)));
            }
            if this.done {
                return Poll::Ready(None);
            }
            match this.body.as_mut().poll_next(cx) {
                Poll::Ready(Some(Ok(bytes))) => match this.decoder.push(&bytes) {
                    Ok(frames) => this.ready.extend(frames),
                    Err(e) => return this.err(e),
                },
                Poll::Ready(Some(Err(e))) => return this.err(e.to_string()),
                Poll::Ready(None) => {
                    let left = this.decoder.pending();
                    if left > 0 {
                        return this.err(format!("s2s stream cut mid-frame ({left} bytes left)"));
                    }
                    this.done = true;
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl GatewayClient {
    /// `POST /v1/s2s`: returns once the response headers arrived; a failure before them (e.g. `503
    /// provider_unavailable`) is an `Err`. Never retried by default (paid call).
    pub async fn s2s(&self, req: S2SRequest) -> Result<S2SStream> {
        let path = "/v1/s2s";
        self.guarded(path, async {
            let config = serde_json::to_string(&req.config)
                .map_err(|e| GatewayError::Config(format!("s2s config does not serialize: {e}")))?;
            let (_, mime) = audio_part_meta(&req.file);
            let form = vec![
                FormField::File {
                    name: "file".into(),
                    bytes: req.file.clone(),
                    filename: part_filename(req.filename.as_deref(), "turn"),
                    mime: mime.to_string(),
                },
                FormField::Text("config".into(), config),
            ];
            let spec = Spec::new(Method::POST, path, TimeoutGroup::S2s, &req.call).body(Body::Form(form)).idempotent(false);
            let resp = self.fetch_stream(&spec).await?;
            Ok(S2SStream {
                path: path.to_string(),
                body: resp.bytes_stream().boxed(),
                decoder: S2SFrameDecoder::default(),
                ready: Default::default(),
                done: false,
            })
        })
        .await
    }
}

#[cfg(test)]
pub(crate) fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = vec![kind];
    v.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    v.extend_from_slice(payload);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_frames_split_anywhere() {
        let mut wire = frame(b'E', br#"{"type":"transcript","text":"oi","stt_ms":120}"#);
        wire.extend(frame(b'A', &[1, 2, 3, 4]));
        wire.extend(frame(b'E', br#"{"type":"something_new","x":1}"#));
        wire.extend(frame(b'E', br#"{"type":"done","transcript":"oi","total_ms":900}"#));
        for cut in 0..wire.len() {
            let mut d = S2SFrameDecoder::default();
            let mut frames = d.push(&wire[..cut]).unwrap();
            frames.extend(d.push(&wire[cut..]).unwrap());
            assert_eq!(d.pending(), 0);
            assert_eq!(frames.len(), 4, "cut at {cut}");
            assert!(matches!(&frames[0], S2SFrame::Event(S2SEvent::Transcript { text, .. }) if text == "oi"));
            assert_eq!(frames[1], S2SFrame::Audio(Bytes::from_static(&[1, 2, 3, 4])));
            assert!(matches!(&frames[2], S2SFrame::UnknownEvent(v) if v["type"] == "something_new"));
            assert!(matches!(&frames[3], S2SFrame::Event(S2SEvent::Done { total_ms, .. }) if *total_ms == 900.0));
        }
    }

    #[test]
    fn unknown_kind_is_an_error() {
        assert!(S2SFrameDecoder::default().push(&frame(b'Z', b"x")).is_err());
    }

    #[test]
    fn oversized_frame_is_refused_from_its_header() {
        // Only the 5-byte header of a ~4 GiB frame: refused at once, nothing buffered.
        let mut d = S2SFrameDecoder::default();
        let err = d.push(&[b'A', 0xFF, 0xFF, 0xFF, 0xF0]).unwrap_err();
        assert!(err.contains("larger than"), "{err}");
        let mut d = S2SFrameDecoder::default();
        let mut hdr = vec![b'A'];
        hdr.extend_from_slice(&((S2S_MAX_FRAME_BYTES + 1) as u32).to_be_bytes());
        assert!(d.push(&hdr).is_err());
        // At the limit: fine (waits for the payload).
        let mut d = S2SFrameDecoder::with_max_frame(8);
        assert!(d.push(&frame(b'A', &[0; 8])).unwrap().len() == 1);
        assert!(d.push(&frame(b'A', &[0; 9])).is_err());
    }

    #[test]
    fn error_event_keeps_the_code() {
        let wire = frame(b'E', br#"{"type":"error","stage":"primary","code":"upstream_truncated","message":"cut","partial":true,"at_ms":12}"#);
        let frames = S2SFrameDecoder::default().push(&wire).unwrap();
        assert_eq!(
            frames[0],
            S2SFrame::Event(S2SEvent::Error {
                message: "cut".into(),
                code: Some("upstream_truncated".into()),
                stage: Some("primary".into()),
                partial: Some(true),
                at_ms: Some(12.0),
            })
        );
        let no_code = S2SFrameDecoder::default().push(&frame(b'E', br#"{"type":"error","message":"x"}"#)).unwrap();
        assert!(matches!(&no_code[0], S2SFrame::Event(S2SEvent::Error { code: None, .. })));
    }

    #[test]
    fn config_serializes_like_the_node_mirror() {
        let cfg = S2SConfig {
            user_template: Some("O jogador diz: \"{{transcript}}\"".into()),
            language: Some("pt".into()),
            models: Some(S2SModels { stt: Some("parle-stt".into()), chat: Some("parle-llm".into()), tts: None }),
            ..S2SConfig::default()
        };
        let v = serde_json::to_value(&cfg).unwrap();
        assert_eq!(v, serde_json::json!({"user_template": "O jogador diz: \"{{transcript}}\"", "language": "pt", "models": {"stt": "parle-stt", "chat": "parle-llm"}}));
    }
}

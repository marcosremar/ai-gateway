//! `GET /v1/audio/transcriptions/stream`: streaming STT over a WebSocket (contract: `docs/api/stt-stream.md`).
//!
//! PCM16 16 kHz mono goes up while the person speaks; `partial` events (the open utterance, with its `stable` prefix that
//! never changes) and one `final` per utterance come back. The vocabulary prompt (slide terms, names) is Whisper's
//! `initial_prompt` on every decode and can change at any time ([`SttStreamSender::set_prompt`]).
//!
//! Every refusal happens before the handshake and is a normal [`GatewayError::Status`] with the batch route's codes
//! (`gpu_not_ready` 503 with `Retry-After`, `no_streaming_backend` 404, `quota_exceeded` 402, …): fall back to
//! [`GatewayClient::transcribe`] on any of them.
//!
//! ```no_run
//! # async fn demo(gw: ai_gateway_sdk::GatewayClient, pcm: Vec<u8>) -> ai_gateway_sdk::Result<()> {
//! use ai_gateway_sdk::{SttStreamEvent, TranscribeStreamRequest};
//!
//! let stream = gw
//!     .transcribe_stream(TranscribeStreamRequest::new("babelcast-stt").language("pt").prompt("Kubernetes, Grafana"))
//!     .await?; // Err(Status { code: "gpu_not_ready", .. }) → use gw.transcribe(..) instead
//! let (tx, mut rx) = stream.split();
//! tokio::spawn(async move {
//!     for frame in pcm.chunks(3200) {
//!         // 100 ms of 16 kHz PCM16
//!         if tx.send_pcm(frame).await.is_err() {
//!             break;
//!         }
//!     }
//!     let _ = tx.flush().await;
//! });
//! while let Some(event) = rx.next_event().await {
//!     match event? {
//!         SttStreamEvent::Partial(p) => println!("{} [{}]", p.stable, p.provisional()),
//!         SttStreamEvent::Final(f) => println!("{} ({})", f.text, f.reason),
//!         SttStreamEvent::Closed { code, .. } => println!("closed {code}"),
//!         _ => {}
//!     }
//! }
//! # Ok(()) }
//! ```
//!
//! The WebSocket client is in this module (RFC 6455 client side over reqwest's HTTP/1.1 upgrade, no extra crate):
//! text and binary frames, fragments, ping → pong, close; no extensions.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use reqwest::header::{CONNECTION, UPGRADE};
use reqwest::Method;
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::client::{enc, GatewayClient};
use crate::error::{status_error, GatewayError, Result};
use crate::http::{send_error, within, Spec};
use crate::openai::call_options_setters;
use crate::types::{CallOptions, Served, TimeoutGroup};

/// Path of the streaming transcription route.
pub const STT_STREAM_PATH: &str = "/v1/audio/transcriptions/stream";

/// Close code: the GPU replica closed, failed or was released (reconnect, or fall back to batch).
pub const CLOSE_GPU_LOST: u16 = 1013;
/// Close code: a quota or the daily budget was crossed mid-stream (the batch route refuses too).
pub const CLOSE_POLICY: u16 = 1008;

/// Largest server message the client accepts (the gateway's text frames are a few KB).
const MAX_MESSAGE: usize = 1 << 20;
/// Audio is sent in frames of at most this many bytes (the gateway refuses frames over 256 KiB).
const MAX_AUDIO_FRAME: usize = 64 * 1024;
const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONTINUATION: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

// ── request ─────────────────────────────────────────────────────────────────

/// `GET /v1/audio/transcriptions/stream` request. The call timeout (default: the `Stt` group, plus [`Self::wait`])
/// bounds the handshake only, up to the gateway's `ready`.
#[derive(Debug, Clone)]
pub struct TranscribeStreamRequest {
    /// The app's STT alias (`babelcast-stt`); admin keys may name `deployment:<name>`.
    pub model: String,
    /// `pt`, `fr`, `en-US`…; `None` = Whisper detects per decode.
    pub language: Option<String>,
    /// Vocabulary prompt for every decode (≤ 4000 characters), sent as the first `config` frame (never in the URL).
    pub prompt: Option<String>,
    /// Seconds of new audio between two decodes (0.2–5, default 1).
    pub chunk_size: Option<f32>,
    /// Longest utterance in seconds (5–28, default 20).
    pub window: Option<f32>,
    /// Seconds of quiet that end an utterance (0.3–3, default 0.9).
    pub silence: Option<f32>,
    /// Wait this long for a cold GPU instead of a 503 at once (≤ 30 s).
    pub wait: Option<Duration>,
    /// `Some(false)` = QA: skip the gateway's hallucination filter on finals.
    pub filter_hallucinations: Option<bool>,
    pub call: CallOptions,
}

impl TranscribeStreamRequest {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            language: None,
            prompt: None,
            chunk_size: None,
            window: None,
            silence: None,
            wait: None,
            filter_hallucinations: None,
            call: CallOptions::default(),
        }
    }

    pub fn language(mut self, language: impl Into<String>) -> Self {
        self.language = Some(language.into()).filter(|l| !l.is_empty());
        self
    }

    pub fn prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(prompt.into()).filter(|p| !p.is_empty());
        self
    }

    pub fn chunk_size(mut self, seconds: f32) -> Self {
        self.chunk_size = Some(seconds);
        self
    }

    pub fn window(mut self, seconds: f32) -> Self {
        self.window = Some(seconds);
        self
    }

    pub fn silence(mut self, seconds: f32) -> Self {
        self.silence = Some(seconds);
        self
    }

    pub fn wait(mut self, wait: Duration) -> Self {
        self.wait = Some(wait);
        self
    }

    pub fn filter_hallucinations(mut self, on: bool) -> Self {
        self.filter_hallucinations = Some(on);
        self
    }

    call_options_setters!();

    /// The query string (percent-encoded; never the prompt).
    pub(crate) fn query(&self) -> String {
        let mut q = vec![format!("model={}", enc(&self.model))];
        if let Some(l) = &self.language {
            q.push(format!("language={}", enc(l)));
        }
        for (name, v) in [("chunk_size", self.chunk_size), ("window", self.window), ("silence", self.silence)] {
            if let Some(v) = v.filter(|v| v.is_finite()) {
                q.push(format!("{name}={v}"));
            }
        }
        if let Some(w) = self.wait {
            q.push(format!("wait_ms={}", w.as_millis().min(30_000)));
        }
        if self.filter_hallucinations == Some(false) {
            q.push("filter_hallucinations=false".into());
        }
        q.join("&")
    }
}

// ── events ──────────────────────────────────────────────────────────────────

fn lenient_ms<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<u64>, D::Error> {
    let v = Option::<f64>::deserialize(d)?;
    Ok(v.filter(|v| v.is_finite() && *v >= 0.0).map(|v| v.round() as u64))
}

/// The gateway's first frame: who serves the stream.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct StreamReady {
    /// The alias asked.
    #[serde(default)]
    pub model: String,
    /// `deployment:<name>`.
    #[serde(default)]
    pub provider: Option<String>,
    /// The replica's STT model (`large-v3`).
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub prompt_chars: usize,
}

/// The open utterance so far. `text` starts with `stable`, and a stable word never changes in a later partial of the
/// same utterance.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct StreamPartial {
    pub utterance: u64,
    pub text: String,
    #[serde(default)]
    pub stable: String,
    /// End of the audio decoded, on the stream's clock (ms of audio sent).
    #[serde(default, deserialize_with = "lenient_ms")]
    pub end_ms: Option<u64>,
}

impl StreamPartial {
    /// The words after the stable prefix (may still change).
    pub fn provisional(&self) -> &str {
        self.text.get(self.stable.len()..).unwrap_or("").trim_start()
    }
}

/// The end of an utterance, decoded fresh over its whole audio (as the batch route would).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct StreamFinal {
    pub utterance: u64,
    /// Empty when the hallucination filter dropped it (see `filtered`).
    pub text: String,
    /// `silence` | `max_length` | `flush`.
    #[serde(default)]
    pub reason: String,
    #[serde(default, deserialize_with = "lenient_ms")]
    pub start_ms: Option<u64>,
    #[serde(default, deserialize_with = "lenient_ms")]
    pub end_ms: Option<u64>,
    #[serde(default, deserialize_with = "lenient_ms")]
    pub audio_ms: Option<u64>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub language_probability: Option<f64>,
    #[serde(default)]
    pub avg_logprob: Option<f64>,
    #[serde(default)]
    pub no_speech_prob: Option<f64>,
    #[serde(default)]
    pub compression_ratio: Option<f64>,
    /// Milliseconds of speech the replica's VAD found in it.
    #[serde(default, deserialize_with = "lenient_ms")]
    pub speech_ms: Option<u64>,
    #[serde(default, deserialize_with = "lenient_ms")]
    pub decode_ms: Option<u64>,
    /// Hallucination-filter reason codes when the gateway emptied it.
    #[serde(default)]
    pub filtered: Vec<String>,
}

/// One event of the stream.
#[derive(Debug, Clone, PartialEq)]
pub enum SttStreamEvent {
    Partial(StreamPartial),
    Final(StreamFinal),
    /// Ack of a `config` (prompt / language change).
    Config { language: Option<String>, prompt_chars: usize },
    /// An in-band error: `bad_frame` (the stream goes on), or the reason sent just before a close (`gpu_lost`,
    /// `quota_exceeded`, `idle`…).
    Error { code: String, message: String },
    Pong,
    /// The stream ended: [`CLOSE_GPU_LOST`] (1013) → reconnect or batch, [`CLOSE_POLICY`] (1008) → stop, 1000 `idle` /
    /// `session_limit` → reconnect. The last event; `next_event` then returns `None`.
    Closed { code: u16, reason: String },
    /// Any other JSON the gateway sends (forward compatibility).
    Other(Value),
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn parse_event(text: &str) -> SttStreamEvent {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return SttStreamEvent::Other(Value::String(text.to_string())),
    };
    let kind = str_field(&v, "type").unwrap_or_default();
    match kind.as_str() {
        "partial" => match serde_json::from_value::<StreamPartial>(v.clone()) {
            Ok(p) => SttStreamEvent::Partial(p),
            Err(_) => SttStreamEvent::Other(v),
        },
        "final" => match serde_json::from_value::<StreamFinal>(v.clone()) {
            Ok(f) => SttStreamEvent::Final(f),
            Err(_) => SttStreamEvent::Other(v),
        },
        "config" => SttStreamEvent::Config {
            language: str_field(&v, "language"),
            prompt_chars: v.get("prompt_chars").and_then(Value::as_u64).unwrap_or(0) as usize,
        },
        "error" => SttStreamEvent::Error {
            code: str_field(&v, "code").unwrap_or_else(|| "error".into()),
            message: str_field(&v, "message").unwrap_or_default(),
        },
        "pong" => SttStreamEvent::Pong,
        _ => SttStreamEvent::Other(v),
    }
}

// ── WebSocket client codec ──────────────────────────────────────────────────

fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    h.write_u128(nanos);
    h.finish()
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (slot, v) in h.iter_mut().zip([a, b, c, d, e]) {
            *slot = slot.wrapping_add(v);
        }
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// `Sec-WebSocket-Accept` for a `Sec-WebSocket-Key` (RFC 6455 §4.2.2).
fn accept_key(key: &str) -> String {
    base64(&sha1(format!("{key}{GUID}").as_bytes()))
}

fn new_key() -> String {
    let mut raw = [0u8; 16];
    raw[..8].copy_from_slice(&random_u64().to_le_bytes());
    raw[8..].copy_from_slice(&random_u64().to_le_bytes());
    base64(&raw)
}

/// One client frame (always masked, RFC 6455 §5.3).
fn encode_frame(opcode: u8, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let len = payload.len();
    let mut out = Vec::with_capacity(len + 14);
    out.push(0x80 | opcode);
    if len < 126 {
        out.push(0x80 | len as u8);
    } else if len < 65_536 {
        out.push(0x80 | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i & 3]));
    out
}

/// A frame read from the front of `buf`.
#[derive(Debug, PartialEq)]
struct Frame {
    fin: bool,
    opcode: u8,
    payload: Vec<u8>,
    used: usize,
}

/// Parses one frame from the front of `buf`: `Ok(None)` = not complete yet.
fn parse_frame(buf: &[u8], max: usize) -> std::result::Result<Option<Frame>, String> {
    if buf.len() < 2 {
        return Ok(None);
    }
    let (b0, b1) = (buf[0], buf[1]);
    if b0 & 0x70 != 0 {
        return Err("reserved bits set (no extension was negotiated)".into());
    }
    let mut len = u64::from(b1 & 0x7f);
    let mut at = 2usize;
    if len == 126 {
        if buf.len() < 4 {
            return Ok(None);
        }
        len = u64::from(u16::from_be_bytes([buf[2], buf[3]]));
        at = 4;
    } else if len == 127 {
        if buf.len() < 10 {
            return Ok(None);
        }
        let mut b = [0u8; 8];
        b.copy_from_slice(&buf[2..10]);
        len = u64::from_be_bytes(b);
        at = 10;
    }
    if len > max as u64 {
        return Err(format!("a frame of {len} bytes is over the {max}-byte limit"));
    }
    let mask = if b1 & 0x80 != 0 {
        if buf.len() < at + 4 {
            return Ok(None);
        }
        let m = [buf[at], buf[at + 1], buf[at + 2], buf[at + 3]];
        at += 4;
        Some(m)
    } else {
        None
    };
    let len = len as usize;
    if buf.len() < at + len {
        return Ok(None);
    }
    let mut payload = buf[at..at + len].to_vec();
    if let Some(m) = mask {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= m[i & 3];
        }
    }
    Ok(Some(Frame { fin: b0 & 0x80 != 0, opcode: b0 & 0x0f, payload, used: at + len }))
}

type BoxRead = Box<dyn AsyncRead + Send + Unpin>;
type BoxWrite = Box<dyn AsyncWrite + Send + Unpin>;

struct Writer {
    io: BoxWrite,
    closed: bool,
}

type SharedWriter = Arc<Mutex<Writer>>;

fn stream_error(code: &str, message: impl Into<String>, served: Option<&Served>) -> GatewayError {
    GatewayError::Stream {
        path: STT_STREAM_PATH.to_string(),
        code: code.to_string(),
        message: message.into(),
        served: served.map(|s| Box::new(s.clone())),
        details: None,
    }
}

async fn write_frame(writer: &SharedWriter, opcode: u8, payload: &[u8]) -> Result<()> {
    let mut w = writer.lock().await;
    if w.closed {
        return Err(stream_error("closed", "the transcription stream is closed", None));
    }
    if opcode == OP_CLOSE {
        w.closed = true;
    }
    let m = random_u64().to_le_bytes();
    let frame = encode_frame(opcode, payload, [m[0], m[1], m[2], m[3]]);
    let mut sent = w.io.write_all(&frame).await;
    if sent.is_ok() {
        sent = w.io.flush().await;
    }
    sent.map_err(|e| stream_error("stream_error", format!("sending to the gateway failed: {e}"), None))
}

fn close_payload(code: u16) -> Vec<u8> {
    code.to_be_bytes().to_vec()
}

// ── sender / receiver ───────────────────────────────────────────────────────

/// Sending half: audio and control frames. Cheap to clone (one socket, frames serialized by a lock). A send cut by
/// dropping its future may leave half a frame on the socket: let sends finish.
#[derive(Clone)]
pub struct SttStreamSender {
    writer: SharedWriter,
}

impl std::fmt::Debug for SttStreamSender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SttStreamSender").finish_non_exhaustive()
    }
}

impl SttStreamSender {
    /// Int16 little-endian PCM, 16 kHz mono (split into frames of at most 64 KiB).
    pub async fn send_pcm(&self, pcm: &[u8]) -> Result<()> {
        for frame in pcm.chunks(MAX_AUDIO_FRAME) {
            write_frame(&self.writer, OP_BINARY, frame).await?;
        }
        Ok(())
    }

    /// 16 kHz mono samples.
    pub async fn send_samples(&self, samples: &[i16]) -> Result<()> {
        let mut pcm = Vec::with_capacity(samples.len() * 2);
        for s in samples {
            pcm.extend_from_slice(&s.to_le_bytes());
        }
        self.send_pcm(&pcm).await
    }

    /// New vocabulary prompt for the next decodes (the open utterance included); `None` = no prompt.
    pub async fn set_prompt(&self, prompt: Option<&str>) -> Result<()> {
        self.control(json!({ "type": "config", "prompt": prompt })).await
    }

    /// Language of the next decodes (auto-swap: the speaker changed language).
    pub async fn set_language(&self, language: &str) -> Result<()> {
        self.control(json!({ "type": "config", "language": language })).await
    }

    /// Decode what is buffered now and end the open utterance (`final` with `reason: "flush"`).
    pub async fn flush(&self) -> Result<()> {
        self.control(json!({ "type": "flush" })).await
    }

    /// In-band ping (answered by [`SttStreamEvent::Pong`]).
    pub async fn ping(&self) -> Result<()> {
        self.control(json!({ "type": "ping" })).await
    }

    /// Sends the close frame (1000). The receiver then gets the gateway's close as [`SttStreamEvent::Closed`].
    pub async fn close(&self) -> Result<()> {
        write_frame(&self.writer, OP_CLOSE, &close_payload(1000)).await
    }

    async fn control(&self, msg: Value) -> Result<()> {
        write_frame(&self.writer, OP_TEXT, msg.to_string().as_bytes()).await
    }
}

/// Receiving half: events in order. `next_event` is safe to cancel (e.g. in `tokio::select!`): bytes are only taken
/// from the socket by a completed read.
pub struct SttStreamReceiver {
    reader: BoxRead,
    writer: SharedWriter,
    buf: Vec<u8>,
    fragments: Vec<u8>,
    fragment_opcode: Option<u8>,
    finished: bool,
}

impl std::fmt::Debug for SttStreamReceiver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SttStreamReceiver").field("finished", &self.finished).finish_non_exhaustive()
    }
}

enum Message {
    Text(String),
    Close(u16, String),
}

impl SttStreamReceiver {
    /// The next event; `None` after [`SttStreamEvent::Closed`] or an error that ended the connection.
    pub async fn next_event(&mut self) -> Option<Result<SttStreamEvent>> {
        match self.next_message().await? {
            Ok(Message::Text(text)) => Some(Ok(parse_event(&text))),
            Ok(Message::Close(code, reason)) => Some(Ok(SttStreamEvent::Closed { code, reason })),
            Err(e) => Some(Err(e)),
        }
    }

    async fn next_message(&mut self) -> Option<Result<Message>> {
        if self.finished {
            return None;
        }
        loop {
            let frame = match parse_frame(&self.buf, MAX_MESSAGE) {
                Err(e) => return Some(Err(self.fail("protocol_error", e).await)),
                Ok(Some(frame)) => frame,
                Ok(None) => {
                    let mut chunk = [0u8; 16 * 1024];
                    match self.reader.read(&mut chunk).await {
                        Ok(0) => {
                            self.finished = true;
                            return Some(Err(stream_error("stream_error", "the connection closed without a close frame", None)));
                        }
                        Ok(n) => {
                            self.buf.extend_from_slice(&chunk[..n]);
                            continue;
                        }
                        Err(e) => {
                            self.finished = true;
                            return Some(Err(stream_error("stream_error", format!("reading from the gateway failed: {e}"), None)));
                        }
                    }
                }
            };
            self.buf.drain(..frame.used);
            match frame.opcode {
                OP_PING => {
                    // Best effort: a failed pong surfaces on the next read.
                    let _ = write_frame(&self.writer, OP_PONG, &frame.payload).await;
                }
                OP_PONG => {}
                OP_CLOSE => {
                    self.finished = true;
                    let code = if frame.payload.len() >= 2 { u16::from_be_bytes([frame.payload[0], frame.payload[1]]) } else { 1005 };
                    let reason = String::from_utf8_lossy(frame.payload.get(2..).unwrap_or(&[])).into_owned();
                    // Echo the close (RFC 6455 §5.5.1) unless we sent ours already.
                    let echo = if code == 1005 { 1000 } else { code };
                    let _ = write_frame(&self.writer, OP_CLOSE, &close_payload(echo)).await;
                    return Some(Ok(Message::Close(code, reason)));
                }
                OP_TEXT | OP_BINARY => {
                    if self.fragment_opcode.is_some() {
                        return Some(Err(self.fail("protocol_error", "a new message inside a fragmented one").await));
                    }
                    if frame.fin {
                        if frame.opcode == OP_TEXT {
                            return Some(Ok(Message::Text(String::from_utf8_lossy(&frame.payload).into_owned())));
                        }
                    } else {
                        self.fragment_opcode = Some(frame.opcode);
                        self.fragments = frame.payload;
                    }
                }
                OP_CONTINUATION => {
                    let Some(opcode) = self.fragment_opcode else {
                        return Some(Err(self.fail("protocol_error", "a continuation without a first fragment").await));
                    };
                    if self.fragments.len() + frame.payload.len() > MAX_MESSAGE {
                        return Some(Err(self.fail("protocol_error", "message too large").await));
                    }
                    self.fragments.extend_from_slice(&frame.payload);
                    if frame.fin {
                        self.fragment_opcode = None;
                        let whole = std::mem::take(&mut self.fragments);
                        if opcode == OP_TEXT {
                            return Some(Ok(Message::Text(String::from_utf8_lossy(&whole).into_owned())));
                        }
                    }
                }
                other => return Some(Err(self.fail("protocol_error", format!("unknown opcode {other}")).await)),
            }
        }
    }

    async fn fail(&mut self, code: &str, message: impl Into<String>) -> GatewayError {
        self.finished = true;
        let _ = write_frame(&self.writer, OP_CLOSE, &close_payload(1002)).await;
        stream_error(code, message, None)
    }
}

/// An open transcription stream. Use it whole (one task sends and reads) or [`Self::split`] it (a capture task sends,
/// another reads). Dropping it closes the connection.
#[derive(Debug)]
pub struct TranscriptionStream {
    ready: StreamReady,
    served: Served,
    sender: SttStreamSender,
    receiver: SttStreamReceiver,
}

impl TranscriptionStream {
    fn from_io(reader: BoxRead, writer: BoxWrite) -> (SttStreamSender, SttStreamReceiver) {
        let writer = Arc::new(Mutex::new(Writer { io: writer, closed: false }));
        (
            SttStreamSender { writer: writer.clone() },
            SttStreamReceiver { reader, writer, buf: Vec::new(), fragments: Vec::new(), fragment_opcode: None, finished: false },
        )
    }

    /// Waits for the gateway's `ready` frame (the first message after the handshake).
    async fn start(mut receiver: SttStreamReceiver, sender: SttStreamSender, served: Served) -> Result<Self> {
        let ready = match receiver.next_message().await {
            Some(Ok(Message::Text(text))) => {
                let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                if v.get("type").and_then(Value::as_str) != Some("ready") {
                    return Err(stream_error("bad_handshake", "the gateway did not start the stream with `ready`", Some(&served)));
                }
                serde_json::from_value::<StreamReady>(v).unwrap_or_default()
            }
            Some(Ok(Message::Close(code, reason))) => {
                return Err(stream_error("closed", format!("the gateway closed the stream at once ({code} {reason})"), Some(&served)))
            }
            Some(Err(e)) => return Err(e),
            None => return Err(stream_error("closed", "the stream ended before `ready`", Some(&served))),
        };
        Ok(Self { ready, served, sender, receiver })
    }

    /// Who serves the stream (`provider: deployment:<name>`, `engine: large-v3`).
    pub fn ready(&self) -> &StreamReady {
        &self.ready
    }

    /// `X-Gateway-*` headers of the handshake.
    pub fn served(&self) -> &Served {
        &self.served
    }

    /// A sending handle (shares the socket with this stream).
    pub fn sender(&self) -> SttStreamSender {
        self.sender.clone()
    }

    pub async fn send_pcm(&self, pcm: &[u8]) -> Result<()> {
        self.sender.send_pcm(pcm).await
    }

    pub async fn send_samples(&self, samples: &[i16]) -> Result<()> {
        self.sender.send_samples(samples).await
    }

    pub async fn set_prompt(&self, prompt: Option<&str>) -> Result<()> {
        self.sender.set_prompt(prompt).await
    }

    pub async fn set_language(&self, language: &str) -> Result<()> {
        self.sender.set_language(language).await
    }

    pub async fn flush(&self) -> Result<()> {
        self.sender.flush().await
    }

    pub async fn next_event(&mut self) -> Option<Result<SttStreamEvent>> {
        self.receiver.next_event().await
    }

    /// Sends the close frame and waits (up to 5 s) for the gateway's close; the events still in flight are dropped.
    pub async fn close(mut self) -> Result<()> {
        self.sender.close().await?;
        let drain = async {
            while let Some(event) = self.receiver.next_event().await {
                if matches!(event, Ok(SttStreamEvent::Closed { .. }) | Err(_)) {
                    break;
                }
            }
        };
        let _ = tokio::time::timeout(Duration::from_secs(5), drain).await;
        Ok(())
    }

    /// The two halves, for a sending task and a reading task.
    pub fn split(self) -> (SttStreamSender, SttStreamReceiver) {
        (self.sender, self.receiver)
    }
}

// ── connect ─────────────────────────────────────────────────────────────────

impl GatewayClient {
    /// Opens `GET /v1/audio/transcriptions/stream` (WebSocket) and waits for the gateway's `ready`; the request's prompt
    /// is sent as the first `config` frame. Every refusal is a [`GatewayError::Status`] with the batch route's codes
    /// (`gpu_not_ready` 503 + `Retry-After`, `no_streaming_backend` 404, `quota_exceeded` 402, `stream_unsupported`
    /// 502…): fall back to [`GatewayClient::transcribe`]. Never retried (it is paid and stateful).
    pub async fn transcribe_stream(&self, req: TranscribeStreamRequest) -> Result<TranscriptionStream> {
        self.guarded(STT_STREAM_PATH, self.open_transcription_stream(&req)).await
    }

    async fn open_transcription_stream(&self, req: &TranscribeStreamRequest) -> Result<TranscriptionStream> {
        let base = req.call.timeout.unwrap_or_else(|| self.inner.timeouts.get(TimeoutGroup::Stt));
        let timeout = if base.is_zero() { Duration::ZERO } else { base + req.wait.unwrap_or_default().min(Duration::from_secs(30)) };
        let deadline = (!timeout.is_zero()).then(|| Instant::now() + timeout);
        let timed_out = |headers_received| GatewayError::Timeout { path: STT_STREAM_PATH.to_string(), after: timeout, headers_received };

        let spec = Spec::new(Method::GET, format!("{STT_STREAM_PATH}?{}", req.query()), TimeoutGroup::Stt, &req.call);
        let key = new_key();
        let http = self.inner.ws_http.as_ref().unwrap_or(&self.inner.http);
        let rb = self
            .request_with(http, &spec)?
            .version(reqwest::Version::HTTP_11)
            .header(CONNECTION, "Upgrade")
            .header(UPGRADE, "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", key.as_str());
        let resp = match within(deadline, rb.send()).await {
            None => return Err(timed_out(false)),
            Some(Err(e)) => return Err(send_error(STT_STREAM_PATH, e)),
            Some(Ok(r)) => r,
        };
        let status = resp.status();
        let headers = resp.headers().clone();
        if status != reqwest::StatusCode::SWITCHING_PROTOCOLS {
            let body = match within(deadline, resp.bytes()).await {
                None => return Err(timed_out(true)),
                Some(Ok(b)) => b,
                Some(Err(_)) => Bytes::new(),
            };
            return Err(status_error(status.as_u16(), &headers, &body, STT_STREAM_PATH));
        }
        let served = Served::from_headers(&headers);
        let accept = headers.get("sec-websocket-accept").and_then(|v| v.to_str().ok()).unwrap_or("");
        if accept != accept_key(&key) {
            return Err(stream_error("bad_handshake", "the gateway answered the upgrade with a wrong Sec-WebSocket-Accept", Some(&served)));
        }
        let upgraded = match within(deadline, resp.upgrade()).await {
            None => return Err(timed_out(true)),
            Some(Err(e)) => return Err(stream_error("stream_error", format!("the upgrade failed: {e}"), Some(&served))),
            Some(Ok(u)) => u,
        };
        let (reader, writer) = tokio::io::split(upgraded);
        let (sender, receiver) = TranscriptionStream::from_io(Box::new(reader), Box::new(writer));
        let stream = match within(deadline, TranscriptionStream::start(receiver, sender, served)).await {
            None => return Err(timed_out(true)),
            Some(r) => r?,
        };
        if let Some(prompt) = req.prompt.as_deref() {
            stream.set_prompt(Some(prompt)).await?;
        }
        Ok(stream)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::future::BoxFuture;
    use futures_util::FutureExt;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::TcpListener;

    /// `"<opcode>:<payload as JSON>"` as the fake gateway reports a client text frame.
    fn json_frame(seen: &str) -> (u8, Value) {
        let (op, payload) = seen.split_once(':').unwrap();
        (op.parse().unwrap(), serde_json::from_str(payload).unwrap())
    }

    #[test]
    fn sha1_base64_and_the_rfc_accept_key() {
        assert_eq!(base64(&sha1(b"abc")), "qZk+NkcGgWq6PiVxeFDCbJzQ2J0=");
        assert_eq!(base64(&sha1(b"")), "2jmj7l5rSw0yVb/vlWAYkK/YBwk=");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        // RFC 6455 §1.3.
        assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGAzzGZRRbqLE=");
        assert_eq!(new_key().len(), 24);
        assert_ne!(new_key(), new_key());
    }

    #[test]
    fn frames_round_trip_with_every_length_encoding() {
        for len in [0usize, 5, 125, 126, 300, 65_535, 65_536, 70_000] {
            let payload: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let wire = encode_frame(OP_BINARY, &payload, [1, 2, 3, 4]);
            assert_eq!(wire[1] & 0x80, 0x80, "client frames are masked");
            let frame = parse_frame(&wire, MAX_MESSAGE).unwrap().unwrap();
            assert_eq!((frame.fin, frame.opcode, frame.used), (true, OP_BINARY, wire.len()));
            assert_eq!(frame.payload, payload);
            assert_eq!(parse_frame(&wire[..wire.len() - 1], MAX_MESSAGE).unwrap(), None, "incomplete");
        }
        assert!(parse_frame(&[0x82, 127, 0, 0, 0, 0, 0, 0x20, 0, 0], MAX_MESSAGE).is_err(), "over the limit");
        assert!(parse_frame(&[0xC1, 0], MAX_MESSAGE).is_err(), "reserved bit");
    }

    #[test]
    fn events_parse_and_unknown_ones_are_kept() {
        let p = parse_event(r#"{"type":"partial","utterance":2,"text":"Bom dia a todos","stable":"Bom dia","end_ms":2100.0}"#);
        let SttStreamEvent::Partial(p) = p else { panic!("{p:?}") };
        assert_eq!((p.utterance, p.provisional(), p.end_ms), (2, "a todos", Some(2100)));
        let f = parse_event(
            r#"{"type":"final","utterance":2,"text":"","reason":"silence","start_ms":0,"end_ms":3400,"audio_ms":3400,
                "avg_logprob":-0.2,"speech_ms":2900,"filtered":["pattern_credits"]}"#,
        );
        let SttStreamEvent::Final(f) = f else { panic!("{f:?}") };
        assert_eq!((f.reason.as_str(), f.speech_ms, f.filtered.len()), ("silence", Some(2900), 1));
        assert_eq!(
            parse_event(r#"{"type":"config","language":"fr","prompt_chars":16}"#),
            SttStreamEvent::Config { language: Some("fr".into()), prompt_chars: 16 }
        );
        assert_eq!(
            parse_event(r#"{"type":"error","code":"gpu_lost","message":"x"}"#),
            SttStreamEvent::Error { code: "gpu_lost".into(), message: "x".into() }
        );
        assert_eq!(parse_event(r#"{"type":"pong"}"#), SttStreamEvent::Pong);
        assert!(matches!(parse_event(r#"{"type":"news"}"#), SttStreamEvent::Other(_)));
        assert!(matches!(parse_event("not json"), SttStreamEvent::Other(Value::String(_))));
    }

    #[test]
    fn the_query_carries_no_prompt() {
        let q = TranscribeStreamRequest::new("babelcast-stt")
            .language("pt-BR")
            .prompt("Ksawery Wiśniewski")
            .chunk_size(0.5)
            .wait(Duration::from_secs(90))
            .filter_hallucinations(false)
            .query();
        assert_eq!(q, "model=babelcast-stt&language=pt-BR&chunk_size=0.5&wait_ms=30000&filter_hallucinations=false");
    }

    /// Server side of the fake gateway: reads masked client frames, writes unmasked ones.
    async fn read_client_frame(sock: &mut (impl AsyncRead + Unpin), buf: &mut Vec<u8>) -> (u8, Vec<u8>) {
        loop {
            if let Some(f) = parse_frame(buf, MAX_MESSAGE).unwrap() {
                buf.drain(..f.used);
                return (f.opcode, f.payload);
            }
            let mut chunk = [0u8; 4096];
            let n = sock.read(&mut chunk).await.unwrap();
            assert!(n > 0, "client hung up");
            buf.extend_from_slice(&chunk[..n]);
        }
    }

    fn server_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![0x80 | opcode];
        assert!(payload.len() < 126);
        out.push(payload.len() as u8);
        out.extend_from_slice(payload);
        out
    }

    async fn fake_gateway(script: impl FnOnce(tokio::net::TcpStream, String) -> BoxFuture<'static, ()> + Send + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(sock);
            let mut head = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                head.push_str(&line);
            }
            script(reader.into_inner(), head).await;
        });
        format!("http://{addr}")
    }

    fn header<'a>(head: &'a str, name: &str) -> &'a str {
        head.lines()
            .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case(name)).map(|(_, v)| v.trim()))
            .unwrap_or("")
    }

    #[tokio::test]
    async fn streams_audio_and_reads_events_through_a_real_upgrade() {
        let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let base = fake_gateway(move |mut sock, head| {
            async move {
                seen_tx.send(head.lines().next().unwrap_or("").to_string()).unwrap();
                seen_tx.send(header(&head, "authorization").to_string()).unwrap();
                let accept = accept_key(header(&head, "sec-websocket-key"));
                sock.write_all(
                    format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nX-Gateway-Provider: deployment:babelcast-3090\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
                let ready = br#"{"type":"ready","model":"babelcast-stt","provider":"deployment:babelcast-3090","engine":"large-v3","language":"pt","prompt_chars":0}"#;
                let mut out = vec![0x81, 126];
                out.extend_from_slice(&(ready.len() as u16).to_be_bytes());
                out.extend_from_slice(ready);
                sock.write_all(&out).await.unwrap();
                let mut buf = Vec::new();
                let (op, payload) = read_client_frame(&mut sock, &mut buf).await;
                seen_tx.send(format!("{op}:{}", String::from_utf8_lossy(&payload))).unwrap();
                let (op, payload) = read_client_frame(&mut sock, &mut buf).await;
                seen_tx.send(format!("{op}:{}", payload.len())).unwrap();
                sock.write_all(&server_frame(OP_PING, b"hi")).await.unwrap();
                let (op, payload) = read_client_frame(&mut sock, &mut buf).await;
                seen_tx.send(format!("pong {op}:{}", String::from_utf8_lossy(&payload))).unwrap();
                // A partial in two fragments, then a final.
                let partial = br#"{"type":"partial","utterance":0,"text":"bom dia","stable":"bom"}"#;
                sock.write_all(&[0x01, 20]).await.unwrap();
                sock.write_all(&partial[..20]).await.unwrap();
                let rest = &partial[20..];
                sock.write_all(&[0x80, rest.len() as u8]).await.unwrap();
                sock.write_all(rest).await.unwrap();
                let (op, payload) = read_client_frame(&mut sock, &mut buf).await;
                seen_tx.send(format!("{op}:{}", String::from_utf8_lossy(&payload))).unwrap();
                sock.write_all(&server_frame(OP_TEXT, br#"{"type":"final","utterance":0,"text":"Bom dia.","reason":"flush"}"#))
                    .await
                    .unwrap();
                let mut close = 1013u16.to_be_bytes().to_vec();
                close.extend_from_slice(b"gpu_lost");
                sock.write_all(&server_frame(OP_CLOSE, &close)).await.unwrap();
                let (op, payload) = read_client_frame(&mut sock, &mut buf).await;
                seen_tx.send(format!("close {op}:{:?}", payload)).unwrap();
            }
            .boxed()
        })
        .await;

        let gw = GatewayClient::new(base, "ucast_live_test").unwrap();
        let mut stream = gw
            .transcribe_stream(TranscribeStreamRequest::new("babelcast-stt").language("pt").prompt("Grafana"))
            .await
            .unwrap();
        assert_eq!(stream.ready().provider.as_deref(), Some("deployment:babelcast-3090"));
        assert_eq!(stream.ready().engine.as_deref(), Some("large-v3"));
        assert_eq!(stream.served().provider.as_deref(), Some("deployment:babelcast-3090"));
        assert_eq!(seen_rx.recv().await.unwrap(), "GET /v1/audio/transcriptions/stream?model=babelcast-stt&language=pt HTTP/1.1");
        assert_eq!(seen_rx.recv().await.unwrap(), "Bearer ucast_live_test");
        assert_eq!(
            json_frame(&seen_rx.recv().await.unwrap()),
            (OP_TEXT, json!({ "type": "config", "prompt": "Grafana" })),
            "the prompt goes as the first config frame, never in the URL"
        );

        stream.send_samples(&[1000i16; 1600]).await.unwrap();
        assert_eq!(seen_rx.recv().await.unwrap(), "2:3200");
        let (tx, mut rx) = stream.split();
        // The gateway pings before the partial: the receiver answers it while reading.
        let SttStreamEvent::Partial(p) = rx.next_event().await.unwrap().unwrap() else { panic!("partial") };
        assert_eq!((p.text.as_str(), p.stable.as_str(), p.provisional()), ("bom dia", "bom", "dia"));
        assert_eq!(seen_rx.recv().await.unwrap(), "pong 10:hi");
        tx.flush().await.unwrap();
        assert_eq!(json_frame(&seen_rx.recv().await.unwrap()), (OP_TEXT, json!({ "type": "flush" })));
        let SttStreamEvent::Final(f) = rx.next_event().await.unwrap().unwrap() else { panic!("final") };
        assert_eq!(f.text, "Bom dia.");
        assert_eq!(
            rx.next_event().await.unwrap().unwrap(),
            SttStreamEvent::Closed { code: CLOSE_GPU_LOST, reason: "gpu_lost".into() }
        );
        assert_eq!(seen_rx.recv().await.unwrap(), "close 8:[3, 245]", "the close is echoed with its code");
        assert!(rx.next_event().await.is_none());
        assert_eq!(tx.send_pcm(&[0, 0]).await.unwrap_err().code(), "closed");
    }

    #[tokio::test]
    async fn a_refusal_before_the_handshake_is_the_batch_routes_status_error() {
        let base = fake_gateway(|mut sock, _head| {
            async move {
                let body = r#"{"error":{"message":"the GPU for 'babelcast-stt' is not ready","type":"provider_unavailable","code":"gpu_not_ready"}}"#;
                sock.write_all(
                    format!("HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nRetry-After: 30\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                        .as_bytes(),
                )
                .await
                .unwrap();
            }
            .boxed()
        })
        .await;
        let gw = GatewayClient::new(base, "k").unwrap();
        let err = gw.transcribe_stream(TranscribeStreamRequest::new("babelcast-stt")).await.unwrap_err();
        assert_eq!((err.status(), err.code()), (Some(503), "gpu_not_ready"));
        assert_eq!(err.retry_after(), Some(Duration::from_secs(30)));
        assert!(!err.is_unreachable(), "the gateway answered: fall back to batch, the gateway is up");
    }

    #[tokio::test]
    async fn a_wrong_accept_key_is_refused() {
        let base = fake_gateway(|mut sock, _head| {
            async move {
                sock.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: nope\r\n\r\n")
                    .await
                    .unwrap();
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            .boxed()
        })
        .await;
        let gw = GatewayClient::new(base, "k").unwrap();
        let err = gw.transcribe_stream(TranscribeStreamRequest::new("babelcast-stt")).await.unwrap_err();
        assert_eq!(err.code(), "bad_handshake");
    }
}

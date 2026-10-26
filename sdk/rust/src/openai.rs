//! OpenAI-compatible routes: `POST /v1/audio/transcriptions`, `POST /v1/chat/completions` (buffered and SSE),
//! `POST /v1/audio/speech` (buffered and streamed).

use bytes::Bytes;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::GatewayClient;
use crate::error::{GatewayError, Result};
use crate::http::{Body, FormField, Spec};
use crate::stream::{ChatStream, SpeechStream};
use crate::types::{CallOptions, Served, TimeoutGroup};

macro_rules! call_options_setters {
    () => {
        /// Overrides the group timeout for this call.
        pub fn timeout(mut self, timeout: ::std::time::Duration) -> Self {
            self.call.timeout = Some(timeout);
            self
        }

        /// End-user device id (`X-Gateway-Device`).
        pub fn device(mut self, device: impl Into<String>) -> Self {
            self.call.device = Some(device.into());
            self
        }

        /// Request id (`X-Request-Id`).
        pub fn request_id(mut self, id: impl Into<String>) -> Self {
            self.call.request_id = Some(id.into());
            self
        }

        /// Never start (or keep alive) a rented machine for this call (`X-Gateway-No-Wake: 1`): a cold deployment
        /// target is skipped and the route falls through to its cloud fallback.
        pub fn no_wake(mut self, on: bool) -> Self {
            self.call.no_wake = on;
            self
        }
    };
}
pub(crate) use call_options_setters;

// ── STT ─────────────────────────────────────────────────────────────────────

/// `response_format` of a transcription.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseFormat {
    Json,
    Text,
    Srt,
    /// `language`, `duration` and the kept `segments` next to `text`.
    VerboseJson,
    Vtt,
}

impl ResponseFormat {
    /// The wire value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Text => "text",
            Self::Srt => "srt",
            Self::VerboseJson => "verbose_json",
            Self::Vtt => "vtt",
        }
    }
}

/// `POST /v1/audio/transcriptions` request (multipart `file` + `model` + optional fields).
#[derive(Debug, Clone)]
pub struct TranscribeRequest {
    /// The audio (WAV, Ogg/Opus, FLAC, MP3, WebM…).
    pub file: Bytes,
    /// File name of the part; default from the container ([`audio_part_meta`]).
    pub filename: Option<String>,
    /// MIME type of the part; default from the container.
    pub mime: Option<String>,
    /// The app's STT alias (`parle-stt`, `babelcast-stt`…) or a model name (admin keys).
    pub model: String,
    pub language: Option<String>,
    /// Whisper prompt (vocabulary, previous sentences).
    pub prompt: Option<String>,
    pub response_format: Option<ResponseFormat>,
    /// `Some(false)` = QA: skip the gateway's hallucination filter (`filter_hallucinations=false`).
    pub filter_hallucinations: Option<bool>,
    /// Extra multipart text fields, sent as-is.
    pub extra_fields: Vec<(String, String)>,
    pub call: CallOptions,
}

impl TranscribeRequest {
    /// Request for `model` with this audio.
    pub fn new(model: impl Into<String>, file: impl Into<Bytes>) -> Self {
        Self {
            file: file.into(),
            filename: None,
            mime: None,
            model: model.into(),
            language: None,
            prompt: None,
            response_format: None,
            filter_hallucinations: None,
            extra_fields: Vec::new(),
            call: CallOptions::default(),
        }
    }

    /// Spoken language (`pt`, `pt-BR` or `Portuguese`). Empty = not sent.
    pub fn language(mut self, language: impl Into<String>) -> Self {
        self.language = Some(language.into()).filter(|l| !l.is_empty());
        self
    }

    /// Whisper prompt. Empty = not sent.
    pub fn prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(prompt.into()).filter(|p| !p.is_empty());
        self
    }

    /// `response_format`.
    pub fn response_format(mut self, format: ResponseFormat) -> Self {
        self.response_format = Some(format);
        self
    }

    /// `response_format=verbose_json` (detected language, duration, segments).
    pub fn verbose(self) -> Self {
        self.response_format(ResponseFormat::VerboseJson)
    }

    /// File name of the multipart part. Empty (or blank) = the default from the container: the gateway only treats a
    /// part with a non-empty `filename="…"` as a file.
    pub fn filename(mut self, name: impl Into<String>) -> Self {
        self.filename = Some(name.into());
        self
    }

    /// MIME type of the multipart part.
    pub fn mime(mut self, mime: impl Into<String>) -> Self {
        self.mime = Some(mime.into());
        self
    }

    /// `filter_hallucinations` (false = QA opt-out).
    pub fn filter_hallucinations(mut self, on: bool) -> Self {
        self.filter_hallucinations = Some(on);
        self
    }

    /// Adds an extra multipart text field.
    pub fn field(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra_fields.push((name.into(), value.into()));
        self
    }

    call_options_setters!();

    pub(crate) fn form(&self) -> Vec<FormField> {
        let (filename, mime) = audio_part_meta(&self.file);
        let mut fields = vec![
            FormField::File {
                name: "file".into(),
                bytes: self.file.clone(),
                filename: part_filename(self.filename.as_deref(), filename),
                mime: self.mime.clone().filter(|m| !m.trim().is_empty()).unwrap_or_else(|| mime.to_string()),
            },
            FormField::Text("model".into(), self.model.clone()),
        ];
        let mut text = |k: &str, v: Option<String>| {
            if let Some(v) = v {
                fields.push(FormField::Text(k.into(), v));
            }
        };
        text("language", self.language.clone());
        text("prompt", self.prompt.clone());
        text("response_format", self.response_format.map(|f| f.as_str().to_string()));
        text("filter_hallucinations", self.filter_hallucinations.map(|on| on.to_string()));
        for (k, v) in &self.extra_fields {
            fields.push(FormField::Text(k.clone(), v.clone()));
        }
        fields
    }
}

/// The part's file name: `name` unless it is blank, else `default`. The gateway's multipart parser
/// (`filename="([^"]+)"`, `src/gateway/proxy/server.ts`) does not see a part with an empty file name as a file.
pub(crate) fn part_filename(name: Option<&str>, default: &str) -> String {
    match name {
        Some(n) if !n.trim().is_empty() => n.to_string(),
        _ => default.to_string(),
    }
}

/// File name and MIME type of an audio part, from its container's magic bytes (Ogg, WAV, FLAC, MP3, WebM, MP4);
/// `("audio", "application/octet-stream")` when unknown.
pub fn audio_part_meta(audio: &[u8]) -> (&'static str, &'static str) {
    if audio.starts_with(b"OggS") {
        ("audio.ogg", "audio/ogg")
    } else if audio.starts_with(b"RIFF") && audio.get(8..12) == Some(b"WAVE") {
        ("audio.wav", "audio/wav")
    } else if audio.starts_with(b"fLaC") {
        ("audio.flac", "audio/flac")
    } else if audio.starts_with(b"ID3") || (audio.len() > 1 && audio[0] == 0xFF && audio[1] & 0xE0 == 0xE0) {
        ("audio.mp3", "audio/mpeg")
    } else if audio.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        ("audio.webm", "audio/webm")
    } else if audio.get(4..8) == Some(b"ftyp") {
        ("audio.m4a", "audio/mp4")
    } else {
        ("audio", "application/octet-stream")
    }
}

/// A transcription (`json` / `verbose_json`; other formats land in `text`).
#[derive(Debug, Clone, PartialEq)]
pub struct Transcription {
    pub text: String,
    /// Language the provider detected (`fr`, or `french` on some providers), when given.
    pub language: Option<String>,
    pub language_probability: Option<f64>,
    /// Seconds of audio (`verbose_json`).
    pub duration: Option<f64>,
    /// Kept segments (`verbose_json`).
    pub segments: Option<Vec<Value>>,
    /// The whole answer (a JSON string for non-JSON formats).
    pub raw: Value,
    pub served: Served,
    /// `X-STT-Filtered`: hallucination-filter reason codes, `none`, or `off`.
    pub stt_filtered: Option<String>,
    /// `X-STT-Raw-Length`: characters the provider returned before filtering.
    pub stt_raw_length: Option<usize>,
}

impl Transcription {
    pub(crate) fn parse(bytes: &[u8], served: Served, filtered: Option<String>, raw_len: Option<String>) -> Self {
        let raw: Value = serde_json::from_slice(bytes)
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| Value::String(String::from_utf8_lossy(bytes).into_owned()));
        let (text, language, language_probability, duration, segments) = match &raw {
            Value::Object(o) => (
                o.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
                o.get("language").and_then(Value::as_str).map(str::to_string),
                o.get("language_probability").and_then(Value::as_f64),
                o.get("duration").and_then(Value::as_f64),
                o.get("segments").and_then(Value::as_array).cloned(),
            ),
            Value::String(s) => (s.clone(), None, None, None, None),
            _ => Default::default(),
        };
        Self {
            text,
            language,
            language_probability,
            duration,
            segments,
            raw,
            served,
            stt_filtered: filtered,
            stt_raw_length: raw_len.and_then(|v| v.trim().parse().ok()),
        }
    }
}

// ── Chat ────────────────────────────────────────────────────────────────────

/// Message content: plain text or multimodal parts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<Value>),
}

impl From<&str> for MessageContent {
    fn from(s: &str) -> Self {
        Self::Text(s.to_string())
    }
}

impl From<String> for MessageContent {
    fn from(s: String) -> Self {
        Self::Text(s)
    }
}

/// One chat message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    /// `system`, `user`, `assistant`, `tool`…
    pub role: String,
    pub content: MessageContent,
    /// Other fields (`name`, `tool_call_id`…).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ChatMessage {
    /// A message with this role and content.
    pub fn new(role: impl Into<String>, content: impl Into<MessageContent>) -> Self {
        Self { role: role.into(), content: content.into(), extra: Map::new() }
    }

    pub fn system(content: impl Into<MessageContent>) -> Self {
        Self::new("system", content)
    }

    pub fn user(content: impl Into<MessageContent>) -> Self {
        Self::new("user", content)
    }

    pub fn assistant(content: impl Into<MessageContent>) -> Self {
        Self::new("assistant", content)
    }
}

/// `POST /v1/chat/completions` request.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ChatRequest {
    /// The app's chat alias (`parle-llm`, `babelcast-llm`…) — required by the gateway.
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    /// A string or an array of strings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    /// e.g. `{"type": "json_object"}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<Value>,
    /// e.g. `{"include_usage": true}` (streamed calls).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<Value>,
    /// Extra body fields, merged into the JSON body as-is (they override the fields above).
    #[serde(skip)]
    pub extra_body: Map<String, Value>,
    #[serde(skip)]
    pub call: CallOptions,
}

impl ChatRequest {
    /// Request for `model` with these messages.
    pub fn new(model: impl Into<String>, messages: Vec<ChatMessage>) -> Self {
        Self { model: model.into(), messages, ..Self::default() }
    }

    pub fn temperature(mut self, t: f64) -> Self {
        self.temperature = Some(t);
        self
    }

    pub fn max_tokens(mut self, n: u32) -> Self {
        self.max_tokens = Some(n);
        self
    }

    pub fn top_p(mut self, p: f64) -> Self {
        self.top_p = Some(p);
        self
    }

    pub fn seed(mut self, seed: i64) -> Self {
        self.seed = Some(seed);
        self
    }

    /// `response_format: {"type": "json_object"}`.
    pub fn json_object(mut self) -> Self {
        self.response_format = Some(serde_json::json!({ "type": "json_object" }));
        self
    }

    /// `stream_options.include_usage`: asks the provider for a final usage chunk on a streamed call, so
    /// [`ChatStream::usage`] is set at the end (providers that ignore it still send none).
    pub fn include_usage(mut self, on: bool) -> Self {
        let mut opts = match self.stream_options.take() {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        opts.insert("include_usage".into(), Value::Bool(on));
        self.stream_options = Some(Value::Object(opts));
        self
    }

    /// Adds one extra body field.
    pub fn extra(mut self, key: impl Into<String>, value: Value) -> Self {
        self.extra_body.insert(key.into(), value);
        self
    }

    call_options_setters!();

    /// The JSON body sent: the fields, then `extra_body`, then `stream`.
    pub fn to_body(&self, stream: bool) -> Value {
        let mut body = match serde_json::to_value(self) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        };
        for (k, v) in &self.extra_body {
            body.insert(k.clone(), v.clone());
        }
        body.insert("stream".into(), Value::Bool(stream));
        Value::Object(body)
    }
}

/// Token usage.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
}

/// The assistant message of a choice.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ResponseMessage {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One choice of a completion.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ChatChoice {
    #[serde(default)]
    pub index: u32,
    #[serde(default)]
    pub message: ResponseMessage,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

/// A non-streamed chat completion.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ChatCompletion {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub object: String,
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub choices: Vec<ChatChoice>,
    #[serde(default)]
    pub usage: Option<ChatUsage>,
    /// Where the answer came from (headers, not body).
    #[serde(skip)]
    pub served: Served,
}

impl ChatCompletion {
    /// Content of the first choice.
    pub fn content(&self) -> Option<&str> {
        self.choices.first().and_then(|c| c.message.content.as_deref())
    }
}

// ── TTS ─────────────────────────────────────────────────────────────────────

/// Voice-cloning reference (Qwen3-TTS *Base* on a self-hosted deployment): sent as `task_type: "Base"`, `ref_audio`,
/// `ref_text`. Only `deployment:` targets get these fields; cloud fallbacks answer in a preset voice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TtsClone {
    /// The voice audio: a data URL (`data:audio/wav;base64,…`).
    pub ref_audio: String,
    /// Exactly what the audio says.
    pub ref_text: String,
}

/// `POST /v1/audio/speech` request.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpeechRequest {
    /// The app's TTS alias (`parle-tts`, `babelcast-tts`…).
    pub model: String,
    pub input: String,
    /// Required by the gateway (kept even with a clone reference; the gateway drops it then).
    pub voice: String,
    /// Voice for a fallback provider that does not know `voice` (e.g. Kokoro `pf_dora`).
    pub fallback_voice: Option<String>,
    /// `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`.
    pub response_format: Option<String>,
    pub speed: Option<f64>,
    /// Language of the text (`pt`, or `French` for Qwen3-TTS).
    pub language: Option<String>,
    /// Speaking style (`calm, slower…`), followed by Qwen3-TTS.
    pub instructions: Option<String>,
    pub stream: Option<bool>,
    pub clone: Option<TtsClone>,
    /// Other fields, merged as-is (self-hosted targets get them; they override the fields above).
    pub extra: Map<String, Value>,
    pub call: CallOptions,
}

impl SpeechRequest {
    /// Request for `model` saying `input` with `voice`.
    pub fn new(model: impl Into<String>, input: impl Into<String>, voice: impl Into<String>) -> Self {
        Self { model: model.into(), input: input.into(), voice: voice.into(), ..Self::default() }
    }

    pub fn fallback_voice(mut self, v: impl Into<String>) -> Self {
        self.fallback_voice = Some(v.into());
        self
    }

    pub fn response_format(mut self, f: impl Into<String>) -> Self {
        self.response_format = Some(f.into());
        self
    }

    pub fn speed(mut self, s: f64) -> Self {
        self.speed = Some(s);
        self
    }

    /// Empty = not sent.
    pub fn language(mut self, l: impl Into<String>) -> Self {
        self.language = Some(l.into()).filter(|l| !l.is_empty());
        self
    }

    pub fn instructions(mut self, i: impl Into<String>) -> Self {
        self.instructions = Some(i.into());
        self
    }

    pub fn stream(mut self, on: bool) -> Self {
        self.stream = Some(on);
        self
    }

    /// Clone this voice (`task_type: "Base"`, `ref_audio`, `ref_text`).
    pub fn clone_voice(mut self, ref_audio: impl Into<String>, ref_text: impl Into<String>) -> Self {
        self.clone = Some(TtsClone { ref_audio: ref_audio.into(), ref_text: ref_text.into() });
        self
    }

    /// Adds one extra body field.
    pub fn extra(mut self, key: impl Into<String>, value: Value) -> Self {
        self.extra.insert(key.into(), value);
        self
    }

    call_options_setters!();

    /// The JSON body sent.
    pub fn to_body(&self) -> Value {
        let mut b = Map::new();
        b.insert("model".into(), self.model.clone().into());
        b.insert("input".into(), self.input.clone().into());
        b.insert("voice".into(), self.voice.clone().into());
        let mut opt = |k: &str, v: Option<Value>| {
            if let Some(v) = v {
                b.insert(k.into(), v);
            }
        };
        opt("fallback_voice", self.fallback_voice.clone().map(Value::from));
        opt("response_format", self.response_format.clone().map(Value::from));
        opt("speed", self.speed.map(Value::from));
        opt("language", self.language.clone().map(Value::from));
        opt("instructions", self.instructions.clone().map(Value::from));
        opt("stream", self.stream.map(Value::from));
        if let Some(c) = &self.clone {
            b.insert("task_type".into(), "Base".into());
            b.insert("ref_audio".into(), c.ref_audio.clone().into());
            b.insert("ref_text".into(), c.ref_text.clone().into());
        }
        for (k, v) in &self.extra {
            b.insert(k.clone(), v.clone());
        }
        Value::Object(b)
    }
}

/// A buffered speech answer.
#[derive(Debug, Clone, PartialEq)]
pub struct SpeechResult {
    pub audio: Bytes,
    pub content_type: String,
    pub served: Served,
}

// ── client methods ──────────────────────────────────────────────────────────

impl GatewayClient {
    /// `POST /v1/audio/transcriptions` (multipart). Never retried by default (paid call).
    pub async fn transcribe(&self, req: TranscribeRequest) -> Result<Transcription> {
        let path = "/v1/audio/transcriptions";
        self.guarded(path, async {
            let spec = Spec::new(Method::POST, path, TimeoutGroup::Stt, &req.call)
                .body(Body::Form(req.form()))
                .idempotent(false);
            let f = self.fetch(&spec).await?;
            Ok(Transcription::parse(&f.bytes, f.served.clone(), f.header("x-stt-filtered"), f.header("x-stt-raw-length")))
        })
        .await
    }

    /// `POST /v1/chat/completions` (non-streamed). Never retried by default (paid call).
    pub async fn chat(&self, req: ChatRequest) -> Result<ChatCompletion> {
        let path = "/v1/chat/completions";
        self.guarded(path, async {
            let spec = Spec::new(Method::POST, path, TimeoutGroup::Chat, &req.call)
                .body(Body::json(&req.to_body(false))?)
                .idempotent(false);
            let f = self.fetch(&spec).await?;
            let mut out: ChatCompletion = f.json(path)?;
            out.served = f.served;
            Ok(out)
        })
        .await
    }

    /// `POST /v1/chat/completions` with `stream: true`: returns once the headers arrived (so `served` is final);
    /// then read the content deltas from the [`ChatStream`]. Dropping the stream closes the connection.
    pub async fn chat_stream(&self, req: ChatRequest) -> Result<ChatStream> {
        let path = "/v1/chat/completions";
        self.guarded(path, async {
            let spec = Spec::new(Method::POST, path, TimeoutGroup::Chat, &req.call)
                .body(Body::json(&req.to_body(true))?)
                .idempotent(false);
            let resp = self.fetch_stream(&spec).await?;
            Ok(ChatStream::new(resp, path))
        })
        .await
    }

    /// `POST /v1/audio/speech`, body read whole. Never retried by default (paid call).
    pub async fn speech(&self, req: SpeechRequest) -> Result<SpeechResult> {
        let path = "/v1/audio/speech";
        self.guarded(path, async {
            let spec = Spec::new(Method::POST, path, TimeoutGroup::Tts, &req.call)
                .body(Body::json(&req.to_body())?)
                .idempotent(false);
            let f = self.fetch(&spec).await?;
            let content_type = f.header("content-type").unwrap_or_else(|| "application/octet-stream".into());
            if f.bytes.is_empty() {
                return Err(GatewayError::Stream {
                    path: path.into(),
                    code: "bad_response".into(),
                    message: "empty speech body".into(),
                    served: Some(Box::new(f.served)),
                    details: None,
                });
            }
            Ok(SpeechResult { audio: f.bytes, content_type, served: f.served })
        })
        .await
    }

    /// `POST /v1/audio/speech`, returned as soon as the headers arrived; the audio arrives as chunks
    /// (wav / pcm are streamed end to end by the gateway).
    pub async fn speech_stream(&self, req: SpeechRequest) -> Result<SpeechStream> {
        let path = "/v1/audio/speech";
        self.guarded(path, async {
            let spec = Spec::new(Method::POST, path, TimeoutGroup::Tts, &req.call)
                .body(Body::json(&req.to_body())?)
                .idempotent(false);
            let resp = self.fetch_stream(&spec).await?;
            Ok(SpeechStream::new(resp, path))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn audio_part_follows_the_container() {
        assert_eq!(audio_part_meta(b"OggS\0\x02"), ("audio.ogg", "audio/ogg"));
        assert_eq!(audio_part_meta(b"RIFF\0\0\0\0WAVEfmt "), ("audio.wav", "audio/wav"));
        assert_eq!(audio_part_meta(b"fLaC"), ("audio.flac", "audio/flac"));
        assert_eq!(audio_part_meta(b"ID3\x04"), ("audio.mp3", "audio/mpeg"));
        assert_eq!(audio_part_meta(&[0x1A, 0x45, 0xDF, 0xA3, 1]), ("audio.webm", "audio/webm"));
        assert_eq!(audio_part_meta(b"????"), ("audio", "application/octet-stream"));
    }

    #[test]
    fn chat_body_merges_extra_then_stream() {
        let req = ChatRequest::new("m", vec![ChatMessage::user("hi")])
            .max_tokens(10)
            .extra("top_k", 20.into())
            .extra("max_tokens", 5.into())
            .timeout(Duration::from_secs(1));
        let body = req.to_body(true);
        assert_eq!(body["model"], "m");
        assert_eq!(body["messages"][0], serde_json::json!({"role": "user", "content": "hi"}));
        assert_eq!(body["top_k"], 20);
        assert_eq!(body["max_tokens"], 5, "extra_body overrides");
        assert_eq!(body["stream"], true);
        assert!(body.get("temperature").is_none() && body.get("call").is_none());
    }

    #[test]
    fn include_usage_sets_stream_options() {
        let body = ChatRequest::new("m", vec![]).include_usage(true).to_body(true);
        assert_eq!(body["stream_options"], serde_json::json!({"include_usage": true}));
        let mut req = ChatRequest::new("m", vec![]);
        req.stream_options = Some(serde_json::json!({"other": 1}));
        assert_eq!(req.include_usage(true).to_body(true)["stream_options"], serde_json::json!({"other": 1, "include_usage": true}));
        assert!(ChatRequest::new("m", vec![]).to_body(true).get("stream_options").is_none());
    }

    #[test]
    fn blank_filename_falls_back_to_the_container_default() {
        let wav = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        let name = |req: TranscribeRequest| match &req.form()[0] {
            FormField::File { filename, mime, .. } => (filename.clone(), mime.clone()),
            _ => panic!("file part first"),
        };
        assert_eq!(name(TranscribeRequest::new("m", wav.clone()).filename("")), ("audio.wav".into(), "audio/wav".into()));
        assert_eq!(name(TranscribeRequest::new("m", wav.clone()).filename("  ").mime("")), ("audio.wav".into(), "audio/wav".into()));
        assert_eq!(name(TranscribeRequest::new("m", wav.clone()).filename("clip.wav")).0, "clip.wav");
        assert_eq!(name(TranscribeRequest::new("m", b"????".to_vec()).filename("")).0, "audio");
    }

    #[test]
    fn speech_body_carries_the_clone_reference_only_when_given() {
        let plain = SpeechRequest::new("babelcast-tts", "Bonjour", "Ryan").response_format("wav").instructions("calm");
        let b = plain.to_body();
        assert_eq!(b, serde_json::json!({"model": "babelcast-tts", "input": "Bonjour", "voice": "Ryan", "response_format": "wav", "instructions": "calm"}));
        let cloned = plain.clone_voice("data:audio/wav;base64,AAAA", "Bonjour à tous").language("French");
        let b = cloned.to_body();
        assert_eq!(b["task_type"], "Base");
        assert_eq!(b["ref_audio"], "data:audio/wav;base64,AAAA");
        assert_eq!(b["ref_text"], "Bonjour à tous");
        assert_eq!(b["voice"], "Ryan", "voice stays: the gateway requires it");
        assert_eq!(b["language"], "French");
    }

    #[test]
    fn transcription_parses_json_and_text() {
        let t = Transcription::parse(br#"{"text":"Bom dia","language":"pt","duration":1.5,"segments":[{"id":0}]}"#, Served::default(), Some("none".into()), Some("7".into()));
        assert_eq!(t.text, "Bom dia");
        assert_eq!(t.language.as_deref(), Some("pt"));
        assert_eq!(t.duration, Some(1.5));
        assert_eq!(t.segments.as_ref().map(Vec::len), Some(1));
        assert_eq!(t.stt_raw_length, Some(7));
        let t = Transcription::parse(b"1\n00:00:00,000 --> 00:00:01,000\nBom dia\n", Served::default(), None, None);
        assert!(t.text.contains("Bom dia"));
    }
}

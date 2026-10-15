//! Streamed bodies: chat SSE (`data: {chunk}` … `data: [DONE]`) and raw speech audio (port of
//! `sdk/node/gateway-streams.ts`). Dropping a stream closes the connection, so the gateway stops the upstream work.

use std::collections::VecDeque;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use futures_util::stream::{BoxStream, Stream, StreamExt};
use serde::Deserialize;
use serde_json::Value;

use crate::error::{GatewayError, Result};
use crate::openai::ChatUsage;
use crate::types::Served;

/// Splits a byte stream into SSE `data:` payloads, one per event (comments and other fields ignored).
#[derive(Debug, Default)]
pub(crate) struct SseParser {
    buf: Vec<u8>,
    data: Vec<String>,
    events: VecDeque<String>,
}

impl SseParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=nl).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.line(&line);
        }
    }

    /// End of body: a last event without its blank line still counts.
    pub(crate) fn finish(&mut self) {
        let rest = std::mem::take(&mut self.buf);
        if !rest.is_empty() {
            self.line(&rest);
        }
        self.flush();
    }

    pub(crate) fn next_event(&mut self) -> Option<String> {
        self.events.pop_front()
    }

    fn line(&mut self, line: &[u8]) {
        if line.is_empty() {
            self.flush();
        } else if let Some(rest) = line.strip_prefix(b"data:") {
            let rest = rest.strip_prefix(b" ").unwrap_or(rest);
            self.data.push(String::from_utf8_lossy(rest).into_owned());
        }
    }

    fn flush(&mut self) {
        if !self.data.is_empty() {
            self.events.push_back(self.data.join("\n"));
            self.data.clear();
        }
    }
}

#[derive(Deserialize)]
struct Chunk {
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<ChatUsage>,
}

#[derive(Deserialize)]
struct ChunkChoice {
    #[serde(default)]
    delta: Option<Delta>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
}

/// A streamed chat answer: a [`Stream`] of content deltas. `served` is known before the first delta;
/// `finish_reason` and `usage` once the stream ended (when the provider reported them).
///
/// An in-band `data: {"error": …}` event becomes a [`GatewayError::Stream`] item (with the gateway's code).
pub struct ChatStream {
    served: Served,
    path: String,
    body: BoxStream<'static, reqwest::Result<Bytes>>,
    parser: SseParser,
    pending: VecDeque<String>,
    finish_reason: Option<String>,
    usage: Option<ChatUsage>,
    done: bool,
    eof: bool,
}

impl std::fmt::Debug for ChatStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatStream")
            .field("served", &self.served)
            .field("finish_reason", &self.finish_reason)
            .field("usage", &self.usage)
            .field("done", &self.done)
            .finish()
    }
}

impl ChatStream {
    pub(crate) fn new(resp: reqwest::Response, path: &str) -> Self {
        Self {
            served: Served::from_headers(resp.headers()),
            path: path.to_string(),
            body: resp.bytes_stream().boxed(),
            parser: SseParser::default(),
            pending: VecDeque::new(),
            finish_reason: None,
            usage: None,
            done: false,
            eof: false,
        }
    }

    /// Where the answer came from (final: the gateway falls back only before the first token).
    pub fn served(&self) -> &Served {
        &self.served
    }

    /// Set once the stream ended, when the provider reported it.
    pub fn finish_reason(&self) -> Option<&str> {
        self.finish_reason.as_deref()
    }

    /// Set once the stream ended, when the provider reported it (`stream_options.include_usage`).
    pub fn usage(&self) -> Option<ChatUsage> {
        self.usage
    }

    /// Next content delta; `None` at the end.
    pub async fn next_delta(&mut self) -> Option<Result<String>> {
        self.next().await
    }

    /// Reads the whole answer.
    pub async fn collect_text(&mut self) -> Result<String> {
        let mut out = String::new();
        while let Some(d) = self.next().await {
            out.push_str(&d?);
        }
        Ok(out)
    }

    /// Stops reading and closes the connection (same as dropping the stream).
    pub fn cancel(self) {}

    fn stream_error(&self, code: &str, message: String, details: Option<Value>) -> GatewayError {
        GatewayError::Stream { path: self.path.clone(), code: code.to_string(), message, served: Some(Box::new(self.served.clone())), details }
    }

    /// Handles one SSE payload; `Some(err)` on an in-band error.
    fn event(&mut self, data: &str) -> Option<GatewayError> {
        if data == "[DONE]" {
            self.done = true;
            return None;
        }
        let Ok(chunk) = serde_json::from_str::<Chunk>(data) else { return None };
        if let Some(err) = chunk.error.filter(|e| !e.is_null()) {
            let code = err
                .get("code")
                .and_then(Value::as_str)
                .or_else(|| err.get("type").and_then(Value::as_str))
                .unwrap_or("stream_error")
                .to_string();
            let message = err
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| err.as_str().map(str::to_string))
                .unwrap_or_else(|| "error".into());
            self.done = true;
            return Some(self.stream_error(&code, message, Some(err)));
        }
        if chunk.usage.is_some() {
            self.usage = chunk.usage;
        }
        for choice in chunk.choices {
            if choice.finish_reason.is_some() {
                self.finish_reason = choice.finish_reason;
            }
            if let Some(c) = choice.delta.and_then(|d| d.content).filter(|c| !c.is_empty()) {
                self.pending.push_back(c);
            }
        }
        None
    }
}

impl Stream for ChatStream {
    type Item = Result<String>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        loop {
            if let Some(d) = this.pending.pop_front() {
                return Poll::Ready(Some(Ok(d)));
            }
            if this.done {
                return Poll::Ready(None);
            }
            if let Some(data) = this.parser.next_event() {
                if let Some(err) = this.event(&data) {
                    return Poll::Ready(Some(Err(err)));
                }
                continue;
            }
            if this.eof {
                // Body over and every event handled (a stream cut without `[DONE]` simply ends).
                this.done = true;
                continue;
            }
            match this.body.as_mut().poll_next(cx) {
                Poll::Ready(Some(Ok(bytes))) => this.parser.push(&bytes),
                Poll::Ready(Some(Err(e))) => {
                    this.done = true;
                    return Poll::Ready(Some(Err(this.stream_error("stream_error", e.to_string(), None))));
                }
                Poll::Ready(None) => {
                    this.parser.finish();
                    this.eof = true;
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

/// Speech audio as it arrives. Dropping it closes the connection.
pub struct SpeechStream {
    content_type: String,
    served: Served,
    path: String,
    body: BoxStream<'static, reqwest::Result<Bytes>>,
}

impl std::fmt::Debug for SpeechStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpeechStream").field("content_type", &self.content_type).field("served", &self.served).finish()
    }
}

impl SpeechStream {
    pub(crate) fn new(resp: reqwest::Response, path: &str) -> Self {
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        Self { content_type, served: Served::from_headers(resp.headers()), path: path.to_string(), body: resp.bytes_stream().boxed() }
    }

    /// `Content-Type` of the audio (`audio/wav`, `audio/mpeg`…).
    pub fn content_type(&self) -> &str {
        &self.content_type
    }

    /// Where the answer came from.
    pub fn served(&self) -> &Served {
        &self.served
    }

    /// Reads the rest of the audio.
    pub async fn collect_bytes(mut self) -> Result<Bytes> {
        let mut out = Vec::new();
        while let Some(chunk) = self.next().await {
            out.extend_from_slice(&chunk?);
        }
        Ok(Bytes::from(out))
    }
}

impl Stream for SpeechStream {
    type Item = Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        match this.body.as_mut().poll_next(cx) {
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(GatewayError::Stream {
                path: this.path.clone(),
                code: "stream_error".into(),
                message: e.to_string(),
                served: Some(Box::new(this.served.clone())),
                details: None,
            }))),
            Poll::Ready(Some(Ok(b))) => Poll::Ready(Some(Ok(b))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(chunks: &[&[u8]]) -> Vec<String> {
        let mut p = SseParser::default();
        let mut out = Vec::new();
        for c in chunks {
            p.push(c);
            while let Some(e) = p.next_event() {
                out.push(e);
            }
        }
        p.finish();
        while let Some(e) = p.next_event() {
            out.push(e);
        }
        out
    }

    #[test]
    fn sse_events_survive_any_split() {
        let body = b": comment\r\ndata: {\"a\":1}\r\n\r\nevent: x\ndata:{\"b\":2}\n\ndata: line1\ndata: line2\n\ndata: [DONE]";
        let whole = events(&[body]);
        assert_eq!(whole, ["{\"a\":1}", "{\"b\":2}", "line1\nline2", "[DONE]"]);
        for cut in 1..body.len() {
            assert_eq!(events(&[&body[..cut], &body[cut..]]), whole, "cut at {cut}");
        }
    }

    #[test]
    fn utf8_split_across_chunks() {
        let body = "data: ação\n\n".as_bytes();
        assert_eq!(events(&[&body[..8], &body[8..]]), ["ação"]);
    }
}

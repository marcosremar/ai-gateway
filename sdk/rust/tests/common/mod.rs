//! A tiny scripted HTTP server (axum) for the tests: records every request and answers from per-route queues.

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use bytes::Bytes;

/// One request the server received.
#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("JSON body")
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// One scripted answer.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// Sent as separate body chunks.
    pub chunks: Vec<Vec<u8>>,
    pub delay: Duration,
}

impl Reply {
    pub fn status(status: u16) -> Self {
        Self { status, headers: Vec::new(), chunks: Vec::new(), delay: Duration::ZERO }
    }

    pub fn json(status: u16, v: serde_json::Value) -> Self {
        Self::status(status).header("content-type", "application/json").body(v.to_string())
    }

    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.to_string(), v.to_string()));
        self
    }

    pub fn body(mut self, b: impl Into<Vec<u8>>) -> Self {
        self.chunks = vec![b.into()];
        self
    }

    pub fn chunks(mut self, chunks: Vec<Vec<u8>>) -> Self {
        self.chunks = chunks;
        self
    }

    pub fn delay(mut self, d: Duration) -> Self {
        self.delay = d;
        self
    }
}

#[derive(Default)]
struct Shared {
    recorded: Mutex<Vec<Recorded>>,
    /// "METHOD /path" → answers; the last one repeats.
    replies: Mutex<HashMap<String, VecDeque<Reply>>>,
    /// Requests the gateway serves but no test scripted ("METHOD /path").
    unscripted: Mutex<Vec<String>>,
}

/// The methods the real gateway (ai-gateway `origin/main` 0f6ac49: `serve.ts`, `src/rooms/http.ts`,
/// `src/deployments/http.ts`) serves on `path`; `None` when it serves no such path (404).
///
/// The mock refuses to script a reply the gateway could never give (`Mock::on` panics) and answers like the gateway
/// otherwise: 405 + `Allow` for a known path with another method, 404 for an unknown path.
pub fn gateway_methods(path: &str) -> Option<&'static [&'static str]> {
    let seg: Vec<&str> = path.trim_end_matches('/').split('/').skip(1).collect();
    let post: &'static [&'static str] = &["POST"];
    let get: &'static [&'static str] = &["GET"];
    let get_put: &'static [&'static str] = &["GET", "PUT"];
    Some(match seg.as_slice() {
        ["health"] | ["v1", "models"] => get,
        ["v1", "audio", "transcriptions"] | ["v1", "chat", "completions"] | ["v1", "audio", "speech"] | ["v1", "s2s"] | ["v1", "activate"] => post,
        // src/rooms/http.ts: no action → GET, HEAD, PATCH; lines/audio/end → POST; events → GET, POST; ws → GET.
        ["v1", "rooms"] => post,
        ["v1", "rooms", _] => &["GET", "HEAD", "PATCH"],
        ["v1", "rooms", _, "lines" | "audio" | "end"] => post,
        ["v1", "rooms", _, "events"] => &["GET", "POST"],
        ["v1", "rooms", _, "ws"] => get,
        // src/deployments/http.ts
        ["v1", "deployments"] => get,
        ["v1", "deployments", _] => &["GET", "PUT", "PATCH", "DELETE"],
        ["v1", "deployments", _, "wake" | "park" | "start" | "extend"] => post,
        ["v1", "deployments", _, "capacity"] => get,
        ["v1", "apps", _] => get,
        ["v1", "apps", _, "images", _] => get_put,
        ["v1", "apps", _, "routes" | "limits" | "profile"] => get_put,
        ["v1", "apps", _, "fallback" | "status"] => get,
        ["v1", "apps", _, "stability-report"] => &["GET", "POST"],
        // src/app-telemetry/index.ts
        ["v1", "telemetry", "app", "events"] => &["GET", "POST"],
        _ => return None,
    })
}

/// The running mock gateway.
pub struct Mock {
    pub addr: SocketAddr,
    shared: Arc<Shared>,
}

impl Mock {
    pub async fn start() -> Self {
        let shared = Arc::new(Shared::default());
        let app = axum::Router::new().fallback(handle).with_state(shared.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { addr, shared }
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Queues answers for `METHOD /path` (the last one repeats). Panics when the gateway does not serve that method on
    /// that path: a test must not script an answer the real gateway never gives.
    pub fn on(&self, method: &str, path: &str, replies: Vec<Reply>) {
        match gateway_methods(path) {
            Some(allowed) if allowed.contains(&method) => {}
            Some(allowed) => panic!("the gateway answers 405 to {method} {path} (it serves {allowed:?}): do not script it"),
            None => panic!("the gateway serves no {path} (404): do not script it"),
        }
        self.shared.replies.lock().unwrap().insert(format!("{method} {path}"), replies.into());
    }

    /// Requests to a served route that no test scripted (answered 404 "no mock").
    pub fn unscripted(&self) -> Vec<String> {
        self.shared.unscripted.lock().unwrap().clone()
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.shared.recorded.lock().unwrap().clone()
    }

    pub fn requests_to(&self, path: &str) -> Vec<Recorded> {
        self.requests().into_iter().filter(|r| r.path == path).collect()
    }
}

async fn handle(State(shared): State<Arc<Shared>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let body = to_bytes(body, 64 * 1024 * 1024).await.unwrap_or_default();
    let rec = Recorded {
        method: parts.method.to_string(),
        path: parts.uri.path().to_string(),
        query: parts.uri.query().map(str::to_string),
        headers: parts.headers.clone(),
        body,
    };
    let key = format!("{} {}", rec.method, rec.path);
    let allowed = gateway_methods(&rec.path);
    let method = rec.method.clone();
    shared.recorded.lock().unwrap().push(rec);
    let reply = {
        let mut map = shared.replies.lock().unwrap();
        match map.get_mut(&key) {
            Some(q) if q.len() > 1 => q.pop_front(),
            Some(q) => q.front().cloned(),
            None => None,
        }
    };
    let reply = reply.unwrap_or_else(|| match allowed {
        // As the gateway: 405 with Allow for a method it does not serve on a known path, 404 for an unknown path.
        Some(allowed) if !allowed.contains(&method.as_str()) => {
            Reply::json(405, serde_json::json!({ "error": { "message": format!("use {}", allowed.join(" or ")), "type": "invalid_request_error" } }))
                .header("allow", &allowed.join(", "))
        }
        Some(_) => {
            shared.unscripted.lock().unwrap().push(key.clone());
            Reply::json(404, serde_json::json!({ "error": format!("no mock for {key}") }))
        }
        None => Reply::json(404, serde_json::json!({ "error": { "message": format!("Not found: {key}"), "type": "not_found" } })),
    });
    if !reply.delay.is_zero() {
        tokio::time::sleep(reply.delay).await;
    }
    let mut builder = Response::builder().status(StatusCode::from_u16(reply.status).unwrap());
    for (k, v) in &reply.headers {
        builder = builder.header(k, v);
    }
    let body = if reply.chunks.len() > 1 {
        let chunks: Vec<Result<Bytes, std::io::Error>> = reply.chunks.into_iter().map(|c| Ok(Bytes::from(c))).collect();
        Body::from_stream(futures_util::stream::iter(chunks))
    } else {
        Body::from(reply.chunks.into_iter().next().unwrap_or_default())
    };
    builder.body(body).unwrap()
}

/// A raw TCP server that reads each request's head and answers with these exact bytes, then closes the connection
/// (for answers axum cannot produce, e.g. a body shorter than its `Content-Length`). Returns its base URL.
pub async fn raw_server(answer: Vec<u8>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let answer = answer.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut buf = [0u8; 4096];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                    }
                }
                let _ = sock.write_all(&answer).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    format!("http://{addr}")
}

/// An address where nothing listens (connection refused).
pub async fn dead_addr() -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    format!("http://{addr}")
}

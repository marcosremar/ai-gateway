//! One HTTP exchange with the gateway: headers, deadline, retries, typed errors (port of `exchange` in
//! `sdk/node/gateway-http.ts`, plus the status retries of [`RetryPolicy`]).

use std::time::Duration;

use bytes::Bytes;
use reqwest::header::HeaderMap;
use reqwest::Method;
use serde::Serialize;
use tokio::time::Instant;

use crate::client::GatewayClient;
use crate::error::{status_error, GatewayError, Result};
use crate::types::{CallOptions, Served, TimeoutGroup, REDACTED};

/// When and how calls are retried.
///
/// Matches the Node SDK by default: only **idempotent** calls (GET, PUT, PATCH, DELETE, deployment `wake` / `park`,
/// room line publish — the gateway replaces a line by id) are retried, at most twice, 200 ms then 600 ms apart. Only
/// failures to reach the gateway (connect error, connect timeout) are retried as connection errors; a request that
/// could not be built, or a body cut after the headers, is not. On top of the Node SDK's connection-error retries,
/// they are also retried on the statuses in `statuses` (408, 429, 500, 502, 503, 504), waiting `Retry-After` when the
/// gateway sends one — unless it asks for more than `max_retry_after`, or the total wait would exceed `budget` (the
/// error is then returned at once, with [`GatewayError::retry_after`] for the caller). A `429` for an exhausted daily
/// budget (`daily_budget_exhausted` / `budget_exceeded`) is never retried: it cannot succeed before the reset.
///
/// Calls that cost money or act once (transcriptions, chat, speech, s2s, room audio / end, activation) are **not**
/// retried unless
/// `retry_non_idempotent` is set: the gateway already falls back and hedges between providers, and a client retry would
/// double the cost. Timeouts are never retried (the deadline already elapsed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Retries after the first attempt. 0 = never retry.
    pub max_retries: u32,
    /// Wait before retry n (the last value repeats) when there is no `Retry-After`.
    pub backoff: Vec<Duration>,
    /// Statuses that are retried (idempotent calls).
    pub statuses: Vec<u16>,
    /// Longest `Retry-After` the client waits for; a longer one returns the error.
    pub max_retry_after: Duration,
    /// Total time spent waiting between attempts of one call.
    pub budget: Duration,
    /// Also retry non-idempotent (paid) calls.
    pub retry_non_idempotent: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 2,
            backoff: vec![Duration::from_millis(200), Duration::from_millis(600)],
            statuses: vec![408, 429, 500, 502, 503, 504],
            max_retry_after: Duration::from_secs(5),
            budget: Duration::from_secs(10),
            retry_non_idempotent: false,
        }
    }
}

impl RetryPolicy {
    /// No retries at all.
    pub fn none() -> Self {
        Self { max_retries: 0, ..Self::default() }
    }

    /// How long to wait before retrying after `err` (attempt `attempt`, 0-based, `waited` so far); `None` = give up.
    pub(crate) fn wait_for(&self, err: &GatewayError, idempotent: bool, attempt: u32, waited: Duration) -> Option<Duration> {
        if attempt >= self.max_retries || !(idempotent || self.retry_non_idempotent) {
            return None;
        }
        let backoff = || {
            self.backoff
                .get(attempt as usize)
                .or(self.backoff.last())
                .copied()
                .unwrap_or(Duration::from_millis(200))
        };
        let wait = match err {
            GatewayError::Http { unreachable: true, .. } => backoff(),
            GatewayError::Status(s) if self.statuses.contains(&s.status) => {
                if matches!(s.code.as_str(), "daily_budget_exhausted" | "budget_exceeded") {
                    return None;
                }
                match s.retry_after {
                    Some(ra) if ra > self.max_retry_after => return None,
                    Some(ra) => ra,
                    None => backoff(),
                }
            }
            _ => return None,
        };
        (waited + wait <= self.budget).then_some(wait)
    }
}

/// Which credential a request carries. Its `Debug` never prints the token.
#[derive(Clone)]
pub(crate) enum Auth {
    /// The client's API key (and `X-App`).
    Key,
    /// Another bearer token (a room's publish token).
    Bearer(String),
    /// Nothing (activation, the breaker's health probe).
    None,
}

impl std::fmt::Debug for Auth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Key => f.write_str("Key"),
            Self::Bearer(_) => write!(f, "Bearer({REDACTED})"),
            Self::None => f.write_str("None"),
        }
    }
}

/// One multipart field.
#[derive(Debug, Clone)]
pub(crate) enum FormField {
    Text(String, String),
    File { name: String, bytes: Bytes, filename: String, mime: String },
}

/// A request body, rebuildable for each attempt. Its `Debug` prints sizes and field names only (a JSON body can carry
/// a secret: the activation key).
#[derive(Clone)]
pub(crate) enum Body {
    Empty,
    Json(Bytes),
    Form(Vec<FormField>),
}

impl std::fmt::Debug for Body {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => f.write_str("Empty"),
            Self::Json(b) => write!(f, "Json({} bytes)", b.len()),
            Self::Form(fields) => {
                let names: Vec<&str> = fields
                    .iter()
                    .map(|x| match x {
                        FormField::Text(name, _) | FormField::File { name, .. } => name.as_str(),
                    })
                    .collect();
                write!(f, "Form({names:?})")
            }
        }
    }
}

impl Body {
    pub(crate) fn json<T: Serialize + ?Sized>(value: &T) -> Result<Self> {
        serde_json::to_vec(value)
            .map(|v| Body::Json(Bytes::from(v)))
            .map_err(|e| GatewayError::Config(format!("request body does not serialize: {e}")))
    }

    fn form(fields: &[FormField]) -> Result<reqwest::multipart::Form> {
        let mut form = reqwest::multipart::Form::new();
        for f in fields {
            form = match f {
                FormField::Text(name, value) => form.text(name.clone(), value.clone()),
                FormField::File { name, bytes, filename, mime } => {
                    let part = reqwest::multipart::Part::stream_with_length(bytes.clone(), bytes.len() as u64)
                        .file_name(filename.clone())
                        .mime_str(mime)
                        .map_err(|e| GatewayError::Config(format!("invalid MIME type {mime:?}: {e}")))?;
                    form.part(name.clone(), part)
                }
            };
        }
        Ok(form)
    }
}

/// Everything one call needs.
#[derive(Debug, Clone)]
pub(crate) struct Spec<'a> {
    pub method: Method,
    pub path: String,
    pub group: TimeoutGroup,
    pub body: Body,
    pub auth: Auth,
    pub idempotent: bool,
    pub call: &'a CallOptions,
}

impl<'a> Spec<'a> {
    pub(crate) fn new(method: Method, path: impl Into<String>, group: TimeoutGroup, call: &'a CallOptions) -> Self {
        let idempotent = matches!(method, Method::GET | Method::HEAD | Method::PUT | Method::PATCH | Method::DELETE);
        Self { method, path: path.into(), group, body: Body::Empty, auth: Auth::Key, idempotent, call }
    }

    pub(crate) fn body(mut self, body: Body) -> Self {
        self.body = body;
        self
    }

    pub(crate) fn auth(mut self, auth: Auth) -> Self {
        self.auth = auth;
        self
    }

    pub(crate) fn idempotent(mut self, idempotent: bool) -> Self {
        self.idempotent = idempotent;
        self
    }
}

/// A 2xx answer read whole.
#[derive(Debug)]
pub(crate) struct Fetched {
    #[allow(dead_code)]
    pub status: u16,
    pub headers: HeaderMap,
    pub served: Served,
    pub bytes: Bytes,
}

impl Fetched {
    pub(crate) fn json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        serde_json::from_slice(&self.bytes).map_err(|source| GatewayError::Decode {
            path: path.to_string(),
            body: String::from_utf8_lossy(&self.bytes).chars().take(500).collect(),
            source,
        })
    }

    /// As [`Self::json`] for answers that carry secrets (room publish token, provider keys): a decode error keeps
    /// neither the body nor serde's message (which can quote a value), only the error category and position.
    pub(crate) fn json_secret<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        serde_json::from_slice(&self.bytes).map_err(|e| {
            let what = match e.classify() {
                serde_json::error::Category::Io => "I/O error",
                serde_json::error::Category::Syntax => "not JSON",
                serde_json::error::Category::Data => "unexpected shape",
                serde_json::error::Category::Eof => "truncated JSON",
            };
            GatewayError::Decode {
                path: path.to_string(),
                body: format!("{REDACTED} (the answer carries secrets)"),
                source: <serde_json::Error as serde::de::Error>::custom(format!(
                    "{what} at line {} column {}",
                    e.line(),
                    e.column()
                )),
            }
        })
    }

    pub(crate) fn header(&self, name: &str) -> Option<String> {
        self.headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
    }
}

enum Exchanged {
    Buffered(Fetched),
    Streaming(reqwest::Response),
}

impl GatewayClient {
    /// Sends `spec` and reads the whole 2xx body (deadline covers headers + body). Non-2xx → `GatewayError::Status`.
    pub(crate) async fn fetch(&self, spec: &Spec<'_>) -> Result<Fetched> {
        match self.exchange(spec, true).await? {
            Exchanged::Buffered(f) => Ok(f),
            Exchanged::Streaming(_) => unreachable!("buffered exchange"),
        }
    }

    /// Sends `spec` and returns the 2xx response as soon as its headers arrived (deadline covers headers only).
    pub(crate) async fn fetch_stream(&self, spec: &Spec<'_>) -> Result<reqwest::Response> {
        match self.exchange(spec, false).await? {
            Exchanged::Streaming(r) => Ok(r),
            Exchanged::Buffered(_) => unreachable!("streaming exchange"),
        }
    }

    async fn exchange(&self, spec: &Spec<'_>, buffered: bool) -> Result<Exchanged> {
        let policy = &self.inner.retry;
        let mut waited = Duration::ZERO;
        for attempt in 0.. {
            match self.attempt(spec, buffered).await {
                Ok(x) => return Ok(x),
                Err(err) => match policy.wait_for(&err, spec.idempotent, attempt, waited) {
                    Some(wait) => {
                        tokio::time::sleep(wait).await;
                        waited += wait;
                    }
                    None => return Err(err),
                },
            }
        }
        unreachable!("the retry loop returns")
    }

    fn request(&self, spec: &Spec<'_>) -> Result<reqwest::RequestBuilder> {
        self.request_with(&self.inner.http, spec)
    }

    /// The request of `spec` (URL, credential, device / request-id headers, body) on `http`.
    pub(crate) fn request_with(&self, http: &reqwest::Client, spec: &Spec<'_>) -> Result<reqwest::RequestBuilder> {
        let url = format!("{}{}", self.inner.base_url, spec.path);
        let mut rb = http.request(spec.method.clone(), url);
        match &spec.auth {
            Auth::Key => {
                if let Some(key) = self.inner.api_key.as_deref() {
                    rb = rb.bearer_auth(key);
                }
                if let Some(app) = self.inner.app.as_deref() {
                    rb = rb.header("X-App", app);
                }
            }
            Auth::Bearer(token) => rb = rb.bearer_auth(token),
            Auth::None => {}
        }
        if let Some(device) = spec.call.device.as_deref() {
            rb = rb.header("X-Gateway-Device", device);
        }
        if let Some(id) = spec.call.request_id.as_deref() {
            rb = rb.header("X-Request-Id", id);
        }
        Ok(match &spec.body {
            Body::Empty => rb,
            Body::Json(bytes) => rb.header(reqwest::header::CONTENT_TYPE, "application/json").body(bytes.clone()),
            Body::Form(fields) => rb.multipart(Body::form(fields)?),
        })
    }

    async fn attempt(&self, spec: &Spec<'_>, buffered: bool) -> Result<Exchanged> {
        let timeout = spec.call.timeout.unwrap_or_else(|| self.inner.timeouts.get(spec.group));
        // Duration::ZERO = no deadline.
        let deadline = (!timeout.is_zero()).then(|| Instant::now() + timeout);
        let path = spec.path.as_str();
        let timed_out = |headers_received| GatewayError::Timeout { path: path.to_string(), after: timeout, headers_received };

        let rb = self.request(spec)?;
        let resp = match within(deadline, rb.send()).await {
            None => return Err(timed_out(false)),
            Some(Err(e)) => return Err(send_error(path, e)),
            Some(Ok(r)) => r,
        };
        let status = resp.status();
        if !status.is_success() {
            let headers = resp.headers().clone();
            let body = match within(deadline, resp.bytes()).await {
                None => return Err(timed_out(true)),
                Some(Ok(b)) => b,
                Some(Err(_)) => Bytes::new(),
            };
            return Err(status_error(status.as_u16(), &headers, &body, path));
        }
        if !buffered {
            return Ok(Exchanged::Streaming(resp));
        }
        let headers = resp.headers().clone();
        let served = Served::from_headers(&headers);
        let bytes = match within(deadline, resp.bytes()).await {
            None => return Err(timed_out(true)),
            // The gateway answered, then the body broke (cut connection, short body): `bad_response`, as the Node
            // SDK; never unreachable.
            Some(Err(e)) => {
                return Err(GatewayError::Stream {
                    path: path.to_string(),
                    code: "bad_response".into(),
                    message: format!("response body could not be read: {}", error_chain(&e)),
                    served: Some(Box::new(served)),
                    details: None,
                })
            }
            Some(Ok(b)) => b,
        };
        Ok(Exchanged::Buffered(Fetched { status: status.as_u16(), served, headers, bytes }))
    }
}

/// `e` and its sources, `: `-separated (reqwest's own message is often just "error sending request").
fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        out.push_str(": ");
        out.push_str(&s.to_string());
        cur = s.source();
    }
    out
}

/// Runs `fut` until `deadline` (`None` when it fired first).
pub(crate) async fn within<F: std::future::Future>(deadline: Option<Instant>, fut: F) -> Option<F::Output> {
    match deadline {
        Some(d) => tokio::time::timeout_at(d, fut).await.ok(),
        None => Some(fut.await),
    }
}

/// Error of `send()` (no response header yet).
///
/// - builder errors (a header value with `\n`, a bad URL): the request was never sent — `Config`, not unreachable,
///   never retried, never counted by the breaker;
/// - connect / timeout errors (refused, DNS, TLS handshake, connect timeout): the gateway could not be reached —
///   `Http { unreachable: true }`, retried for idempotent calls and counted by the breaker;
/// - anything else (connection reset after the request went out, protocol error): `Http { unreachable: false }`.
pub(crate) fn send_error(path: &str, e: reqwest::Error) -> GatewayError {
    if e.is_builder() {
        return GatewayError::Config(format!("invalid request for {path}: {}", error_chain(&e)));
    }
    GatewayError::Http { path: path.to_string(), unreachable: e.is_connect() || e.is_timeout(), source: e }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::StatusError;

    fn status(status: u16, code: &str, retry_after: Option<Duration>) -> GatewayError {
        GatewayError::Status(Box::new(StatusError {
            status,
            code: code.into(),
            message: String::new(),
            path: "/x".into(),
            body: String::new(),
            details: None,
            retry_after,
            served: Served::default(),
            unreachable: false,
        }))
    }

    #[test]
    fn secrets_stay_out_of_debug_and_decode_errors() {
        let call = CallOptions::default();
        let spec = Spec::new(Method::POST, "/v1/rooms/X/lines", TimeoutGroup::Rooms, &call).auth(Auth::Bearer("pt-secret".into()));
        assert!(!format!("{spec:?}").contains("pt-secret"));
        let activate = Spec::new(Method::POST, "/v1/activate", TimeoutGroup::Admin, &call)
            .body(Body::json(&serde_json::json!({"key": "ucast_live_secret"})).unwrap());
        assert!(!format!("{activate:?}").contains("ucast_live_secret"));
        let f = Fetched {
            status: 200,
            headers: HeaderMap::new(),
            served: Served::default(),
            bytes: Bytes::from_static(br#"{"code": 5, "publishToken": "pt-secret", "apiKey": 12345678}"#),
        };
        #[derive(Debug, serde::Deserialize)]
        #[allow(dead_code)]
        struct Shape {
            code: String,
            #[serde(rename = "apiKey")]
            api_key: String,
        }
        let leaky = f.json::<Shape>("/x").unwrap_err();
        assert!(format!("{leaky:?}").contains("pt-secret"), "the plain decoder keeps the body (for non-secret answers)");
        let err = f.json_secret::<Shape>("/x").unwrap_err();
        let text = format!("{err} {err:?}");
        assert!(!text.contains("pt-secret") && !text.contains("12345678"), "{text}");
        assert_eq!(err.code(), "bad_response");
    }

    #[test]
    fn retry_rules() {
        let p = RetryPolicy::default();
        let zero = Duration::ZERO;
        // Idempotent 503 without Retry-After: backoff.
        assert_eq!(p.wait_for(&status(503, "unavailable", None), true, 0, zero), Some(Duration::from_millis(200)));
        assert_eq!(p.wait_for(&status(503, "unavailable", None), true, 1, zero), Some(Duration::from_millis(600)));
        assert_eq!(p.wait_for(&status(503, "unavailable", None), true, 2, zero), None, "at most 2 retries");
        // Retry-After honoured, within the cap and the budget.
        assert_eq!(p.wait_for(&status(429, "rate_limited", Some(Duration::from_secs(1))), true, 0, zero), Some(Duration::from_secs(1)));
        assert_eq!(p.wait_for(&status(503, "warming", Some(Duration::from_secs(30))), true, 0, zero), None, "too long a Retry-After");
        assert_eq!(p.wait_for(&status(503, "x", Some(Duration::from_secs(4))), true, 1, Duration::from_secs(8)), None, "over budget");
        // Never: paid calls, 4xx, exhausted daily budget.
        assert_eq!(p.wait_for(&status(503, "unavailable", None), false, 0, zero), None);
        assert_eq!(p.wait_for(&status(400, "invalid_request", None), true, 0, zero), None);
        assert_eq!(p.wait_for(&status(429, "daily_budget_exhausted", Some(Duration::from_secs(1))), true, 0, zero), None);
        // Opt-in for paid calls.
        let all = RetryPolicy { retry_non_idempotent: true, ..RetryPolicy::default() };
        assert!(all.wait_for(&status(502, "http_502", None), false, 0, zero).is_some());
        assert_eq!(RetryPolicy::none().wait_for(&status(503, "x", None), true, 0, zero), None);
    }
}

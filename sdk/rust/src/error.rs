//! Typed errors of the client (mirror of the Node SDK `GatewayError`, `sdk/node/gateway-http.ts`).

use std::time::Duration;

use reqwest::header::HeaderMap;
use serde_json::Value;

use crate::types::Served;

/// Result alias of the crate.
pub type Result<T, E = GatewayError> = std::result::Result<T, E>;

/// Every failure of a gateway call.
///
/// - [`GatewayError::Http`]: transport error before the response headers (connection refused, DNS, TLS, connection
///   reset); `unreachable` only for connect / connect-timeout failures.
/// - [`GatewayError::Timeout`]: the call's deadline fired.
/// - [`GatewayError::Status`]: the gateway (or the edge in front of it) answered a non-2xx status; carries the body.
/// - [`GatewayError::Stream`]: a body broke after the headers (code `stream_error` for streams, `bad_response` for a
///   buffered body) or a chat stream carried an in-band error (with the gateway's code and the raw object).
/// - [`GatewayError::Decode`]: a 2xx body that is not the expected JSON.
/// - [`GatewayError::BreakerOpen`]: the opt-in client breaker is open and the gateway still does not answer `/health`.
/// - [`GatewayError::Config`]: invalid client configuration or request (bad base URL, bad MIME type, a header value
///   with a newline…). Never secret-bearing: error texts never include API keys, tokens or provider keys.
#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    /// Transport error before the response headers. `unreachable` is true for connect and connect-timeout failures
    /// (the gateway itself could not be reached).
    #[error("gateway unreachable on {path}: {source}")]
    Http {
        path: String,
        unreachable: bool,
        #[source]
        source: reqwest::Error,
    },

    /// The call's deadline fired. `headers_received` = false means the gateway never answered (unreachable).
    #[error("gateway timed out after {}ms on {path}{}", after.as_millis(), if *headers_received { " (reading the body)" } else { "" })]
    Timeout { path: String, after: Duration, headers_received: bool },

    /// Non-2xx answer, with the body.
    #[error("{0}")]
    Status(Box<StatusError>),

    /// A streamed body broke, or carried an in-band `{"error": …}` event.
    #[error("stream error on {path}: {message}")]
    Stream {
        path: String,
        code: String,
        message: String,
        served: Option<Box<Served>>,
        /// The raw in-band error object of a chat stream (`{"message", "type", "code", "status"…}`), when there was one.
        details: Option<Value>,
    },

    /// A 2xx body that could not be decoded.
    #[error("bad response on {path}: {source}")]
    Decode {
        path: String,
        body: String,
        #[source]
        source: serde_json::Error,
    },

    /// The client breaker is open: the gateway failed `threshold` times in a row and its `/health` probe still fails.
    #[error("gateway skipped on {path}: unreachable recently (breaker open)")]
    BreakerOpen { path: String },

    /// Invalid configuration or request built by the caller.
    #[error("{0}")]
    Config(String),
}

/// Details of a non-2xx answer (the `Status` variant).
#[derive(Debug, Clone)]
pub struct StatusError {
    /// HTTP status.
    pub status: u16,
    /// The gateway's `error.code` / `error.type` (`provider_unavailable`, `invalid_request_error`, …), else derived
    /// from the status (`not_found`, `rate_limited`, `http_502`…), `warming` for a deployment warming up.
    pub code: String,
    /// Human message (`error.message`, `error` string, or the start of the body).
    pub message: String,
    /// Request path (without host).
    pub path: String,
    /// The raw body (lossy UTF-8, at most 4 KiB).
    pub body: String,
    /// The body parsed as JSON, when it is JSON.
    pub details: Option<Value>,
    /// `Retry-After` (seconds or HTTP date), when sent.
    pub retry_after: Option<Duration>,
    /// `X-Gateway-*` headers of the answer.
    pub served: Served,
    /// The gateway itself could not be reached: a 502/503/504 without the gateway's own JSON error (edge/proxy failure,
    /// gateway restarting). A gateway `503 provider_unavailable` is NOT unreachable.
    pub unreachable: bool,
}

impl std::fmt::Display for StatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "gateway {} on {}: {}", self.status, self.path, self.message)
    }
}

impl GatewayError {
    /// HTTP status of a `Status` error.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Status(s) => Some(s.status),
            _ => None,
        }
    }

    /// The `Status` details, if this is one.
    pub fn as_status(&self) -> Option<&StatusError> {
        match self {
            Self::Status(s) => Some(s),
            _ => None,
        }
    }

    /// The response body of a `Status` error.
    pub fn body(&self) -> Option<&str> {
        self.as_status().map(|s| s.body.as_str())
    }

    /// The JSON the gateway sent about the failure: a `Status` error's parsed body, or the raw in-band error object of
    /// a chat stream.
    pub fn details(&self) -> Option<&Value> {
        match self {
            Self::Status(s) => s.details.as_ref(),
            Self::Stream { details, .. } => details.as_ref(),
            _ => None,
        }
    }

    /// `Retry-After` of a `Status` error (429, 503 warming/cold…).
    pub fn retry_after(&self) -> Option<Duration> {
        self.as_status().and_then(|s| s.retry_after)
    }

    /// Short machine code, as the Node SDK `GatewayError.code`: `network`, `timeout`, `stream_error`, `bad_response`,
    /// `breaker_open`, `config`, or the status code of a `Status` error.
    pub fn code(&self) -> &str {
        match self {
            Self::Http { .. } => "network",
            Self::Timeout { .. } => "timeout",
            Self::Status(s) => &s.code,
            Self::Stream { code, .. } => code,
            Self::Decode { .. } => "bad_response",
            Self::BreakerOpen { .. } => "breaker_open",
            Self::Config(_) => "config",
        }
    }

    /// The gateway itself could not be reached (connection error, timeout before the first byte, edge 502/503/504,
    /// open breaker). Errors the gateway answered itself are final and not unreachable.
    pub fn is_unreachable(&self) -> bool {
        match self {
            Self::Http { unreachable, .. } => *unreachable,
            Self::Timeout { headers_received, .. } => !headers_received,
            Self::Status(s) => s.unreachable,
            Self::BreakerOpen { .. } => true,
            _ => false,
        }
    }

    /// The `X-Gateway-*` headers of the failed answer, when there was one.
    pub fn served(&self) -> Option<&Served> {
        match self {
            Self::Status(s) => Some(&s.served),
            Self::Stream { served, .. } => served.as_deref(),
            _ => None,
        }
    }

    /// Request path of the failed call (empty for `Config`).
    pub fn path(&self) -> &str {
        match self {
            Self::Http { path, .. }
            | Self::Timeout { path, .. }
            | Self::Stream { path, .. }
            | Self::Decode { path, .. }
            | Self::BreakerOpen { path } => path,
            Self::Status(s) => &s.path,
            Self::Config(_) => "",
        }
    }
}

const BODY_KEEP: usize = 4096;

/// Machine code for a status without the gateway's own code (as `STATUS_CODES` in gateway-http.ts).
fn status_code_name(status: u16) -> Option<&'static str> {
    Some(match status {
        400 => "invalid_request",
        401 => "unauthorized",
        403 => "forbidden",
        404 => "not_found",
        405 => "method_not_allowed",
        409 => "conflict",
        413 => "too_large",
        429 => "rate_limited",
        503 => "unavailable",
        _ => return None,
    })
}

/// `Retry-After` as delta-seconds (integer or decimal) or an HTTP date.
pub(crate) fn parse_retry_after(value: &str) -> Option<Duration> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    if let Ok(secs) = v.parse::<f64>() {
        return (secs.is_finite() && secs > 0.0).then(|| Duration::from_secs_f64(secs));
    }
    let at = httpdate::parse_http_date(v).ok()?;
    at.duration_since(std::time::SystemTime::now()).ok()
}

/// Builds the `Status` error of a non-2xx answer (gateway shapes `{error:{message,type,code}}` and `{error:"…"}`).
pub(crate) fn status_error(status: u16, headers: &HeaderMap, body: &[u8], path: &str) -> GatewayError {
    let text = String::from_utf8_lossy(body);
    let details: Option<Value> = serde_json::from_slice(body).ok();
    let err = details.as_ref().and_then(|d| d.get("error")).filter(|e| !e.is_null());
    let own_error = err.is_some();
    let message = match err {
        Some(Value::String(s)) => s.clone(),
        Some(obj) => obj.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_default(),
        None => String::new(),
    };
    let message = if message.is_empty() {
        let t: String = text.trim().chars().take(300).collect();
        if t.is_empty() {
            format!("HTTP {status}")
        } else {
            t
        }
    } else {
        message
    };
    let named = err
        .and_then(|e| {
            ["code", "type"]
                .iter()
                .find_map(|k| e.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()))
        })
        .map(str::to_string);
    let warming = details.as_ref().and_then(|d| d.get("status")).and_then(Value::as_str) == Some("warming");
    let code = named.unwrap_or_else(|| {
        if warming {
            "warming".to_string()
        } else {
            status_code_name(status).map(str::to_string).unwrap_or_else(|| format!("http_{status}"))
        }
    });
    let retry_after = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_retry_after);
    let body: String = if text.len() > BODY_KEEP {
        let mut end = BODY_KEEP;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text[..end].to_string()
    } else {
        text.into_owned()
    };
    GatewayError::Status(Box::new(StatusError {
        status,
        code,
        message,
        path: path.to_string(),
        body,
        details,
        retry_after,
        served: Served::from_headers(headers),
        unreachable: matches!(status, 502..=504) && !own_error,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn openai_shaped_error_keeps_the_gateway_code() {
        let body = br#"{"error":{"message":"No provider available","type":"provider_unavailable","code":"provider_unavailable"}}"#;
        let e = status_error(503, &headers(&[("retry-after", "7")]), body, "/v1/chat/completions");
        assert_eq!(e.status(), Some(503));
        assert_eq!(e.code(), "provider_unavailable");
        assert_eq!(e.retry_after(), Some(Duration::from_secs(7)));
        assert!(!e.is_unreachable(), "the gateway answered: not unreachable");
        assert!(e.to_string().contains("No provider available"));
    }

    #[test]
    fn management_string_error_and_warming() {
        let e = status_error(503, &HeaderMap::new(), br#"{"error":"replicas are starting","status":"warming"}"#, "/v1/deployments/x");
        assert_eq!(e.code(), "warming");
        assert_eq!(e.as_status().unwrap().message, "replicas are starting");
    }

    #[test]
    fn edge_failure_is_unreachable() {
        let e = status_error(502, &HeaderMap::new(), b"<html>Bad gateway</html>", "/health");
        assert!(e.is_unreachable());
        assert_eq!(e.code(), "http_502");
        let e = status_error(404, &HeaderMap::new(), b"", "/x");
        assert_eq!(e.code(), "not_found");
        assert_eq!(e.as_status().unwrap().message, "HTTP 404");
    }

    #[test]
    fn retry_after_parses_seconds_and_dates() {
        assert_eq!(parse_retry_after("2"), Some(Duration::from_secs(2)));
        assert_eq!(parse_retry_after("0.5"), Some(Duration::from_millis(500)));
        assert_eq!(parse_retry_after("0"), None);
        assert_eq!(parse_retry_after("soon"), None);
        let later = httpdate::fmt_http_date(std::time::SystemTime::now() + Duration::from_secs(30));
        let d = parse_retry_after(&later).unwrap();
        assert!(d > Duration::from_secs(25) && d <= Duration::from_secs(30), "{d:?}");
    }
}

//! [`GatewayClient`] and its builder.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use reqwest::Method;
use serde_json::Value;

use crate::breaker::{BreakerConfig, GatewayBreaker, GatewayState};
use crate::error::{GatewayError, Result};
use crate::http::{RetryPolicy, Spec};
use crate::types::{CallOptions, HealthReport, TimeoutGroup, Timeouts, REDACTED};

/// Gateway URL used by [`GatewayClientBuilder::from_env`] when no env var is set (same default as the
/// `ai-gateway` CLI).
pub const DEFAULT_BASE_URL: &str = "http://localhost:4000";

/// Env vars read for the base URL, in order (as the `ai-gateway` CLI and the repo scripts).
pub const ENV_BASE_URL: [&str; 2] = ["AI_GATEWAY_URL", "GATEWAY_URL"];

/// Env vars read for the API key, in order.
pub const ENV_API_KEY: [&str; 2] = ["AI_GATEWAY_API_KEY", "GATEWAY_API_KEY"];

/// Env var read for `X-App` by [`GatewayClientBuilder::from_env`].
pub const ENV_APP: &str = "GATEWAY_APP";

const DEFAULT_USER_AGENT: &str = concat!("ai-gateway-sdk-rust/", env!("CARGO_PKG_VERSION"));

/// Typed async client of the current gateway API (`serve.ts`). Cheap to clone (shared connection pool and breaker).
///
/// ```no_run
/// # async fn demo() -> ai_gateway_sdk::Result<()> {
/// use ai_gateway_sdk::{ChatMessage, ChatRequest, GatewayClient};
///
/// let gw = GatewayClient::builder()
///     .base_url("https://gateway.example.com")
///     .api_key(std::env::var("GATEWAY_API_KEY").unwrap_or_default())
///     .build()?;
/// let answer = gw.chat(ChatRequest::new("parle-llm", vec![ChatMessage::user("Olá")])).await?;
/// println!("{:?} via {:?}", answer.content(), answer.served.provider);
/// # Ok(()) }
/// ```
#[derive(Clone)]
pub struct GatewayClient {
    pub(crate) inner: Arc<Inner>,
}

pub(crate) struct Inner {
    pub base_url: String,
    pub api_key: Option<String>,
    pub app: Option<String>,
    pub http: reqwest::Client,
    pub timeouts: Timeouts,
    pub retry: RetryPolicy,
    pub breaker: Option<Arc<GatewayBreaker>>,
}

impl std::fmt::Debug for GatewayClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayClient")
            .field("base_url", &self.inner.base_url)
            .field("api_key", &self.inner.api_key.as_ref().map(|_| REDACTED))
            .field("app", &self.inner.app)
            .field("timeouts", &self.inner.timeouts)
            .field("retry", &self.inner.retry)
            .field("breaker", &self.inner.breaker.as_ref().map(|b| b.config))
            .finish()
    }
}

/// Builder of [`GatewayClient`]. Its `Debug` redacts the API key.
#[derive(Clone)]
pub struct GatewayClientBuilder {
    base_url: Option<String>,
    api_key: Option<String>,
    app: Option<String>,
    user_agent: Option<String>,
    timeouts: Timeouts,
    connect_timeout: Option<Duration>,
    retry: RetryPolicy,
    breaker: Option<BreakerConfig>,
    http: Option<reqwest::Client>,
}

impl std::fmt::Debug for GatewayClientBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayClientBuilder")
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| REDACTED))
            .field("app", &self.app)
            .field("user_agent", &self.user_agent)
            .field("timeouts", &self.timeouts)
            .field("connect_timeout", &self.connect_timeout)
            .field("retry", &self.retry)
            .field("breaker", &self.breaker)
            .field("http", &self.http.as_ref().map(|_| "<custom reqwest::Client>"))
            .finish()
    }
}

impl Default for GatewayClientBuilder {
    fn default() -> Self {
        Self {
            base_url: None,
            api_key: None,
            app: None,
            user_agent: None,
            timeouts: Timeouts::default(),
            connect_timeout: Some(Duration::from_secs(10)),
            retry: RetryPolicy::default(),
            breaker: None,
            http: None,
        }
    }
}

fn env_first(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|n| std::env::var(n).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()))
}

impl GatewayClientBuilder {
    /// A builder pre-filled from the environment: base URL from `AI_GATEWAY_URL`, then `GATEWAY_URL` (else
    /// [`DEFAULT_BASE_URL`]); API key from `AI_GATEWAY_API_KEY`, then `GATEWAY_API_KEY`; `X-App` from `GATEWAY_APP`.
    /// Later builder calls override them.
    pub fn from_env() -> Self {
        Self {
            base_url: Some(env_first(&ENV_BASE_URL).unwrap_or_else(|| DEFAULT_BASE_URL.to_string())),
            api_key: env_first(&ENV_API_KEY),
            app: env_first(&[ENV_APP]),
            ..Self::default()
        }
    }

    /// Gateway base URL, e.g. `https://gateway.example.com` (no trailing `/v1`; trailing slashes are trimmed).
    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = Some(url.into());
        self
    }

    /// Gateway API key, sent as `Authorization: Bearer <key>`. An empty key sends no header (keyless localhost).
    pub fn api_key(mut self, key: impl Into<String>) -> Self {
        let key: String = key.into();
        self.api_key = Some(key.trim().to_string()).filter(|k| !k.is_empty());
        self
    }

    /// Sends `X-App` (an admin key acting for an app, or an app key naming its own app).
    pub fn app(mut self, app: impl Into<String>) -> Self {
        self.app = Some(app.into()).filter(|a| !a.is_empty());
        self
    }

    /// `User-Agent` header (default `ai-gateway-sdk-rust/<version>`). Ignored with [`Self::http_client`].
    pub fn user_agent(mut self, ua: impl Into<String>) -> Self {
        self.user_agent = Some(ua.into());
        self
    }

    /// Default timeout of one group ([`Duration::ZERO`] = none).
    pub fn timeout(mut self, group: TimeoutGroup, timeout: Duration) -> Self {
        self.timeouts.set(group, timeout);
        self
    }

    /// Replaces every group timeout.
    pub fn timeouts(mut self, timeouts: Timeouts) -> Self {
        self.timeouts = timeouts;
        self
    }

    /// TCP/TLS connect timeout (default 10 s; `None` = reqwest's default). Ignored with [`Self::http_client`].
    pub fn connect_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.connect_timeout = timeout;
        self
    }

    /// Retry policy (default: [`RetryPolicy::default`]).
    pub fn retry(mut self, policy: RetryPolicy) -> Self {
        self.retry = policy;
        self
    }

    /// Enables the client breaker on the gateway itself (off by default; see [`crate::breaker`]).
    pub fn breaker(mut self, config: BreakerConfig) -> Self {
        self.breaker = Some(config);
        self
    }

    /// Uses this reqwest client (custom TLS, proxy, pool…) instead of building one.
    pub fn http_client(mut self, client: reqwest::Client) -> Self {
        self.http = Some(client);
        self
    }

    /// Builds the client. Fails when the base URL is missing or not `http(s)://`.
    pub fn build(self) -> Result<GatewayClient> {
        let base = self
            .base_url
            .ok_or_else(|| GatewayError::Config("GatewayClient: base_url is required".into()))?;
        let base_url = base.trim().trim_end_matches('/').to_string();
        let parsed = reqwest::Url::parse(&base_url)
            .map_err(|e| GatewayError::Config(format!("GatewayClient: invalid base_url {base_url:?}: {e}")))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(GatewayError::Config(format!("GatewayClient: base_url must be http(s), got {base_url:?}")));
        }
        let http = match self.http {
            Some(c) => c,
            None => {
                let mut b = reqwest::Client::builder()
                    .user_agent(self.user_agent.unwrap_or_else(|| DEFAULT_USER_AGENT.to_string()));
                if let Some(t) = self.connect_timeout {
                    b = b.connect_timeout(t);
                }
                b.build()
                    .map_err(|e| GatewayError::Config(format!("GatewayClient: http client: {e}")))?
            }
        };
        Ok(GatewayClient {
            inner: Arc::new(Inner {
                base_url,
                api_key: self.api_key,
                app: self.app,
                http,
                timeouts: self.timeouts,
                retry: self.retry,
                breaker: self.breaker.map(|c| Arc::new(GatewayBreaker::new(c))),
            }),
        })
    }
}

impl GatewayClient {
    /// A builder with nothing set.
    pub fn builder() -> GatewayClientBuilder {
        GatewayClientBuilder::default()
    }

    /// Client with defaults for `base_url` and `api_key` (empty key = no `Authorization` header).
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Result<Self> {
        Self::builder().base_url(base_url).api_key(api_key).build()
    }

    /// Client configured from the environment (see [`GatewayClientBuilder::from_env`]).
    pub fn from_env() -> Result<Self> {
        GatewayClientBuilder::from_env().build()
    }

    /// The base URL (no trailing slash).
    pub fn base_url(&self) -> &str {
        &self.inner.base_url
    }

    /// The configured API key, if any.
    pub fn api_key(&self) -> Option<&str> {
        self.inner.api_key.as_deref()
    }

    /// The configured `X-App`, if any.
    pub fn app(&self) -> Option<&str> {
        self.inner.app.as_deref()
    }

    /// A client like this one with another API key (empty = no `Authorization` header). Cheap: it shares the
    /// connection pool and the breaker, so an app whose key changes at runtime (e.g. after an activation) swaps
    /// clients without reconnecting.
    pub fn with_api_key(&self, key: impl Into<String>) -> Self {
        let key: String = key.into();
        self.derive(|i| i.api_key = Some(key.trim().to_string()).filter(|k| !k.is_empty()))
    }

    /// A client like this one with another `X-App` (empty = none); shares the pool and the breaker.
    pub fn with_app(&self, app: impl Into<String>) -> Self {
        let app: String = app.into();
        self.derive(|i| i.app = Some(app).filter(|a| !a.is_empty()))
    }

    fn derive(&self, change: impl FnOnce(&mut Inner)) -> Self {
        let i = &self.inner;
        let mut inner = Inner {
            base_url: i.base_url.clone(),
            api_key: i.api_key.clone(),
            app: i.app.clone(),
            http: i.http.clone(),
            timeouts: i.timeouts,
            retry: i.retry.clone(),
            breaker: i.breaker.clone(),
        };
        change(&mut inner);
        Self { inner: Arc::new(inner) }
    }

    /// URL apps call a deployment's replica through, with the gateway key (`<invokeUrl>/<path>` → the container's
    /// `/<path>`).
    pub fn invoke_url(&self, deployment: &str) -> String {
        format!("{}/v1/deployments/{}/invoke", self.inner.base_url, enc(deployment))
    }

    /// The breaker's view of the gateway (always `Closed` when the breaker is off).
    pub fn gateway_state(&self) -> GatewayState {
        match &self.inner.breaker {
            Some(b) => b.state(),
            None => GatewayState {
                breaker: crate::breaker::BreakerPosition::Closed,
                consecutive_failures: 0,
                opened_at_ms: None,
                last_error: None,
            },
        }
    }

    // ── health ──────────────────────────────────────────────────────────────

    /// `GET /health` (`{ status, version, uptimeSeconds }`).
    pub async fn health(&self) -> Result<HealthReport> {
        self.health_with("/health", &CallOptions::default()).await
    }

    /// `GET /health?deep=1` (admin key).
    pub async fn health_deep(&self) -> Result<HealthReport> {
        self.health_with("/health?deep=1", &CallOptions::default()).await
    }

    /// `GET /health?details=1`: stage chains, app budgets (an admin sees everything, an app key its own).
    pub async fn health_details(&self) -> Result<HealthReport> {
        self.health_with("/health?details=1", &CallOptions::default()).await
    }

    /// `GET <path>` health variant with call options.
    async fn health_with(&self, path: &str, call: &CallOptions) -> Result<HealthReport> {
        let f = self.fetch(&Spec::new(Method::GET, path, TimeoutGroup::Health, call)).await?;
        if let Some(b) = &self.inner.breaker {
            b.success();
        }
        f.json(path)
    }

    /// True when `GET /health` answers 2xx (never fails).
    pub async fn is_healthy(&self) -> bool {
        self.health().await.is_ok()
    }

    /// `GET /v1/models`: OpenAI-style model list (`{ object: "list", data: [...] }`), as JSON.
    pub async fn models(&self) -> Result<Value> {
        let path = "/v1/models";
        self.fetch(&Spec::new(Method::GET, path, TimeoutGroup::Admin, &CallOptions::default()))
            .await?
            .json(path)
    }

    // ── breaker plumbing ────────────────────────────────────────────────────

    /// Runs an inference call under the breaker (when enabled).
    pub(crate) async fn guarded<T, F>(&self, path: &str, fut: F) -> Result<T>
    where
        F: Future<Output = Result<T>>,
    {
        let Some(b) = &self.inner.breaker else { return fut.await };
        if b.is_open() && !self.recheck(b).await {
            return Err(GatewayError::BreakerOpen { path: path.to_string() });
        }
        let out = fut.await;
        match &out {
            Err(e) if e.is_unreachable() => b.failure(e.code()),
            _ => b.success(),
        }
        out
    }

    /// While open: probe `/health` (shared, rate-limited). True once the gateway answered.
    async fn recheck(&self, b: &GatewayBreaker) -> bool {
        let _probe = b.probe_lock.lock().await;
        if !b.is_open() {
            return true; // another caller's probe closed it
        }
        if b.probe_failed_recently() {
            return false;
        }
        // The guard clears `Probing` even when the caller drops this future mid-probe.
        let probing = b.probing();
        let ok = self.probe(b.config.probe_timeout).await;
        drop(probing);
        if ok {
            b.success();
        } else {
            b.probe_failed();
        }
        ok
    }

    /// One unauthenticated `GET /health`, no retry (as the Node SDK `probe`).
    async fn probe(&self, timeout: Duration) -> bool {
        let url = format!("{}/health", self.inner.base_url);
        matches!(
            tokio::time::timeout(timeout, self.inner.http.get(url).send()).await,
            Ok(Ok(r)) if r.status().is_success()
        )
    }
}

/// Percent-encodes one path segment (as `encodeURIComponent`).
pub(crate) fn enc(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for b in segment.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_validates_and_trims() {
        let c = GatewayClient::new("https://gw.example.com//", "  k  ").unwrap();
        assert_eq!(c.base_url(), "https://gw.example.com");
        assert_eq!(c.api_key(), Some("k"));
        assert!(GatewayClient::new("", "").is_err());
        assert!(GatewayClient::new("ftp://x", "").is_err());
        assert!(GatewayClient::builder().build().is_err());
        assert_eq!(GatewayClient::new("http://h", "").unwrap().api_key(), None);
    }

    #[test]
    fn debug_redacts_the_key() {
        let c = GatewayClient::new("https://gw.example.com", "secret-key").unwrap();
        let d = format!("{c:?}");
        assert!(!d.contains("secret-key") && d.contains("redacted"));
        let b = GatewayClient::builder().base_url("https://gw.example.com").api_key("builder-secret");
        let d = format!("{b:?} {b:#?}");
        assert!(!d.contains("builder-secret") && d.contains(REDACTED), "{d}");
        let swapped = c.with_api_key("other-secret");
        assert!(!format!("{swapped:?}").contains("other-secret"));
    }

    #[test]
    fn with_api_key_shares_pool_and_breaker() {
        let c = GatewayClient::builder()
            .base_url("https://gw.example.com")
            .api_key("old")
            .app("parle")
            .breaker(BreakerConfig::default())
            .build()
            .unwrap();
        let d = c.with_api_key(" new ");
        assert_eq!((d.api_key(), d.app(), d.base_url()), (Some("new"), Some("parle"), "https://gw.example.com"));
        assert_eq!(c.api_key(), Some("old"), "the original is unchanged");
        assert!(Arc::ptr_eq(c.inner.breaker.as_ref().unwrap(), d.inner.breaker.as_ref().unwrap()));
        assert_eq!(d.with_api_key("").api_key(), None);
        assert_eq!(d.with_app("").app(), None);
    }

    #[test]
    fn invoke_url_and_encoding() {
        let c = GatewayClient::new("https://gw.example.com", "").unwrap();
        assert_eq!(c.invoke_url("parle-speech"), "https://gw.example.com/v1/deployments/parle-speech/invoke");
        assert_eq!(enc("a b/c?d"), "a%20b%2Fc%3Fd");
        assert_eq!(enc("ção"), "%C3%A7%C3%A3o");
    }
}

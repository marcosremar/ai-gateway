//! Shared types: where an answer came from, per-call options, timeout groups, health.

use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What `Debug` prints in place of a secret (API key, publish token, provider key).
pub(crate) const REDACTED: &str = "<redacted>";

/// Where an answer came from: `X-Gateway-Provider` / `X-Gateway-Fallback` / `X-Gateway-Fallback-From`, plus the
/// echoed `X-Request-Id`. `None` when the header is absent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Served {
    /// Who answered: `deployment:<name>`, `openrouter:<model>`, `cache`…
    pub provider: Option<String>,
    /// Why the first target of the chain was left (`cold`, `5xx`, `timeout`…), only when it was.
    pub fallback: Option<String>,
    /// The provider that was left behind.
    pub fallback_from: Option<String>,
    /// The effective request id the gateway logged.
    pub request_id: Option<String>,
}

impl Served {
    /// Reads the `X-Gateway-*` headers.
    pub fn from_headers(headers: &HeaderMap) -> Self {
        let get = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        Self {
            provider: get("x-gateway-provider"),
            fallback: get("x-gateway-fallback"),
            fallback_from: get("x-gateway-fallback-from"),
            request_id: get("x-request-id"),
        }
    }
}

/// Timeout groups (as the Node SDK `TimeoutGroup`, plus `Rooms`); each call may override with
/// [`CallOptions::timeout`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TimeoutGroup {
    Stt,
    Chat,
    Tts,
    S2s,
    Admin,
    Health,
    /// Live rooms (publish line / audio): a caption stuck longer than this is already late.
    Rooms,
}

/// Per-group default timeouts. Defaults match `GATEWAY_CLIENT_TIMEOUTS` of the Node SDK (stt/chat/tts 15 s, s2s 50 s,
/// admin 30 s, health 10 s), plus rooms 8 s. `Duration::ZERO` = no timeout.
///
/// For streamed results (`chat_stream`, `speech_stream`, `s2s`) the timeout bounds the wait for the response headers
/// only; for buffered results it bounds headers + body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub stt: Duration,
    pub chat: Duration,
    pub tts: Duration,
    pub s2s: Duration,
    pub admin: Duration,
    pub health: Duration,
    pub rooms: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            stt: Duration::from_secs(15),
            chat: Duration::from_secs(15),
            tts: Duration::from_secs(15),
            s2s: Duration::from_secs(50),
            admin: Duration::from_secs(30),
            health: Duration::from_secs(10),
            rooms: Duration::from_secs(8),
        }
    }
}

impl Timeouts {
    /// The timeout of a group.
    pub fn get(&self, group: TimeoutGroup) -> Duration {
        match group {
            TimeoutGroup::Stt => self.stt,
            TimeoutGroup::Chat => self.chat,
            TimeoutGroup::Tts => self.tts,
            TimeoutGroup::S2s => self.s2s,
            TimeoutGroup::Admin => self.admin,
            TimeoutGroup::Health => self.health,
            TimeoutGroup::Rooms => self.rooms,
        }
    }

    /// Sets the timeout of a group.
    pub fn set(&mut self, group: TimeoutGroup, value: Duration) {
        match group {
            TimeoutGroup::Stt => self.stt = value,
            TimeoutGroup::Chat => self.chat = value,
            TimeoutGroup::Tts => self.tts = value,
            TimeoutGroup::S2s => self.s2s = value,
            TimeoutGroup::Admin => self.admin = value,
            TimeoutGroup::Health => self.health = value,
            TimeoutGroup::Rooms => self.rooms = value,
        }
    }
}

/// Per-call options (as the Node SDK `CallOptions`). Cancel a call by dropping its future.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallOptions {
    /// Overrides the group timeout for this call.
    pub timeout: Option<Duration>,
    /// End-user device id, sent as `X-Gateway-Device`.
    pub device: Option<String>,
    /// Request id sent as `X-Request-Id` (≤ 128 chars of `[A-Za-z0-9_.-]`; anything else is replaced by the gateway).
    pub request_id: Option<String>,
}

impl CallOptions {
    /// Options with only a timeout.
    pub fn timeout(timeout: Duration) -> Self {
        Self { timeout: Some(timeout), ..Self::default() }
    }
}

/// `GET /health` answer: `{ status, version, uptimeSeconds, … }`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HealthReport {
    #[serde(default)]
    pub status: String,
    /// Every other field (`version`, `uptimeSeconds`, the deep / details views…).
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl HealthReport {
    /// `status` is `ok` (or `healthy`).
    pub fn is_ok(&self) -> bool {
        matches!(self.status.as_str(), "ok" | "healthy")
    }
}

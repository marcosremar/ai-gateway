//! Opt-in client breaker on the gateway ITSELF (port of `sdk/node/gateway-breaker.ts`, without the direct fallback).
//!
//! After `threshold` consecutive *unreachable* failures (connection error, timeout before the first byte, edge
//! 502/503/504) of an inference call, the breaker opens. While open, each inference call first probes `GET /health`
//! (at most once per `recheck_interval`, concurrent calls share one probe): when the gateway answers, the breaker
//! closes and the call goes through; otherwise the call fails fast with
//! [`GatewayError::BreakerOpen`](crate::GatewayError::BreakerOpen) instead of waiting for its own timeout.
//!
//! This is the Node SDK's behaviour for a call without a direct route; the Node SDK only enables its breaker together
//! with `directFallback`, which this crate does not port (see the README). Errors the gateway answered itself
//! (4xx, its own `503 provider_unavailable`) never count: the gateway is alive.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Breaker configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BreakerConfig {
    /// Consecutive unreachable failures before it opens. Default 3.
    pub threshold: u32,
    /// A failed probe answers for this long (later calls fail fast without probing). Default 1 s.
    pub recheck_interval: Duration,
    /// Timeout of the `/health` probe. Default 3 s.
    pub probe_timeout: Duration,
}

impl Default for BreakerConfig {
    fn default() -> Self {
        Self { threshold: 3, recheck_interval: Duration::from_secs(1), probe_timeout: Duration::from_secs(3) }
    }
}

/// Position of the breaker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakerPosition {
    /// The gateway is used.
    Closed,
    /// Calls probe `/health` first and fail fast while it fails.
    Open,
    /// A `/health` probe is in flight.
    Probing,
}

/// Snapshot of the client's view of the gateway (as the Node SDK `GatewayState`, minus the direct-fallback fields).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayState {
    pub breaker: BreakerPosition,
    pub consecutive_failures: u32,
    /// When it opened (ms since the Unix epoch), while open.
    pub opened_at_ms: Option<u64>,
    /// Code of the last failure (`network`, `timeout`, `http_502`…).
    pub last_error: Option<String>,
}

#[derive(Debug, Default)]
struct State {
    failures: u32,
    opened_at: Option<(Instant, u64)>,
    last_error: Option<String>,
    probing: bool,
    last_probe_failed: Option<Instant>,
}

#[derive(Debug)]
pub(crate) struct GatewayBreaker {
    pub(crate) config: BreakerConfig,
    state: Mutex<State>,
    /// Serializes probes: callers that arrive during a probe wait for its verdict.
    pub(crate) probe_lock: tokio::sync::Mutex<()>,
}

impl GatewayBreaker {
    pub(crate) fn new(config: BreakerConfig) -> Self {
        Self { config, state: Mutex::new(State::default()), probe_lock: tokio::sync::Mutex::new(()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn is_open(&self) -> bool {
        self.lock().opened_at.is_some()
    }

    /// A probe failed less than `recheck_interval` ago.
    pub(crate) fn probe_failed_recently(&self) -> bool {
        self.lock().last_probe_failed.is_some_and(|t| t.elapsed() < self.config.recheck_interval)
    }

    /// Marks a probe in flight until the returned guard drops (also when the probing future is cancelled).
    pub(crate) fn probing(&self) -> ProbingGuard<'_> {
        self.lock().probing = true;
        ProbingGuard(self)
    }

    pub(crate) fn success(&self) {
        let mut s = self.lock();
        s.failures = 0;
        s.opened_at = None;
        s.last_error = None;
        s.last_probe_failed = None;
    }

    pub(crate) fn failure(&self, code: &str) {
        let mut s = self.lock();
        s.failures = s.failures.saturating_add(1);
        s.last_error = Some(code.to_string());
        if s.failures >= self.config.threshold && s.opened_at.is_none() {
            s.opened_at = Some((Instant::now(), epoch_ms()));
        }
    }

    pub(crate) fn probe_failed(&self) {
        let mut s = self.lock();
        s.last_probe_failed = Some(Instant::now());
        if s.opened_at.is_none() {
            s.opened_at = Some((Instant::now(), epoch_ms()));
        }
    }

    pub(crate) fn state(&self) -> GatewayState {
        let s = self.lock();
        GatewayState {
            breaker: if s.probing {
                BreakerPosition::Probing
            } else if s.opened_at.is_some() {
                BreakerPosition::Open
            } else {
                BreakerPosition::Closed
            },
            consecutive_failures: s.failures,
            opened_at_ms: s.opened_at.map(|(_, ms)| ms),
            last_error: s.last_error.clone(),
        }
    }
}

/// Clears the `Probing` position on drop.
pub(crate) struct ProbingGuard<'a>(&'a GatewayBreaker);

impl Drop for ProbingGuard<'_> {
    fn drop(&mut self) {
        self.0.lock().probing = false;
    }
}

fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_after_threshold_and_closes_on_success() {
        let b = GatewayBreaker::new(BreakerConfig { threshold: 2, ..BreakerConfig::default() });
        b.failure("network");
        assert!(!b.is_open());
        b.failure("timeout");
        assert!(b.is_open());
        let st = b.state();
        assert_eq!(st.breaker, BreakerPosition::Open);
        assert_eq!(st.consecutive_failures, 2);
        assert_eq!(st.last_error.as_deref(), Some("timeout"));
        b.success();
        assert_eq!(b.state(), GatewayState { breaker: BreakerPosition::Closed, consecutive_failures: 0, opened_at_ms: None, last_error: None });
    }

    #[test]
    fn probing_guard_clears_on_drop() {
        let b = GatewayBreaker::new(BreakerConfig::default());
        b.probe_failed();
        {
            let _g = b.probing();
            assert_eq!(b.state().breaker, BreakerPosition::Probing);
        }
        assert_eq!(b.state().breaker, BreakerPosition::Open);
    }

    #[test]
    fn failed_probe_answers_for_the_recheck_interval() {
        let b = GatewayBreaker::new(BreakerConfig { recheck_interval: Duration::from_millis(30), ..BreakerConfig::default() });
        b.probe_failed();
        assert!(b.is_open() && b.probe_failed_recently());
        std::thread::sleep(Duration::from_millis(40));
        assert!(!b.probe_failed_recently());
    }
}

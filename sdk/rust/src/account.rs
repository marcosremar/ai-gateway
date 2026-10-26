//! Accounts: `POST /v1/activate` (desktop-app activation keys).

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::GatewayClient;
use crate::error::{GatewayError, Result};
use crate::http::{Auth, Body, Spec};
use crate::types::{CallOptions, TimeoutGroup};

/// The account that owns an activation key.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Activation {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub plan: String,
    /// `{limits, month, monthResetsAt}`.
    #[serde(default)]
    pub quota: Value,
}

/// The account's usage report (`GET /v1/account/usage`): the current quota view — the EFFECTIVE plan (a coupon
/// counts), its limits, the month's counters and the plan dates — plus one row per day and per key.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageReport {
    /// The quota view: `plan`, `limits`, `month`, `today`, `monthResetsAt`, `dayResetsAt`, `grantEndsAt`,
    /// `viaCoupon`, `planRenewsAt`, `planCancelsAtPeriodEnd`.
    #[serde(default)]
    pub quota: Value,
    /// One row per day: `{day, requests, sttRequests, audioSeconds, llmRequests, llmTokens, ttsRequests, ttsChars, ttsSeconds, rooms}`.
    #[serde(default)]
    pub days: Vec<Value>,
    /// Per activation key totals.
    #[serde(default)]
    pub by_key: Vec<Value>,
}

#[derive(Deserialize)]
struct ActivateAnswer {
    #[serde(default)]
    ok: bool,
    #[serde(flatten)]
    activation: Activation,
}

impl GatewayClient {
    /// `POST /v1/activate {key, deviceName, appVersion}`: validates an activation key (sent in the body, not as the
    /// Bearer) and returns its account. Rate-limited per IP by the gateway; never retried.
    pub async fn activate(&self, key: &str, device_name: &str, app_version: &str) -> Result<Activation> {
        let path = "/v1/activate";
        let body = serde_json::json!({ "key": key.trim(), "deviceName": device_name, "appVersion": app_version });
        let call = CallOptions::default();
        let spec = Spec::new(Method::POST, path, TimeoutGroup::Admin, &call)
            .auth(Auth::None)
            .body(Body::json(&body)?)
            .idempotent(false);
        let answer: ActivateAnswer = self.fetch(&spec).await?.json(path)?;
        if !answer.ok {
            return Err(GatewayError::Config("unexpected /v1/activate answer: ok is not true".into()));
        }
        Ok(answer.activation)
    }

    /// `GET /v1/account/usage?days=N` — the account's quota view and daily usage, read with the activation key as the
    /// Bearer. Read-only, so no retry-safe body: never retried by the SDK.
    pub async fn usage(&self, days: u32) -> Result<UsageReport> {
        let path = format!("/v1/account/usage?days={days}");
        let call = CallOptions::default();
        let spec = Spec::new(Method::GET, &path, TimeoutGroup::Admin, &call);
        self.fetch(&spec).await?.json(&path)
    }
}

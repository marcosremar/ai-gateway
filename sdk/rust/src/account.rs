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
}

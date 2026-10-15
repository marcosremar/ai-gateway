//! Desktop-app field telemetry: `POST /v1/telemetry/app/events` (docs/app-telemetry.md).

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::GatewayClient;
use crate::error::Result;
use crate::http::{Body, Spec};
use crate::types::{CallOptions, TimeoutGroup};

/// `POST /v1/telemetry/app/events` body. Each event is `{ts, kind, fields}`; the gateway drops text keys
/// (`original`, `text`, `transcript`…) and refuses long strings.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEventsBatch {
    /// Random UUID of this install.
    pub install_id: String,
    pub app_version: String,
    pub os: String,
    pub events: Vec<Value>,
}

#[derive(Deserialize)]
struct Accepted {
    #[serde(default)]
    accepted: u64,
}

impl GatewayClient {
    /// `POST /v1/telemetry/app/events` (gateway key): returns how many events were stored. Timeout group: `Admin`.
    /// Never retried (a retry could store the batch twice); 429 / 503 / 507 carry `Retry-After`.
    pub async fn upload_app_events(&self, batch: &AppEventsBatch, call: &CallOptions) -> Result<u64> {
        let path = "/v1/telemetry/app/events";
        let spec = Spec::new(Method::POST, path, TimeoutGroup::Admin, call).body(Body::json(batch)?).idempotent(false);
        let answer: Accepted = self.fetch(&spec).await?.json(path)?;
        Ok(answer.accepted)
    }
}

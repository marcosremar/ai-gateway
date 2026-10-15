//! Deployments (`/v1/deployments*`): GPU replicas behind the gateway. Mutations need an admin key (or a client key
//! with `canStartGpu` for `wake` / `park`). Never routed elsewhere.

use std::collections::BTreeMap;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::{enc, GatewayClient};
use crate::error::Result;
use crate::http::{Body, Spec};
use crate::types::{CallOptions, TimeoutGroup};

/// One replica of a deployment (main fields; the rest in `extra`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaView {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub zone: String,
    #[serde(default)]
    pub machine_type: String,
    #[serde(default)]
    pub price_per_hour: Option<f64>,
    #[serde(default)]
    pub age_seconds: f64,
    #[serde(default)]
    pub inflight: u32,
    #[serde(default)]
    pub busy: bool,
    #[serde(default)]
    pub draining: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Mirror of the server's `DeploymentView` (main fields typed; the rest — `autoscale`, `warm`, `realtime`… — in
/// `extra`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentView {
    #[serde(default)]
    pub name: String,
    /// `paused`, `scaled-to-zero`, `warming`, `ready`, `degraded`.
    #[serde(default = "unknown")]
    pub status: String,
    #[serde(default)]
    pub spec: Value,
    #[serde(default)]
    pub desired_replicas: u32,
    #[serde(default)]
    pub replicas: Vec<ReplicaView>,
    #[serde(default)]
    pub inflight: u32,
    #[serde(default)]
    pub waiting: u32,
    #[serde(default)]
    pub last_request_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub invoke_url: String,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub app_image: Option<String>,
    #[serde(default)]
    pub public_ip: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn unknown() -> String {
    "unknown".into()
}

impl DeploymentView {
    /// Ready to serve (`ready`; `degraded` still serves with fewer replicas).
    pub fn is_ready(&self) -> bool {
        matches!(self.status.as_str(), "ready" | "degraded" | "running" | "serving")
    }
}

/// Controller health in a deployment list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentsHealth {
    #[serde(default)]
    pub deployments: u32,
    #[serde(default)]
    pub replicas: u32,
    #[serde(default)]
    pub list_error: Option<String>,
}

/// `GET /v1/deployments`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeploymentList {
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub health: DeploymentsHealth,
    #[serde(default)]
    pub deployments: Vec<DeploymentView>,
}

/// Deployment calls; get it with [`GatewayClient::deployments`].
#[derive(Debug, Clone)]
pub struct Deployments<'a> {
    client: &'a GatewayClient,
    call: CallOptions,
}

impl GatewayClient {
    /// Deployment calls (`/v1/deployments*`).
    pub fn deployments(&self) -> Deployments<'_> {
        Deployments { client: self, call: CallOptions::default() }
    }
}

impl Deployments<'_> {
    /// Uses these call options for the calls made through this handle.
    pub fn with(mut self, call: CallOptions) -> Self {
        self.call = call;
        self
    }

    fn spec(&self, method: Method, path: String) -> Spec<'_> {
        Spec::new(method, path, TimeoutGroup::Admin, &self.call)
    }

    /// `GET /v1/deployments[?app=]`.
    pub async fn list(&self, app: Option<&str>) -> Result<DeploymentList> {
        let path = match app {
            Some(a) => format!("/v1/deployments?app={}", enc(a)),
            None => "/v1/deployments".into(),
        };
        self.client.fetch(&self.spec(Method::GET, path.clone())).await?.json(&path)
    }

    /// `GET /v1/deployments/:name`; `None` when it does not exist (404).
    pub async fn get(&self, name: &str) -> Result<Option<DeploymentView>> {
        let path = format!("/v1/deployments/{}", enc(name));
        match self.client.fetch(&self.spec(Method::GET, path.clone())).await {
            Ok(f) => f.json(&path).map(Some),
            Err(e) if e.status() == Some(404) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `PUT /v1/deployments/:name`: create or update (merge), idempotent. `spec`: spec fields and/or
    /// `{"profile": …}` / `{"appImage": …, "appImageVersion": …}`.
    pub async fn put<S: Serialize + ?Sized>(&self, name: &str, spec: &S) -> Result<DeploymentView> {
        self.send_json(Method::PUT, name, "", Some(Body::json(spec)?)).await
    }

    /// `PATCH /v1/deployments/:name` (e.g. `{"minReplicas": 1}`).
    pub async fn patch<S: Serialize + ?Sized>(&self, name: &str, fields: &S) -> Result<DeploymentView> {
        self.send_json(Method::PATCH, name, "", Some(Body::json(fields)?)).await
    }

    /// `PATCH {paused: true}`.
    pub async fn pause(&self, name: &str) -> Result<DeploymentView> {
        self.patch(name, &serde_json::json!({ "paused": true })).await
    }

    /// `PATCH {paused: false}`.
    pub async fn resume(&self, name: &str) -> Result<DeploymentView> {
        self.patch(name, &serde_json::json!({ "paused": false })).await
    }

    /// `POST /v1/deployments/:name/wake`: start replicas now (pre-warm); does not wait for them to boot.
    pub async fn wake(&self, name: &str) -> Result<DeploymentView> {
        self.send_json(Method::POST, name, "/wake", None).await
    }

    /// `POST /v1/deployments/:name/park`: done for now, scale to `minReplicas`.
    pub async fn park(&self, name: &str) -> Result<DeploymentView> {
        self.send_json(Method::POST, name, "/park", None).await
    }

    /// `DELETE /v1/deployments/:name`; `false` when it did not exist.
    pub async fn delete(&self, name: &str) -> Result<bool> {
        let path = format!("/v1/deployments/{}", enc(name));
        match self.client.fetch(&self.spec(Method::DELETE, path)).await {
            Ok(_) => Ok(true),
            Err(e) if e.status() == Some(404) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// URL apps call the replica through (see [`GatewayClient::invoke_url`]).
    pub fn invoke_url(&self, name: &str) -> String {
        self.client.invoke_url(name)
    }

    async fn send_json(&self, method: Method, name: &str, suffix: &str, body: Option<Body>) -> Result<DeploymentView> {
        let path = format!("/v1/deployments/{}{suffix}", enc(name));
        // wake / park are idempotent too (as in the Node SDK).
        let spec = self.spec(method, path.clone()).body(body.unwrap_or(Body::Empty)).idempotent(true);
        let f = self.client.fetch(&spec).await?;
        if f.bytes.iter().all(u8::is_ascii_whitespace) {
            // 202/204 without a body: an empty view with the name.
            return Ok(DeploymentView { name: name.to_string(), ..DeploymentView::default() });
        }
        f.json(&path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_decodes_the_server_shape_and_keeps_the_rest() {
        let v: DeploymentView = serde_json::from_value(serde_json::json!({
            "name": "parle-speech", "status": "warming", "desiredReplicas": 1, "replicas": [{"id": "r1", "phase": "booting", "ip": null,
            "zone": "fr-par-2", "machineType": "L4", "pricePerHour": 0.75, "ageSeconds": 12, "inflight": 0, "busy": false, "draining": false,
            "stagesOut": []}], "inflight": 0, "waiting": 2, "lastRequestAt": null, "lastError": "boot timeout", "invokeUrl": "https://x/invoke",
            "app": "parle", "appImage": "speech-stack", "publicIp": null, "autoscale": {"desired": 1}, "warnings": []
        }))
        .unwrap();
        assert_eq!(v.status, "warming");
        assert!(!v.is_ready());
        assert_eq!(v.replicas[0].machine_type, "L4");
        assert_eq!(v.last_error.as_deref(), Some("boot timeout"));
        assert_eq!(v.extra["autoscale"]["desired"], 1);
        assert!(v.replicas[0].extra.contains_key("stagesOut"));
        let empty: DeploymentView = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.status, "unknown");
    }
}

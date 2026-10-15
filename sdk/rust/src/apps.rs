//! App accounts (`/v1/apps/:app*`): images, model routes (aliases), the direct-fallback plan.

use std::collections::BTreeMap;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::{enc, GatewayClient};
use crate::error::Result;
use crate::http::{Body, Spec};
use crate::types::{CallOptions, TimeoutGroup, REDACTED};

/// Mirror of `AppImage` (`src/deployments/apps.ts`). `extra` keeps fields this crate does not know, so a read →
/// edit → write round trip never drops them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppImage {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub image: String,
    #[serde(default)]
    pub digest: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub health_path: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub defaults: BTreeMap<String, Value>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub history: Vec<AppImageVersion>,
    /// Fields of newer gateways, kept as-is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One past version of an app image.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AppImageVersion {
    pub image: String,
    #[serde(default)]
    pub digest: Option<String>,
    #[serde(default)]
    pub at: u64,
    /// Fields of newer gateways, kept as-is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A deployment of an app.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDeploymentRef {
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub app_image: Option<String>,
    /// Fields of newer gateways, kept as-is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `GET /v1/apps/:app`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppView {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub images: Vec<AppImage>,
    #[serde(default)]
    pub deployments: Vec<AppDeploymentRef>,
    /// `requireDevice` and fields of newer gateways.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Stock TTS voice by the gender of the requested voice (`VoiceByGender`, `src/config/tts-fallback-voices.ts`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VoiceByGender {
    pub feminine: String,
    pub masculine: String,
    /// Fields of newer gateways, kept as-is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Mirror of `RouteEntrySpec` (`src/config/serve-providers.ts`). Every field the gateway knows is typed; `extra`
/// keeps the ones a newer gateway adds, so `routes()` → edit → `put_routes()` never strips them (the PUT replaces
/// every alias of the app).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteEntrySpec {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    /// TTS only: keeps its own voice even when the request sends `fallback_voice`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed_voice: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment: Option<String>,
    /// Deployment entries only (one-GPU mode): used when `deployment` is not registered and this one is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub one_gpu_deployment: Option<String>,
    /// Chat only: provider-specific body fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_body: Option<Map<String, Value>>,
    /// TTS only: stock voice by the gender of the requested voice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voices: Option<VoiceByGender>,
    /// TTS only, with `voices`: the app's voice ids → `feminine` / `masculine`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_genders: Option<BTreeMap<String, String>>,
    /// TTS only, with `voices`: the request's `fallback_voice` wins over the gender table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefer_fallback_voice: Option<bool>,
    /// TTS only: a refusal by the account's data policy takes this target out for a while.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_policy_guard: Option<bool>,
    /// `benchmark` (with `benchmark_dataset`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub benchmark_dataset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equivalent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Fields of newer gateways, kept as-is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A route target: `"deployment:parle-speech"`, `"openrouter:openai/whisper-large-v3-turbo"`, or a full entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RouteTarget {
    Target(String),
    /// Boxed: an entry is much larger than a target string.
    Entry(Box<RouteEntrySpec>),
}

impl From<&str> for RouteTarget {
    fn from(s: &str) -> Self {
        Self::Target(s.to_string())
    }
}

impl From<RouteEntrySpec> for RouteTarget {
    fn from(e: RouteEntrySpec) -> Self {
        Self::Entry(Box::new(e))
    }
}

/// Mirror of `ModelRoutesSpec`: stage (`chat` / `stt` / `tts`) → alias → ordered targets.
pub type ModelRoutesSpec = BTreeMap<String, BTreeMap<String, Vec<RouteTarget>>>;

/// Mirror of `FallbackCredential`. Carries a provider key: keep it in memory, server-side. Its `Debug` redacts
/// `api_key`.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackCredential {
    pub base_url: String,
    pub api_key: String,
    /// `provisioned` or `shared`.
    pub key_kind: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub limit_usd: Option<f64>,
    /// Fields of newer gateways, kept as-is (not shown by `Debug`: they could carry secrets too).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl std::fmt::Debug for FallbackCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FallbackCredential")
            .field("base_url", &self.base_url)
            .field("api_key", &REDACTED)
            .field("key_kind", &self.key_kind)
            .field("expires_at", &self.expires_at)
            .field("limit_usd", &self.limit_usd)
            .field("extra", &self.extra.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// Mirror of `FallbackEntry`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackEntry {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub voice: Option<String>,
    #[serde(default)]
    pub fixed_voice: Option<bool>,
    #[serde(default)]
    pub extra_body: Option<Map<String, Value>>,
    /// Fields of newer gateways, kept as-is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Mirror of `FallbackPlan` (`GET /v1/apps/:app/fallback`). Its credentials' `Debug` redacts the provider keys.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackPlan {
    pub app: String,
    pub issued_at: String,
    pub ttl_seconds: u64,
    #[serde(default)]
    pub providers: BTreeMap<String, FallbackCredential>,
    #[serde(default)]
    pub openrouter: Option<FallbackCredential>,
    #[serde(default)]
    pub routes: BTreeMap<String, BTreeMap<String, Vec<FallbackEntry>>>,
    /// Fields of newer gateways, kept as-is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// App-account calls; get it with [`GatewayClient::apps`].
#[derive(Debug, Clone)]
pub struct Apps<'a> {
    client: &'a GatewayClient,
    call: CallOptions,
}

impl GatewayClient {
    /// App-account calls (`/v1/apps/:app*`).
    pub fn apps(&self) -> Apps<'_> {
        Apps { client: self, call: CallOptions::default() }
    }
}

#[derive(Serialize, Deserialize)]
struct RoutesEnvelope {
    routes: ModelRoutesSpec,
}

impl Apps<'_> {
    /// Uses these call options for the calls made through this handle.
    pub fn with(mut self, call: CallOptions) -> Self {
        self.call = call;
        self
    }

    fn spec(&self, method: Method, path: String) -> Spec<'_> {
        Spec::new(method, path, TimeoutGroup::Admin, &self.call)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: String) -> Result<T> {
        self.client.fetch(&self.spec(Method::GET, path.clone())).await?.json(&path)
    }

    /// `GET /v1/apps/:app`.
    pub async fn get(&self, app: &str) -> Result<AppView> {
        self.get_json(format!("/v1/apps/{}", enc(app))).await
    }

    /// `GET /v1/apps/:app/images/:name`; `None` on 404.
    pub async fn get_image(&self, app: &str, name: &str) -> Result<Option<AppImage>> {
        match self.get_json(format!("/v1/apps/{}/images/{}", enc(app), enc(name))).await {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.status() == Some(404) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `PUT /v1/apps/:app/images/:name` with `{image, digest?, port?, healthPath?, description?, defaults?}`.
    pub async fn put_image<S: Serialize + ?Sized>(&self, app: &str, name: &str, image: &S) -> Result<AppImage> {
        let path = format!("/v1/apps/{}/images/{}", enc(app), enc(name));
        let spec = self.spec(Method::PUT, path.clone()).body(Body::json(image)?);
        self.client.fetch(&spec).await?.json(&path)
    }

    /// `GET /v1/apps/:app/routes` (the app's aliases).
    pub async fn routes(&self, app: &str) -> Result<ModelRoutesSpec> {
        let env: RoutesEnvelope = self.get_json(format!("/v1/apps/{}/routes", enc(app))).await?;
        Ok(env.routes)
    }

    /// `PUT /v1/apps/:app/routes`: replaces all of the app's aliases.
    pub async fn put_routes(&self, app: &str, routes: &ModelRoutesSpec) -> Result<ModelRoutesSpec> {
        let path = format!("/v1/apps/{}/routes", enc(app));
        let spec = self.spec(Method::PUT, path.clone()).body(Body::json(routes)?);
        let env: RoutesEnvelope = self.client.fetch(&spec).await?.json(&path)?;
        Ok(env.routes)
    }

    /// `GET /v1/apps/:app/fallback`: the direct-fallback plan (carries provider keys).
    pub async fn fallback_plan(&self, app: &str) -> Result<FallbackPlan> {
        let path = format!("/v1/apps/{}/fallback", enc(app));
        // The answer carries provider keys: a decode error must not keep the body.
        self.client.fetch(&self.spec(Method::GET, path.clone())).await?.json_secret(&path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_accept_strings_and_entries() {
        let r: ModelRoutesSpec = serde_json::from_value(serde_json::json!({
            "stt": {"parle-stt": ["deployment:parle-speech", {"provider": "openrouter", "model": "openai/whisper-large-v3-turbo"}]}
        }))
        .unwrap();
        let chain = &r["stt"]["parle-stt"];
        assert_eq!(chain[0], RouteTarget::from("deployment:parle-speech"));
        assert!(matches!(&chain[1], RouteTarget::Entry(e) if e.provider == "openrouter"));
        let back = serde_json::to_value(&r).unwrap();
        assert_eq!(back["stt"]["parle-stt"][1], serde_json::json!({"provider": "openrouter", "model": "openai/whisper-large-v3-turbo"}));
    }

    /// Every field `parseEntry` (origin/main `src/config/serve-providers.ts`) keeps, plus unknown ones.
    fn full_routes() -> Value {
        serde_json::json!({
            "chat": {"parle-llm": [
                {"provider": "deployment", "deployment": "parle-speech", "oneGpuDeployment": "parle-all", "model": "qwen",
                 "extraBody": {"reasoning": {"enabled": false}}, "equivalent": "gemini-2.5-flash-lite", "language": "pt",
                 "futureField": {"nested": [1, 2.5, null]}},
                {"provider": "openrouter", "model": "google/gemini-2.5-flash-lite", "order": "benchmark", "benchmarkDataset": "parle-pt"}
            ]},
            "tts": {"parle-tts": [
                {"provider": "openrouter", "model": "qwen/qwen3-tts", "voice": "Cherry", "fixedVoice": true,
                 "voices": {"feminine": "Cherry", "masculine": "Ethan", "neutral": "Sky"},
                 "voiceGenders": {"br-f-01": "feminine", "br-m-08": "masculine"},
                 "preferFallbackVoice": true, "accountPolicyGuard": true}
            ]},
            "stt": {"parle-stt": ["deployment:parle-speech"]},
            "newStage": {"x": [{"provider": "p", "unknown": true}]}
        })
    }

    #[test]
    fn route_entries_keep_every_server_field_and_unknown_ones() {
        let r: ModelRoutesSpec = serde_json::from_value(full_routes()).unwrap();
        let RouteTarget::Entry(e) = &r["tts"]["parle-tts"][0] else { panic!("entry") };
        assert_eq!(e.voices.as_ref().map(|v| v.masculine.as_str()), Some("Ethan"));
        assert_eq!(e.voice_genders.as_ref().unwrap()["br-f-01"], "feminine");
        assert_eq!((e.prefer_fallback_voice, e.account_policy_guard, e.fixed_voice), (Some(true), Some(true), Some(true)));
        let RouteTarget::Entry(c) = &r["chat"]["parle-llm"][0] else { panic!("entry") };
        assert_eq!(c.one_gpu_deployment.as_deref(), Some("parle-all"));
        assert!(c.extra.contains_key("futureField"));
        let RouteTarget::Entry(b) = &r["chat"]["parle-llm"][1] else { panic!("entry") };
        assert_eq!((b.order.as_deref(), b.benchmark_dataset.as_deref()), (Some("benchmark"), Some("parle-pt")));
        assert_eq!(serde_json::to_value(&r).unwrap(), full_routes(), "lossless round trip");
    }

    #[test]
    fn app_and_plan_types_keep_unknown_fields() {
        let app = serde_json::json!({"id": "parle", "createdAt": 1, "requireDevice": true,
            "images": [{"name": "speech", "image": "ghcr.io/x:1", "digest": null, "port": 8000, "healthPath": "/health",
                "description": null, "defaults": {"a": 1}, "createdAt": 2, "updatedAt": 3,
                "history": [{"image": "ghcr.io/x:0", "digest": null, "at": 1, "by": "admin"}], "newImageField": "x"}],
            "deployments": [{"name": "parle-speech", "status": "ready", "appImage": "speech", "replicas": 1}]});
        let v: AppView = serde_json::from_value(app.clone()).unwrap();
        assert_eq!(serde_json::to_value(&v).unwrap(), app);
        let plan = serde_json::json!({"app": "parle", "issuedAt": "t", "ttlSeconds": 600,
            "providers": {"groq": {"baseUrl": "https://g", "apiKey": "gsk-secret", "keyKind": "shared", "expiresAt": null, "limitUsd": null}},
            "openrouter": {"baseUrl": "https://o", "apiKey": "sk-or-secret", "keyKind": "provisioned", "expiresAt": "t2", "limitUsd": 5.0, "hash": "h"},
            "routes": {"stt": {"parle-stt": [{"provider": "groq", "model": "whisper", "voice": null, "fixedVoice": null, "extraBody": null, "lang": "pt"}]}},
            "version": 2});
        let p: FallbackPlan = serde_json::from_value(plan.clone()).unwrap();
        assert_eq!(serde_json::to_value(&p).unwrap(), plan);
        let dbg = format!("{p:?}");
        assert!(!dbg.contains("gsk-secret") && !dbg.contains("sk-or-secret") && dbg.contains(REDACTED), "{dbg}");
    }
}

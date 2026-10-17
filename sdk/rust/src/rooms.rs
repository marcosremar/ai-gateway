//! Live rooms (`/v1/rooms*`, docs/rooms.md): the page the audience opens from a QR code. Creating a room uses the
//! gateway key; publishing to it uses the room's own `publish_token`.

use std::collections::BTreeMap;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::{enc, GatewayClient};
use crate::error::{GatewayError, Result};
use crate::http::{Auth, Body, Spec};
use crate::types::{CallOptions, TimeoutGroup, REDACTED};

/// `POST /v1/rooms` body.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoom {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_lang: Option<String>,
    /// Target languages (`["en", "es"]`).
    pub languages: Vec<String>,
    /// Server-side dubbing for listeners (default true on the gateway).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_dub: Option<bool>,
    /// "Watch on YouTube" link (an `https` YouTube link; ai-gateway `main` ≥ 0f6ac49 stores it, older gateways ignore it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub youtube_url: Option<String>,
}

impl CreateRoom {
    /// A room with these target languages.
    pub fn new<I, S>(languages: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self { languages: languages.into_iter().map(Into::into).collect(), ..Self::default() }
    }

    /// Empty = not sent.
    pub fn title(mut self, t: impl Into<String>) -> Self {
        self.title = Some(t.into()).filter(|t| !t.is_empty());
        self
    }

    pub fn original_lang(mut self, l: impl Into<String>) -> Self {
        self.original_lang = Some(l.into());
        self
    }

    pub fn server_dub(mut self, on: bool) -> Self {
        self.server_dub = Some(on);
        self
    }

    /// Empty = not sent.
    pub fn youtube_url(mut self, u: impl Into<String>) -> Self {
        self.youtube_url = Some(u.into()).filter(|u| !u.is_empty());
        self
    }
}

/// A created room (`201 {code, publishToken, url, expiresAt}`). Its `Debug` redacts `publish_token`.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub code: String,
    /// Bearer token for publishing to this room only.
    pub publish_token: String,
    /// Public page URL.
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub expires_at: String,
}

impl std::fmt::Debug for Room {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Room")
            .field("code", &self.code)
            .field("publish_token", &REDACTED)
            .field("url", &self.url)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// Answer of [`Rooms::update_youtube`] (`200 {code, youtubeUrl}`): the link as the gateway stored it (normalized),
/// `None` once cleared.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomUpdate {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub youtube_url: Option<String>,
}

/// One caption line (original + translations).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomLine {
    pub id: u64,
    pub original: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_lang: Option<String>,
    /// lang → text.
    pub translations: BTreeMap<String, String>,
    /// Timestamp, ms.
    #[serde(rename = "ts", skip_serializing_if = "Option::is_none")]
    pub ts_ms: Option<u64>,
    /// End of speech → caption delay, ms (the page shows the median).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub draft: bool,
}

/// `GET /v1/rooms/:code` (public).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub code: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub original_lang: Option<String>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub ended: bool,
    #[serde(default)]
    pub lines: Vec<Value>,
    /// `createdAt`, `expiresAt`, `dubLangs`, `youtubeUrl`…
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Room calls; get it with [`GatewayClient::rooms`]. Timeout group: `Rooms` (8 s by default).
#[derive(Debug, Clone)]
pub struct Rooms<'a> {
    client: &'a GatewayClient,
    call: CallOptions,
}

impl GatewayClient {
    /// Live-room calls (`/v1/rooms*`).
    pub fn rooms(&self) -> Rooms<'_> {
        Rooms { client: self, call: CallOptions::default() }
    }
}

impl Rooms<'_> {
    /// Uses these call options (e.g. a 5 s timeout for caption lines) for the calls made through this handle.
    pub fn with(mut self, call: CallOptions) -> Self {
        self.call = call;
        self
    }

    /// `POST /v1/rooms` (gateway key).
    pub async fn create(&self, req: &CreateRoom) -> Result<Room> {
        let path = "/v1/rooms";
        let spec = Spec::new(Method::POST, path, TimeoutGroup::Rooms, &self.call).body(Body::json(req)?);
        // The answer carries the publish token: a decode error must not keep the body.
        let room: Room = self.client.fetch(&spec).await?.json_secret(path)?;
        if room.code.is_empty() || room.publish_token.is_empty() {
            let missing = if room.code.is_empty() { "code" } else { "publishToken" };
            return Err(GatewayError::Config(format!("unexpected /v1/rooms answer: no {missing}")));
        }
        Ok(room)
    }

    /// `GET /v1/rooms/:code` (public; sends no key).
    pub async fn get(&self, code: &str) -> Result<RoomSnapshot> {
        let path = format!("/v1/rooms/{}", enc(code));
        let spec = Spec::new(Method::GET, path.clone(), TimeoutGroup::Rooms, &self.call).auth(Auth::None);
        self.client.fetch(&spec).await?.json(&path)
    }

    /// `POST /v1/rooms/:code/lines` (publish token). The gateway adds or **replaces** the line with the same `id`
    /// (`RoomService.publishLine`), so publishing a line again is harmless: this call is idempotent and retried under
    /// the [`RetryPolicy`](crate::RetryPolicy) rules for idempotent calls.
    pub async fn publish_line(&self, room: &Room, line: &RoomLine) -> Result<()> {
        self.post(room, "lines", Body::json(line)?, true).await
    }

    /// `POST /v1/rooms/:code/audio` `{lineId, lang, wav}`: a dubbed clip (WAV, base64, ≤ 2 MB decoded) for listeners.
    /// Broadcast to the listeners connected now, so it is not retried (a retry could play it twice).
    pub async fn publish_audio(&self, room: &Room, line_id: u64, lang: &str, wav_base64: &str) -> Result<()> {
        let body = serde_json::json!({ "lineId": line_id, "lang": lang, "wav": wav_base64 });
        self.post(room, "audio", Body::json(&body)?, false).await
    }

    pub async fn publish_voice(&self, room: &Room, lang: &str, ref_audio: &str, ref_text: &str) -> Result<()> {
        let path = format!("/v1/rooms/{}/voice", enc(&room.code));
        let body = serde_json::json!({ "lang": lang, "ref_audio": ref_audio, "ref_text": ref_text });
        let spec = Spec::new(Method::PUT, path, TimeoutGroup::Rooms, &self.call)
            .auth(Auth::Bearer(room.publish_token.clone()))
            .body(Body::json(&body)?)
            .idempotent(true);
        self.client.fetch(&spec).await.map(|_| ())
    }

    /// `POST /v1/rooms/:code/end`: ends the room (the text stays readable).
    pub async fn end(&self, room: &Room) -> Result<()> {
        self.post(room, "end", Body::json(&serde_json::json!({}))?, false).await
    }

    /// `PATCH /v1/rooms/:code` `{"youtubeUrl"}` (publish token): sets (or clears, `None`) the "Watch on YouTube"
    /// link; the gateway accepts only `https` YouTube links (400 otherwise). Idempotent (retried as such).
    ///
    /// Requires a gateway that serves `PATCH /v1/rooms/:code` (ai-gateway `main` ≥ 0f6ac49, which answers
    /// `200 {code, youtubeUrl}`); older gateways answer **405**. A body-less 2xx is accepted too (then the result
    /// echoes the requested link).
    pub async fn update_youtube(&self, room: &Room, youtube_url: Option<&str>) -> Result<RoomUpdate> {
        let path = format!("/v1/rooms/{}", enc(&room.code));
        let spec = Spec::new(Method::PATCH, path.clone(), TimeoutGroup::Rooms, &self.call)
            .auth(Auth::Bearer(room.publish_token.clone()))
            .body(Body::json(&serde_json::json!({ "youtubeUrl": youtube_url }))?);
        let f = self.client.fetch(&spec).await?;
        if f.bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(RoomUpdate { code: room.code.clone(), youtube_url: youtube_url.map(str::to_string) });
        }
        f.json(&path)
    }

    async fn post(&self, room: &Room, what: &str, body: Body, idempotent: bool) -> Result<()> {
        let path = format!("/v1/rooms/{}/{what}", enc(&room.code));
        let spec = Spec::new(Method::POST, path, TimeoutGroup::Rooms, &self.call)
            .auth(Auth::Bearer(room.publish_token.clone()))
            .body(body)
            .idempotent(idempotent);
        self.client.fetch(&spec).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_debug_redacts_the_publish_token() {
        let room = Room { code: "ABC123".into(), publish_token: "pt-secret-123".into(), url: "u".into(), expires_at: "t".into() };
        let d = format!("{room:?} {room:#?} {:?}", Some(&room));
        assert!(!d.contains("pt-secret-123") && d.contains("ABC123") && d.contains(REDACTED), "{d}");
    }
}

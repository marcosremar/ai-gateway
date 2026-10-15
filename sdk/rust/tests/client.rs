//! Client tests against a local mock gateway (no network).

mod common;

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use ai_gateway_sdk::{
    BreakerConfig, BreakerPosition, CallOptions, ChatMessage, ChatRequest, CreateRoom, GatewayClient, GatewayError,
    RetryPolicy, RoomLine, RouteTarget, S2SConfig, S2SEvent, S2SFrame, S2SRequest, SpeechRequest, TimeoutGroup,
    TranscribeRequest,
};
use common::{dead_addr, Mock, Reply};
use futures_util::StreamExt;
use serde_json::json;

fn client(mock: &Mock) -> GatewayClient {
    GatewayClient::builder().base_url(mock.url()).api_key("test-key").build().unwrap()
}

fn completion(text: &str) -> serde_json::Value {
    json!({"id": "c1", "object": "chat.completion", "created": 1, "model": "parle-llm",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}})
}

// ── health, headers, auth ───────────────────────────────────────────────────

#[tokio::test]
async fn health_sends_key_app_and_user_agent() {
    let mock = Mock::start().await;
    mock.on("GET", "/health", vec![Reply::json(200, json!({"status": "ok", "version": "1.2.3", "uptimeSeconds": 9}))]);
    let gw = GatewayClient::builder().base_url(format!("{}/", mock.url())).api_key("k1").app("parle").user_agent("ua-test/1").build().unwrap();
    let h = gw.health().await.unwrap();
    assert!(h.is_ok());
    assert_eq!(h.extra["version"], "1.2.3");
    let r = &mock.requests()[0];
    assert_eq!(r.header("authorization"), Some("Bearer k1"));
    assert_eq!(r.header("x-app"), Some("parle"));
    assert_eq!(r.header("user-agent"), Some("ua-test/1"));
    assert!(gw.is_healthy().await);
    assert_eq!(mock.requests_to("/health")[1].query, None);
    gw.health_deep().await.unwrap();
    assert_eq!(mock.requests().last().unwrap().query.as_deref(), Some("deep=1"));
}

#[tokio::test]
async fn keyless_client_sends_no_authorization() {
    let mock = Mock::start().await;
    mock.on("GET", "/health", vec![Reply::json(200, json!({"status": "ok"}))]);
    let gw = GatewayClient::new(mock.url(), "").unwrap();
    gw.health().await.unwrap();
    let r = &mock.requests()[0];
    assert!(r.header("authorization").is_none());
    assert!(r.header("user-agent").unwrap().starts_with("ai-gateway-sdk-rust/"));
}

#[tokio::test]
async fn unhealthy_is_false_not_an_error() {
    let gw = GatewayClient::builder().base_url(dead_addr().await).retry(RetryPolicy::none()).build().unwrap();
    assert!(!gw.is_healthy().await);
}

// ── chat ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn chat_request_shape_and_served_headers() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/chat/completions", vec![Reply::json(200, completion("Hello"))
        .header("x-gateway-provider", "openrouter:google/gemini-2.5-flash-lite")
        .header("x-gateway-fallback", "cold")
        .header("x-gateway-fallback-from", "deployment:parle-speech")
        .header("x-request-id", "req-1")]);
    let gw = client(&mock);
    let req = ChatRequest::new("parle-llm", vec![ChatMessage::system("be brief"), ChatMessage::user("Olá")])
        .max_tokens(160)
        .temperature(0.2)
        .extra("top_k", json!(20))
        .device("dev-42")
        .request_id("req-1");
    let out = gw.chat(req).await.unwrap();
    assert_eq!(out.content(), Some("Hello"));
    assert_eq!(out.usage.unwrap().total_tokens, 5);
    assert_eq!(out.served.provider.as_deref(), Some("openrouter:google/gemini-2.5-flash-lite"));
    assert_eq!(out.served.fallback.as_deref(), Some("cold"));
    assert_eq!(out.served.fallback_from.as_deref(), Some("deployment:parle-speech"));
    assert_eq!(out.served.request_id.as_deref(), Some("req-1"));

    let r = &mock.requests()[0];
    assert_eq!(r.method, "POST");
    assert_eq!(r.header("authorization"), Some("Bearer test-key"));
    assert_eq!(r.header("content-type"), Some("application/json"));
    assert_eq!(r.header("x-gateway-device"), Some("dev-42"));
    assert_eq!(r.header("x-request-id"), Some("req-1"));
    assert_eq!(r.json(), json!({
        "model": "parle-llm",
        "messages": [{"role": "system", "content": "be brief"}, {"role": "user", "content": "Olá"}],
        "temperature": 0.2, "max_tokens": 160, "top_k": 20, "stream": false
    }));
}

#[tokio::test]
async fn provider_unavailable_maps_to_a_typed_error_and_is_not_retried() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/chat/completions", vec![Reply::json(503, json!({"error": {
        "message": "No provider available for chat model \"parle-llm\"", "type": "provider_unavailable", "code": "provider_unavailable"}}))
        .header("retry-after", "3")]);
    let gw = client(&mock);
    let err = gw.chat(ChatRequest::new("parle-llm", vec![ChatMessage::user("x")])).await.unwrap_err();
    assert_eq!(err.status(), Some(503));
    assert_eq!(err.code(), "provider_unavailable");
    assert_eq!(err.retry_after(), Some(Duration::from_secs(3)));
    assert!(!err.is_unreachable());
    assert!(err.body().unwrap().contains("No provider available"));
    assert_eq!(err.path(), "/v1/chat/completions");
    assert_eq!(mock.requests().len(), 1, "paid calls are never retried by default");
}

#[tokio::test]
async fn bad_json_is_a_decode_error() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/chat/completions", vec![Reply::status(200).body("not json")]);
    let err = client(&mock).chat(ChatRequest::new("m", vec![])).await.unwrap_err();
    assert!(matches!(err, GatewayError::Decode { .. }), "{err:?}");
    assert_eq!(err.code(), "bad_response");
}

#[tokio::test]
async fn chat_stream_yields_deltas_usage_and_finish_reason() {
    let mock = Mock::start().await;
    let sse = vec![
        b": keep-alive\n\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n".to_vec(),
        b"data: {\"choices\":[{\"delta\":{\"content\":\"Bom \"}}]}\n\ndata: {\"choi".to_vec(),
        b"ces\":[{\"delta\":{\"content\":\"dia\"},\"finish_reason\":\"stop\"}]}\r\n\r\n".to_vec(),
        b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2,\"total_tokens\":6}}\n\ndata: [DONE]\n\n".to_vec(),
    ];
    mock.on("POST", "/v1/chat/completions", vec![Reply::status(200)
        .header("content-type", "text/event-stream")
        .header("x-gateway-provider", "deployment:parle-speech")
        .chunks(sse)]);
    let gw = client(&mock);
    let mut stream = gw.chat_stream(ChatRequest::new("parle-llm", vec![ChatMessage::user("oi")]).include_usage(true)).await.unwrap();
    assert_eq!(stream.served().provider.as_deref(), Some("deployment:parle-speech"));
    let mut deltas = Vec::new();
    while let Some(d) = stream.next().await {
        deltas.push(d.unwrap());
    }
    assert_eq!(deltas, ["Bom ", "dia"]);
    assert_eq!(stream.finish_reason(), Some("stop"));
    assert_eq!(stream.usage().unwrap().total_tokens, 6);
    let body = mock.requests()[0].json();
    assert_eq!(body["stream"], true);
    assert_eq!(body["stream_options"], json!({"include_usage": true}), "usage() needs include_usage");
}

#[tokio::test]
async fn chat_stream_in_band_error_is_an_error_item() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/chat/completions", vec![Reply::status(200).header("content-type", "text/event-stream").chunks(vec![
        b"data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n".to_vec(),
        b"data: {\"error\":{\"message\":\"upstream broke\",\"type\":\"server_error\",\"status\":502}}\n\n".to_vec(),
    ])]);
    let mut stream = client(&mock).chat_stream(ChatRequest::new("m", vec![])).await.unwrap();
    assert_eq!(stream.next_delta().await.unwrap().unwrap(), "Hel");
    let err = stream.next_delta().await.unwrap().unwrap_err();
    assert_eq!(err.code(), "server_error");
    assert!(err.to_string().contains("upstream broke"));
    assert_eq!(err.details().unwrap()["status"], 502, "the raw in-band object is kept");
    assert!(stream.next_delta().await.is_none());
}

// ── STT ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn transcription_is_multipart_with_all_fields() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/audio/transcriptions", vec![Reply::json(200, json!({
        "text": "Bonjour", "language": "fr", "duration": 1.2, "segments": [{"id": 0, "text": "Bonjour"}]}))
        .header("x-gateway-provider", "groq")
        .header("x-stt-filtered", "none")
        .header("x-stt-raw-length", "7")]);
    let gw = client(&mock);
    let ogg = b"OggS\x00\x02fake-opus-payload".to_vec();
    let t = gw
        .transcribe(TranscribeRequest::new("babelcast-stt", ogg).language("fr").prompt("vocab: Lyon").verbose().filter_hallucinations(false))
        .await
        .unwrap();
    assert_eq!(t.text, "Bonjour");
    assert_eq!(t.language.as_deref(), Some("fr"));
    assert_eq!(t.duration, Some(1.2));
    assert_eq!(t.segments.unwrap().len(), 1);
    assert_eq!(t.served.provider.as_deref(), Some("groq"));
    assert_eq!(t.stt_filtered.as_deref(), Some("none"));
    assert_eq!(t.stt_raw_length, Some(7));

    let r = &mock.requests()[0];
    assert_eq!(r.header("authorization"), Some("Bearer test-key"));
    assert!(r.header("content-type").unwrap().starts_with("multipart/form-data; boundary="));
    let body = r.text();
    assert!(body.contains("name=\"file\"; filename=\"audio.ogg\""), "{body}");
    assert!(body.contains("Content-Type: audio/ogg"));
    assert!(body.contains("fake-opus-payload"));
    for (k, v) in [("model", "babelcast-stt"), ("language", "fr"), ("prompt", "vocab: Lyon"), ("response_format", "verbose_json"), ("filter_hallucinations", "false")] {
        assert!(body.contains(&format!("name=\"{k}\"\r\n\r\n{v}\r\n")), "field {k} missing in {body}");
    }
}

#[tokio::test]
async fn wav_transcription_without_optional_fields() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/audio/transcriptions", vec![Reply::json(200, json!({"text": ""}))]);
    let wav = b"RIFF\x24\x00\x00\x00WAVEfmt ".to_vec();
    let t = client(&mock).transcribe(TranscribeRequest::new("parle-stt", wav).language("").filename("")).await.unwrap();
    assert_eq!(t.text, "");
    let body = mock.requests()[0].text();
    assert!(body.contains("filename=\"audio.wav\"") && body.contains("Content-Type: audio/wav"));
    assert!(!body.contains("name=\"language\"") && !body.contains("name=\"prompt\"") && !body.contains("response_format"));
}

// ── TTS ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn speech_with_clone_reference() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/audio/speech", vec![Reply::status(200)
        .header("content-type", "audio/wav")
        .header("x-gateway-provider", "deployment:qwen3-tts-clone")
        .body(b"RIFFxxxxWAVE".to_vec())]);
    let gw = client(&mock);
    let req = SpeechRequest::new("babelcast-tts", "Bonjour à tous", "Ryan")
        .response_format("wav")
        .language("French")
        .instructions("calm")
        .clone_voice("data:audio/wav;base64,UklGRg==", "Bonjour")
        .timeout(Duration::from_secs(60));
    let out = gw.speech(req).await.unwrap();
    assert_eq!(&out.audio[..], b"RIFFxxxxWAVE");
    assert_eq!(out.content_type, "audio/wav");
    assert_eq!(out.served.provider.as_deref(), Some("deployment:qwen3-tts-clone"));
    assert_eq!(mock.requests()[0].json(), json!({
        "model": "babelcast-tts", "input": "Bonjour à tous", "voice": "Ryan", "response_format": "wav",
        "language": "French", "instructions": "calm", "task_type": "Base",
        "ref_audio": "data:audio/wav;base64,UklGRg==", "ref_text": "Bonjour"
    }));
}

#[tokio::test]
async fn speech_stream_arrives_in_chunks() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/audio/speech", vec![Reply::status(200).header("content-type", "audio/pcm").chunks(vec![vec![1, 2], vec![3], vec![4, 5, 6]])]);
    let s = client(&mock).speech_stream(SpeechRequest::new("parle-tts", "oi", "br-f-01").response_format("pcm")).await.unwrap();
    assert_eq!(s.content_type(), "audio/pcm");
    assert_eq!(&s.collect_bytes().await.unwrap()[..], &[1, 2, 3, 4, 5, 6]);
}

// ── s2s ─────────────────────────────────────────────────────────────────────

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = vec![kind];
    v.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    v.extend_from_slice(payload);
    v
}

#[tokio::test]
async fn s2s_frames_and_config_part() {
    let mock = Mock::start().await;
    let mut wire = frame(b'E', br#"{"type":"route","provider":"composite","fallback":"cold"}"#);
    wire.extend(frame(b'E', br#"{"type":"transcript","text":"oi"}"#));
    wire.extend(frame(b'A', &[0, 1, 2, 3]));
    wire.extend(frame(b'E', r#"{"type":"done","transcript":"oi","reply":"Olá!","total_ms":812}"#.as_bytes()));
    let (a, b) = wire.split_at(7);
    mock.on("POST", "/v1/s2s", vec![Reply::status(200).header("content-type", "application/x-aigw-s2s").chunks(vec![a.to_vec(), b.to_vec()])]);
    let cfg = S2SConfig { language: Some("pt".into()), voice: Some("br-m-08".into()), ..S2SConfig::default() };
    let mut turn = client(&mock).s2s(S2SRequest::new(b"RIFF....WAVE".to_vec(), cfg)).await.unwrap();
    let mut frames = Vec::new();
    while let Some(f) = turn.next().await {
        frames.push(f.unwrap());
    }
    assert_eq!(frames.len(), 4);
    assert!(matches!(&frames[0], S2SFrame::Event(S2SEvent::Route { provider, fallback, .. }) if provider == "composite" && fallback.as_deref() == Some("cold")));
    assert!(matches!(&frames[2], S2SFrame::Audio(pcm) if pcm.len() == 4));
    assert!(matches!(&frames[3], S2SFrame::Event(S2SEvent::Done { reply: Some(r), .. }) if r == "Olá!"));
    let body = mock.requests()[0].text();
    assert!(body.contains("name=\"file\"; filename=\"turn\""));
    assert!(body.contains(r#"{"language":"pt","voice":"br-m-08"}"#), "{body}");
}

#[tokio::test]
async fn s2s_cut_mid_frame_is_an_error() {
    let mock = Mock::start().await;
    let f = frame(b'A', &[0; 10]);
    mock.on("POST", "/v1/s2s", vec![Reply::status(200).body(f[..8].to_vec())]);
    let mut turn = client(&mock).s2s(S2SRequest::new(vec![0u8; 4], S2SConfig::default())).await.unwrap();
    let err = turn.next().await.unwrap().unwrap_err();
    assert!(err.to_string().contains("cut mid-frame"), "{err}");
}

// ── rooms ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn rooms_use_the_gateway_key_to_create_and_the_publish_token_after() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/rooms", vec![Reply::json(201, json!({"code": "ABC123", "publishToken": "pt-1", "url": "https://live/r/ABC123", "expiresAt": "2026-10-16T00:00:00Z"}))]);
    for p in ["/v1/rooms/ABC123/lines", "/v1/rooms/ABC123/audio", "/v1/rooms/ABC123/end"] {
        mock.on("POST", p, vec![Reply::status(204)]);
    }
    // origin/main (0f6ac49) answers PATCH with 200 {code, youtubeUrl}.
    mock.on("PATCH", "/v1/rooms/ABC123", vec![Reply::json(200, json!({"code": "ABC123", "youtubeUrl": null}))]);
    mock.on("GET", "/v1/rooms/ABC123", vec![Reply::json(200, json!({"code": "ABC123", "title": "Aula", "languages": ["en"], "ended": false, "lines": [], "createdAt": 1}))]);
    let gw = client(&mock);
    let rooms = gw.rooms().with(CallOptions::timeout(Duration::from_secs(5)));
    let room = rooms
        .create(&CreateRoom::new(["en", "es"]).title("Aula").original_lang("pt").youtube_url("https://youtu.be/x"))
        .await
        .unwrap();
    assert_eq!(room.code, "ABC123");
    assert_eq!(room.publish_token, "pt-1");
    let mut translations = BTreeMap::new();
    translations.insert("en".to_string(), "Hello".to_string());
    rooms
        .publish_line(&room, &RoomLine { id: 7, original: "Olá".into(), original_lang: Some("pt".into()), translations, ts_ms: Some(1000), delay_ms: Some(1800) })
        .await
        .unwrap();
    rooms.publish_audio(&room, 7, "en", "UklGRg==").await.unwrap();
    let upd = rooms.update_youtube(&room, None).await.unwrap();
    assert_eq!((upd.code.as_str(), upd.youtube_url), ("ABC123", None));
    rooms.end(&room).await.unwrap();
    let snap = gw.rooms().get("ABC123").await.unwrap();
    assert_eq!(snap.title.as_deref(), Some("Aula"));
    assert_eq!(snap.extra["createdAt"], 1);

    let reqs = mock.requests();
    assert_eq!(reqs[0].header("authorization"), Some("Bearer test-key"));
    assert_eq!(reqs[0].json(), json!({"title": "Aula", "originalLang": "pt", "languages": ["en", "es"], "youtubeUrl": "https://youtu.be/x"}));
    assert_eq!(reqs[1].header("authorization"), Some("Bearer pt-1"));
    assert_eq!(reqs[1].json(), json!({"id": 7, "original": "Olá", "originalLang": "pt", "translations": {"en": "Hello"}, "ts": 1000, "delayMs": 1800}));
    assert_eq!(reqs[2].json(), json!({"lineId": 7, "lang": "en", "wav": "UklGRg=="}));
    assert_eq!((reqs[3].method.as_str(), reqs[3].header("authorization")), ("PATCH", Some("Bearer pt-1")));
    assert_eq!(reqs[3].json(), json!({"youtubeUrl": null}));
    assert_eq!(reqs[4].path, "/v1/rooms/ABC123/end");
    assert!(reqs[5].header("authorization").is_none(), "GET room is public");
    assert!(mock.unscripted().is_empty(), "{:?}", mock.unscripted());
}

fn room() -> ai_gateway_sdk::Room {
    serde_json::from_value(json!({"code": "ABC123", "publishToken": "pt-secret-1", "url": "u", "expiresAt": "t"})).unwrap()
}

#[tokio::test]
async fn room_youtube_update_accepts_200_json_and_204_and_surfaces_405_of_older_gateways() {
    let mock = Mock::start().await;
    mock.on("PATCH", "/v1/rooms/ABC123", vec![
        Reply::json(200, json!({"code": "ABC123", "youtubeUrl": "https://www.youtube.com/watch?v=x"})),
        Reply::status(204),
        // What a gateway older than 0f6ac49 (no PATCH on /v1/rooms/:code) answers.
        Reply::json(405, json!({"error": {"message": "use GET or HEAD", "type": "invalid_request_error"}})).header("allow", "GET, HEAD"),
    ]);
    let gw = client(&mock);
    let r = room();
    let upd = gw.rooms().update_youtube(&r, Some("https://youtu.be/x")).await.unwrap();
    assert_eq!(upd.youtube_url.as_deref(), Some("https://www.youtube.com/watch?v=x"), "the gateway's normalized link");
    let upd = gw.rooms().update_youtube(&r, Some("https://youtu.be/y")).await.unwrap();
    assert_eq!((upd.code.as_str(), upd.youtube_url.as_deref()), ("ABC123", Some("https://youtu.be/y")), "204 echoes the request");
    let err = gw.rooms().update_youtube(&r, None).await.unwrap_err();
    assert_eq!((err.status(), err.code()), (Some(405), "invalid_request_error"));
    assert!(!format!("{err} {err:?}").contains("pt-secret-1"));
}

#[tokio::test]
async fn mock_answers_like_the_gateway_for_unscripted_methods_and_paths() {
    let mock = Mock::start().await;
    let gw = client(&mock);
    // A method the gateway does not serve on a known path → 405 with Allow (as src/rooms/http.ts).
    let http = reqwest::Client::new();
    let r = http.delete(format!("{}/v1/rooms/ABC123", mock.url())).send().await.unwrap();
    assert_eq!(r.status(), 405);
    assert_eq!(r.headers()["allow"], "GET, HEAD, PATCH");
    let r = http.patch(format!("{}/v1/rooms/ABC123/lines", mock.url())).send().await.unwrap();
    assert_eq!((r.status().as_u16(), r.headers()["allow"].to_str().unwrap()), (405, "POST"));
    // An unknown path → 404.
    let r = http.get(format!("{}/v1/transcribe", mock.url())).send().await.unwrap();
    assert_eq!(r.status(), 404);
    // A served route nobody scripted → 404, and listed.
    assert!(gw.rooms().get("ZZZ999").await.is_err());
    assert_eq!(mock.unscripted(), ["GET /v1/rooms/ZZZ999"]);
}

#[tokio::test]
#[should_panic(expected = "405")]
async fn mock_refuses_to_script_a_method_the_gateway_does_not_serve() {
    Mock::start().await.on("PATCH", "/v1/rooms/ABC123/lines", vec![Reply::status(204)]);
}

#[tokio::test]
#[should_panic(expected = "serves no")]
async fn mock_refuses_to_script_an_unknown_path() {
    Mock::start().await.on("POST", "/v1/translate", vec![Reply::status(200)]);
}

#[tokio::test]
async fn publish_line_is_retried_as_idempotent_but_audio_is_not() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/rooms/ABC123/lines", vec![Reply::status(503).body("edge"), Reply::status(204)]);
    mock.on("POST", "/v1/rooms/ABC123/audio", vec![Reply::status(503).body("edge"), Reply::status(204)]);
    let gw = GatewayClient::builder()
        .base_url(mock.url())
        .retry(RetryPolicy { backoff: vec![Duration::from_millis(5)], ..RetryPolicy::default() })
        .build()
        .unwrap();
    let r = room();
    let line = RoomLine { id: 1, original: "Olá".into(), ..RoomLine::default() };
    gw.rooms().publish_line(&r, &line).await.unwrap();
    assert_eq!(mock.requests_to("/v1/rooms/ABC123/lines").len(), 2, "a line is replaced by id: retrying is safe");
    assert_eq!(gw.rooms().publish_audio(&r, 1, "en", "UklGRg==").await.unwrap_err().status(), Some(503));
    assert_eq!(mock.requests_to("/v1/rooms/ABC123/audio").len(), 1, "a clip is broadcast once: not retried");
}

#[tokio::test]
async fn room_create_errors_never_carry_the_publish_token() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/rooms", vec![
        Reply::json(201, json!({"code": "", "publishToken": "pt-secret-2"})),
        Reply::json(201, json!({"code": 5, "publishToken": "pt-secret-2"})),
    ]);
    let gw = client(&mock);
    for _ in 0..2 {
        let err = gw.rooms().create(&CreateRoom::new(["en"])).await.unwrap_err();
        let text = format!("{err} | {err:?}");
        assert!(!text.contains("pt-secret-2"), "{text}");
    }
}

// ── deployments, apps, activation ───────────────────────────────────────────

#[tokio::test]
async fn deployments_calls() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/deployments/parle-speech/wake", vec![Reply::json(200, json!({"name": "parle-speech", "status": "warming"}))]);
    mock.on("GET", "/v1/deployments/parle-speech", vec![Reply::json(200, json!({"name": "parle-speech", "status": "ready", "lastError": null}))]);
    mock.on("GET", "/v1/deployments/nope", vec![Reply::json(404, json!({"error": "deployment not found"}))]);
    mock.on("DELETE", "/v1/deployments/nope", vec![Reply::json(404, json!({"error": "deployment not found"}))]);
    mock.on("GET", "/v1/deployments", vec![Reply::json(200, json!({"namespace": "default", "health": {"deployments": 1, "replicas": 0, "listError": null}, "deployments": [{"name": "parle-speech", "status": "scaled-to-zero"}]}))]);
    mock.on("PATCH", "/v1/deployments/parle-speech", vec![Reply::json(200, json!({"name": "parle-speech", "status": "paused"}))]);
    let gw = client(&mock);
    let d = gw.deployments();
    assert_eq!(d.wake("parle-speech").await.unwrap().status, "warming");
    assert!(d.get("parle-speech").await.unwrap().unwrap().is_ready());
    assert!(d.get("nope").await.unwrap().is_none());
    assert!(!d.delete("nope").await.unwrap());
    let list = d.list(Some("parle")).await.unwrap();
    assert_eq!(list.deployments[0].status, "scaled-to-zero");
    assert_eq!(d.pause("parle-speech").await.unwrap().status, "paused");
    let reqs = mock.requests();
    assert_eq!(reqs[0].header("authorization"), Some("Bearer test-key"));
    assert_eq!(reqs[4].query.as_deref(), Some("app=parle"));
    assert_eq!(reqs[5].json(), json!({"paused": true}));
    assert_eq!(d.invoke_url("parle-speech"), format!("{}/v1/deployments/parle-speech/invoke", mock.url()));
}

/// What origin/main's `GET /v1/apps/:app/routes` returns: `{app, routes}` with every field `parseEntry` keeps, plus a
/// field and a stage this crate does not know.
fn server_routes() -> serde_json::Value {
    json!({
        "chat": {"parle-llm": [
            {"provider": "deployment", "deployment": "parle-speech", "oneGpuDeployment": "parle-all", "model": "qwen",
             "extraBody": {"reasoning": {"enabled": false}}, "equivalent": "gemini-2.5-flash-lite", "language": "pt"},
            {"provider": "openrouter", "model": "google/gemini-2.5-flash-lite", "order": "benchmark", "benchmarkDataset": "parle-pt"}
        ]},
        "stt": {"parle-stt": [{"provider": "deployment", "deployment": "parle-speech"}, {"provider": "openrouter", "model": "openai/whisper-large-v3-turbo"}]},
        "tts": {"parle-tts": [
            {"provider": "deployment", "deployment": "parle-tts", "voice": "br-f-01", "fixedVoice": true},
            {"provider": "openrouter", "model": "qwen/qwen3-tts", "voices": {"feminine": "Cherry", "masculine": "Ethan"},
             "voiceGenders": {"br-f-01": "feminine", "br-m-08": "masculine"}, "preferFallbackVoice": true,
             "accountPolicyGuard": true, "someFutureField": {"a": [1, 2]}}
        ]},
        "image": {"x": [{"provider": "p"}]}
    })
}

#[tokio::test]
async fn app_routes_get_edit_put_keeps_every_server_field() {
    let mock = Mock::start().await;
    mock.on("GET", "/v1/apps/parle/routes", vec![Reply::json(200, json!({"app": "parle", "routes": server_routes()}))]);
    mock.on("PUT", "/v1/apps/parle/routes", vec![Reply::json(200, json!({"app": "parle", "routes": server_routes()}))]);
    let gw = client(&mock);
    let mut routes = gw.apps().routes("parle").await.unwrap();
    // Edit one alias; everything else must go back byte-for-byte equivalent.
    routes.get_mut("stt").unwrap().get_mut("parle-stt").unwrap().reverse();
    gw.apps().put_routes("parle", &routes).await.unwrap();
    let sent = mock.requests_to("/v1/apps/parle/routes")[1].json();
    let mut expected = server_routes();
    expected["stt"]["parle-stt"].as_array_mut().unwrap().reverse();
    assert_eq!(sent, expected);
    // Unedited: identical to what the server sent.
    let routes = gw.apps().routes("parle").await.unwrap();
    gw.apps().put_routes("parle", &routes).await.unwrap();
    assert_eq!(mock.requests_to("/v1/apps/parle/routes")[3].json(), server_routes());
}

#[tokio::test]
async fn app_routes_round_trip() {
    let mock = Mock::start().await;
    let routes = json!({"routes": {"stt": {"parle-stt": ["deployment:parle-speech", "openrouter:openai/whisper-large-v3-turbo"]}}});
    mock.on("PUT", "/v1/apps/parle/routes", vec![Reply::json(200, routes.clone())]);
    mock.on("GET", "/v1/apps/parle/routes", vec![Reply::json(200, routes)]);
    let gw = client(&mock);
    let got = gw.apps().routes("parle").await.unwrap();
    assert_eq!(got["stt"]["parle-stt"][0], RouteTarget::from("deployment:parle-speech"));
    let put = gw.apps().put_routes("parle", &got).await.unwrap();
    assert_eq!(put, got);
    assert_eq!(mock.requests()[1].json(), json!({"stt": {"parle-stt": ["deployment:parle-speech", "openrouter:openai/whisper-large-v3-turbo"]}}));
}

#[tokio::test]
async fn activation_sends_the_key_in_the_body_only() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/activate", vec![Reply::json(200, json!({"ok": true, "email": "a@b.c", "plan": "pro", "quota": {"month": 3}}))]);
    let gw = client(&mock);
    let a = gw.activate("  ucast_live_x  ", "PC", "1.0.0").await.unwrap();
    assert_eq!((a.email.as_str(), a.plan.as_str()), ("a@b.c", "pro"));
    assert_eq!(a.quota["month"], 3);
    let r = &mock.requests()[0];
    assert!(r.header("authorization").is_none());
    assert_eq!(r.json(), json!({"key": "ucast_live_x", "deviceName": "PC", "appVersion": "1.0.0"}));

    mock.on("POST", "/v1/activate", vec![Reply::json(200, json!({"ok": false}))]);
    assert!(gw.activate("k", "PC", "1").await.is_err());
    mock.on("POST", "/v1/activate", vec![Reply::json(401, json!({"error": {"message": "Chave inválida.", "code": "invalid_key"}}))]);
    let err = gw.activate("k", "PC", "1").await.unwrap_err();
    assert_eq!((err.status(), err.code()), (Some(401), "invalid_key"));
}

// ── retries, timeouts, unreachable ──────────────────────────────────────────

#[tokio::test]
async fn idempotent_calls_retry_on_503_honouring_retry_after() {
    let mock = Mock::start().await;
    mock.on("GET", "/v1/deployments/x", vec![
        Reply::json(503, json!({"error": "replicas are starting", "status": "warming"})).header("retry-after", "0.05"),
        Reply::status(502).body("<html>edge</html>"),
        Reply::json(200, json!({"name": "x", "status": "ready"})),
    ]);
    let gw = GatewayClient::builder()
        .base_url(mock.url())
        .retry(RetryPolicy { backoff: vec![Duration::from_millis(10)], ..RetryPolicy::default() })
        .build()
        .unwrap();
    let started = Instant::now();
    let v = gw.deployments().get("x").await.unwrap().unwrap();
    assert!(v.is_ready());
    assert_eq!(mock.requests().len(), 3);
    assert!(started.elapsed() >= Duration::from_millis(60), "waited Retry-After then the backoff");
}

#[tokio::test]
async fn long_retry_after_and_daily_budget_are_returned_at_once() {
    let mock = Mock::start().await;
    mock.on("GET", "/v1/deployments/a", vec![Reply::json(503, json!({"error": "cold", "status": "warming"})).header("retry-after", "30")]);
    mock.on("GET", "/v1/deployments/b", vec![Reply::json(429, json!({"error": {"type": "budget_exceeded", "code": "daily_budget_exhausted"}})).header("retry-after", "1")]);
    let gw = client(&mock);
    let err = gw.deployments().get("a").await.unwrap_err();
    assert_eq!(err.retry_after(), Some(Duration::from_secs(30)));
    assert_eq!(err.code(), "warming");
    let err = gw.deployments().get("b").await.unwrap_err();
    assert_eq!(err.code(), "daily_budget_exhausted");
    assert_eq!(mock.requests().len(), 2, "neither was retried");
}

#[tokio::test]
async fn paid_calls_retry_only_when_opted_in() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/chat/completions", vec![Reply::status(502).body("bad gateway"), Reply::json(200, completion("ok"))]);
    let gw = GatewayClient::builder()
        .base_url(mock.url())
        .retry(RetryPolicy { retry_non_idempotent: true, backoff: vec![Duration::from_millis(5)], ..RetryPolicy::default() })
        .build()
        .unwrap();
    assert_eq!(gw.chat(ChatRequest::new("m", vec![])).await.unwrap().content(), Some("ok"));
    assert_eq!(mock.requests().len(), 2);
}

#[tokio::test]
async fn timeout_before_headers_is_unreachable_and_not_retried() {
    let mock = Mock::start().await;
    mock.on("GET", "/health", vec![Reply::json(200, json!({"status": "ok"})).delay(Duration::from_millis(800))]);
    let gw = GatewayClient::builder().base_url(mock.url()).timeout(TimeoutGroup::Health, Duration::from_millis(100)).build().unwrap();
    let started = Instant::now();
    let err = gw.health().await.unwrap_err();
    assert!(matches!(err, GatewayError::Timeout { headers_received: false, .. }), "{err:?}");
    assert!(err.is_unreachable());
    assert_eq!(err.code(), "timeout");
    assert!(started.elapsed() < Duration::from_millis(600));
    assert_eq!(mock.requests().len(), 1);
}

#[tokio::test]
async fn per_call_timeout_overrides_the_group() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/chat/completions", vec![Reply::json(200, completion("late")).delay(Duration::from_millis(400))]);
    let err = client(&mock).chat(ChatRequest::new("m", vec![]).timeout(Duration::from_millis(50))).await.unwrap_err();
    assert_eq!(err.code(), "timeout");
}

#[tokio::test]
async fn connection_refused_is_unreachable_and_retried_for_idempotent_calls() {
    let gw = GatewayClient::builder()
        .base_url(dead_addr().await)
        .retry(RetryPolicy { backoff: vec![Duration::from_millis(5)], ..RetryPolicy::default() })
        .build()
        .unwrap();
    let err = gw.deployments().list(None).await.unwrap_err();
    assert!(matches!(err, GatewayError::Http { unreachable: true, .. }), "{err:?}");
    assert_eq!(err.code(), "network");
}

#[tokio::test]
async fn a_request_that_cannot_be_built_is_config_not_unreachable() {
    let mock = Mock::start().await;
    mock.on("GET", "/v1/deployments", vec![Reply::json(200, json!({"deployments": []}))]);
    mock.on("POST", "/v1/chat/completions", vec![Reply::json(200, completion("ok"))]);
    let gw = GatewayClient::builder()
        .base_url(mock.url())
        .breaker(BreakerConfig { threshold: 1, ..BreakerConfig::default() })
        .retry(RetryPolicy { backoff: vec![Duration::from_millis(5)], ..RetryPolicy::default() })
        .build()
        .unwrap();
    // A header value with a newline: reqwest refuses to build the request.
    let err = gw.chat(ChatRequest::new("m", vec![]).device("dev\nX-Evil: 1")).await.unwrap_err();
    assert!(matches!(err, GatewayError::Config(_)), "{err:?}");
    assert!(!err.is_unreachable());
    assert_eq!(gw.gateway_state().breaker, BreakerPosition::Closed, "never counted by the breaker");
    let err = gw.deployments().with(CallOptions { request_id: Some("a\r\nb".into()), ..CallOptions::default() }).list(None).await.unwrap_err();
    assert_eq!(err.code(), "config");
    assert!(mock.requests().is_empty(), "nothing was sent, nothing retried");
    // A key with a newline neither: and the key is not in the message.
    let err = gw.with_api_key("bad\nkey-secret").chat(ChatRequest::new("m", vec![])).await.unwrap_err();
    assert_eq!(err.code(), "config");
    assert!(!format!("{err} {err:?}").contains("key-secret"));
}

#[tokio::test]
async fn a_cut_buffered_body_is_bad_response_and_not_retried() {
    let url = common::raw_server(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\nX-Gateway-Provider: p1\r\n\r\n{\"name\":".to_vec(),
    )
    .await;
    let gw = GatewayClient::builder()
        .base_url(url)
        .breaker(BreakerConfig { threshold: 1, ..BreakerConfig::default() })
        .retry(RetryPolicy { backoff: vec![Duration::from_millis(5)], ..RetryPolicy::default() })
        .build()
        .unwrap();
    let err = gw.deployments().list(None).await.unwrap_err();
    assert_eq!(err.code(), "bad_response", "{err:?}");
    assert!(!err.is_unreachable());
    assert_eq!(err.served().unwrap().provider.as_deref(), Some("p1"));
    let err = gw.chat(ChatRequest::new("m", vec![])).await.unwrap_err();
    assert_eq!(err.code(), "bad_response");
    assert_eq!(gw.gateway_state().breaker, BreakerPosition::Closed, "the gateway answered: not counted");
}

// ── breaker ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn breaker_does_not_stay_probing_when_the_caller_gives_up_mid_probe() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/chat/completions", vec![Reply::status(502).body("edge"), Reply::json(200, completion("back"))]);
    mock.on("GET", "/health", vec![Reply::json(200, json!({"status": "ok"})).delay(Duration::from_millis(500)), Reply::json(200, json!({"status": "ok"}))]);
    let gw = GatewayClient::builder().base_url(mock.url()).breaker(BreakerConfig { threshold: 1, ..BreakerConfig::default() }).build().unwrap();
    assert!(gw.chat(ChatRequest::new("m", vec![])).await.unwrap_err().is_unreachable());
    assert_eq!(gw.gateway_state().breaker, BreakerPosition::Open);
    // The call probes /health (500 ms); the caller drops it after 50 ms.
    let dropped = tokio::time::timeout(Duration::from_millis(50), gw.chat(ChatRequest::new("m", vec![]))).await;
    assert!(dropped.is_err(), "the caller gave up mid-probe");
    assert_eq!(gw.gateway_state().breaker, BreakerPosition::Open, "not stuck in Probing");
    // The next call probes again and goes through.
    assert_eq!(gw.chat(ChatRequest::new("m", vec![])).await.unwrap().content(), Some("back"));
    assert_eq!(gw.gateway_state().breaker, BreakerPosition::Closed);
}

#[tokio::test]
async fn breaker_opens_then_fails_fast_while_health_fails() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/chat/completions", vec![Reply::status(502).body("<html>edge down</html>")]);
    mock.on("GET", "/health", vec![Reply::status(502).body("down")]);
    let gw = GatewayClient::builder()
        .base_url(mock.url())
        .breaker(BreakerConfig { threshold: 2, recheck_interval: Duration::from_secs(60), ..BreakerConfig::default() })
        .build()
        .unwrap();
    let chat = || gw.chat(ChatRequest::new("m", vec![]));
    assert_eq!(chat().await.unwrap_err().status(), Some(502));
    assert_eq!(gw.gateway_state().breaker, BreakerPosition::Closed);
    assert_eq!(chat().await.unwrap_err().status(), Some(502));
    let st = gw.gateway_state();
    assert_eq!((st.breaker, st.consecutive_failures, st.last_error.as_deref()), (BreakerPosition::Open, 2, Some("http_502")));
    // Open: the call probes /health (fails) and fails fast without calling the route.
    assert!(matches!(chat().await.unwrap_err(), GatewayError::BreakerOpen { .. }));
    // Within recheck_interval: no second probe.
    assert!(matches!(chat().await.unwrap_err(), GatewayError::BreakerOpen { .. }));
    assert_eq!(mock.requests_to("/v1/chat/completions").len(), 2);
    assert_eq!(mock.requests_to("/health").len(), 1);
}

#[tokio::test]
async fn breaker_closes_when_health_answers() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/chat/completions", vec![Reply::status(503).body("edge"), Reply::json(200, completion("back"))]);
    mock.on("GET", "/health", vec![Reply::json(200, json!({"status": "ok"}))]);
    let gw = GatewayClient::builder().base_url(mock.url()).breaker(BreakerConfig { threshold: 1, ..BreakerConfig::default() }).build().unwrap();
    assert!(gw.chat(ChatRequest::new("m", vec![])).await.unwrap_err().is_unreachable());
    assert_eq!(gw.gateway_state().breaker, BreakerPosition::Open);
    assert_eq!(gw.chat(ChatRequest::new("m", vec![])).await.unwrap().content(), Some("back"));
    assert_eq!(gw.gateway_state().breaker, BreakerPosition::Closed);
    assert_eq!(mock.requests_to("/health").len(), 1);
}

#[tokio::test]
async fn gateway_answered_errors_do_not_count_toward_the_breaker() {
    let mock = Mock::start().await;
    mock.on("POST", "/v1/chat/completions", vec![Reply::json(503, json!({"error": {"type": "provider_unavailable", "message": "none"}}))]);
    let gw = GatewayClient::builder().base_url(mock.url()).breaker(BreakerConfig { threshold: 1, ..BreakerConfig::default() }).build().unwrap();
    for _ in 0..3 {
        assert_eq!(gw.chat(ChatRequest::new("m", vec![])).await.unwrap_err().code(), "provider_unavailable");
    }
    assert_eq!(gw.gateway_state().breaker, BreakerPosition::Closed);
}

// ── env ─────────────────────────────────────────────────────────────────────

#[test]
fn from_env_reads_the_url_and_key_vars() {
    // The only test touching these vars.
    let saved: Vec<_> = ["AI_GATEWAY_URL", "GATEWAY_URL", "AI_GATEWAY_API_KEY", "GATEWAY_API_KEY", "GATEWAY_APP"]
        .iter()
        .map(|k| (*k, std::env::var(k).ok()))
        .collect();
    for (k, _) in &saved {
        std::env::remove_var(k);
    }
    let gw = GatewayClient::from_env().unwrap();
    assert_eq!(gw.base_url(), ai_gateway_sdk::DEFAULT_BASE_URL);
    assert_eq!(gw.api_key(), None);
    std::env::set_var("GATEWAY_URL", "https://second.example.com/");
    std::env::set_var("GATEWAY_API_KEY", "k2");
    let gw = GatewayClient::from_env().unwrap();
    assert_eq!((gw.base_url(), gw.api_key()), ("https://second.example.com", Some("k2")));
    std::env::set_var("AI_GATEWAY_URL", "https://first.example.com");
    std::env::set_var("AI_GATEWAY_API_KEY", "k1");
    std::env::set_var("GATEWAY_APP", "babelcast");
    let gw = GatewayClient::from_env().unwrap();
    assert_eq!((gw.base_url(), gw.api_key(), gw.app()), ("https://first.example.com", Some("k1"), Some("babelcast")));
    for (k, v) in saved {
        match v {
            Some(v) => std::env::set_var(k, v),
            None => std::env::remove_var(k),
        }
    }
}

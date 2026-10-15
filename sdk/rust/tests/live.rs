//! Live test against a real gateway — `#[ignore]`d, never part of the normal suite.
//!
//! ```text
//! $env:AI_GATEWAY_URL = 'https://parle-ai-gateway.up.railway.app'   # or GATEWAY_URL
//! $env:GATEWAY_API_KEY = '…'                                        # optional for /health
//! cargo test --test live -- --ignored --nocapture
//! ```
//!
//! Only free calls (`/health`, `/v1/models`). A paid chat call runs only with `AIGW_LIVE_PAID=1` and
//! `AIGW_LIVE_CHAT_MODEL=<alias>`.

use ai_gateway_sdk::{ChatMessage, ChatRequest, GatewayClient};

#[tokio::test]
#[ignore = "calls the real gateway; set AI_GATEWAY_URL or GATEWAY_URL"]
async fn live_gateway_health_and_models() {
    if std::env::var("AI_GATEWAY_URL").is_err() && std::env::var("GATEWAY_URL").is_err() {
        panic!("set AI_GATEWAY_URL or GATEWAY_URL");
    }
    let gw = GatewayClient::from_env().unwrap();
    let health = gw.health().await.unwrap();
    println!("health of {}: {health:?}", gw.base_url());
    assert!(health.is_ok());

    if gw.api_key().is_some() {
        match gw.models().await {
            Ok(models) => println!("models: {} entries", models["data"].as_array().map_or(0, Vec::len)),
            Err(e) => println!("models: {e} (code {})", e.code()),
        }
    }

    if std::env::var("AIGW_LIVE_PAID").as_deref() == Ok("1") {
        let model = std::env::var("AIGW_LIVE_CHAT_MODEL").expect("AIGW_LIVE_CHAT_MODEL");
        let out = gw
            .chat(ChatRequest::new(model, vec![ChatMessage::user("Reply with the single word: pong")]).max_tokens(5))
            .await
            .unwrap();
        println!("chat: {:?} via {:?}", out.content(), out.served.provider);
        assert!(out.served.provider.is_some(), "X-Gateway-Provider is set on every answer");
    }
}

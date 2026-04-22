use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::Value;

use super::sse::SseDecoder;

pub const DEFAULT_ANTHROPIC_VERSION: &str = "2023-06-01";
pub const DEFAULT_HAIKU_MODEL: &str = crate::domain::DEFAULT_ANTHROPIC_MODEL;

const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";

#[derive(Debug, thiserror::Error)]
pub enum AnthropicError {
    #[error("Missing Anthropic API key")]
    MissingApiKey,

    #[error("HTTP error {status}: {body}")]
    Http { status: u16, body: String },

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Invalid response: {0}")]
    InvalidResponse(String),
}

pub struct StreamOptions<'a> {
    pub api_key: &'a str,
    pub model: &'a str,
    pub system_prompt: &'a str,
    pub user_text: &'a str,
    pub max_tokens: u32,
    pub temperature: f32,
}

pub struct StreamUserContentOptions<'a> {
    pub api_key: &'a str,
    pub model: &'a str,
    pub system_prompt: &'a str,
    pub user_content: &'a Value,
    pub max_tokens: u32,
    pub temperature: f32,
}

pub async fn stream_text_deltas(
    opts: StreamOptions<'_>,
    on_delta: impl FnMut(&str) + Send,
) -> Result<(), AnthropicError> {
    let user_content = serde_json::json!(opts.user_text);
    let user_opts = StreamUserContentOptions {
        api_key: opts.api_key,
        model: opts.model,
        system_prompt: opts.system_prompt,
        user_content: &user_content,
        max_tokens: opts.max_tokens,
        temperature: opts.temperature,
    };

    stream_user_content_deltas(user_opts, on_delta).await
}

pub async fn stream_user_content_deltas(
    opts: StreamUserContentOptions<'_>,
    mut on_delta: impl FnMut(&str) + Send,
) -> Result<(), AnthropicError> {
    if opts.api_key.trim().is_empty() {
        return Err(AnthropicError::MissingApiKey);
    }

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "model": opts.model,
        "max_tokens": opts.max_tokens,
        "temperature": opts.temperature,
        "stream": true,
        "system": opts.system_prompt,
        "messages": [
            { "role": "user", "content": opts.user_content }
        ]
    });

    let resp = client
        .post(ANTHROPIC_MESSAGES_URL)
        .header("x-api-key", opts.api_key)
        .header("anthropic-version", DEFAULT_ANTHROPIC_VERSION)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&payload)
        .send()
        .await?;

    let status = resp.status();
    if status != StatusCode::OK {
        let body = resp.text().await.unwrap_or_default();
        return Err(AnthropicError::Http {
            status: status.as_u16(),
            body,
        });
    }

    let mut decoder = SseDecoder::new();
    let mut stream = resp.bytes_stream();

    while let Some(item) = stream.next().await {
        let bytes = item?;

        for evt in decoder.push(&bytes) {
            if evt.data.is_empty() {
                continue;
            }

            let Ok(json) = serde_json::from_str::<Value>(&evt.data) else {
                continue;
            };

            if let Some(delta) = extract_text_delta(&json) {
                on_delta(delta);
                continue;
            }

            if is_message_stop(&json) {
                return Ok(());
            }

            if let Some(err) = extract_error_message(&json) {
                return Err(AnthropicError::InvalidResponse(err));
            }
        }
    }

    Ok(())
}

fn extract_text_delta(json: &Value) -> Option<&str> {
    let ty = json.get("type")?.as_str()?;
    if ty != "content_block_delta" {
        return None;
    }

    let delta = json.get("delta")?;
    let delta_type = delta.get("type")?.as_str()?;
    if delta_type != "text_delta" {
        return None;
    }

    delta.get("text")?.as_str()
}

fn is_message_stop(json: &Value) -> bool {
    json.get("type")
        .and_then(|v| v.as_str())
        .map(|t| t == "message_stop")
        .unwrap_or(false)
}

fn extract_error_message(json: &Value) -> Option<String> {
    let ty = json.get("type")?.as_str()?;
    if ty != "error" {
        return None;
    }

    let msg = json
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("Unknown error");

    Some(msg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_text_delta() {
        let json: Value = serde_json::json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "привет" }
        });
        assert_eq!(extract_text_delta(&json), Some("привет"));
    }

    #[test]
    fn detects_message_stop() {
        let json: Value = serde_json::json!({ "type": "message_stop" });
        assert!(is_message_stop(&json));
    }
}

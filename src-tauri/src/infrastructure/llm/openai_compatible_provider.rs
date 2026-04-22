use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::Value;

use crate::domain::{
    LlmDeltaCallback, LlmError, LlmProvider, LlmResult, LlmRuntimeConfig, LlmStreamRequest,
};
use crate::infrastructure::ai::sse::SseDecoder;

/// OpenAI-compatible Chat Completions provider (SSE streaming).
///
/// Работает с OpenAI и прокси, которые поддерживают `/v1/chat/completions` со `stream=true`
/// (например OpenRouter).
pub struct OpenAiCompatibleLlmProvider {
    api_key: String,
    base_url: String,
}

impl OpenAiCompatibleLlmProvider {
    pub fn new(config: &LlmRuntimeConfig) -> LlmResult<Self> {
        let api_key = config
            .api_key
            .clone()
            .ok_or_else(|| LlmError::Authentication("Missing API key".to_string()))?;

        if api_key.trim().is_empty() {
            return Err(LlmError::Authentication("Missing API key".to_string()));
        }

        let base_url = config
            .base_url
            .clone()
            .or_else(|| std::env::var("OPENAI_BASE_URL").ok())
            .unwrap_or_else(|| "https://api.openai.com".to_string());

        Ok(Self { api_key, base_url })
    }

    fn chat_completions_url(&self) -> String {
        let trimmed = self.base_url.trim_end_matches('/');

        if trimmed.ends_with("/chat/completions") {
            return trimmed.to_string();
        }
        if trimmed.ends_with("/v1") {
            return format!("{trimmed}/chat/completions");
        }

        format!("{trimmed}/v1/chat/completions")
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompatibleLlmProvider {
    async fn stream_text(
        &self,
        request: &LlmStreamRequest,
        mut on_delta: LlmDeltaCallback,
    ) -> LlmResult<()> {
        let url = self.chat_completions_url();

        let payload = serde_json::json!({
            "model": request.model,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "stream": true,
            "messages": [
                { "role": "system", "content": request.system_prompt },
                { "role": "user", "content": request.user_text }
            ]
        });

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .connect_timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| LlmError::Internal(e.to_string()))?;

        let resp = client
            .post(url)
            .bearer_auth(&self.api_key)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| LlmError::Network(e.to_string()))?;

        let status = resp.status();
        if status != StatusCode::OK {
            let body = resp.text().await.unwrap_or_default();
            return Err(LlmError::Http {
                status: status.as_u16(),
                body,
            });
        }

        let mut decoder = SseDecoder::new();
        let mut stream = resp.bytes_stream();

        while let Some(item) = stream.next().await {
            let bytes = item.map_err(|e| LlmError::Network(e.to_string()))?;

            for evt in decoder.push(&bytes) {
                let data = evt.data.trim();
                if data.is_empty() {
                    continue;
                }

                if data == "[DONE]" {
                    return Ok(());
                }

                let json: Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                if let Some(msg) = extract_error_message(&json) {
                    return Err(LlmError::InvalidResponse(msg));
                }

                if let Some(delta) = extract_chat_delta(&json) {
                    on_delta(delta);
                }

                if is_finished(&json) {
                    return Ok(());
                }
            }
        }

        Ok(())
    }

    fn name(&self) -> &str {
        "openai_compatible"
    }

    fn is_online(&self) -> bool {
        true
    }
}

fn extract_chat_delta(json: &Value) -> Option<&str> {
    let choice0 = json.get("choices")?.get(0)?;

    // Chat Completions streaming: choices[0].delta.content
    if let Some(s) = choice0
        .get("delta")
        .and_then(|d| d.get("content"))
        .and_then(|v| v.as_str())
    {
        return Some(s);
    }

    // Some proxies might emit delta.text
    if let Some(s) = choice0
        .get("delta")
        .and_then(|d| d.get("text"))
        .and_then(|v| v.as_str())
    {
        return Some(s);
    }

    // Non-chat completions style fallback
    choice0.get("text")?.as_str()
}

fn is_finished(json: &Value) -> bool {
    json.get("choices")
        .and_then(|v| v.get(0))
        .and_then(|c| c.get("finish_reason"))
        .and_then(|v| v.as_str())
        .is_some()
}

fn extract_error_message(json: &Value) -> Option<String> {
    let err = json.get("error")?;
    let msg = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("Unknown error");
    Some(msg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_chat_delta_from_choices_delta_content() {
        let json: Value = serde_json::json!({
            "choices": [
                { "delta": { "content": "hello" }, "finish_reason": null }
            ]
        });
        assert_eq!(extract_chat_delta(&json), Some("hello"));
        assert!(!is_finished(&json));
    }

    #[test]
    fn detects_finish_reason() {
        let json: Value = serde_json::json!({
            "choices": [
                { "delta": {}, "finish_reason": "stop" }
            ]
        });
        assert!(is_finished(&json));
    }

    #[test]
    fn extracts_error_message() {
        let json: Value = serde_json::json!({
            "error": { "message": "bad key" }
        });
        assert_eq!(extract_error_message(&json), Some("bad key".to_string()));
    }
}

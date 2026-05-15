use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::Value;

use crate::domain::{
    LlmDeltaCallback, LlmError, LlmProvider, LlmResult, LlmRuntimeConfig, LlmStreamRequest,
};
use crate::infrastructure::ai::sse::SseDecoder;

pub struct OpenAiResponsesLlmProvider {
    api_key: String,
    base_url: String,
}

impl OpenAiResponsesLlmProvider {
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

    fn responses_url(&self) -> String {
        responses_url(&self.base_url)
    }
}

#[async_trait]
impl LlmProvider for OpenAiResponsesLlmProvider {
    async fn stream_text(
        &self,
        request: &LlmStreamRequest,
        mut on_delta: LlmDeltaCallback,
    ) -> LlmResult<()> {
        let url = self.responses_url();
        let payload = build_responses_payload(request);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
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
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }

                let json: Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                if let Some(msg) = extract_error_message(&json) {
                    return Err(LlmError::InvalidResponse(msg));
                }

                if let Some(delta) = extract_output_text_delta(&json) {
                    on_delta(delta);
                }

                if is_completed(&json) {
                    return Ok(());
                }
            }
        }

        Ok(())
    }

    fn name(&self) -> &str {
        "openai_responses"
    }

    fn is_online(&self) -> bool {
        true
    }
}

fn responses_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');

    if trimmed.ends_with("/responses") {
        return trimmed.to_string();
    }
    if trimmed.ends_with("/v1") {
        return format!("{trimmed}/responses");
    }

    format!("{trimmed}/v1/responses")
}

fn build_responses_payload(request: &LlmStreamRequest) -> Value {
    let mut content = Vec::new();
    let text = request.user_text.trim();
    if !text.is_empty() {
        content.push(serde_json::json!({
            "type": "input_text",
            "text": text
        }));
    }

    for image in request.images.iter().filter(|image| {
        image.media_type.trim().starts_with("image/") && !image.data_base64.trim().is_empty()
    }) {
        content.push(serde_json::json!({
            "type": "input_image",
            "image_url": format!(
                "data:{};base64,{}",
                image.media_type.trim(),
                image.data_base64.trim()
            )
        }));
    }

    let mut payload = serde_json::json!({
        "model": request.model,
        "instructions": request.system_prompt,
        "input": [
            {
                "role": "user",
                "content": content
            }
        ],
        "max_output_tokens": request.max_tokens,
        "temperature": request.temperature,
        "stream": true,
        "store": false
    });

    if let Some(effort) = request
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["reasoning"] = serde_json::json!({ "effort": effort });
    }

    if let Some(verbosity) = request
        .verbosity
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["text"] = serde_json::json!({ "verbosity": verbosity });
    }

    if let Some(web_search) = &request.web_search {
        payload["tools"] = serde_json::json!([
            {
                "type": web_search.tool_type,
                "search_context_size": web_search.context_size
            }
        ]);
        payload["tool_choice"] = serde_json::json!("auto");
    }

    payload
}

fn extract_output_text_delta(json: &Value) -> Option<&str> {
    if json.get("type").and_then(|v| v.as_str()) != Some("response.output_text.delta") {
        return None;
    }

    json.get("delta")?.as_str()
}

fn is_completed(json: &Value) -> bool {
    matches!(
        json.get("type").and_then(|v| v.as_str()),
        Some("response.completed") | Some("response.output_text.done")
    )
}

fn extract_error_message(json: &Value) -> Option<String> {
    if let Some(error) = json.get("error") {
        let msg = error
            .get("message")
            .and_then(|v| v.as_str())
            .or_else(|| error.as_str())
            .unwrap_or("Unknown error");
        return Some(msg.to_string());
    }

    if matches!(
        json.get("type").and_then(|v| v.as_str()),
        Some("response.failed")
    ) {
        let msg = json
            .get("response")
            .and_then(|response| response.get("error"))
            .and_then(|error| error.get("message").or(Some(error)))
            .and_then(|v| v.as_str())
            .unwrap_or("OpenAI response failed");
        return Some(msg.to_string());
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{LlmImageContent, LlmStreamRequest, LlmWebSearchOptions};

    fn request() -> LlmStreamRequest {
        LlmStreamRequest::new("gpt-5.4-mini", "system", "hello", 512, 0.2)
            .with_reasoning_effort("low")
            .with_verbosity("low")
    }

    #[test]
    fn builds_responses_url_from_base_url() {
        assert_eq!(
            responses_url("https://api.openai.com"),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            responses_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            responses_url("https://api.openai.com/v1/responses"),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn payload_uses_responses_defaults() {
        let payload = build_responses_payload(&request());

        assert_eq!(payload["model"], "gpt-5.4-mini");
        assert_eq!(payload["store"], false);
        assert_eq!(payload["stream"], true);
        assert_eq!(payload["reasoning"]["effort"], "low");
        assert_eq!(payload["text"]["verbosity"], "low");
        assert!(payload.get("tools").is_none());
    }

    #[test]
    fn payload_adds_web_search_only_when_enabled() {
        let payload = build_responses_payload(&request().with_web_search(LlmWebSearchOptions {
            tool_type: "web_search_preview".to_string(),
            context_size: "low".to_string(),
        }));

        assert_eq!(payload["tools"][0]["type"], "web_search_preview");
        assert_eq!(payload["tools"][0]["search_context_size"], "low");
        assert_eq!(payload["tool_choice"], "auto");
    }

    #[test]
    fn payload_adds_multimodal_input_images() {
        let payload = build_responses_payload(&request().with_images(vec![LlmImageContent {
            media_type: "image/png".to_string(),
            data_base64: "AAA=".to_string(),
        }]));

        assert_eq!(payload["input"][0]["content"][1]["type"], "input_image");
        assert_eq!(
            payload["input"][0]["content"][1]["image_url"],
            "data:image/png;base64,AAA="
        );
    }

    #[test]
    fn parses_output_text_delta() {
        let json = serde_json::json!({
            "type": "response.output_text.delta",
            "delta": "hello"
        });

        assert_eq!(extract_output_text_delta(&json), Some("hello"));
    }

    #[test]
    fn parses_error_message() {
        let json = serde_json::json!({
            "type": "response.failed",
            "response": {
                "error": { "message": "bad request" }
            }
        });

        assert_eq!(
            extract_error_message(&json),
            Some("bad request".to_string())
        );
    }
}

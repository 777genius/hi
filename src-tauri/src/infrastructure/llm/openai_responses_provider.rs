use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::Value;
use std::sync::OnceLock;

use crate::domain::{
    LlmDeltaCallback, LlmError, LlmProvider, LlmResult, LlmRuntimeConfig, LlmStreamRequest,
};
use crate::infrastructure::ai::sse::SseDecoder;

pub struct OpenAiResponsesLlmProvider {
    api_key: String,
    base_url: String,
}

static RESPONSES_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn responses_client() -> LlmResult<&'static reqwest::Client> {
    if let Some(client) = RESPONSES_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .connect_timeout(std::time::Duration::from_secs(6))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|error| LlmError::Internal(error.to_string()))?;
    Ok(RESPONSES_CLIENT.get_or_init(|| client))
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

        let client = responses_client()?;
        let mut attempt = 0;
        let resp = loop {
            let result = tokio::time::timeout(std::time::Duration::from_secs(45), client
                .post(&url)
                .bearer_auth(&self.api_key)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .json(&payload)
                .send()
            ).await.map_err(|_| LlmError::Network("Сервер LLM не ответил за 45 секунд".to_string()))?;
            match result {
                Ok(response) if attempt == 0 && matches!(response.status().as_u16(), 502 | 503 | 504) => {
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                }
                Ok(response) => break response,
                Err(error) if attempt == 0 && error.is_connect() => {
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                }
                Err(error) => return Err(LlmError::Network(error.to_string())),
            }
        };

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

        while let Some(item) = tokio::time::timeout(
            std::time::Duration::from_secs(30), stream.next()
        ).await.map_err(|_| LlmError::Network("Поток LLM не присылал данные 30 секунд".to_string()))? {
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
                    let input_tokens = json.pointer("/response/usage/input_tokens").and_then(Value::as_u64);
                    let cached_tokens = json.pointer("/response/usage/input_tokens_details/cached_tokens").and_then(Value::as_u64);
                    log::info!("Responses usage: input_tokens={input_tokens:?} cached_tokens={cached_tokens:?}");
                    return Ok(());
                }
            }
        }

        Err(LlmError::InvalidResponse(
            "OpenAI Responses stream ended before response.completed".to_string(),
        ))
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
        "stream": true,
        "store": false
    });

    // Постоянный prompt_cache_key + prompt_cache_options замедляли первый токен примерно на 1,5 с
    // (замер на одном приложении: медиана 3,7 с с ключом против 2,1 с без ключа или с уникальным ключом).
    // Неявное кэширование префикса работает и без ключа.

    // Some callers use a generic LlmStreamRequest without specifying effort.
    // Honor the configured Responses effort there too, while keeping any
    // per-request value authoritative.
    let configured_effort = std::env::var("OPENAI_RESPONSES_REASONING_EFFORT").ok();
    if let Some(effort) = resolved_reasoning_effort(
        request.reasoning_effort.as_deref(),
        configured_effort.as_deref(),
    ) {
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

fn resolved_reasoning_effort<'a>(
    explicit: Option<&'a str>,
    configured: Option<&'a str>,
) -> Option<&'a str> {
    let nonempty = |value: &'a str| {
        let value = value.trim();
        (!value.is_empty()).then_some(value)
    };
    explicit
        .and_then(nonempty)
        .or_else(|| configured.and_then(nonempty))
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
        Some("response.completed")
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

    if json.get("type").and_then(|v| v.as_str()) == Some("response.incomplete") {
        let reason = json
            .pointer("/response/incomplete_details/reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown reason");
        return Some(format!("OpenAI response incomplete: {reason}"));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{LlmImageContent, LlmStreamRequest, LlmWebSearchOptions};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
        assert!(payload.get("temperature").is_none());
        assert!(payload.get("tools").is_none());
        assert!(payload.get("prompt_cache_options").is_none());
    }

    #[test]
    fn does_not_pin_a_prompt_cache_key() {
        let payload = build_responses_payload(&LlmStreamRequest::new("gpt-6.1-terra", "system", "first", 64, 0.2));
        assert!(payload.get("prompt_cache_key").is_none());
        assert!(payload.get("prompt_cache_options").is_none());
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
    fn output_text_done_is_not_response_completion() {
        assert!(!is_completed(
            &serde_json::json!({"type": "response.output_text.done"})
        ));
        assert!(is_completed(
            &serde_json::json!({"type": "response.completed"})
        ));
    }

    #[test]
    fn reports_incomplete_response_reason() {
        let json = serde_json::json!({
            "type": "response.incomplete",
            "response": {"incomplete_details": {"reason": "max_output_tokens"}}
        });
        assert_eq!(
            extract_error_message(&json).as_deref(),
            Some("OpenAI response incomplete: max_output_tokens")
        );
    }

    #[test]
    fn request_effort_takes_priority_over_configured_fallback() {
        assert_eq!(
            resolved_reasoning_effort(None, Some(" medium ")),
            Some("medium")
        );
        assert_eq!(
            resolved_reasoning_effort(Some("high"), Some("medium")),
            Some("high")
        );
        assert_eq!(resolved_reasoning_effort(Some(" "), None), None);
    }

    async fn stream_fixture(body: &str, request: LlmStreamRequest) -> (LlmResult<()>, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = body.to_string();
        let expected_images = request.images.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let n = socket.read(&mut buf).await.unwrap();
                assert_ne!(n, 0);
                request.extend_from_slice(&buf[..n]);
            }
            let header_end = request
                .windows(4)
                .position(|part| part == b"\r\n\r\n")
                .unwrap()
                + 4;
            let headers = String::from_utf8_lossy(&request[..header_end]);
            assert!(headers.starts_with("POST /v1/responses "));
            let content_length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            while request.len() < header_end + content_length {
                let n = socket.read(&mut buf).await.unwrap();
                assert_ne!(n, 0);
                request.extend_from_slice(&buf[..n]);
            }
            let payload: Value = serde_json::from_slice(&request[header_end..header_end + content_length]).unwrap();
            let content = payload["input"][0]["content"].as_array().unwrap();
            let actual_images: Vec<&str> = content.iter()
                .filter(|item| item["type"] == "input_image")
                .filter_map(|item| item["image_url"].as_str())
                .collect();
            assert_eq!(actual_images.len(), expected_images.len());
            for (actual, expected) in actual_images.iter().zip(expected_images.iter()) {
                assert_eq!(*actual, format!("data:{};base64,{}", expected.media_type, expected.data_base64));
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let provider = OpenAiResponsesLlmProvider {
            api_key: "test-key".to_string(),
            base_url: format!("http://{address}/v1"),
        };
        let output = Arc::new(Mutex::new(String::new()));
        let collected = Arc::clone(&output);
        let result = provider
            .stream_text(
                &request,
                Box::new(move |delta| {
                    collected.lock().unwrap().push_str(delta);
                }),
            )
            .await;
        server.await.unwrap();
        let text = output.lock().unwrap().clone();
        (result, text)
    }

    #[tokio::test]
    async fn streaming_waits_for_completed_and_detects_failures_or_truncation() {
        let prefix = concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
            "data: {\"type\":\"response.output_text.done\"}\n\n",
        );
        let completed = format!("{prefix}data: {{\"type\":\"response.output_text.delta\",\"delta\":\" world\"}}\n\ndata: {{\"type\":\"response.completed\"}}\n\n");
        let (result, text) = stream_fixture(&completed, request()).await;
        assert!(result.is_ok());
        assert_eq!(text, "hello world");

        let failed = format!("{prefix}data: {{\"type\":\"response.failed\",\"response\":{{\"error\":{{\"message\":\"upstream failed\"}}}}}}\n\n");
        let (result, text) = stream_fixture(&failed, request()).await;
        assert!(result.unwrap_err().to_string().contains("upstream failed"));
        assert_eq!(text, "hello");

        let (result, _) = stream_fixture(prefix, request()).await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("before response.completed"));
    }

    #[tokio::test]
    async fn retries_one_gateway_failure_before_streaming() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request_bytes = Vec::new();
                let mut buffer = [0u8; 2048];
                while !request_bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                    let read = socket.read(&mut buffer).await.unwrap();
                    assert!(read > 0);
                    request_bytes.extend_from_slice(&buffer[..read]);
                }
                let body = if attempt == 0 {
                    "busy"
                } else {
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\ndata: {\"type\":\"response.completed\"}\n\n"
                };
                let status = if attempt == 0 { "503 Service Unavailable" } else { "200 OK" };
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let provider = OpenAiResponsesLlmProvider { api_key: "test-key".into(), base_url: format!("http://{address}/v1") };
        let output = Arc::new(Mutex::new(String::new()));
        let collected = output.clone();
        provider.stream_text(&request(), Box::new(move |delta| collected.lock().unwrap().push_str(delta))).await.unwrap();
        server.await.unwrap();
        assert_eq!(*output.lock().unwrap(), "OK");
    }

    #[tokio::test]
    async fn sends_multiple_image_formats_to_responses_in_order() {
        let request = request().with_images(vec![
            LlmImageContent { media_type: "image/png".into(), data_base64: "UE5H".into() },
            LlmImageContent { media_type: "image/jpeg".into(), data_base64: "SlBFRw==".into() },
        ]);
        let body = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"two images\"}\n\ndata: {\"type\":\"response.completed\"}\n\n";
        let (result, text) = stream_fixture(body, request).await;
        assert!(result.is_ok());
        assert_eq!(text, "two images");
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

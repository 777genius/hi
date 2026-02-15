use async_trait::async_trait;

use crate::domain::{LlmDeltaCallback, LlmError, LlmProvider, LlmResult, LlmRuntimeConfig, LlmStreamRequest};

/// Anthropic Messages API provider.
pub struct AnthropicLlmProvider {
    api_key: String,
}

impl AnthropicLlmProvider {
    pub fn new(config: &LlmRuntimeConfig) -> LlmResult<Self> {
        let api_key = config
            .api_key
            .clone()
            .ok_or_else(|| LlmError::Authentication("Missing API key".to_string()))?;

        if api_key.trim().is_empty() {
            return Err(LlmError::Authentication("Missing API key".to_string()));
        }

        Ok(Self { api_key })
    }
}

#[async_trait]
impl LlmProvider for AnthropicLlmProvider {
    async fn stream_text(
        &self,
        request: &LlmStreamRequest,
        mut on_delta: LlmDeltaCallback,
    ) -> LlmResult<()> {
        let opts = crate::infrastructure::ai::anthropic::StreamOptions {
            api_key: &self.api_key,
            model: &request.model,
            system_prompt: &request.system_prompt,
            user_text: &request.user_text,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
        };

        crate::infrastructure::ai::anthropic::stream_text_deltas(opts, move |delta| {
            on_delta(delta);
        })
        .await
        .map_err(|e| match e {
            crate::infrastructure::ai::anthropic::AnthropicError::MissingApiKey => {
                LlmError::Authentication("Missing API key".to_string())
            }
            crate::infrastructure::ai::anthropic::AnthropicError::Http { status, body } => {
                LlmError::Http { status, body }
            }
            crate::infrastructure::ai::anthropic::AnthropicError::Network(err) => {
                LlmError::Network(err.to_string())
            }
            crate::infrastructure::ai::anthropic::AnthropicError::InvalidResponse(err) => {
                LlmError::InvalidResponse(err)
            }
        })
    }

    fn name(&self) -> &str {
        "anthropic"
    }

    fn is_online(&self) -> bool {
        true
    }
}


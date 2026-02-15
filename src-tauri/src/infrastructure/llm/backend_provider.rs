use async_trait::async_trait;

use crate::domain::{LlmDeltaCallback, LlmError, LlmProvider, LlmResult, LlmRuntimeConfig, LlmStreamRequest};

/// Backend provider placeholder.
///
/// В будущем здесь будет запрос на наш backend, который сам решает:
/// - выбор модели/провайдера
/// - проксирование
/// - аутентификацию и лимиты
pub struct BackendLlmProvider {
    #[allow(dead_code)]
    backend_url: String,
    #[allow(dead_code)]
    auth_token: Option<String>,
}

impl BackendLlmProvider {
    pub fn new(config: &LlmRuntimeConfig) -> LlmResult<Self> {
        let backend_url = config
            .backend_url
            .clone()
            .or_else(|| std::env::var("LLM_BACKEND_URL").ok())
            .unwrap_or_else(|| "https://api.voicetext.site".to_string());

        Ok(Self {
            backend_url,
            auth_token: config.backend_auth_token.clone(),
        })
    }
}

#[async_trait]
impl LlmProvider for BackendLlmProvider {
    async fn stream_text(
        &self,
        _request: &LlmStreamRequest,
        _on_delta: LlmDeltaCallback,
    ) -> LlmResult<()> {
        Err(LlmError::Unsupported(
            "Backend LLM provider is not implemented yet".to_string(),
        ))
    }

    fn name(&self) -> &str {
        "backend"
    }

    fn is_online(&self) -> bool {
        true
    }
}


use serde::{Deserialize, Serialize};

/// Default Anthropic model used for hover-analysis.
pub const DEFAULT_ANTHROPIC_MODEL: &str = "claude-haiku-4-5-20251001";
pub const DEFAULT_OPENAI_RESPONSES_MODEL: &str = "gpt-5.4-mini";

/// Supported LLM provider types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LlmProviderType {
    /// Anthropic Messages API (SSE streaming).
    Anthropic,
    /// OpenAI-compatible Chat Completions API (SSE streaming).
    ///
    /// Подходит для OpenAI / OpenRouter и любых провайдеров с совместимым контрактом.
    OpenAiCompatible,
    /// OpenAI Responses API (SSE streaming).
    OpenAiResponses,
    /// Наш backend, который сам решает роутинг/проксирование моделей.
    Backend,
}

impl Default for LlmProviderType {
    fn default() -> Self {
        Self::Anthropic
    }
}

/// Runtime configuration for LLM provider initialization.
///
/// Важно: это не пользовательский persisted-конфиг (как `AppConfig`), а параметры запуска,
/// которые обычно приходят из переменных окружения или auth state.
#[derive(Debug, Clone, Default)]
pub struct LlmRuntimeConfig {
    pub provider: LlmProviderType,

    /// API key (если нужен). Для Anthropic: `ANTHROPIC_API_KEY`.
    /// Для OpenAI-compatible / Responses: `OPENAI_API_KEY`.
    pub api_key: Option<String>,

    /// Base URL for OpenAI-compatible / Responses providers.
    pub base_url: Option<String>,

    /// Optional backend URL (если провайдер `Backend`).
    pub backend_url: Option<String>,

    /// Optional backend auth token (если провайдер `Backend`).
    pub backend_auth_token: Option<String>,
}

/// A single streaming completion request.
#[derive(Debug, Clone)]
pub struct LlmStreamRequest {
    pub model: String,
    pub system_prompt: String,
    pub user_text: String,
    pub max_tokens: u32,
    pub temperature: f32,
    pub reasoning_effort: Option<String>,
    pub verbosity: Option<String>,
    pub web_search: Option<LlmWebSearchOptions>,
    pub images: Vec<LlmImageContent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmImageContent {
    pub media_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmWebSearchOptions {
    pub tool_type: String,
    pub context_size: String,
}

impl LlmStreamRequest {
    pub fn new(
        model: impl Into<String>,
        system_prompt: impl Into<String>,
        user_text: impl Into<String>,
        max_tokens: u32,
        temperature: f32,
    ) -> Self {
        Self {
            model: model.into(),
            system_prompt: system_prompt.into(),
            user_text: user_text.into(),
            max_tokens,
            temperature,
            reasoning_effort: None,
            verbosity: None,
            web_search: None,
            images: Vec::new(),
        }
    }

    pub fn with_reasoning_effort(mut self, effort: impl Into<String>) -> Self {
        self.reasoning_effort = Some(effort.into());
        self
    }

    pub fn with_verbosity(mut self, verbosity: impl Into<String>) -> Self {
        self.verbosity = Some(verbosity.into());
        self
    }

    pub fn with_web_search(mut self, options: LlmWebSearchOptions) -> Self {
        self.web_search = Some(options);
        self
    }

    pub fn with_images(mut self, images: Vec<LlmImageContent>) -> Self {
        self.images = images;
        self
    }
}

use async_trait::async_trait;

use crate::domain::models::{LlmRuntimeConfig, LlmStreamRequest};

/// Result type for LLM operations.
pub type LlmResult<T> = Result<T, LlmError>;

/// Errors that can occur during LLM operations.
#[derive(Debug, thiserror::Error, Clone)]
pub enum LlmError {
    #[error("Configuration error: {0}")]
    Configuration(String),

    #[error("Authentication error: {0}")]
    Authentication(String),

    #[error("HTTP error {status}: {body}")]
    Http { status: u16, body: String },

    #[error("Network error: {0}")]
    Network(String),

    #[error("Invalid response: {0}")]
    InvalidResponse(String),

    #[error("Unsupported operation: {0}")]
    Unsupported(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

/// Streaming delta callback.
pub type LlmDeltaCallback = Box<dyn FnMut(&str) + Send>;

/// Trait defining the contract for LLM providers.
///
/// Following the Dependency Inversion Principle (SOLID), the domain layer defines this interface,
/// and the infrastructure layer provides implementations.
#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Stream completion deltas for the given request.
    async fn stream_text(
        &self,
        request: &LlmStreamRequest,
        on_delta: LlmDeltaCallback,
    ) -> LlmResult<()>;

    /// Provider name for diagnostics.
    fn name(&self) -> &str;

    /// Whether provider is online (cloud-based).
    fn is_online(&self) -> bool;

    /// Whether provider supports streaming.
    fn supports_streaming(&self) -> bool {
        true
    }
}

/// Factory trait for creating LLM providers based on runtime configuration.
pub trait LlmProviderFactory: Send + Sync {
    fn create(&self, config: &LlmRuntimeConfig) -> LlmResult<Box<dyn LlmProvider>>;
}


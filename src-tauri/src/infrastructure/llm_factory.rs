use crate::domain::{
    LlmProvider, LlmProviderFactory, LlmProviderType, LlmResult, LlmRuntimeConfig,
};
use crate::infrastructure::llm::{
    AnthropicLlmProvider, BackendLlmProvider, OpenAiCompatibleLlmProvider,
};

/// Factory for creating LLM providers based on runtime configuration.
pub struct DefaultLlmProviderFactory;

impl DefaultLlmProviderFactory {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DefaultLlmProviderFactory {
    fn default() -> Self {
        Self::new()
    }
}

impl LlmProviderFactory for DefaultLlmProviderFactory {
    fn create(&self, config: &LlmRuntimeConfig) -> LlmResult<Box<dyn LlmProvider>> {
        log::info!("Creating LLM provider: {:?}", config.provider);

        match config.provider {
            LlmProviderType::Anthropic => Ok(Box::new(AnthropicLlmProvider::new(config)?)),

            LlmProviderType::OpenAiCompatible => {
                Ok(Box::new(OpenAiCompatibleLlmProvider::new(config)?))
            }

            LlmProviderType::Backend => Ok(Box::new(BackendLlmProvider::new(config)?)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factory_constructs() {
        let _ = DefaultLlmProviderFactory::new();
        let _ = DefaultLlmProviderFactory::default();
    }

    #[test]
    fn create_backend_ok_without_keys() {
        let f = DefaultLlmProviderFactory::new();
        let cfg = LlmRuntimeConfig {
            provider: LlmProviderType::Backend,
            ..Default::default()
        };
        assert!(f.create(&cfg).is_ok());
    }

    #[test]
    fn create_anthropic_requires_key() {
        let f = DefaultLlmProviderFactory::new();
        let cfg = LlmRuntimeConfig {
            provider: LlmProviderType::Anthropic,
            ..Default::default()
        };
        let err = f.create(&cfg).err().expect("expected error");
        assert!(matches!(err, crate::domain::LlmError::Authentication(_)));
    }
}

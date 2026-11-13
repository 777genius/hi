mod assemblyai;
mod backend;
mod backend_messages;
/// STT provider implementations
mod deepgram;
mod local_glossary;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod local_stt;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod utterance_segmenter;
mod whisper_local;

pub use assemblyai::AssemblyAIProvider;
pub use backend::BackendProvider;
pub use deepgram::DeepgramProvider;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub use local_stt::{ensure_local_model_present, LocalModel, LocalSttProvider};

/// Local models run only on Apple Silicon; elsewhere there is nothing to check.
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn ensure_local_model_present(
    config: &crate::domain::SttConfig,
) -> crate::domain::SttResult<()> {
    if config.provider.is_local_utterance() {
        return Err(crate::domain::SttError::Configuration(
            "Local STT models currently require macOS Apple Silicon".to_string(),
        ));
    }
    Ok(())
}
pub use whisper_local::WhisperLocalProvider;

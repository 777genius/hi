mod assemblyai;
mod backend;
mod backend_messages;
/// STT provider implementations
mod deepgram;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod parakeet_ultra;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod utterance_segmenter;
mod whisper_local;

pub use assemblyai::AssemblyAIProvider;
pub use backend::BackendProvider;
pub use deepgram::DeepgramProvider;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub use parakeet_ultra::ParakeetUltraProvider;
pub use whisper_local::WhisperLocalProvider;

pub mod ai;
pub mod audio;
pub(crate) mod atomic_file;
pub mod auth_store; // Auth session + device_id (Rust SoT)
pub mod auto_paste; // Автоматическая вставка текста
pub mod clipboard; // Кроссплатформенная работа с clipboard
pub mod config_store;
pub mod embedded_keys; // API ключи встроенные в build
pub mod factory;
pub mod focus_copy_helper;
pub mod hotkey; // Нормализация/миграция хоткеев
pub mod interview_memory_session_store;
pub mod llm;
pub mod llm_factory;
pub mod local_interview_memory;
pub mod microphone_mute;
pub mod models;
pub mod signal;
pub mod test_interviewer; // Тестовый режим: озвучка вопросов интервьюера
/// Infrastructure layer - contains concrete implementations of domain interfaces
/// This layer depends on domain layer but is independent of application layer
pub mod stt;
pub mod updater; // OS-level mute/unmute default microphone

pub use auth_store::{AuthSession, AuthStore, AuthStoreData, AuthUser};
pub use clipboard::copy_to_clipboard;
pub use config_store::ConfigStore;
pub use factory::*;
pub use interview_memory_session_store::{
    ActiveInterviewMemorySession, InterviewMemorySessionStore,
};
pub use llm_factory::DefaultLlmProviderFactory;

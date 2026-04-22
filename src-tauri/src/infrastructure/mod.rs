pub mod ai;
pub mod audio;
pub mod auth_store; // Auth session + device_id (Rust SoT)
pub mod auto_paste; // Автоматическая вставка текста
pub mod clipboard; // Кроссплатформенная работа с clipboard
pub mod config_store;
pub mod embedded_keys; // API ключи встроенные в build
pub mod factory;
pub mod hotkey; // Нормализация/миграция хоткеев
pub mod llm;
pub mod llm_factory;
pub mod microphone_mute;
pub mod models;
/// Infrastructure layer - contains concrete implementations of domain interfaces
/// This layer depends on domain layer but is independent of application layer
pub mod stt;
pub mod updater; // OS-level mute/unmute default microphone

pub use auth_store::{AuthSession, AuthStore, AuthStoreData, AuthUser};
pub use clipboard::copy_to_clipboard;
pub use config_store::ConfigStore;
pub use factory::*;
pub use llm_factory::DefaultLlmProviderFactory;

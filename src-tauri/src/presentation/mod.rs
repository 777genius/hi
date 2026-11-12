/// Presentation layer - Tauri commands, events, and application state
/// This layer handles communication with the frontend
pub mod answer_style_prompt;
pub mod commands;
pub mod companion;
pub mod companion_actions;
pub mod companion_timeline;
pub mod companion_timeline_store;
pub mod events;
pub mod interview_memory_bridge;
pub mod signal_bridge;
pub mod state;
pub mod tray;

pub use events::*;
pub use state::AppState;

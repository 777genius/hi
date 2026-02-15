/// Domain ports - interfaces (traits) that define contracts for external dependencies
/// These abstractions allow the domain layer to remain independent of infrastructure

mod stt_provider;
mod audio_capture;
mod llm_provider;

pub use stt_provider::*;
pub use audio_capture::*;
pub use llm_provider::*;

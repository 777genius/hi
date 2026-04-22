mod capture_factory;
#[cfg(target_os = "linux")]
mod linux_output_capture;
#[cfg(target_os = "macos")]
mod macos_output_capture;
/// Audio capture implementations
mod mock_capture;
mod speech_audio;
mod system_capture;
mod vad_capture_wrapper;
mod vad_processor;
#[cfg(target_os = "windows")]
mod windows_output_capture;

pub use capture_factory::{
    create_default_output_audio_capture, create_output_audio_capture_for_device,
};
#[cfg(target_os = "linux")]
pub use linux_output_capture::LinuxOutputAudioCapture;
#[cfg(target_os = "macos")]
pub use macos_output_capture::MacosOutputAudioCapture;
pub use mock_capture::MockAudioCapture;
pub use system_capture::SystemAudioCapture;
pub use vad_capture_wrapper::VadCaptureWrapper;
pub use vad_processor::{VadProcessor, VadResult};
#[cfg(target_os = "windows")]
pub use windows_output_capture::WindowsOutputAudioCapture;

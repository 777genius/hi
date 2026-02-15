use crate::domain::{AudioCapture, AudioResult};

/// Create the default audio capture for "system output" (what the user hears).
///
/// This is intentionally platform-specific behind a single constructor to keep the
/// higher-level state (AppState/TranscriptionService wiring) clean.
pub fn create_default_output_audio_capture() -> AudioResult<Box<dyn AudioCapture>> {
    create_output_audio_capture_for_device(None)
}

/// Create a system-output capture for a specific device, if supported by the platform.
///
/// Notes:
/// - macOS: ScreenCaptureKit captures the system mix; device selection is ignored.
/// - Windows: device name maps to an output endpoint; loopback capture is enabled.
/// - Linux: uses PipeWire sink capture; device selection is currently ignored.
pub fn create_output_audio_capture_for_device(
    device_name: Option<String>,
) -> AudioResult<Box<dyn AudioCapture>> {
    #[cfg(target_os = "macos")]
    {
        let _ = device_name;
        let capture = super::MacosOutputAudioCapture::new()?;
        return Ok(Box::new(capture));
    }

    #[cfg(target_os = "windows")]
    {
        let capture = super::WindowsOutputAudioCapture::with_device(device_name)?;
        return Ok(Box::new(capture));
    }

    #[cfg(target_os = "linux")]
    {
        let _ = device_name;
        let capture = super::LinuxOutputAudioCapture::new()?;
        return Ok(Box::new(capture));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        // Fallback: microphone capture.
        let capture = super::SystemAudioCapture::with_device(device_name)?;
        return Ok(Box::new(capture));
    }
}


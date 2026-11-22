use async_trait::async_trait;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use screencapturekit::error::{SCError, SCStreamErrorCode};
use screencapturekit::prelude::*;
use screencapturekit::stream::delegate_trait::StreamCallbacks;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::domain::{
    AudioCapture, AudioChunk, AudioChunkCallback, AudioConfig, AudioError, AudioResult,
};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const TARGET_CHANNELS: u16 = 1;
const TARGET_FRAME_MS: usize = 30;
const TARGET_FRAME_SAMPLES: usize = (TARGET_SAMPLE_RATE as usize * TARGET_FRAME_MS) / 1000; // 480

/// macOS system audio capture via ScreenCaptureKit.
///
/// Captures **output audio** (what user hears) and converts it to 16kHz mono i16 PCM.
/// Output is emitted in fixed 30ms frames (480 samples) to match STT pipeline expectations.
pub struct MacosOutputAudioCapture {
    stream: Option<SCStream>,
    callback_enabled: Arc<AtomicBool>,
    diagnostics: Option<Arc<CaptureDiagnostics>>,
    audio_config: AudioConfig,
    is_capturing: bool,
}

impl MacosOutputAudioCapture {
    pub fn new() -> AudioResult<Self> {
        Ok(Self {
            stream: None,
            callback_enabled: Arc::new(AtomicBool::new(false)),
            diagnostics: None,
            audio_config: AudioConfig::default(),
            is_capturing: false,
        })
    }
}

struct CaptureDiagnostics {
    started: Instant,
    callbacks: AtomicU64,
    frames: AtomicU64,
    rejected: AtomicU64,
    last_callback_ms: AtomicU64,
    last_frame_ms: AtomicU64,
    cadence_started_ms: AtomicU64,
    recovery_armed: AtomicBool,
    native_error: Mutex<Option<SCError>>,
}

impl CaptureDiagnostics {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            callbacks: AtomicU64::new(0),
            frames: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
            last_callback_ms: AtomicU64::new(0),
            last_frame_ms: AtomicU64::new(0),
            cadence_started_ms: AtomicU64::new(0),
            recovery_armed: AtomicBool::new(false),
            native_error: Mutex::new(None),
        }
    }

    fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn note_callback(&self, now_ms: u64) -> (u64, u64) {
        let count = self.callbacks.fetch_add(1, Ordering::Relaxed);
        let previous_ms = self.last_callback_ms.swap(now_ms, Ordering::Relaxed);
        let gap_ms = now_ms.saturating_sub(previous_ms);
        if count == 0 || gap_ms > 250 {
            self.cadence_started_ms.store(now_ms, Ordering::Relaxed);
        } else if now_ms.saturating_sub(self.cadence_started_ms.load(Ordering::Relaxed)) >= 1_000 {
            self.recovery_armed.store(true, Ordering::Release);
        }
        (count, gap_ms)
    }

    fn starvation_ms(&self, now_ms: u64) -> Option<u64> {
        // A successful start is not evidence of buffer delivery. In particular,
        // never restart-loop an idle source or a stream still warming up.
        if !self.recovery_armed.load(Ordering::Acquire) || self.frames.load(Ordering::Relaxed) == 0
        {
            return None;
        }
        Some(now_ms.saturating_sub(self.last_callback_ms.load(Ordering::Relaxed)))
    }

    fn native_error(&self) -> Option<SCError> {
        self.native_error
            .lock()
            .ok()
            .and_then(|error| error.clone())
    }

    fn note_native_error(&self, error: SCError) {
        if let Ok(mut slot) = self.native_error.lock() {
            if slot.is_none() {
                log::error!(
                    "ScreenCaptureKit stopped by macOS after {}ms, code={:?}: {error:?}",
                    self.elapsed_ms(),
                    error.stream_error_code().map(|code| code.as_raw())
                );
                *slot = Some(error);
            }
        }
    }
}

fn native_capture_error(error: SCError) -> AudioError {
    let message = format!("{error:?}");
    match error.stream_error_code() {
        Some(SCStreamErrorCode::UserStopped) => AudioError::StoppedByUser(message),
        Some(SCStreamErrorCode::UserDeclined | SCStreamErrorCode::MissingEntitlements) => {
            AudioError::AccessDenied(message)
        }
        Some(
            SCStreamErrorCode::SystemStoppedStream
            | SCStreamErrorCode::FailedApplicationConnectionInvalid
            | SCStreamErrorCode::FailedApplicationConnectionInterrupted
            | SCStreamErrorCode::InternalError
            | SCStreamErrorCode::FailedToStartAudioCapture
            | SCStreamErrorCode::FailedToStopAudioCapture,
        ) => AudioError::Capture(message),
        _ if matches!(error, SCError::PermissionDenied(_)) => AudioError::AccessDenied(message),
        // Unknown codes/configuration failures require an explicit new Start.
        _ => AudioError::Configuration(message),
    }
}

fn capture_start_error(error: SCError, native_error: Option<SCError>) -> AudioError {
    if let Some(native_error) = native_error {
        return native_capture_error(native_error);
    }
    if error.stream_error_code().is_some() || matches!(error, SCError::PermissionDenied(_)) {
        return native_capture_error(error);
    }
    match error {
        // The bridge start completion only carries a localized string. Do not
        // infer a permission/configuration failure from that lossy result.
        SCError::CaptureStartFailed(_) | SCError::StreamError(_) | SCError::Timeout(_) => {
            AudioError::Capture(format!("Failed to start ScreenCaptureKit capture: {error}"))
        }
        _ => native_capture_error(error),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NativeAudioFormat {
    sample_rate: u32,
    is_float: bool,
    is_big_endian: bool,
    bits_per_channel: u32,
}

struct ResamplePipeline {
    format: NativeAudioFormat,
    is_float: bool,
    is_big_endian: bool,
    bits_per_channel: u32,
    resampler: SincFixedIn<f32>,
    // Native mono f32 samples (at from_sample_rate)
    native_mono: Vec<f32>,
    // Resampled mono i16 samples (at 16kHz)
    out_i16: Vec<i16>,
    // Expected native samples per ~30ms
    input_frame_samples: usize,
}

impl ResamplePipeline {
    fn ensure_format(slot: &mut Option<Self>, format: NativeAudioFormat) -> AudioResult<bool> {
        if slot.as_ref().map(|pipe| pipe.format) == Some(format) {
            return Ok(false);
        }
        let pipeline = Self::new(
            format.sample_rate,
            format.is_float,
            format.is_big_endian,
            format.bits_per_channel,
        )?;
        *slot = Some(pipeline);
        Ok(true)
    }

    fn new(
        from_sample_rate: u32,
        is_float: bool,
        is_big_endian: bool,
        bits_per_channel: u32,
    ) -> AudioResult<Self> {
        if from_sample_rate == 0
            || !((is_float && bits_per_channel == 32) || (!is_float && bits_per_channel == 16))
        {
            return Err(AudioError::Configuration(format!(
                "Unsupported ScreenCaptureKit PCM format: rate={from_sample_rate}, float={is_float}, bits={bits_per_channel}"
            )));
        }
        let input_frame_samples = ((from_sample_rate as usize) * TARGET_FRAME_MS) / 1000;
        let input_frame_samples = input_frame_samples.max(1);

        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };

        let resampler = SincFixedIn::<f32>::new(
            TARGET_SAMPLE_RATE as f64 / from_sample_rate as f64,
            2.0,
            params,
            input_frame_samples,
            1, // mono
        )
        .map_err(|e| AudioError::Internal(format!("Failed to create resampler: {e}")))?;

        Ok(Self {
            format: NativeAudioFormat {
                sample_rate: from_sample_rate,
                is_float,
                is_big_endian,
                bits_per_channel,
            },
            is_float,
            is_big_endian,
            bits_per_channel,
            resampler,
            native_mono: Vec::with_capacity(input_frame_samples * 4),
            out_i16: Vec::with_capacity(TARGET_FRAME_SAMPLES * 6),
            input_frame_samples,
        })
    }

    fn decode_and_push_native_mono(&mut self, sample: &CMSampleBuffer) {
        let Some(audio_list) = sample.audio_buffer_list() else {
            return;
        };

        // We expect PCM. ScreenCaptureKit typically provides float32 PCM.
        // Handle a few common layouts:
        // - 1 buffer, interleaved (number_channels = N)
        // - N buffers, non-interleaved (each with number_channels = 1)
        let num_buffers = audio_list.num_buffers();
        if num_buffers == 0 {
            return;
        }

        if num_buffers == 1 {
            let Some(buf) = audio_list.get(0) else {
                return;
            };
            let channels = buf.number_channels as usize;
            let data = buf.data();
            if channels == 0 || data.is_empty() {
                return;
            }

            if self.is_float && self.bits_per_channel == 32 {
                // Interleaved f32
                let frame_count = data.len() / (4 * channels);
                if frame_count == 0 {
                    return;
                }

                // Fast path: aligned cast
                let ptr = data.as_ptr();
                let aligned = (ptr as usize) % std::mem::align_of::<f32>() == 0;
                if aligned && self.is_big_endian == cfg!(target_endian = "big") {
                    let samples_len = data.len() / 4;
                    // SAFETY: pointer alignment is checked; slice length is correct.
                    let samples =
                        unsafe { std::slice::from_raw_parts(ptr as *const f32, samples_len) };
                    for frame in 0..frame_count {
                        let base = frame * channels;
                        let mut sum = 0.0f32;
                        for ch in 0..channels {
                            sum += samples[base + ch];
                        }
                        self.native_mono.push(sum / channels as f32);
                    }
                } else {
                    // Fallback: decode bytes
                    for frame in 0..frame_count {
                        let mut sum = 0.0f32;
                        for ch in 0..channels {
                            let idx = (frame * channels + ch) * 4;
                            let bytes = [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
                            let v = if self.is_big_endian {
                                f32::from_be_bytes(bytes)
                            } else {
                                f32::from_le_bytes(bytes)
                            };
                            sum += v;
                        }
                        self.native_mono.push(sum / channels as f32);
                    }
                }
            } else if !self.is_float && self.bits_per_channel == 16 {
                // Interleaved i16
                let frame_count = data.len() / (2 * channels);
                if frame_count == 0 {
                    return;
                }
                for frame in 0..frame_count {
                    let mut sum = 0i32;
                    for ch in 0..channels {
                        let idx = (frame * channels + ch) * 2;
                        let bytes = [data[idx], data[idx + 1]];
                        let v = if self.is_big_endian {
                            i16::from_be_bytes(bytes)
                        } else {
                            i16::from_le_bytes(bytes)
                        };
                        sum += v as i32;
                    }
                    let avg = sum as f32 / channels as f32;
                    self.native_mono.push(avg / 32767.0);
                }
            }

            return;
        }

        // Non-interleaved: average across buffers.
        // Take min frames across buffers to stay in sync.
        let mut per_buf_samples: Vec<&[u8]> = Vec::with_capacity(num_buffers);
        let mut per_buf_channels: Vec<usize> = Vec::with_capacity(num_buffers);
        for i in 0..num_buffers {
            let Some(b) = audio_list.get(i) else { continue };
            per_buf_channels.push(b.number_channels as usize);
            per_buf_samples.push(b.data());
        }

        if per_buf_samples.is_empty() {
            return;
        }

        // Only support 1 channel per buffer in this layout.
        if per_buf_channels.iter().any(|&c| c != 1) {
            return;
        }

        let bytes_per_sample = if self.is_float && self.bits_per_channel == 32 {
            4
        } else if !self.is_float && self.bits_per_channel == 16 {
            2
        } else {
            return;
        };

        let frame_count = per_buf_samples
            .iter()
            .map(|d| d.len() / bytes_per_sample)
            .min()
            .unwrap_or(0);
        if frame_count == 0 {
            return;
        }

        for frame in 0..frame_count {
            let mut sum = 0.0f32;
            for d in &per_buf_samples {
                let idx = frame * bytes_per_sample;
                let v = if bytes_per_sample == 4 {
                    let bytes = [d[idx], d[idx + 1], d[idx + 2], d[idx + 3]];
                    if self.is_big_endian {
                        f32::from_be_bytes(bytes)
                    } else {
                        f32::from_le_bytes(bytes)
                    }
                } else {
                    let bytes = [d[idx], d[idx + 1]];
                    let v = if self.is_big_endian {
                        i16::from_be_bytes(bytes)
                    } else {
                        i16::from_le_bytes(bytes)
                    };
                    v as f32 / 32767.0
                };
                sum += v;
            }
            self.native_mono.push(sum / per_buf_samples.len() as f32);
        }
    }

    fn drain_frames(&mut self) -> Vec<Vec<i16>> {
        let mut frames: Vec<Vec<i16>> = Vec::new();

        // Process native buffer through resampler in fixed-size chunks.
        while self.native_mono.len() >= self.input_frame_samples {
            let chunk: Vec<f32> = self.native_mono.drain(..self.input_frame_samples).collect();
            let input = vec![chunk];
            let out = match self.resampler.process(&input, None) {
                Ok(o) => o,
                Err(err) => {
                    log::error!("Resampling error: {}", err);
                    continue;
                }
            };

            let out_ch = out.get(0).map(|v| v.as_slice()).unwrap_or(&[]);
            for &s in out_ch {
                let clamped = s.clamp(-1.0, 1.0);
                self.out_i16.push((clamped * 32767.0) as i16);
            }
        }

        while self.out_i16.len() >= TARGET_FRAME_SAMPLES {
            let frame: Vec<i16> = self.out_i16.drain(..TARGET_FRAME_SAMPLES).collect();
            frames.push(frame);
        }

        frames
    }
}

#[async_trait]
impl AudioCapture for MacosOutputAudioCapture {
    async fn initialize(&mut self, config: AudioConfig) -> AudioResult<()> {
        self.audio_config = config;
        Ok(())
    }

    async fn start_capture(&mut self, on_chunk: AudioChunkCallback) -> AudioResult<()> {
        if self.is_capturing {
            return Err(AudioError::Capture("Already capturing audio".to_string()));
        }

        // ScreenCaptureKit requires user permission (Screen Recording).
        let content = SCShareableContent::get()
            .map_err(|e| AudioError::AccessDenied(format!("ScreenCaptureKit unavailable: {e}")))?;

        let display = content.displays().into_iter().next().ok_or_else(|| {
            AudioError::DeviceNotFound("No displays found for capture".to_string())
        })?;

        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();

        let config = SCStreamConfiguration::new()
            // Минимальные размеры, чтобы не тратить ресурсы на видео.
            .with_width(2)
            .with_height(2)
            .with_captures_audio(true)
            // Важно: не захватывать звук самого приложения.
            .with_excludes_current_process_audio(true)
            .with_sample_rate(48_000)
            .with_channel_count(2);

        let pipeline: Arc<Mutex<Option<ResamplePipeline>>> = Arc::new(Mutex::new(None));
        let pipeline_for_cb = pipeline.clone();
        let on_chunk_cb = on_chunk.clone();
        let callback_enabled = Arc::new(AtomicBool::new(true));
        let callback_enabled_for_cb = callback_enabled.clone();
        let diagnostics = Arc::new(CaptureDiagnostics::new());
        let diagnostics_for_cb = diagnostics.clone();

        let diagnostics_for_error = diagnostics.clone();
        let callback_enabled_for_error = callback_enabled.clone();
        let delegate = StreamCallbacks::new().on_error(move |error| {
            callback_enabled_for_error.store(false, Ordering::Release);
            diagnostics_for_error.note_native_error(error);
        });
        let mut stream = SCStream::new_with_delegate(&filter, &config, delegate);
        let added = stream.add_output_handler(
            move |sample: CMSampleBuffer, output: SCStreamOutputType| {
                if output != SCStreamOutputType::Audio
                    || !callback_enabled_for_cb.load(Ordering::Acquire)
                {
                    return;
                }
                let now_ms = diagnostics_for_cb.elapsed_ms();
                let (count, gap_ms) = diagnostics_for_cb.note_callback(now_ms);
                if count > 0 && gap_ms >= 1_000 {
                    log::warn!(
                        "ScreenCaptureKit raw audio resumed after {}ms without callbacks (callbacks={}, frames={}, rejected={})",
                        gap_ms, count + 1,
                        diagnostics_for_cb.frames.load(Ordering::Relaxed),
                        diagnostics_for_cb.rejected.load(Ordering::Relaxed),
                    );
                }
                let Some(fmt) = sample.format_description() else {
                    diagnostics_for_cb.rejected.fetch_add(1, Ordering::Relaxed);
                    return;
                };
                if !fmt.is_audio() {
                    diagnostics_for_cb.rejected.fetch_add(1, Ordering::Relaxed);
                    return;
                }

                let sample_rate = fmt
                    .audio_sample_rate()
                    .map(|v| v.round() as u32)
                    .unwrap_or(48_000);
                let bits = fmt.audio_bits_per_channel().unwrap_or(32);
                let is_float = fmt.audio_is_float();
                let is_be = fmt.audio_is_big_endian();
                let format = NativeAudioFormat {
                    sample_rate,
                    is_float,
                    is_big_endian: is_be,
                    bits_per_channel: bits,
                };

                let mut guard = match pipeline_for_cb.lock() {
                    Ok(g) => g,
                    Err(e) => {
                        log::error!("Audio pipeline mutex poisoned: {}", e);
                        return;
                    }
                };

                // Output routes may change while a stream is running. Reusing
                // the old decoder can turn valid native buffers into no PCM.
                match ResamplePipeline::ensure_format(&mut guard, format) {
                    Ok(true) => log::info!("ScreenCaptureKit native audio format: {format:?}"),
                    Ok(false) => {}
                    Err(e) => {
                        let rejected = diagnostics_for_cb.rejected.fetch_add(1, Ordering::Relaxed);
                        if rejected == 0 || rejected % 100 == 0 {
                            log::error!("Failed to init ScreenCaptureKit resample pipeline: {e}");
                        }
                        return;
                    }
                }
                let Some(pipe) = guard.as_mut() else { return };

                // Decode audio bytes to native mono f32, then resample into fixed 16k frames.
                let previous_samples = pipe.native_mono.len();
                pipe.decode_and_push_native_mono(&sample);
                if pipe.native_mono.len() == previous_samples {
                    let rejected = diagnostics_for_cb.rejected.fetch_add(1, Ordering::Relaxed);
                    if rejected == 0 || rejected % 100 == 0 {
                        log::warn!("ScreenCaptureKit native audio buffer produced no PCM (rejected={}, samples={})", rejected + 1, sample.num_samples());
                    }
                }
                let frames = pipe.drain_frames();
                drop(guard);

                for frame in frames {
                    if frame.is_empty() || !callback_enabled_for_cb.load(Ordering::Acquire) {
                        continue;
                    }
                    diagnostics_for_cb.frames.fetch_add(1, Ordering::Relaxed);
                    diagnostics_for_cb.last_frame_ms.store(now_ms, Ordering::Relaxed);
                    on_chunk_cb(AudioChunk::new(frame, TARGET_SAMPLE_RATE, TARGET_CHANNELS));
                }
            },
            SCStreamOutputType::Audio,
        );

        if added.is_none() {
            return Err(AudioError::Internal(
                "Failed to register ScreenCaptureKit audio handler".to_string(),
            ));
        }

        stream
            .start_capture()
            .map_err(|error| capture_start_error(error, diagnostics.native_error()))?;

        self.stream = Some(stream);
        self.callback_enabled = callback_enabled;
        self.diagnostics = Some(diagnostics);
        self.is_capturing = true;
        log::info!("ScreenCaptureKit system audio capture started");

        Ok(())
    }

    async fn stop_capture(&mut self) -> AudioResult<()> {
        if !self.is_capturing {
            return Ok(());
        }

        // Invalidate this generation before stopping. A late queued callback
        // from the old stream must never enter the next recording/recovery.
        self.callback_enabled.store(false, Ordering::Release);
        self.is_capturing = false;
        let native_stopped = self
            .diagnostics
            .as_ref()
            .and_then(|diagnostics| diagnostics.native_error())
            .is_some();
        if let Some(diagnostics) = self.diagnostics.take() {
            let now_ms = diagnostics.elapsed_ms();
            log::info!(
                "ScreenCaptureKit audio stopped: callbacks={}, frames={}, rejected={}, last_raw={}ms ago, last_pcm={}ms ago",
                diagnostics.callbacks.load(Ordering::Relaxed),
                diagnostics.frames.load(Ordering::Relaxed),
                diagnostics.rejected.load(Ordering::Relaxed),
                now_ms.saturating_sub(diagnostics.last_callback_ms.load(Ordering::Relaxed)),
                now_ms.saturating_sub(diagnostics.last_frame_ms.load(Ordering::Relaxed)),
            );
        }
        if let Some(stream) = self.stream.take() {
            // didStopWithError already ended the native stream. A second stop
            // fails with "already stopped" and must not block its replacement.
            if !native_stopped {
                stream.stop_capture().map_err(|e| {
                    AudioError::Capture(format!("Failed to stop ScreenCaptureKit capture: {e}"))
                })?;
            }
        }
        Ok(())
    }

    fn is_capturing(&self) -> bool {
        self.is_capturing
    }

    fn config(&self) -> AudioConfig {
        self.audio_config
    }
    fn supports_quiet_refresh(&self) -> bool {
        true
    }
    fn capture_starvation_ms(&self) -> Option<u64> {
        self.diagnostics
            .as_ref()
            .and_then(|diagnostics| diagnostics.starvation_ms(diagnostics.elapsed_ms()))
    }
    fn capture_error(&self) -> Option<AudioError> {
        self.diagnostics
            .as_ref()
            .and_then(|diagnostics| diagnostics.native_error())
            .map(native_capture_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_preserves_typed_native_denial_but_retries_lossy_start_failures() {
        assert!(matches!(
            capture_start_error(
                SCError::CaptureStartFailed("localized failure".to_string()),
                None
            ),
            AudioError::Capture(_)
        ));
        assert!(matches!(
            capture_start_error(
                SCError::CaptureStartFailed("localized failure".to_string()),
                Some(SCError::from(SCStreamErrorCode::UserDeclined))
            ),
            AudioError::AccessDenied(_)
        ));
        assert!(matches!(
            capture_start_error(
                SCError::InvalidConfiguration("bad config".to_string()),
                None
            ),
            AudioError::Configuration(_)
        ));
    }

    #[test]
    fn native_failure_is_retained_even_before_capture_cadence_arms() {
        let diagnostics = CaptureDiagnostics::new();
        let error = SCError::from(SCStreamErrorCode::SystemStoppedStream);
        diagnostics.note_native_error(error.clone());
        diagnostics.note_native_error(SCError::StreamError("secondary error".to_string()));
        assert_eq!(diagnostics.native_error(), Some(error));
        assert_eq!(diagnostics.starvation_ms(0), None);
        assert_eq!(CaptureDiagnostics::new().native_error(), None);
    }

    #[test]
    fn native_user_stop_and_permission_revocation_are_not_recoverable() {
        assert!(matches!(
            native_capture_error(SCError::from(SCStreamErrorCode::UserStopped)),
            AudioError::StoppedByUser(_)
        ));
        assert!(matches!(
            native_capture_error(SCError::from(SCStreamErrorCode::UserDeclined)),
            AudioError::AccessDenied(_)
        ));
        assert!(matches!(
            native_capture_error(SCError::from(SCStreamErrorCode::SystemStoppedStream)),
            AudioError::Capture(_)
        ));
        assert!(matches!(
            native_capture_error(SCError::StreamError("unknown native failure".to_string())),
            AudioError::Configuration(_)
        ));
    }

    #[test]
    fn native_liveness_arms_on_cadence_and_new_capture_must_rearm() {
        let diagnostics = CaptureDiagnostics::new();
        assert_eq!(diagnostics.starvation_ms(120_000), None);
        diagnostics.note_callback(0);
        diagnostics.frames.store(1, Ordering::Relaxed);
        // Widely spaced callbacks do not establish a healthy stream.
        diagnostics.note_callback(500);
        diagnostics.note_callback(1_000);
        assert_eq!(diagnostics.starvation_ms(30_000), None);
        for now_ms in (1_010..=2_000).step_by(10) {
            diagnostics.note_callback(now_ms);
        }
        assert_eq!(diagnostics.starvation_ms(32_000), Some(30_000));
        diagnostics.note_callback(32_001);
        assert_eq!(diagnostics.starvation_ms(32_001), Some(0));
        let restarted = CaptureDiagnostics::new();
        assert_eq!(restarted.starvation_ms(120_000), None);
    }

    #[test]
    fn changed_native_rate_resets_decoder_and_preserves_pcm_duration() {
        let mut pipeline = None;
        let mut format = NativeAudioFormat {
            sample_rate: 48_000,
            is_float: true,
            is_big_endian: false,
            bits_per_channel: 32,
        };
        for sample_rate in [48_000, 24_000] {
            format.sample_rate = sample_rate;
            assert!(ResamplePipeline::ensure_format(&mut pipeline, format).unwrap());
            let pipe = pipeline.as_mut().unwrap();
            pipe.native_mono
                .extend(std::iter::repeat(0.25).take(sample_rate as usize));
            let frames = pipe.drain_frames();
            // One native second must remain approximately one 16kHz second,
            // allowing the sinc resampler's startup delay and frame remainder.
            assert!(
                (30..=34).contains(&frames.len()),
                "{}Hz yielded {} frames",
                sample_rate,
                frames.len()
            );
            assert!(frames.iter().all(|frame| frame.len() == 480));
            assert!(frames
                .last()
                .unwrap()
                .iter()
                .all(|sample| (8_000..=8_400).contains(sample)));
        }
        pipeline.as_mut().unwrap().native_mono.push(0.125);
        let pending = pipeline.as_ref().unwrap().native_mono.len();
        assert!(!ResamplePipeline::ensure_format(&mut pipeline, format).unwrap());
        assert_eq!(pipeline.as_ref().unwrap().native_mono.len(), pending);
        format.bits_per_channel = 64;
        assert!(ResamplePipeline::ensure_format(&mut pipeline, format).is_err());
        assert_eq!(pipeline.as_ref().unwrap().native_mono.len(), pending);
    }
}

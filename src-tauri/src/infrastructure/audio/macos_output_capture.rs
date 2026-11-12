use async_trait::async_trait;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use screencapturekit::prelude::*;
use std::sync::{Arc, Mutex};

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
    audio_config: AudioConfig,
    is_capturing: bool,
}

impl MacosOutputAudioCapture {
    pub fn new() -> AudioResult<Self> {
        Ok(Self {
            stream: None,
            audio_config: AudioConfig::default(),
            is_capturing: false,
        })
    }
}

struct ResamplePipeline {
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
    fn new(
        from_sample_rate: u32,
        is_float: bool,
        is_big_endian: bool,
        bits_per_channel: u32,
    ) -> AudioResult<Self> {
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
                if aligned {
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

        let mut stream = SCStream::new(&filter, &config);
        let added = stream.add_output_handler(
            move |sample: CMSampleBuffer, _output: SCStreamOutputType| {
                let Some(fmt) = sample.format_description() else {
                    return;
                };
                if !fmt.is_audio() {
                    return;
                }

                let sample_rate = fmt
                    .audio_sample_rate()
                    .map(|v| v.round() as u32)
                    .unwrap_or(48_000);
                let bits = fmt.audio_bits_per_channel().unwrap_or(32);
                let is_float = fmt.audio_is_float();
                let is_be = fmt.audio_is_big_endian();

                let mut guard = match pipeline_for_cb.lock() {
                    Ok(g) => g,
                    Err(e) => {
                        log::error!("Audio pipeline mutex poisoned: {}", e);
                        return;
                    }
                };

                let pipe = guard.get_or_insert_with(|| {
                    match ResamplePipeline::new(sample_rate, is_float, is_be, bits) {
                        Ok(p) => p,
                        Err(e) => {
                            log::error!("Failed to init resample pipeline: {:?}", e);
                            // Fallback: still keep None to avoid spamming errors per frame.
                            return ResamplePipeline::new(48_000, true, false, 32)
                                .expect("fallback pipeline must be constructible");
                        }
                    }
                });

                // Decode audio bytes to native mono f32, then resample into fixed 16k frames.
                pipe.decode_and_push_native_mono(&sample);
                let frames = pipe.drain_frames();
                drop(guard);

                for frame in frames {
                    if frame.is_empty() {
                        continue;
                    }
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

        stream.start_capture().map_err(|e| {
            AudioError::Capture(format!("Failed to start ScreenCaptureKit capture: {e}"))
        })?;

        self.stream = Some(stream);
        self.is_capturing = true;

        Ok(())
    }

    async fn stop_capture(&mut self) -> AudioResult<()> {
        if !self.is_capturing {
            return Ok(());
        }

        if let Some(stream) = self.stream.take() {
            let _ = stream.stop_capture();
        }

        self.is_capturing = false;
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
}

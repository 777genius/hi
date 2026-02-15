use async_trait::async_trait;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig, SupportedStreamConfig};
use std::sync::{Arc, Mutex};

use crate::domain::{AudioCapture, AudioChunkCallback, AudioConfig, AudioError, AudioResult};
use crate::infrastructure::audio::speech_audio::{
    f32_to_i16, interleaved_to_mono_i16, Mono16kResampleState, TARGET_CHANNELS, TARGET_SAMPLE_RATE,
};

fn i32_to_i16(samples: &[i32]) -> Vec<i16> {
    // i32 full scale -> i16 full scale
    samples
        .iter()
        .map(|&s| {
            let v = (s as i64 / 65536).clamp(i16::MIN as i64, i16::MAX as i64);
            v as i16
        })
        .collect()
}

fn u16_to_i16(samples: &[u16]) -> Vec<i16> {
    samples.iter().map(|&s| (s as i32 - 32768) as i16).collect()
}

/// Windows system output (speaker) capture using CPAL WASAPI loopback.
///
/// Implementation detail:
/// - On Windows/WASAPI, calling `build_input_stream()` on an output device enables loopback mode.
/// - We capture the default output device by default, convert to mono i16 and resample to 16kHz.
pub struct WindowsOutputAudioCapture {
    device: Device,
    stream: Option<Stream>,
    native_config: SupportedStreamConfig,
    audio_config: AudioConfig,
    is_capturing: bool,
}

impl WindowsOutputAudioCapture {
    pub fn new() -> AudioResult<Self> {
        Self::with_device(None)
    }

    pub fn with_device(device_name: Option<String>) -> AudioResult<Self> {
        let host = cpal::default_host();

        let all_devices: Vec<String> = host
            .output_devices()
            .ok()
            .map(|devices| devices.filter_map(|d| d.name().ok()).collect())
            .unwrap_or_default();
        log::debug!("Available output devices: {:?}", all_devices);

        let device = if let Some(ref name) = device_name {
            log::info!("Looking for audio output device: {}", name);
            host.output_devices()
                .map_err(|e| {
                    AudioError::DeviceNotFound(format!("Failed to enumerate devices: {}", e))
                })?
                .find(|d| d.name().ok().as_ref() == Some(name))
                .ok_or_else(|| {
                    AudioError::DeviceNotFound(format!(
                        "Device '{}' not found. Available devices: {:?}",
                        name, all_devices
                    ))
                })?
        } else {
            log::info!("Using default audio output device");
            host.default_output_device()
                .ok_or_else(|| AudioError::DeviceNotFound("No output device available".to_string()))?
        };

        let selected_device_name = device.name().unwrap_or_else(|_| "Unknown".to_string());
        log::info!("Using audio output device (loopback): {}", selected_device_name);

        // Choose a config for `build_input_stream` (loopback).
        //
        // В cpal WASAPI:
        // - у render-устройства `supported_input_configs()/default_input_config()` возвращают пусто/ошибку,
        //   но `build_input_stream()` всё равно работает и включает loopback через флаг
        //   `AUDCLNT_STREAMFLAGS_LOOPBACK`.
        // - поэтому самый надёжный путь — использовать mix-format устройства, т.е. `default_output_config()`.
        //   Это минимизирует риск "тишины" из-за неудачного sample_rate/format.
        let native_config = if let Ok(cfg) = device.default_output_config() {
            cfg
        } else {
            let mut best: Option<SupportedStreamConfig> = None;

            if let Ok(mut supported) = device.supported_output_configs() {
                // Prefer f32 if present.
                best = supported
                    .find(|c| c.sample_format() == SampleFormat::F32)
                    .map(|c| c.with_max_sample_rate());
            }

            if best.is_none() {
                if let Ok(mut supported) = device.supported_output_configs() {
                    best = supported
                        .find(|c| c.sample_format() == SampleFormat::I16)
                        .map(|c| c.with_max_sample_rate());
                }
            }

            if best.is_none() {
                if let Ok(mut supported) = device.supported_output_configs() {
                    best = supported
                        .find(|c| c.sample_format() == SampleFormat::I32)
                        .map(|c| c.with_max_sample_rate());
                }
            }

            best.ok_or_else(|| AudioError::Configuration("No suitable audio config found".to_string()))?
        };

        log::info!(
            "Selected loopback config: {} Hz, {} channels, {:?} format",
            native_config.sample_rate().0,
            native_config.channels(),
            native_config.sample_format()
        );

        Ok(Self {
            device,
            stream: None,
            native_config,
            audio_config: AudioConfig::default(),
            is_capturing: false,
        })
    }
}

// SAFETY: cpal::Stream is not Send/Sync on all platforms, but this capture is only controlled
// via &mut self methods from the transcription service (single owner). The stream itself is never
// moved across threads after being created.
unsafe impl Send for WindowsOutputAudioCapture {}
unsafe impl Sync for WindowsOutputAudioCapture {}

#[async_trait]
impl AudioCapture for WindowsOutputAudioCapture {
    async fn initialize(&mut self, config: AudioConfig) -> AudioResult<()> {
        self.audio_config = config;
        log::info!("WindowsOutputAudioCapture initialized with config: {:?}", config);
        Ok(())
    }

    async fn start_capture(&mut self, on_chunk: AudioChunkCallback) -> AudioResult<()> {
        if self.is_capturing {
            return Err(AudioError::Capture("Already capturing audio".to_string()));
        }

        let native_sample_rate = self.native_config.sample_rate().0;
        let native_channels = self.native_config.channels() as usize;
        let sample_format = self.native_config.sample_format();

        log::info!(
            "Starting Windows loopback: {} Hz → {} Hz, {} channels → {} channel ({:?})",
            native_sample_rate,
            TARGET_SAMPLE_RATE,
            native_channels,
            TARGET_CHANNELS,
            sample_format
        );

        let processing_state: Arc<Mutex<Mono16kResampleState>> =
            Arc::new(Mutex::new(Mono16kResampleState::new(native_sample_rate)?));
        let state_clone = processing_state.clone();

        let stream_config: StreamConfig = self.native_config.clone().into();

        let stream = match sample_format {
            SampleFormat::F32 => self
                .device
                .build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        // 1) f32 → i16
                        let pcm = f32_to_i16(data);

                        // 2) downmix to mono if needed
                        let mono = if native_channels > 1 {
                            interleaved_to_mono_i16(&pcm, native_channels)
                        } else {
                            pcm
                        };

                        // 3) buffer + resample + emit
                        let mut state = match state_clone.lock() {
                            Ok(s) => s,
                            Err(e) => {
                                log::error!("Audio processing state poisoned: {}", e);
                                return;
                            }
                        };
                        state.push_mono_i16(&mono, &on_chunk);
                    },
                    |err| log::error!("Audio stream error: {}", err),
                    None,
                )
                .map_err(|e| AudioError::Capture(format!("Failed to build loopback stream: {}", e)))?,
            SampleFormat::I16 => self
                .device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        // 1) downmix to mono if needed
                        let mut state = match state_clone.lock() {
                            Ok(s) => s,
                            Err(e) => {
                                log::error!("Audio processing state poisoned: {}", e);
                                return;
                            }
                        };

                        if native_channels > 1 {
                            let mono = interleaved_to_mono_i16(data, native_channels);
                            state.push_mono_i16(&mono, &on_chunk);
                        } else {
                            state.push_mono_i16(data, &on_chunk);
                        }
                    },
                    |err| log::error!("Audio stream error: {}", err),
                    None,
                )
                .map_err(|e| AudioError::Capture(format!("Failed to build loopback stream: {}", e)))?,
            SampleFormat::I32 => self
                .device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i32], _: &cpal::InputCallbackInfo| {
                        let pcm = i32_to_i16(data);
                        let mono = if native_channels > 1 {
                            interleaved_to_mono_i16(&pcm, native_channels)
                        } else {
                            pcm
                        };

                        let mut state = match state_clone.lock() {
                            Ok(s) => s,
                            Err(e) => {
                                log::error!("Audio processing state poisoned: {}", e);
                                return;
                            }
                        };
                        state.push_mono_i16(&mono, &on_chunk);
                    },
                    |err| log::error!("Audio stream error: {}", err),
                    None,
                )
                .map_err(|e| AudioError::Capture(format!("Failed to build loopback stream: {}", e)))?,
            SampleFormat::U16 => self
                .device
                .build_input_stream(
                    &stream_config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let pcm = u16_to_i16(data);
                        let mono = if native_channels > 1 {
                            interleaved_to_mono_i16(&pcm, native_channels)
                        } else {
                            pcm
                        };

                        let mut state = match state_clone.lock() {
                            Ok(s) => s,
                            Err(e) => {
                                log::error!("Audio processing state poisoned: {}", e);
                                return;
                            }
                        };
                        state.push_mono_i16(&mono, &on_chunk);
                    },
                    |err| log::error!("Audio stream error: {}", err),
                    None,
                )
                .map_err(|e| AudioError::Capture(format!("Failed to build loopback stream: {}", e)))?,
            other => {
                return Err(AudioError::Configuration(format!(
                    "Unsupported sample format for loopback: {:?}",
                    other
                )));
            }
        };

        stream
            .play()
            .map_err(|e| AudioError::Capture(format!("Failed to start loopback stream: {}", e)))?;

        self.stream = Some(stream);
        self.is_capturing = true;
        log::info!("Windows loopback capture started successfully");
        Ok(())
    }

    async fn stop_capture(&mut self) -> AudioResult<()> {
        if !self.is_capturing {
            return Ok(());
        }

        if let Some(stream) = self.stream.take() {
            drop(stream);
        }

        self.is_capturing = false;
        log::info!("Windows loopback capture stopped");
        Ok(())
    }

    fn is_capturing(&self) -> bool {
        self.is_capturing
    }

    fn config(&self) -> AudioConfig {
        self.audio_config
    }
}


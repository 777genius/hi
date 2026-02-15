use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

use crate::domain::{AudioChunk, AudioChunkCallback, AudioError, AudioResult};

/// Target format for speech recognition and VAD.
pub const TARGET_SAMPLE_RATE: u32 = 16000;
pub const TARGET_CHANNELS: u16 = 1;

/// Fixed chunk size for rubato processing.
pub const RESAMPLER_CHUNK_SIZE: usize = 1024;

/// Resampling/buffering state for converting mono PCM to 16kHz mono i16 chunks.
pub struct Mono16kResampleState {
    input_buffer: Vec<i16>,
    resampler: Option<SincFixedIn<f32>>,
}

impl Mono16kResampleState {
    pub fn new(native_sample_rate: u32) -> AudioResult<Self> {
        let resampler = if native_sample_rate == TARGET_SAMPLE_RATE {
            None
        } else {
            Some(create_resampler(native_sample_rate, 1)?)
        };

        Ok(Self {
            input_buffer: Vec::with_capacity(RESAMPLER_CHUNK_SIZE * 2),
            resampler,
        })
    }

    pub fn push_mono_i16(&mut self, samples: &[i16], on_chunk: &AudioChunkCallback) {
        self.input_buffer.extend_from_slice(samples);

        while self.input_buffer.len() >= RESAMPLER_CHUNK_SIZE {
            let chunk: Vec<i16> = self.input_buffer.drain(..RESAMPLER_CHUNK_SIZE).collect();

            let final_samples = if let Some(ref mut resampler) = self.resampler {
                let float_chunk: Vec<f32> = chunk.iter().map(|&s| s as f32 / 32767.0).collect();
                let resampler_input = vec![float_chunk];

                match resampler.process(&resampler_input, None) {
                    Ok(output) => f32_to_i16(&output[0]),
                    Err(e) => {
                        log::error!("Resampling error: {}", e);
                        continue;
                    }
                }
            } else {
                chunk
            };

            on_chunk(AudioChunk::new(
                final_samples,
                TARGET_SAMPLE_RATE,
                TARGET_CHANNELS,
            ));
        }
    }
}

pub fn create_resampler(from_sample_rate: u32, channels: usize) -> AudioResult<SincFixedIn<f32>> {
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    SincFixedIn::<f32>::new(
        TARGET_SAMPLE_RATE as f64 / from_sample_rate as f64,
        2.0, // Max relative ratio change
        params,
        RESAMPLER_CHUNK_SIZE,
        channels,
    )
    .map_err(|e| AudioError::Internal(format!("Failed to create resampler: {}", e)))
}

#[inline]
pub fn f32_to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|&sample| {
            let clamped = sample.clamp(-1.0, 1.0);
            (clamped * 32767.0) as i16
        })
        .collect()
}

#[inline]
pub fn interleaved_to_mono_i16(samples: &[i16], channels: usize) -> Vec<i16> {
    if channels <= 1 {
        return samples.to_vec();
    }

    samples
        .chunks_exact(channels)
        .map(|frame| {
            let sum: i32 = frame.iter().map(|&s| s as i32).sum();
            (sum / channels as i32) as i16
        })
        .collect()
}


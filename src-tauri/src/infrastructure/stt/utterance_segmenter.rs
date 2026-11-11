//! Per-utterance endpointing for offline STT while the capture session stays open.
//! Independent instance per microphone / system-audio provider.
use std::collections::VecDeque;

use crate::domain::{AudioChunk, SttError, SttResult};
use crate::infrastructure::audio::{VadProcessor, VadResult};

const SAMPLE_RATE: usize = 16_000;
const FRAME_SAMPLES: usize = 480; // 30 ms
const FRAME_MS: usize = 30;
const SILENCE_MS: usize = 700;
const PRE_ROLL_MS: usize = 150;
const TAIL_MS: usize = 150;
const MAX_UTTERANCE_MS: usize = 20_000;
const MIN_VOICED_FRAMES: usize = 3; // reject clicks / extremely short noise
const PRE_ROLL_SAMPLES: usize = SAMPLE_RATE * PRE_ROLL_MS / 1000;
const TAIL_SAMPLES: usize = SAMPLE_RATE * TAIL_MS / 1000;
const MAX_UTTERANCE_SAMPLES: usize = SAMPLE_RATE * MAX_UTTERANCE_MS / 1000;
const SILENCE_FRAMES: usize = SILENCE_MS.div_ceil(FRAME_MS);

#[derive(Debug)]
pub struct Utterance {
    pub pcm: Vec<i16>,
    pub start_sample: u64,
    pub captured_at_ms: i64,
}

pub struct UtteranceSegmenter {
    vad: VadProcessor,
    pending_frame: Vec<i16>,
    pre_roll: VecDeque<i16>,
    active: Vec<i16>,
    sample_clock: u64,
    utterance_start: u64,
    voiced_frames: usize,
    quiet_frames: usize,
}

impl UtteranceSegmenter {
    pub fn new() -> SttResult<Self> {
        Ok(Self {
            vad: VadProcessor::new(Some(SILENCE_MS as u64), None)?,
            pending_frame: Vec::with_capacity(FRAME_SAMPLES * 2),
            pre_roll: VecDeque::with_capacity(PRE_ROLL_SAMPLES),
            active: Vec::with_capacity(SAMPLE_RATE * 4),
            sample_clock: 0,
            utterance_start: 0,
            voiced_frames: 0,
            quiet_frames: 0,
        })
    }

    /// Full utterances only. Never blocks on model inference or ends the recording.
    pub fn accept(&mut self, chunk: &AudioChunk) -> SttResult<Vec<Utterance>> {
        if chunk.sample_rate != SAMPLE_RATE as u32 || chunk.channels != 1 {
            return Err(SttError::Configuration(
                "Local Parakeet requires 16 kHz mono PCM16 audio".to_string(),
            ));
        }

        self.pending_frame.extend_from_slice(&chunk.data);
        let complete_frames = self.pending_frame.len() / FRAME_SAMPLES;
        let mut result = Vec::new();
        for n in 0..complete_frames {
            let from = n * FRAME_SAMPLES;
            let frame = self.pending_frame[from..from + FRAME_SAMPLES].to_vec();
            let state = self.vad.process_samples(&frame)?;
            if let Some(utterance) = self.accept_frame(
                &frame,
                matches!(state, VadResult::Speech),
            ) {
                result.push(utterance);
            }
        }
        if complete_frames > 0 {
            self.pending_frame.drain(..complete_frames * FRAME_SAMPLES);
        }
        Ok(result)
    }

    fn accept_frame(&mut self, frame: &[i16], voiced: bool) -> Option<Utterance> {
        let frame_start = self.sample_clock;
        self.sample_clock = self.sample_clock.saturating_add(frame.len() as u64);

        if self.active.is_empty() {
            if voiced {
                self.utterance_start = frame_start.saturating_sub(self.pre_roll.len() as u64);
                self.active.extend(self.pre_roll.drain(..));
                self.active.extend_from_slice(frame);
                self.voiced_frames = 1;
                self.quiet_frames = 0;
            } else {
                self.pre_roll.extend(frame.iter().copied());
                while self.pre_roll.len() > PRE_ROLL_SAMPLES {
                    self.pre_roll.pop_front();
                }
            }
            return None;
        }

        self.active.extend_from_slice(frame);
        if voiced {
            self.voiced_frames += 1;
            self.quiet_frames = 0;
        } else {
            self.quiet_frames += 1;
        }

        if self.quiet_frames >= SILENCE_FRAMES {
            return self.finish_utterance(true);
        }
        if self.active.len() >= MAX_UTTERANCE_SAMPLES {
            // Bounded memory if a speaker does not pause for a long time.
            return self.finish_utterance(false);
        }
        None
    }

    fn finish_utterance(&mut self, trim_silence: bool) -> Option<Utterance> {
        let mut pcm = std::mem::take(&mut self.active);
        let voiced_frames = std::mem::take(&mut self.voiced_frames);
        let quiet_frames = std::mem::take(&mut self.quiet_frames);
        self.pre_roll.clear();

        if voiced_frames < MIN_VOICED_FRAMES {
            return None;
        }
        if trim_silence {
            let silence_samples = quiet_frames * FRAME_SAMPLES;
            let remove = silence_samples.saturating_sub(TAIL_SAMPLES);
            if remove < pcm.len() {
                pcm.truncate(pcm.len() - remove);
            }
        }
        if pcm.is_empty() {
            return None;
        }

        Some(Utterance {
            pcm,
            start_sample: self.utterance_start,
            captured_at_ms: chrono::Utc::now().timestamp_millis(),
        })
    }

    /// Called when the full recording stops: finish the final incomplete phrase.
    pub fn finish(&mut self) -> Option<Utterance> {
        if !self.active.is_empty() {
            self.active.append(&mut self.pending_frame);
        } else {
            self.pending_frame.clear();
        }
        self.finish_utterance(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: [i16; FRAME_SAMPLES] = [800; FRAME_SAMPLES];
    const QUIET: [i16; FRAME_SAMPLES] = [0; FRAME_SAMPLES];

    #[test]
    fn silence_never_generates_an_utterance() {
        let mut s = UtteranceSegmenter::new().unwrap();
        for _ in 0..120 {
            assert!(s.accept_frame(&QUIET, false).is_none());
        }
        assert!(s.finish().is_none());
    }

    #[test]
    fn ends_at_720_ms_and_keeps_preroll_and_150_ms_tail() {
        let mut s = UtteranceSegmenter::new().unwrap();
        for _ in 0..5 {
            s.accept_frame(&QUIET, false);
        }
        for _ in 0..10 {
            s.accept_frame(&FRAME, true);
        }
        for _ in 0..SILENCE_FRAMES - 1 {
            assert!(s.accept_frame(&QUIET, false).is_none());
        }
        let u = s.accept_frame(&QUIET, false).expect("final at pause");
        assert_eq!(u.start_sample, 0);
        assert_eq!(u.pcm.len(), (5 + 10) * FRAME_SAMPLES + TAIL_SAMPLES);
        assert!(s.finish().is_none());
    }

    #[test]
    fn multiple_utterances_in_one_session() {
        let mut s = UtteranceSegmenter::new().unwrap();
        let mut finals = 0;
        for _ in 0..3 {
            for _ in 0..12 {
                s.accept_frame(&FRAME, true);
            }
            for _ in 0..SILENCE_FRAMES {
                finals += usize::from(s.accept_frame(&QUIET, false).is_some());
            }
        }
        assert_eq!(finals, 3);
    }

    #[test]
    fn flush_keeps_unfinished_final_phrase() {
        let mut s = UtteranceSegmenter::new().unwrap();
        for _ in 0..8 {
            s.accept_frame(&FRAME, true);
        }
        assert_eq!(s.finish().unwrap().pcm.len(), 8 * FRAME_SAMPLES);
        assert!(s.finish().is_none());
    }

    #[test]
    fn short_speech_is_not_committed() {
        let mut s = UtteranceSegmenter::new().unwrap();
        s.accept_frame(&FRAME, true);
        for _ in 0..SILENCE_FRAMES {
            assert!(s.accept_frame(&QUIET, false).is_none());
        }
    }

    #[test]
    fn rejects_wrong_audio_format() {
        let mut s = UtteranceSegmenter::new().unwrap();
        let bad = AudioChunk::new(vec![0; 480], 48_000, 1);
        assert!(s.accept(&bad).is_err());
    }

    #[test]
    fn partial_frames_are_flushed_at_stop() {
        let mut s = UtteranceSegmenter::new().unwrap();
        for _ in 0..5 {
            s.accept_frame(&FRAME, true);
        }
        s.pending_frame.extend_from_slice(&[1; 112]);
        assert_eq!(s.finish().unwrap().pcm.len(), 5 * FRAME_SAMPLES + 112);
    }
}

//! Offline Parakeet Ultra inference behind the existing STT provider contract.
//! A background worker decodes completed VAD utterances while audio capture runs.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::domain::{
    AudioChunk, ConnectionQualityCallback, ErrorCallback, SttConfig, SttError, SttProvider,
    SttResult, Transcription, TranscriptionCallback,
};
use super::utterance_segmenter::{Utterance, UtteranceSegmenter};

const MODEL_FILE: &str = "parakeet-ultra-Q8_0.gguf";
const JOB_QUEUE_CAPACITY: usize = 32;

/// Each provider instance owns a different loaded model handle: transcribe.cpp
/// v0.4.x permits only one active decode per loaded model.
pub struct ParakeetUltraProvider {
    model: Option<transcribe_cpp::Model>,
    segmenter: Option<UtteranceSegmenter>,
    job_tx: Option<mpsc::Sender<Utterance>>,
    worker: Option<tokio::task::JoinHandle<SttResult<()>>>,
    cancelled: Arc<AtomicBool>,
    recording: bool,
}

impl ParakeetUltraProvider {
    pub fn new() -> Self {
        Self {
            model: None,
            segmenter: None,
            job_tx: None,
            worker: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            recording: false,
        }
    }

    fn resolve_model_path(config: &SttConfig) -> SttResult<PathBuf> {
        let explicit = std::env::var("HACKINTERVIEW_PARAKEET_MODEL_PATH")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| config.model.clone().filter(|s| !s.trim().is_empty()));
        if let Some(value) = explicit {
            let path = PathBuf::from(value);
            return Self::require_file(path);
        }

        let home = dirs::home_dir().ok_or_else(|| {
            SttError::Configuration("Cannot locate home directory for local STT model".into())
        })?;
        // Handy may store a manually imported file in its app data directory.
        let handy = home
            .join("Library/Application Support/com.pais.handy/models")
            .join(MODEL_FILE);
        if handy.is_file() {
            return Ok(handy);
        }

        // Handy's curated GGUF downloads normally go to the shared HF cache.
        let hub = std::env::var_os("HF_HUB_CACHE")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HF_HOME")
                    .map(|p| PathBuf::from(p).join("hub"))
            })
            .unwrap_or_else(|| home.join(".cache/huggingface/hub"));
        let snapshots = hub
            .join("models--handy-computer--parakeet-ultra-gguf")
            .join("snapshots");
        if let Ok(entries) = std::fs::read_dir(snapshots) {
            for entry in entries.flatten() {
                let model_path = entry.path().join(MODEL_FILE);
                if model_path.is_file() {
                    return Ok(model_path);
                }
            }
        }

        Err(SttError::Configuration(format!(
            "Parakeet Ultra model not found. Download it in Handy or set \
             HACKINTERVIEW_PARAKEET_MODEL_PATH to the local {} file.",
            MODEL_FILE
        )))
    }

    fn require_file(path: PathBuf) -> SttResult<PathBuf> {
        if path.extension().and_then(|s| s.to_str()) != Some("gguf") {
            return Err(SttError::Configuration(
                "Parakeet Ultra model must be a local .gguf file".into(),
            ));
        }
        if !Path::new(&path).is_file() {
            return Err(SttError::Configuration(format!(
                "Local Parakeet model is not a file: {}",
                path.display()
            )));
        }
        Ok(path)
    }
}

impl Default for ParakeetUltraProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SttProvider for ParakeetUltraProvider {
    async fn initialize(&mut self, config: &SttConfig) -> SttResult<()> {
        if self.recording {
            return Err(SttError::Processing("Cannot change model during recording".into()));
        }
        let path = Self::resolve_model_path(config)?;
        let model = tokio::task::spawn_blocking(move || transcribe_cpp::Model::load(path))
            .await
            .map_err(|error| SttError::Internal(format!("Local model load task: {error}")))?
            .map_err(|error| SttError::Configuration(format!("Cannot load Parakeet: {error}")))?;
        self.model = Some(model);
        Ok(())
    }

    async fn start_stream(
        &mut self,
        _on_partial: TranscriptionCallback,
        on_final: TranscriptionCallback,
        on_error: ErrorCallback,
        on_connection_quality: ConnectionQualityCallback,
    ) -> SttResult<()> {
        if self.recording {
            return Err(SttError::Processing("Local STT already recording".into()));
        }
        let model = self.model.clone().ok_or_else(|| {
            SttError::Configuration("Parakeet model not initialized".into())
        })?;
        let segmenter = UtteranceSegmenter::new()?;
        self.cancelled = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::clone(&self.cancelled);
        let (tx, mut rx) = mpsc::channel::<Utterance>(JOB_QUEUE_CAPACITY);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<SttResult<()>>();

        let mut worker = tokio::task::spawn_blocking(move || -> SttResult<()> {
            // Validate model/session readiness before starting the audio capture.
            let mut session = match model.session() {
                Ok(session) => {
                    let _ = ready_tx.send(Ok(()));
                    session
                }
                Err(error) => {
                    let failure = SttError::Processing(
                        format!("Cannot start Parakeet session: {error}")
                    );
                    let _ = ready_tx.send(Err(failure.clone()));
                    return Err(failure);
                }
            };
            let opts = transcribe_cpp::RunOptions::default(); // automatic RU/EN/UK detection
            while let Some(job) = rx.blocking_recv() {
                if cancelled.load(Ordering::Acquire) {
                    break;
                }
                let samples = job.pcm.iter()
                    .map(|&sample| sample as f32 / 32768.0)
                    .collect::<Vec<_>>();
                let duration_s = samples.len() as f64 / 16_000.0;
                let started = std::time::Instant::now();
                match session.run(&samples, &opts) {
                    Ok(result) => {
                        log::debug!(
                            "Parakeet decoded {:.1}s in {}ms",
                            duration_s,
                            started.elapsed().as_millis(),
                        );
                        if cancelled.load(Ordering::Acquire) {
                            break;
                        }
                        let text = result.text.trim();
                        if !text.is_empty() {
                            let mut transcription =
                                Transcription::final_result(text.to_string())
                                    .with_timing(
                                        job.start_sample as f64 / 16_000.0,
                                        duration_s,
                                    );
                            transcription.language = result.language;
                            // Preserve capture chronology, not decoder completion time.
                            transcription.timestamp = job.captured_at_ms;
                            on_final(transcription);
                        }
                    }
                    Err(error) => {
                        if !cancelled.load(Ordering::Acquire) {
                            on_error(SttError::Processing(
                                format!("Parakeet utterance inference failed: {error}")
                            ));
                        }
                    }
                }
            }
            Ok(())
        });

        match tokio::time::timeout(std::time::Duration::from_secs(10), ready_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => {
                let _ = worker.await;
                return Err(error);
            }
            other => {
                worker.abort();
                return Err(SttError::Processing(
                    format!("Local Parakeet worker failed to become ready: {other:?}")
                ));
            }
        }

        self.segmenter = Some(segmenter);
        self.job_tx = Some(tx);
        self.worker = Some(worker);
        self.recording = true;
        on_connection_quality("Good".to_string(), None);
        Ok(())
    }

    async fn send_audio(&mut self, chunk: &AudioChunk) -> SttResult<()> {
        if !self.recording {
            return Err(SttError::Processing("Parakeet is not recording".into()));
        }
        let segmenter = self.segmenter.as_mut().ok_or_else(|| {
            SttError::Internal("Parakeet segmenter missing".into())
        })?;
        let jobs = segmenter.accept(chunk)?;
        if let Some(tx) = &self.job_tx {
            for job in jobs {
                tx.try_send(job).map_err(|error| {
                    SttError::Processing(format!(
                        "Local STT decode queue unavailable or full: {error}"
                    ))
                })?;
            }
        }
        Ok(())
    }

    async fn stop_stream(&mut self) -> SttResult<()> {
        if !self.recording {
            return Ok(());
        }
        self.recording = false;
        if let Some(tx) = self.job_tx.take() {
            if let Some(segment) = self.segmenter.take().and_then(|mut s| s.finish()) {
                tx.send(segment).await.map_err(|error| {
                    SttError::Processing(format!("Could not flush Parakeet tail: {error}"))
                })?;
            }
            drop(tx); // worker drains all queued utterances, then exits
        }
        if let Some(worker) = self.worker.take() {
            worker.await.map_err(|error| {
                SttError::Internal(format!("Parakeet worker join failed: {error}"))
            })??;
        }
        self.segmenter = None;
        Ok(())
    }

    async fn abort(&mut self) -> SttResult<()> {
        self.cancelled.store(true, Ordering::Release);
        self.recording = false;
        self.segmenter = None;
        self.job_tx.take();
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
        Ok(())
    }

    fn name(&self) -> &str {
        "parakeet-ultra-local"
    }

    fn is_online(&self) -> bool {
        false
    }
}

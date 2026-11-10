//! Offline Parakeet Ultra inference behind the existing STT provider contract.
//! A background worker decodes completed VAD utterances while audio capture runs.
use std::io::Read;
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};
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
/// Handy catalog's pinned Q8_0 model at revision 39eeb55181f0d354fd934f06e92fd8d5037fed8e.
const MODEL_SHA256: &str = "007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59";
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

    fn verify_model_integrity(path: &Path) -> SttResult<()> {
        let mut file = std::fs::File::open(path).map_err(|error| {
            SttError::Configuration(format!("Cannot read local STT model: {error}"))
        })?;
        let metadata = file.metadata().map_err(|error| {
            SttError::Configuration(format!("Cannot stat local STT model: {error}"))
        })?;
        if metadata.len() != 740_363_168 {
            return Err(SttError::Configuration(
                "Parakeet Ultra Q8 model size differs from pinned catalog; redownload model".into(),
            ));
        }
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 256 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|error| {
                SttError::Configuration(format!("Model checksum read failed: {error}"))
            })?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        let actual = format!("{:x}", digest.finalize());
        if actual != MODEL_SHA256 {
            return Err(SttError::Configuration(
                "Parakeet Ultra Q8 checksum mismatch; refusing unverified model".into(),
            ));
        }
        Ok(())
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
        let model = tokio::task::spawn_blocking(move || -> SttResult<_> {
            Self::verify_model_integrity(&path)?;
            transcribe_cpp::Model::load(path).map_err(|error| {
                SttError::Configuration(format!("Cannot load Parakeet Ultra Q8: {error}"))
            })
        })
        .await
        .map_err(|error| SttError::Internal(format!("Local model load task: {error}")))??;
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
        if let Some(mut worker) = self.worker.take() {
            match tokio::time::timeout(
                std::time::Duration::from_secs(10),
                &mut worker,
            ).await {
                Ok(Ok(result)) => result?,
                Ok(Err(error)) => {
                    return Err(SttError::Internal(
                        format!("Parakeet worker join failed: {error}")
                    ));
                }
                Err(_) => {
                    self.cancelled.store(true, Ordering::Release);
                    worker.abort();
                    return Err(SttError::Processing(
                        "Local Parakeet did not finish decoding within 10 seconds".into()
                    ));
                }
            }
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


#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use crate::domain::SttProviderType;

    /// Real ASR E2E: run ONLY with two distinct 16 kHz mono PCM16 fixtures and
    /// a pinned Parakeet Ultra Q8 model. The two audio sources decode concurrently.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires HACKINTERVIEW_PARAKEET_MODEL_PATH + LOCAL_STT_SYSTEM_PCM + LOCAL_STT_MIC_PCM"]
    async fn e2e_local_parakeet_two_sources() {
        let model = std::env::var("HACKINTERVIEW_PARAKEET_MODEL_PATH")
            .expect("model path required");
        let system_pcm = std::fs::read(
            std::env::var("LOCAL_STT_SYSTEM_PCM").expect("system fixture path required")
        ).expect("system fixture");
        let mic_pcm = std::fs::read(
            std::env::var("LOCAL_STT_MIC_PCM").expect("mic fixture path required")
        ).expect("mic fixture");
        let mut system = ParakeetUltraProvider::new();
        let mut microphone = ParakeetUltraProvider::new();
        let mut config = SttConfig::new(SttProviderType::ParakeetUltra);
        config.model = Some(model);
        let (a,b) = tokio::join!(system.initialize(&config), microphone.initialize(&config));
        a.unwrap();
        b.unwrap();

        let system_out = Arc::new(Mutex::new(Vec::<String>::new()));
        let mic_out = Arc::new(Mutex::new(Vec::<String>::new()));
        let system_errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let mic_errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let to_final = |out: Arc<Mutex<Vec<String>>>| -> TranscriptionCallback {
            Arc::new(move |final_text| out.lock().unwrap().push(final_text.text))
        };
        let to_error = |out: Arc<Mutex<Vec<String>>>| -> ErrorCallback {
            Arc::new(move |error| out.lock().unwrap().push(error.to_string()))
        };
        let quality: ConnectionQualityCallback = Arc::new(|_, _| {});

        let (a,b) = tokio::join!(
            system.start_stream(
                Arc::new(|_| {}),
                to_final(Arc::clone(&system_out)),
                to_error(Arc::clone(&system_errors)),
                Arc::clone(&quality),
            ),
            microphone.start_stream(
                Arc::new(|_| {}),
                to_final(Arc::clone(&mic_out)),
                to_error(Arc::clone(&mic_errors)),
                quality,
            )
        );
        a.unwrap();
        b.unwrap();
        async fn play(provider: &mut ParakeetUltraProvider, pcm: &[u8]) -> SttResult<()> {
            let clip = pcm.chunks_exact(2)
                .map(|x| i16::from_le_bytes([x[0],x[1]]))
                .collect::<Vec<_>>();
            for frame in clip.chunks(480) {
                provider.send_audio(&AudioChunk::new(frame.to_vec(),16_000,1)).await?;
                tokio::task::yield_now().await;
            }
            for _ in 0..30 { // 900 ms silence, enough to commit the last utterance.
                provider.send_audio(&AudioChunk::new(vec![0;480],16_000,1)).await?;
            }
            Ok::<(),SttError>(())
        };
        let started = std::time::Instant::now();
        let (a,b) = tokio::join!(play(&mut system,&system_pcm),play(&mut microphone,&mic_pcm));
        a.unwrap();
        b.unwrap();
        let (a,b) = tokio::join!(system.stop_stream(),microphone.stop_stream());
        a.unwrap();
        b.unwrap();
        let a = system_out.lock().unwrap().clone();
        let b = mic_out.lock().unwrap().clone();
        assert!(system_errors.lock().unwrap().is_empty(), "system errors");
        assert!(mic_errors.lock().unwrap().is_empty(), "mic errors");
        assert!(!a.is_empty(), "system audio produced no final transcription");
        assert!(!b.is_empty(), "microphone produced no final transcription");
        let system_text=a.join(" ").to_lowercase();
        let mic_text=b.join(" ").to_lowercase();
        assert!(system_text.contains("fox") || system_text.contains("quick"),
            "unexpected system transcription: {system_text}");
        assert!(mic_text.contains("answer") || mic_text.contains("question"),
            "unexpected mic transcription: {mic_text}");
        assert!(!mic_text.contains("quick brown fox"), "audio channels mixed");
        println!("Real dual-source Parakeet E2E {:?} system={system_text:?} mic={mic_text:?}",
            started.elapsed());
    }
}

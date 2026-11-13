//! Offline local-model STT behind the existing provider contract.
//! One pipeline (VAD utterances -> background decode worker) serves several GGUF
//! models; `LocalModel` describes the weights and per-model decode options.
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::domain::{
    AudioChunk, ConnectionQualityCallback, ErrorCallback, SttConfig, SttError, SttProvider,
    SttProviderType, SttResult, Transcription, TranscriptionCallback,
};
use super::utterance_segmenter::{Utterance, UtteranceSegmenter};
use super::local_glossary::LocalGlossary;

const JOB_QUEUE_CAPACITY: usize = 32;
const STOP_TAIL_SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
// The first inference may lazily compile Metal shaders or fall back to CPU on
// virtualized macOS runners. A 10s Stop timeout lost valid final utterances.
// Keep a finite deadline, but allow genuine ongoing local decode to drain.
const STOP_DECODE_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Whisper truncates vocabulary + prompt at ~223 tokens; stay well below that
/// even for Cyrillic-heavy terms (~2 chars per token).
const WHISPER_VOCABULARY_MAX_CHARS: usize = 400;
/// Short Whisper outputs on near-silence that are known hallucinations.
const WHISPER_HALLUCINATIONS: &[&str] = &[
    "thank you for watching",
    "thanks for watching",
    "you",
    "спасибо за просмотр",
    "продолжение следует",
    "дякую за перегляд",
];
const WHISPER_HALLUCINATION_MAX_SECONDS: f64 = 2.5;

/// Weights + decode behaviour of one local model. Everything model-specific
/// lives here so adding a model is one enum arm, not another provider copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalModel {
    ParakeetUltra,
    WhisperLargeV3,
}

impl LocalModel {
    pub fn for_provider(provider: SttProviderType) -> Option<Self> {
        match provider {
            SttProviderType::ParakeetUltra => Some(Self::ParakeetUltra),
            SttProviderType::WhisperLargeV3 => Some(Self::WhisperLargeV3),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::ParakeetUltra => "Parakeet Ultra Q8",
            Self::WhisperLargeV3 => "Whisper Large-v3 Q8",
        }
    }

    fn provider_name(self) -> &'static str {
        match self {
            Self::ParakeetUltra => "parakeet-ultra-local",
            Self::WhisperLargeV3 => "whisper-large-v3-local",
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            Self::ParakeetUltra => "parakeet-ultra-Q8_0.gguf",
            Self::WhisperLargeV3 => "whisper-large-v3-Q8_0.gguf",
        }
    }

    fn hf_repo(self) -> &'static str {
        match self {
            Self::ParakeetUltra => "handy-computer/parakeet-ultra-gguf",
            Self::WhisperLargeV3 => "handy-computer/whisper-large-v3-gguf",
        }
    }

    fn path_env(self) -> &'static str {
        match self {
            Self::ParakeetUltra => "HACKINTERVIEW_PARAKEET_MODEL_PATH",
            Self::WhisperLargeV3 => "HACKINTERVIEW_WHISPER_MODEL_PATH",
        }
    }

    /// Pinned catalog size in bytes (cheap first check before hashing).
    fn size_bytes(self) -> u64 {
        match self {
            Self::ParakeetUltra => 740_363_168,
            Self::WhisperLargeV3 => 1_668_741_440,
        }
    }

    /// Pinned Handy catalog revision: parakeet 39eeb55181f0d354fd934f06e92fd8d5037fed8e,
    /// whisper 274ad1d1cf680b7ee53cc70f78461394cd3a344b.
    fn sha256(self) -> &'static str {
        match self {
            Self::ParakeetUltra => "007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59",
            Self::WhisperLargeV3 => "2fa1a5f179f8a511a53e2108db270aa4af3ce08cd976af4180e2854666bb4ba3",
        }
    }

    /// Whisper re-decodes a zero-padded 30 s window (~1 s per call), so live
    /// previews would only delay the final phrase; Parakeet previews cost ~0.1 s.
    fn emits_previews(self) -> bool {
        matches!(self, Self::ParakeetUltra)
    }

    fn run_options(self, glossary: &LocalGlossary) -> transcribe_cpp::RunOptions {
        match self {
            // Automatic RU/EN/UK detection, post-corrected by the glossary.
            Self::ParakeetUltra => transcribe_cpp::RunOptions::default(),
            Self::WhisperLargeV3 => transcribe_cpp::RunOptions {
                vocabulary: glossary.vocabulary(WHISPER_VOCABULARY_MAX_CHARS),
                family: Some(transcribe_cpp::RunExtension::Whisper(
                    transcribe_cpp::WhisperRunOptions {
                        // Single greedy pass: the default temperature fallback
                        // keeps a hallucinated last tier when all tiers fail.
                        temperature_inc: Some(0.0),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            },
        }
    }

    /// True when `text` is a known Whisper hallucination: punctuation-only
    /// output, or a stock phrase ("Thank you for watching") on a short clip.
    fn is_hallucination(self, text: &str, duration_s: f64) -> bool {
        if self != Self::WhisperLargeV3 {
            return false;
        }
        let normalized = text
            .trim()
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase();
        normalized.is_empty()
            || (duration_s <= WHISPER_HALLUCINATION_MAX_SECONDS
                && WHISPER_HALLUCINATIONS.contains(&normalized.as_str()))
    }

    /// Finds the model file: explicit path (env var, then config), Handy's
    /// app data, then the shared Hugging Face cache.
    pub fn resolve_path(self, config: &SttConfig) -> SttResult<PathBuf> {
        let explicit = std::env::var(self.path_env())
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| config.model.clone().filter(|s| !s.trim().is_empty()));
        if let Some(value) = explicit {
            return self.require_file(PathBuf::from(value));
        }

        let home = dirs::home_dir().ok_or_else(|| {
            SttError::Configuration("Cannot locate home directory for local STT model".into())
        })?;
        // Handy may store a manually imported file in its app data directory.
        let handy = home
            .join("Library/Application Support/com.pais.handy/models")
            .join(self.file_name());
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
            .join(format!("models--{}", self.hf_repo().replace('/', "--")))
            .join("snapshots");
        if let Ok(entries) = std::fs::read_dir(snapshots) {
            for entry in entries.flatten() {
                let model_path = entry.path().join(self.file_name());
                if model_path.is_file() {
                    return Ok(model_path);
                }
            }
        }

        Err(SttError::Configuration(format!(
            "{} model not found. Run `hf download {} {}` (or download it in Handy), \
             or set {} to the local file.",
            self.label(),
            self.hf_repo(),
            self.file_name(),
            self.path_env(),
        )))
    }

    fn require_file(self, path: PathBuf) -> SttResult<PathBuf> {
        if path.extension().and_then(|s| s.to_str()) != Some("gguf") {
            return Err(SttError::Configuration(format!(
                "{} model must be a local .gguf file",
                self.label()
            )));
        }
        if !Path::new(&path).is_file() {
            return Err(SttError::Configuration(format!(
                "Local {} model is not a file: {}",
                self.label(),
                path.display()
            )));
        }
        Ok(path)
    }

    /// Size + SHA-256 against the pinned catalog. A successful check is cached
    /// per (path, mtime) so the second audio source does not hash the file again.
    fn verify_integrity(self, path: &Path) -> SttResult<()> {
        static VERIFIED: OnceLock<Mutex<HashSet<(PathBuf, u64, SystemTime)>>> = OnceLock::new();
        let mut file = std::fs::File::open(path).map_err(|error| {
            SttError::Configuration(format!("Cannot read local STT model: {error}"))
        })?;
        let metadata = file.metadata().map_err(|error| {
            SttError::Configuration(format!("Cannot stat local STT model: {error}"))
        })?;
        if metadata.len() != self.size_bytes() {
            return Err(SttError::Configuration(format!(
                "{} model size differs from pinned catalog; redownload model",
                self.label()
            )));
        }
        let key = (
            path.to_path_buf(),
            metadata.len(),
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        );
        let verified = VERIFIED.get_or_init(Default::default);
        if verified.lock().map(|set| set.contains(&key)).unwrap_or(false) {
            return Ok(());
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
        if actual != self.sha256() {
            return Err(SttError::Configuration(format!(
                "{} checksum mismatch; refusing unverified model",
                self.label()
            )));
        }
        if let Ok(mut set) = verified.lock() {
            set.insert(key);
        }
        Ok(())
    }
}

/// Fails fast (without loading weights) when the selected local model is missing.
pub fn ensure_local_model_present(config: &SttConfig) -> SttResult<()> {
    match LocalModel::for_provider(config.provider) {
        Some(model) => model.resolve_path(config).map(|_| ()),
        None => Ok(()),
    }
}

async fn enqueue_final_tail(
    tx: &mpsc::Sender<Utterance>,
    segment: Utterance,
    max_wait: std::time::Duration,
) -> SttResult<()> {
    match tokio::time::timeout(max_wait, tx.send(segment)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(SttError::Processing(format!(
            "Could not flush local STT tail: {error}"
        ))),
        Err(_) => Err(SttError::Processing(
            "Timed out flushing local STT tail: decode queue is not draining".into(),
        )),
    }
}


/// Each provider instance owns a different loaded model handle: transcribe.cpp
/// v0.4.x permits only one active decode per loaded model.
pub struct LocalSttProvider {
    kind: LocalModel,
    model: Option<transcribe_cpp::Model>,
    segmenter: Option<UtteranceSegmenter>,
    job_tx: Option<mpsc::Sender<Utterance>>,
    worker: Option<tokio::task::JoinHandle<SttResult<()>>>,
    cancelled: Arc<AtomicBool>,
    recording: bool,
}

impl LocalSttProvider {
    pub fn new(kind: LocalModel) -> Self {
        Self {
            kind,
            model: None,
            segmenter: None,
            job_tx: None,
            worker: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            recording: false,
        }
    }
}

#[async_trait]
impl SttProvider for LocalSttProvider {
    async fn initialize(&mut self, config: &SttConfig) -> SttResult<()> {
        if self.recording {
            return Err(SttError::Processing("Cannot change model during recording".into()));
        }
        let kind = self.kind;
        let path = kind.resolve_path(config)?;
        let model = tokio::task::spawn_blocking(move || -> SttResult<_> {
            kind.verify_integrity(&path)?;
            transcribe_cpp::Model::load(path).map_err(|error| {
                SttError::Configuration(format!("Cannot load {}: {error}", kind.label()))
            })
        })
        .await
        .map_err(|error| SttError::Internal(format!("Local model load task: {error}")))??;
        self.model = Some(model);
        Ok(())
    }

    async fn start_stream(
        &mut self,
        on_partial: TranscriptionCallback,
        on_final: TranscriptionCallback,
        on_error: ErrorCallback,
        on_connection_quality: ConnectionQualityCallback,
    ) -> SttResult<()> {
        if self.recording {
            return Err(SttError::Processing("Local STT already recording".into()));
        }
        let model = self.model.clone().ok_or_else(|| {
            SttError::Configuration("Local STT model not initialized".into())
        })?;
        let kind = self.kind;
        let segmenter = UtteranceSegmenter::new()?;
        self.cancelled = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::clone(&self.cancelled);
        let (tx, mut rx) = mpsc::channel::<Utterance>(JOB_QUEUE_CAPACITY);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<SttResult<()>>();

        let worker = tokio::task::spawn_blocking(move || -> SttResult<()> {
            // Validate model/session readiness before starting the audio capture.
            let mut session = match model.session() {
                Ok(session) => {
                    let _ = ready_tx.send(Ok(()));
                    session
                }
                Err(error) => {
                    let failure = SttError::Processing(
                        format!("Cannot start {} session: {error}", kind.label())
                    );
                    let _ = ready_tx.send(Err(failure.clone()));
                    return Err(failure);
                }
            };
            let glossary = LocalGlossary::load();
            let opts = kind.run_options(&glossary);
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
                            "{} decoded {:.1}s in {}ms",
                            kind.label(),
                            duration_s,
                            started.elapsed().as_millis(),
                        );
                        if cancelled.load(Ordering::Acquire) {
                            break;
                        }
                        let text = result.text.trim();
                        if kind.is_hallucination(text, duration_s) {
                            log::debug!("Dropped {} silence hallucination: {text:?}", kind.label());
                        } else if !text.is_empty() {
                            let corrected = glossary.correct(text);
                            let mut transcription = if job.is_final {
                                Transcription::final_result(corrected)
                            } else {
                                Transcription::partial(corrected)
                            }
                            .with_timing(job.start_sample as f64 / 16_000.0, duration_s);
                            transcription.language = result.language;
                            // Preserve capture chronology, not decoder completion time.
                            transcription.timestamp = job.captured_at_ms;
                            if job.is_final {
                                on_final(transcription);
                            } else {
                                on_partial(transcription);
                            }
                        }
                    }
                    Err(error) => {
                        if cancelled.load(Ordering::Acquire) {
                            break;
                        }
                        let failure = SttError::Processing(
                            format!("{} utterance inference failed: {error}", kind.label())
                        );
                        on_error(failure.clone());
                        // Do not return success from Stop after losing a decoded phrase.
                        return Err(failure);
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
                    format!("Local {} worker failed to become ready: {other:?}", kind.label())
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
            return Err(SttError::Processing("Local STT is not recording".into()));
        }
        let segmenter = self.segmenter.as_mut().ok_or_else(|| {
            SttError::Internal("Local STT segmenter missing".into())
        })?;
        let emits_previews = self.kind.emits_previews();
        let jobs = segmenter.accept(chunk)?;
        if let Some(tx) = &self.job_tx {
            for job in jobs {
                // A preview is superseded by the next preview or final result.
                // Keep the decode queue available for final utterances when the
                // model is slower than real time on a busy machine.
                if !job.is_final && (!emits_previews || tx.capacity() < JOB_QUEUE_CAPACITY) {
                    continue;
                }
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
        let mut tail_error = None;
        if let Some(tx) = self.job_tx.take() {
            if let Some(segment) = self.segmenter.take().and_then(|mut s| s.finish()) {
                if let Err(error) = enqueue_final_tail(&tx, segment, STOP_TAIL_SEND_TIMEOUT).await {
                    // Never keep Stop blocked behind a stalled decode worker.
                    // The caller must see the lost-tail error, not a clean Stop.
                    self.cancelled.store(true, Ordering::Release);
                    tail_error = Some(error);
                }
            }
            drop(tx); // worker drains queued utterances or notices cancellation
        }
        if let Some(mut worker) = self.worker.take() {
            match tokio::time::timeout(
                STOP_DECODE_DRAIN_TIMEOUT,
                &mut worker,
            ).await {
                Ok(Ok(result)) => result?,
                Ok(Err(error)) => {
                    return Err(SttError::Internal(
                        format!("Local STT worker join failed: {error}")
                    ));
                }
                Err(_) => {
                    self.cancelled.store(true, Ordering::Release);
                    worker.abort();
                    return Err(SttError::Processing(
                        format!("Local {} did not finish draining within 30 seconds", self.kind.label())
                    ));
                }
            }
        }
        self.segmenter = None;
        if let Some(error) = tail_error {
            return Err(error);
        }
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

    // Local pause is an utterance flush, not a model unload. The existing
    // TranscriptionService TTL releases this provider after an idle interval.
    async fn pause_stream(&mut self) -> SttResult<()> {
        self.stop_stream().await
    }

    async fn resume_stream(
        &mut self,
        on_partial: TranscriptionCallback,
        on_final: TranscriptionCallback,
        on_error: ErrorCallback,
        on_connection_quality: ConnectionQualityCallback,
    ) -> SttResult<()> {
        if self.model.is_none() {
            return Err(SttError::Configuration(
                format!("Cannot resume unloaded {} model", self.kind.label())
            ));
        }
        self.start_stream(on_partial, on_final, on_error, on_connection_quality).await
    }

    fn supports_keep_alive(&self) -> bool {
        true
    }

    fn is_connection_alive(&self) -> bool {
        self.model.is_some() && !self.recording && self.worker.is_none()
    }

    fn name(&self) -> &str {
        self.kind.provider_name()
    }

    fn supports_idle_model_reuse(&self) -> bool {
        self.model.is_some() && !self.recording && self.worker.is_none()
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

    #[tokio::test]
    async fn stop_tail_send_fails_boundedly_instead_of_hanging_when_decode_queue_stalls() {
        let (tx, _rx) = mpsc::channel::<Utterance>(1);
        let make_utterance = || Utterance {
            pcm: vec![1; 480],
            start_sample: 0,
            captured_at_ms: 0,
            is_final: true,
        };
        tx.try_send(make_utterance()).expect("fill bounded queue");

        let failure = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            enqueue_final_tail(
                &tx,
                make_utterance(),
                std::time::Duration::from_millis(30),
            ),
        )
        .await
        .expect("Stop must never hang on the full queue")
        .expect_err("full and unconsumed queue must report failure");
        assert!(
            failure.to_string().contains("Timed out flushing local STT tail"),
            "unexpected error: {failure}"
        );
    }

    #[test]
    fn models_have_distinct_pinned_weights_and_discovery_settings() {
        let (p, w) = (LocalModel::ParakeetUltra, LocalModel::WhisperLargeV3);
        assert_ne!(p.file_name(), w.file_name());
        assert_ne!(p.sha256(), w.sha256());
        assert_ne!(p.path_env(), w.path_env());
        assert_eq!(p.sha256().len(), 64);
        assert_eq!(w.sha256().len(), 64);
        assert_eq!(LocalModel::for_provider(SttProviderType::WhisperLargeV3), Some(w));
        assert_eq!(LocalModel::for_provider(SttProviderType::Backend), None);
        assert!(p.emits_previews() && !w.emits_previews());
    }

    #[test]
    fn explicit_model_path_must_be_an_existing_gguf_file() {
        let mut config = SttConfig::new(SttProviderType::WhisperLargeV3);
        config.model = Some("/definitely/missing/whisper.bin".into());
        // The env override is not set in unit tests, so the config path is used.
        if std::env::var(LocalModel::WhisperLargeV3.path_env()).is_err() {
            let error = LocalModel::WhisperLargeV3.resolve_path(&config).unwrap_err();
            assert!(error.to_string().contains(".gguf"), "{error}");
        }
    }

    #[test]
    fn whisper_hallucination_guard_drops_stock_phrases_only_on_short_clips() {
        let w = LocalModel::WhisperLargeV3;
        assert!(w.is_hallucination("Thank you for watching!", 1.2));
        assert!(w.is_hallucination("you", 0.8));
        assert!(w.is_hallucination(".", 30.0), "punctuation-only is never speech");
        // A real long phrase or a real short answer must survive.
        assert!(!w.is_hallucination("Thank you for watching the demo, any questions?", 4.0));
        assert!(!w.is_hallucination("Thank you for watching!", 6.0));
        assert!(!w.is_hallucination("Да, использую Redis", 1.2));
        // Parakeet has no such failure mode and is never filtered.
        assert!(!LocalModel::ParakeetUltra.is_hallucination("you", 0.5));
    }

    /// Real ASR E2E: run ONLY with two distinct 16 kHz mono PCM16 fixtures and
    /// a pinned local model. `LOCAL_STT_MODEL=parakeet|whisper` (default parakeet)
    /// picks the provider; the model file is auto-discovered or set via the
    /// per-model HACKINTERVIEW_*_MODEL_PATH variable. Both audio sources decode concurrently.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires LOCAL_STT_SYSTEM_PCM + LOCAL_STT_MIC_PCM + LOCAL_STT_EN_PCM and a downloaded model"]
    async fn e2e_local_stt_two_sources() {
        let provider_type = match std::env::var("LOCAL_STT_MODEL").as_deref() {
            Ok("whisper") => SttProviderType::WhisperLargeV3,
            _ => SttProviderType::ParakeetUltra,
        };
        let kind = LocalModel::for_provider(provider_type).unwrap();
        let system_pcm = std::fs::read(
            std::env::var("LOCAL_STT_SYSTEM_PCM").expect("system fixture path required")
        ).expect("system fixture");
        let mic_pcm = std::fs::read(
            std::env::var("LOCAL_STT_MIC_PCM").expect("mic fixture path required")
        ).expect("mic fixture");
        let en_pcm = std::fs::read(
            std::env::var("LOCAL_STT_EN_PCM").expect("english fixture path required")
        ).expect("english fixture");
        let mut system = LocalSttProvider::new(kind);
        let mut microphone = LocalSttProvider::new(kind);
        let config = SttConfig::new(provider_type);
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
        async fn play(provider: &mut LocalSttProvider, pcm: &[u8]) -> SttResult<()> {
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
        }
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
        // Real FLEURS RU and UK speech from the transcribe.cpp fixtures.
        let system_expected = std::env::var("LOCAL_STT_EXPECT_SYSTEM").ok();
        let mic_expected = std::env::var("LOCAL_STT_EXPECT_MIC").ok();
        assert!(system_expected.as_deref().map_or_else(
            || system_text.contains("добавил") || system_text.contains("следует"),
            |term| system_text.contains(&term.to_lowercase()),
        ),
            "unexpected RU system transcription: {system_text}");
        assert!(mic_expected.as_deref().map_or_else(
            || mic_text.contains("управління") || mic_text.contains("маріанськ") || mic_text.contains("україн"),
            |term| mic_text.contains(&term.to_lowercase()),
        ),
            "unexpected UK mic transcription: {mic_text}");
        assert!(!mic_text.contains("он добавил"), "audio channels mixed");

        // End-to-end continuation: the very same final strings must enter the
        // canonical companion timeline and be included in an LLM-ready context.
        let state = crate::presentation::AppState::default();
        let session_id = 53_u64;
        state.active_transcription_session_id.store(
            session_id, std::sync::atomic::Ordering::Relaxed,
        );
        crate::presentation::companion_timeline::update_system_audio_level(&state, 0.02);
        crate::presentation::companion_timeline::update_microphone_audio_level(&state, 0.75);
        let mic_final = crate::presentation::events::FinalTranscriptionPayload::from_transcription(
            Transcription::final_result(mic_text.clone()), session_id, "microphone",
        );
        crate::presentation::companion_timeline::on_microphone_final(&state, &mic_final).await;
        crate::presentation::companion_timeline::append_system_final(
            &state, session_id, &Transcription::final_result(system_text.clone()),
        ).await;
        let (llm_context, evidence) =
            crate::presentation::companion_timeline::build_context_text_and_memory_evidence(
                &state, false,
            ).await;
        assert!(llm_context.contains("ОС: "), "system channel missing: {llm_context}");
        assert!(llm_context.contains("МИКРОФОН: "), "mic channel missing: {llm_context}");
        assert!(evidence.recent_timeline.iter().any(|item|
            item.label.as_deref() == Some("system_audio") && item.text == system_text
        ), "system final missing from evidence");
        assert!(evidence.recent_timeline.iter().any(|item|
            item.label.as_deref() == Some("microphone") && item.text == mic_text
        ), "microphone final missing from evidence");

        // Model remains loaded: re-start the same provider for English audio.
        let english_out = Arc::new(Mutex::new(Vec::<String>::new()));
        system.start_stream(
            Arc::new(|_| {}),
            to_final(Arc::clone(&english_out)),
            to_error(Arc::clone(&system_errors)),
            Arc::new(|_, _| {}),
        ).await.unwrap();
        play(&mut system, &en_pcm).await.unwrap();
        system.stop_stream().await.unwrap();
        let english_text = english_out.lock().unwrap().join(" ");
        assert!(english_text.len() > 20 && english_text.chars().any(|c| c.is_ascii_alphabetic()),
            "unexpected EN transcription: {english_text}");
        assert!(system_errors.lock().unwrap().is_empty(), "English errors");
        println!(
            "Real RU/UK dual-source + EN restart E2E [{}] {:?} ru={system_text:?} uk={mic_text:?} en={english_text:?}",
            kind.label(), started.elapsed()
        );
    }
}

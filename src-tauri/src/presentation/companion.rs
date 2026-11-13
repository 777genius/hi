use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::stream;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::{CACHE_CONTROL, CONNECTION, CONTENT_TYPE, LOCATION, REFERRER_POLICY};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{watch, Mutex, RwLock};
use tokio::time::timeout;

use crate::domain::RecordingStatus;
use crate::presentation::events::{
    MicrophoneMuteStatePayload, StateSyncInvalidationPayload, EVENT_COMPANION_SNAPSHOT,
    EVENT_STATE_SYNC_INVALIDATION,
};
use crate::presentation::AppState;

const COMPANION_PORT: u16 = 43821;
const COMPANION_FALLBACK_PORT_CANDIDATES: [u16; 2] = [43822, 43823];
const COMPANION_SSE_RETRY_MS: u64 = 1500;
const COMPANION_SSE_HEARTBEAT_SECS: u64 = 15;
const COMPANION_MAX_REQUEST_BODY_BYTES: usize = 32 * 1024 * 1024;
const COMPANION_REQUEST_BODY_TIMEOUT_SECS: u64 = 45;
const COMPANION_TOPIC: &str = "companion-ui";
const COMPANION_ICON_128_PNG: &[u8] = include_bytes!("../../icons/128x128.png");
const COMPANION_ICON_512_PNG: &[u8] = include_bytes!("../../icons/icon.png");
pub const LIVE_STT_MESSAGE_ID: &str = "stt:live";

type CompanionBody = BoxBody<Bytes, Infallible>;
const COMPANION_TOKEN_HEADER: &str = "x-companion-token";
const COMPANION_REQUEST_ID_HEADER: &str = "x-companion-request-id";
const COMPANION_IDEMPOTENCY_TTL_SECS: u64 = 5 * 60;
const COMPANION_IDEMPOTENCY_MAX_ENTRIES: usize = 256;

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionRecordingState {
    pub status: RecordingStatus,
    pub active_session_id: u64,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionMicrophoneState {
    pub muted: bool,
    pub enabled: bool,
    pub supported: bool,
    pub source: String,
    pub system_muted: bool,
    pub system_supported: bool,
    pub system_source: String,
    pub app_muted: bool,
    pub app_enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionControlState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    pub history_floor_seq: u64,
    pub context_floor_seq: u64,
    pub conversation_generation: u64,
    pub companion_mode_enabled: bool,
    pub desktop_blackout_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_action: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionLiveState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_started_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub microphone_partial_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub microphone_partial_started_at_ms: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionMemoryState {
    pub mode: String,
    pub api_variant: String,
    pub api_base_url: String,
    pub backend_ingest_enabled: bool,
    pub backend_prompt_context_enabled: bool,
    pub minimal_local_prompt_context_enabled: bool,
    pub session_id: String,
    pub last_context_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_context_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_context_latency_ms: Option<u64>,
    pub last_ingest_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_ingest_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionAttachment {
    pub id: String,
    pub kind: String,
    pub mime: String,
    pub data_url: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionLlmCandidate {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub model: String,
    pub status: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CompanionMessageKind {
    #[default]
    Stt,
    Mic,
    Signal,
    Prompt,
    Haiku,
    Context,
}

impl CompanionMessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stt => "stt",
            Self::Mic => "mic",
            Self::Signal => "signal",
            Self::Prompt => "prompt",
            Self::Haiku => "haiku",
            Self::Context => "context",
        }
    }
}

impl serde::Serialize for CompanionMessageKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionMessage {
    pub id: String,
    pub seq: u64,
    pub kind: CompanionMessageKind,
    pub role: String,
    pub status: String,
    pub text: String,
    pub created_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insert_after_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stt_index: Option<u64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<CompanionAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<CompanionLlmCandidate>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_candidate_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSnapshot {
    pub auth_required: bool,
    pub recording: CompanionRecordingState,
    pub microphone: CompanionMicrophoneState,
    pub memory: CompanionMemoryState,
    pub controls: CompanionControlState,
    pub live: CompanionLiveState,
    pub timeline: Vec<CompanionMessage>,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSnapshotEnvelope {
    pub revision: String,
    pub data: CompanionSnapshot,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionServerStatus {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_network_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CompanionRuntime {
    pub snapshot: Arc<RwLock<CompanionSnapshotEnvelope>>,
    pub publish_lock: Arc<Mutex<()>>,
    pub sse_tx: watch::Sender<CompanionSnapshotEnvelope>,
    pub security_token: Arc<RwLock<String>>,
    pub enabled: Arc<RwLock<bool>>,
    pub port: Arc<RwLock<Option<u16>>>,
    pub instance_id: Arc<RwLock<Option<String>>>,
    pub action_cache: Arc<RwLock<CompanionActionIdempotencyCache>>,
}

#[derive(Debug, Clone)]
struct CachedCompanionAction {
    ok: bool,
    action_result: String,
}

#[derive(Debug, Clone)]
enum CompanionActionIdempotencyState {
    InFlight,
    Completed(CachedCompanionAction),
}

#[derive(Debug, Clone)]
struct CompanionActionIdempotencyEntry {
    created_at: Instant,
    state: CompanionActionIdempotencyState,
}

#[derive(Debug)]
enum CompanionActionIdempotencyDecision {
    Start(String),
    InFlight,
    Completed(CachedCompanionAction),
}

#[derive(Debug, Default)]
pub struct CompanionActionIdempotencyCache {
    entries: HashMap<String, CompanionActionIdempotencyEntry>,
}

impl CompanionActionIdempotencyCache {
    fn begin(&mut self, key: String) -> CompanionActionIdempotencyDecision {
        self.prune();
        if let Some(entry) = self.entries.get(&key) {
            return match &entry.state {
                CompanionActionIdempotencyState::InFlight => {
                    CompanionActionIdempotencyDecision::InFlight
                }
                CompanionActionIdempotencyState::Completed(cached) => {
                    CompanionActionIdempotencyDecision::Completed(cached.clone())
                }
            };
        }

        self.entries.insert(
            key.clone(),
            CompanionActionIdempotencyEntry {
                created_at: Instant::now(),
                state: CompanionActionIdempotencyState::InFlight,
            },
        );
        self.enforce_capacity();
        CompanionActionIdempotencyDecision::Start(key)
    }

    fn complete(
        &mut self,
        key: String,
        response: &crate::presentation::companion_actions::CompanionActionResponse,
    ) {
        self.entries.insert(
            key,
            CompanionActionIdempotencyEntry {
                created_at: Instant::now(),
                state: CompanionActionIdempotencyState::Completed(CachedCompanionAction {
                    ok: response.ok,
                    action_result: response.action_result.clone(),
                }),
            },
        );
        self.enforce_capacity();
    }

    fn forget(&mut self, key: &str) {
        self.entries.remove(key);
    }

    fn prune(&mut self) {
        let ttl = Duration::from_secs(COMPANION_IDEMPOTENCY_TTL_SECS);
        let now = Instant::now();
        self.entries
            .retain(|_, entry| now.saturating_duration_since(entry.created_at) <= ttl);
    }

    fn enforce_capacity(&mut self) {
        while self.entries.len() > COMPANION_IDEMPOTENCY_MAX_ENTRIES {
            let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.created_at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.entries.remove(&oldest_key);
        }
    }
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    token: String,
}

#[derive(Debug, Deserialize)]
struct IdentityQuery {
    nonce: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CompanionAiRequestBody {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    openai_responses_web_search: Option<bool>,
    #[serde(default)]
    selected_message_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CompanionPromptSendBody {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    images: Vec<crate::presentation::commands::LlmImageInput>,
    #[serde(default)]
    openai_responses_web_search: Option<bool>,
    #[serde(default)]
    selected_message_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FocusCopyIngestBody {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    app_name: Option<String>,
    #[serde(default)]
    bundle_id: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    file_path: Option<String>,
    #[serde(default)]
    language_id: Option<String>,
    #[serde(default)]
    line_count: Option<usize>,
    #[serde(default)]
    character_count: Option<usize>,
}

#[cfg(debug_assertions)]
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct E2eSystemTranscriptBody {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    session_id: Option<u64>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct E2ePlayAudioBody {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    device: Option<String>,
}

pub fn new_runtime() -> CompanionRuntime {
    let snapshot = CompanionSnapshotEnvelope::default();
    let (sse_tx, _sse_rx) = watch::channel(snapshot.clone());

    CompanionRuntime {
        snapshot: Arc::new(RwLock::new(snapshot)),
        publish_lock: Arc::new(Mutex::new(())),
        sse_tx,
        security_token: Arc::new(RwLock::new(generate_security_token())),
        enabled: Arc::new(RwLock::new(false)),
        port: Arc::new(RwLock::new(None)),
        instance_id: Arc::new(RwLock::new(None)),
        action_cache: Arc::new(RwLock::new(CompanionActionIdempotencyCache::default())),
    }
}

fn normalize_persisted_security_token(candidate: Option<String>) -> Option<String> {
    candidate
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

async fn ensure_persisted_security_token(state: &AppState) -> Result<String, String> {
    let existing = {
        let config = state.config.read().await;
        normalize_persisted_security_token(config.companion_access_token.clone())
    };
    if let Some(token) = existing {
        persist_companion_bridge_token(&token).await;
        return Ok(token);
    }

    match crate::infrastructure::ConfigStore::load_companion_bridge_token().await {
        Ok(Some(token)) => {
            let config_snapshot = {
                let mut config = state.config.write().await;
                config.companion_access_token = Some(token.clone());
                config.clone()
            };
            crate::infrastructure::ConfigStore::save_app_config(&config_snapshot)
                .await
                .map_err(|e| format!("Failed to restore companion token: {}", e))?;
            persist_companion_bridge_token(&token).await;
            log::info!("Restored companion token from bridge file");
            return Ok(token);
        }
        Ok(None) => {}
        Err(error) => {
            log::warn!("Failed to load companion bridge token: {}", error);
        }
    }

    let token = generate_security_token();
    let config_snapshot = {
        let mut config = state.config.write().await;
        config.companion_access_token = Some(token.clone());
        config.clone()
    };

    crate::infrastructure::ConfigStore::save_app_config(&config_snapshot)
        .await
        .map_err(|e| format!("Failed to persist companion token: {}", e))?;

    persist_companion_bridge_token(&token).await;
    Ok(token)
}

async fn persist_companion_bridge_token(token: &str) {
    if let Err(error) = crate::infrastructure::ConfigStore::save_companion_bridge_token(token).await
    {
        log::warn!("Failed to persist companion bridge token: {}", error);
    }
}

pub fn current_max_seq(state: &AppState) -> u64 {
    state
        .companion_next_seq
        .load(std::sync::atomic::Ordering::Relaxed)
}

pub async fn build_current_snapshot(
    app_handle: &AppHandle,
) -> Result<CompanionSnapshotEnvelope, String> {
    let state = app_handle
        .try_state::<AppState>()
        .ok_or_else(|| "AppState не доступен".to_string())?;
    // Keep the GET payload and its revision in the same publish epoch.
    // Otherwise a racing broadcast can assign a newer revision to old data.
    let runtime = state.companion_runtime.read().await.clone();
    let _publish_guard = runtime.publish_lock.lock().await;
    let data = build_snapshot_data(state.inner()).await?;
    let revision = state.companion_revision.read().await.to_string();
    Ok(CompanionSnapshotEnvelope { revision, data })
}

pub async fn get_server_status(app_handle: &AppHandle) -> Result<CompanionServerStatus, String> {
    let state = app_handle
        .try_state::<AppState>()
        .ok_or_else(|| "AppState не доступен".to_string())?;
    let runtime = state.companion_runtime.read().await.clone();
    let enabled = *runtime.enabled.read().await;
    let port = *runtime.port.read().await;
    let token = runtime.security_token.read().await.clone();

    if !enabled {
        return Ok(CompanionServerStatus::default());
    }

    let local_url = port.map(|p| format!("http://127.0.0.1:{}/c/{}", p, token));
    let local_network_url = match (detect_primary_ipv4(), port) {
        (Some(ip), Some(port)) => Some(format!("http://{}:{}/c/{}", ip, port, token)),
        _ => None,
    };

    Ok(CompanionServerStatus {
        enabled,
        port,
        token: Some(token),
        local_url,
        local_network_url,
    })
}

fn log_server_ready(status: &CompanionServerStatus) {
    if let Some(port) = status.port {
        // Status URLs embed the bearer token. Never copy them into logs.
        log::info!("Companion server ready on port {}; scan the private QR in the app", port);
    } else {
        log::info!("Companion server started, but port is not available yet");
    }
}

pub async fn publish_snapshot(app_handle: &AppHandle) -> Result<CompanionSnapshotEnvelope, String> {
    publish_snapshot_internal(app_handle, true).await
}

pub async fn publish_snapshot_sse_only(
    app_handle: &AppHandle,
) -> Result<CompanionSnapshotEnvelope, String> {
    publish_snapshot_internal(app_handle, false).await
}

async fn publish_snapshot_internal(
    app_handle: &AppHandle,
    emit_tauri_invalidation: bool,
) -> Result<CompanionSnapshotEnvelope, String> {
    let state = app_handle
        .try_state::<AppState>()
        .ok_or_else(|| "AppState не доступен".to_string())?;
    let runtime = state.companion_runtime.read().await.clone();
    // A partial STT/LLM update may publish concurrently with a UI action.
    // Build, number and broadcast snapshots in one ordered critical section.
    let _publish_guard = runtime.publish_lock.lock().await;
    let data = build_snapshot_data(state.inner()).await?;
    let revision = AppState::bump_revision(&state.companion_revision).await;
    let envelope = CompanionSnapshotEnvelope {
        revision: revision.clone(),
        data,
    };
    let previous = runtime.snapshot.read().await.clone();
    let just_finished_response = envelope.data.timeline.iter().any(|message| {
        message.kind == CompanionMessageKind::Haiku
            && matches!(message.status.as_str(), "final" | "error")
            && previous.data.timeline.iter().find(|old| old.id == message.id)
                .is_none_or(|old| old.status != message.status)
    });
    let just_cleared = envelope.data.controls.history_floor_seq != previous.data.controls.history_floor_seq
        || envelope.data.controls.context_floor_seq != previous.data.controls.context_floor_seq;
    if just_finished_response || just_cleared {
        if let Err(error) = crate::presentation::companion_timeline_store::save_now(state.inner()).await {
            log::warn!("Failed to persist completed companion answer: {}", error);
        }
    } else {
        crate::presentation::companion_timeline_store::schedule_save(state.inner());
    }
    *runtime.snapshot.write().await = envelope.clone();
    let _ = runtime.sse_tx.send(envelope.clone());

    if envelope.data.controls.companion_mode_enabled {
        let _ = app_handle.emit(EVENT_COMPANION_SNAPSHOT, envelope.clone());
    }

    if emit_tauri_invalidation {
        emit_invalidation(app_handle, revision).await;
    }
    Ok(envelope)
}

pub async fn enable_mode(app_handle: &AppHandle) -> Result<CompanionServerStatus, String> {
    let state = app_handle
        .try_state::<AppState>()
        .ok_or_else(|| "AppState не доступен".to_string())?;
    let _guard = state.companion_action_lock.lock().await;

    let runtime = state.companion_runtime.read().await.clone();
    if *runtime.enabled.read().await
        && runtime.port.read().await.is_some()
        && state.companion_server_task.read().await.is_some()
    {
        drop(_guard);
        let _ = publish_snapshot(app_handle).await;
        return get_server_status(app_handle).await;
    }

    let listener = bind_listener()
        .await
        .map_err(|e| format!("Failed to bind companion server: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to resolve companion server address: {}", e))?
        .port();

    let token = ensure_persisted_security_token(state.inner()).await?;
    let instance_id = uuid::Uuid::new_v4().to_string();
    // The listener is bound but is not serving yet. Fail closed if we cannot
    // publish the actual endpoint to the private bridge.
    crate::infrastructure::ConfigStore::save_companion_bridge_state(
        &token,
        Some(port),
        Some(&instance_id),
    )
    .await
    .map_err(|error| format!("Failed to publish Companion endpoint: {error}"))?;
    *runtime.security_token.write().await = token;
    *runtime.instance_id.write().await = Some(instance_id);
    *runtime.port.write().await = Some(port);
    *runtime.enabled.write().await = true;

    let app_handle_for_task = app_handle.clone();
    let task = tauri::async_runtime::spawn(async move {
        if let Err(e) = serve_listener(app_handle_for_task.clone(), listener).await {
            log::warn!("Companion server stopped: {}", e);
        }
    });

    *state.companion_server_task.write().await = Some(task);
    drop(_guard);

    let _ = publish_snapshot(app_handle).await;
    let status = get_server_status(app_handle).await?;
    log_server_ready(&status);
    Ok(status)
}

pub async fn disable_mode(app_handle: &AppHandle) -> Result<(), String> {
    let state = app_handle
        .try_state::<AppState>()
        .ok_or_else(|| "AppState не доступен".to_string())?;
    let _guard = state.companion_action_lock.lock().await;

    if let Some(handle) = state.companion_server_task.write().await.take() {
        handle.abort();
        let _ = handle.await;
    }

    let runtime = state.companion_runtime.read().await.clone();
    let had_blackout = state
        .companion_desktop_blackout_enabled
        .swap(false, std::sync::atomic::Ordering::Relaxed);
    if had_blackout {
        let _ = publish_snapshot(app_handle).await;
    }

    *runtime.enabled.write().await = false;
    *runtime.port.write().await = None;
    *runtime.instance_id.write().await = None;
    let token = runtime.security_token.read().await.clone();
    // A crashed process may leave metadata behind, but an ordinary Stop must
    // explicitly revoke discovery. Identity verification also rejects staleness.
    if let Err(error) = crate::infrastructure::ConfigStore::save_companion_bridge_token(&token).await {
        log::warn!("Failed to invalidate Companion bridge on Stop: {error}");
    }

    drop(_guard);
    let _ = publish_snapshot(app_handle).await;
    Ok(())
}

async fn build_snapshot_data(state: &AppState) -> Result<CompanionSnapshot, String> {
    let runtime = state.companion_runtime.read().await.clone();
    let companion_mode_enabled = *runtime.enabled.read().await;
    let instance_id = runtime.instance_id.read().await.clone();

    let system_microphone_payload =
        crate::presentation::commands::get_system_microphone_mute_state().unwrap_or(
            MicrophoneMuteStatePayload {
                muted: false,
                supported: false,
                source: "unknown".to_string(),
                detail: None,
            },
        );
    let app_microphone_payload =
        crate::presentation::commands::get_app_microphone_mute_state(state);
    let microphone_muted = system_microphone_payload.muted || app_microphone_payload.muted;
    let microphone_source = match (
        system_microphone_payload.muted,
        app_microphone_payload.muted,
    ) {
        (true, true) => "combined".to_string(),
        (true, false) => system_microphone_payload.source.clone(),
        (false, true) => app_microphone_payload.source.clone(),
        (false, false) => system_microphone_payload.source.clone(),
    };

    let recording_status = state.transcription_service.get_status().await;
    let active_session_id = state
        .active_transcription_session_id
        .load(std::sync::atomic::Ordering::Relaxed);
    let partial_text =
        crate::presentation::companion_timeline::visible_system_partial_text(state).await;
    let final_text = state.final_transcription.read().await.clone();
    let partial_started_at_ms = match state
        .companion_live_system_started_at_ms
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        0 => None,
        value => Some(value as i64),
    };
    let microphone_partial_text =
        crate::presentation::companion_timeline::visible_microphone_partial_text(state).await;
    let microphone_partial_started_at_ms = match state
        .companion_live_microphone_started_at_ms
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        0 => None,
        value => Some(value as i64),
    };
    let history_floor_seq = state
        .companion_history_floor_seq
        .load(std::sync::atomic::Ordering::Relaxed);
    let context_floor_seq = state
        .companion_context_floor_seq
        .load(std::sync::atomic::Ordering::Relaxed);
    let conversation_generation = state
        .companion_conversation_generation
        .load(std::sync::atomic::Ordering::Relaxed);
    let last_action = state.companion_last_action.read().await.clone();
    let memory_mode =
        crate::presentation::interview_memory_bridge::resolved_mode_for_state(state).await;
    let memory_session_id =
        crate::presentation::interview_memory_bridge::memory_session_id_string(state).await;
    let memory_diagnostics =
        crate::presentation::interview_memory_bridge::memory_diagnostics(state).await;
    let timeline = state
        .companion_timeline
        .read()
        .await
        .iter()
        .filter(|item| item.seq > history_floor_seq)
        .cloned()
        .collect();

    Ok(CompanionSnapshot {
        auth_required: !state.has_local_access().await,
        recording: CompanionRecordingState {
            status: recording_status,
            active_session_id,
        },
        microphone: CompanionMicrophoneState {
            muted: microphone_muted,
            enabled: !microphone_muted,
            supported: system_microphone_payload.supported || app_microphone_payload.supported,
            source: microphone_source,
            system_muted: system_microphone_payload.muted,
            system_supported: system_microphone_payload.supported,
            system_source: system_microphone_payload.source,
            app_muted: app_microphone_payload.muted,
            app_enabled: !app_microphone_payload.muted,
        },
        memory: CompanionMemoryState {
            mode: memory_mode.as_str().to_string(),
            api_variant: crate::presentation::interview_memory_bridge::resolved_api_variant_label()
                .to_string(),
            api_base_url:
                crate::presentation::interview_memory_bridge::resolved_primary_api_base_url(),
            backend_ingest_enabled: memory_mode.backend_ingest_enabled(),
            backend_prompt_context_enabled: memory_mode.backend_prompt_context_enabled(),
            minimal_local_prompt_context_enabled: memory_mode
                .minimal_local_prompt_context_enabled(),
            session_id: memory_session_id,
            last_context_status: memory_diagnostics.last_context_status,
            last_context_error: memory_diagnostics.last_context_error,
            last_context_latency_ms: memory_diagnostics.last_context_latency_ms,
            last_ingest_status: memory_diagnostics.last_ingest_status,
            last_ingest_error: memory_diagnostics.last_ingest_error,
            last_updated_at_ms: memory_diagnostics.last_updated_at_ms,
        },
        controls: CompanionControlState {
            instance_id,
            history_floor_seq,
            context_floor_seq,
            conversation_generation,
            companion_mode_enabled,
            desktop_blackout_enabled: state
                .companion_desktop_blackout_enabled
                .load(std::sync::atomic::Ordering::Relaxed),
            last_action,
        },
        live: CompanionLiveState {
            partial_text,
            final_text,
            partial_started_at_ms,
            microphone_partial_text,
            microphone_partial_started_at_ms,
        },
        timeline,
    })
}

async fn serve_listener(app_handle: AppHandle, listener: TcpListener) -> Result<(), String> {
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to resolve companion listener port: {}", e))?
        .port();
    log::info!("Companion server listening on http://127.0.0.1:{port}");

    // The listener owns every accepted HTTP/SSE task. Dropping this JoinSet
    // on Companion Stop aborts old keep-alive sessions as well as the listener.
    // This prevents a stale socket from becoming authenticated again after
    // the server is enabled with its persisted token.
    let mut connections = tokio::task::JoinSet::new();
    let mut consecutive_accept_errors = 0_u32;
    loop {
        tokio::select! {
            finished = connections.join_next(), if !connections.is_empty() => {
                if let Some(Err(error)) = finished {
                    log::debug!("Companion connection task exited: {}", error);
                }
            }
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(connection) => {
                        consecutive_accept_errors = 0;
                        connection
                    }
                    Err(error) => {
                        // A transient accept error must not permanently detach
                        // every phone while the desktop application is alive.
                        consecutive_accept_errors = (consecutive_accept_errors + 1).min(5);
                        let delay_ms = 200_u64 * (1_u64 << consecutive_accept_errors);
                        log::warn!("Companion listener accept failed (retrying in {}ms): {}", delay_ms, error);
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        continue;
                    }
                };
                log::debug!("Companion server accepted connection from {}", peer);
                let app_handle_for_conn = app_handle.clone();
                connections.spawn(async move {
                    let io = TokioIo::new(stream);
                    let service = service_fn(move |req| route_request(app_handle_for_conn.clone(), req));
                    if let Err(err) = http1::Builder::new().serve_connection(io, service).await {
                        log::debug!("Companion connection error: {}", err);
                    }
                });
            }
        }
    }
}

async fn route_request(
    app_handle: AppHandle,
    req: Request<Incoming>,
) -> Result<Response<CompanionBody>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    let response = match (method, path.as_str()) {
        (Method::GET, "/health") | (Method::GET, "/api/health") => {
            let body = companion_health_json(&app_handle).await;
            json_response(StatusCode::OK, body)
        }
        (Method::HEAD, "/health") | (Method::HEAD, "/api/health") => empty_response(StatusCode::OK),
        (Method::GET, "/api/identity") => companion_identity_response(&app_handle, req.uri()).await,
        (Method::GET, "/manifest.webmanifest") => {
            companion_manifest_response(&app_handle, req.uri()).await
        }
        (Method::HEAD, "/manifest.webmanifest") => {
            without_body(companion_manifest_response(&app_handle, req.uri()).await)
        }
        (Method::GET, "/companion-icon-128.png") => companion_icon_response(COMPANION_ICON_128_PNG),
        (Method::HEAD, "/companion-icon-128.png") => {
            without_body(companion_icon_response(COMPANION_ICON_128_PNG))
        }
        (Method::GET, "/companion-icon-512.png")
        | (Method::GET, "/companion-apple-touch-icon.png") => {
            companion_icon_response(COMPANION_ICON_512_PNG)
        }
        (Method::HEAD, "/companion-icon-512.png")
        | (Method::HEAD, "/companion-apple-touch-icon.png") => {
            without_body(companion_icon_response(COMPANION_ICON_512_PNG))
        }
        (Method::GET, "/api/state") => {
            if let Some(token) = parse_query_token(req.uri()) {
                if is_valid_token(&app_handle, &token).await {
                    match build_current_snapshot(&app_handle).await {
                        Ok(snapshot) => json_response(
                            StatusCode::OK,
                            serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".to_string()),
                        ),
                        Err(err) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &err),
                    }
                } else {
                    text_response(StatusCode::FORBIDDEN, "Forbidden")
                }
            } else {
                text_response(StatusCode::UNAUTHORIZED, "Missing token")
            }
        }
        (Method::GET, "/events") => {
            if let Some(token) = parse_query_token(req.uri()) {
                if is_valid_token(&app_handle, &token).await {
                    sse_response(app_handle.clone(), token).await
                } else {
                    text_response(StatusCode::FORBIDDEN, "Forbidden")
                }
            } else {
                text_response(StatusCode::UNAUTHORIZED, "Missing token")
            }
        }
        (Method::POST, "/api/record/start") => {
            handle_mutating_post(app_handle.clone(), req, "record_start").await
        }
        (Method::POST, "/api/record/stop") => {
            handle_mutating_post(app_handle.clone(), req, "record_stop").await
        }
        (Method::POST, "/api/microphone/mute") => {
            handle_mutating_post(app_handle.clone(), req, "microphone_mute").await
        }
        (Method::POST, "/api/microphone/unmute") => {
            handle_mutating_post(app_handle.clone(), req, "microphone_unmute").await
        }
        (Method::POST, "/api/microphone/system/mute") => {
            handle_mutating_post(app_handle.clone(), req, "microphone_mute").await
        }
        (Method::POST, "/api/microphone/system/unmute") => {
            handle_mutating_post(app_handle.clone(), req, "microphone_unmute").await
        }
        (Method::POST, "/api/microphone/app/mute") => {
            handle_mutating_post(app_handle.clone(), req, "app_microphone_mute").await
        }
        (Method::POST, "/api/microphone/app/unmute") => {
            handle_mutating_post(app_handle.clone(), req, "app_microphone_unmute").await
        }
        (Method::POST, "/api/desktop/blackout/enable") => {
            handle_mutating_post(app_handle.clone(), req, "desktop_blackout_enable").await
        }
        (Method::POST, "/api/desktop/blackout/disable") => {
            handle_mutating_post(app_handle.clone(), req, "desktop_blackout_disable").await
        }
        (Method::POST, "/api/context/clear") => {
            handle_mutating_post(app_handle.clone(), req, "context_clear").await
        }
        (Method::POST, "/api/history/clear") => {
            handle_mutating_post(app_handle.clone(), req, "history_clear").await
        }
        (Method::POST, "/api/ai/request") => handle_ai_request_post(app_handle.clone(), req).await,
        (Method::POST, "/api/prompt/send") => {
            handle_prompt_send_post(app_handle.clone(), req).await
        }
        (Method::POST, "/api/focus-copy/ingest") => {
            handle_focus_copy_ingest_post(app_handle.clone(), req).await
        }
        (Method::POST, "/api/e2e/play-audio") => {
            handle_e2e_play_audio_post(app_handle.clone(), req).await
        }
        #[cfg(debug_assertions)]
        (Method::POST, "/api/e2e/timeline/system") => {
            handle_e2e_system_transcript_post(app_handle.clone(), req).await
        }
        #[cfg(debug_assertions)]
        (Method::POST, "/api/e2e/timeline/microphone") => {
            handle_e2e_microphone_transcript_post(app_handle.clone(), req).await
        }
        (Method::HEAD, path) if path.starts_with("/c/") => {
            let token = path.trim_start_matches("/c/").to_string();
            if is_valid_token(&app_handle, &token).await {
                without_body(redirect_response(&format!(
                    "/companion.html?token={}",
                    urlencoding::encode(&token)
                )))
            } else {
                without_body(stale_companion_link_response())
            }
        }
        (Method::GET, path) if path.starts_with("/c/") => {
            let token = path.trim_start_matches("/c/").to_string();
            if is_valid_token(&app_handle, &token).await {
                redirect_response(&format!(
                    "/companion.html?token={}",
                    urlencoding::encode(&token)
                ))
            } else {
                stale_companion_link_response()
            }
        }
        (Method::HEAD, "/companion.html") => match parse_query_token(req.uri()) {
            Some(token) if is_valid_token(&app_handle, &token).await => {
                without_body(serve_companion_frontend(&app_handle, req.uri()).await)
            }
            Some(_) => without_body(stale_companion_link_response()),
            None => text_response(StatusCode::UNAUTHORIZED, "Missing token"),
        },
        (Method::GET, "/companion.html") => match parse_query_token(req.uri()) {
            Some(token) if is_valid_token(&app_handle, &token).await => {
                serve_companion_frontend(&app_handle, req.uri()).await
            }
            Some(_) => stale_companion_link_response(),
            None => text_response(StatusCode::UNAUTHORIZED, "Missing token"),
        },
        (Method::HEAD, path) if is_companion_frontend_asset_path(path) => {
            without_body(serve_companion_frontend(&app_handle, req.uri()).await)
        }
        (Method::GET, path) if is_companion_frontend_asset_path(path) => {
            serve_companion_frontend(&app_handle, req.uri()).await
        }
        (Method::OPTIONS, _) => empty_response(StatusCode::METHOD_NOT_ALLOWED),
        (Method::GET, "/favicon.ico") => empty_response(StatusCode::NO_CONTENT),
        _ => text_response(StatusCode::NOT_FOUND, "Not Found"),
    };

    Ok(response)
}

fn companion_action_status(action_result: &str) -> StatusCode {
    match action_result {
        "busy_transition" => StatusCode::CONFLICT,
        "rejected_auth" => StatusCode::UNAUTHORIZED,
        _ => StatusCode::OK,
    }
}

fn companion_action_json_response(
    response: crate::presentation::companion_actions::CompanionActionResponse,
) -> Response<CompanionBody> {
    json_response(
        companion_action_status(&response.action_result),
        serde_json::to_string(&response).unwrap_or_else(|_| "{}".to_string()),
    )
}

async fn cached_companion_action_response(
    app_handle: &AppHandle,
    cached: CachedCompanionAction,
) -> Response<CompanionBody> {
    match build_current_snapshot(app_handle).await {
        Ok(snapshot) => companion_action_json_response(
            crate::presentation::companion_actions::CompanionActionResponse {
                ok: cached.ok,
                action_result: cached.action_result,
                snapshot,
            },
        ),
        Err(err) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

fn companion_idempotency_key(token: &str, request_id: &str, path: &str) -> String {
    format!("{}:{}:{}", token, request_id, path)
}

async fn begin_companion_action_idempotency(
    app_handle: &AppHandle,
    state: &AppState,
    token: &str,
    path: &str,
    request_id: Option<String>,
) -> Result<Option<String>, Response<CompanionBody>> {
    let Some(request_id) = request_id else {
        return Ok(None);
    };
    let key = companion_idempotency_key(token, &request_id, path);
    let cache = {
        let runtime = state.companion_runtime.read().await;
        runtime.action_cache.clone()
    };
    let decision = cache.write().await.begin(key);
    match decision {
        CompanionActionIdempotencyDecision::Start(key) => Ok(Some(key)),
        CompanionActionIdempotencyDecision::InFlight => Err(cached_companion_action_response(
            app_handle,
            CachedCompanionAction {
                ok: false,
                action_result: "busy_transition".to_string(),
            },
        )
        .await),
        CompanionActionIdempotencyDecision::Completed(cached) => {
            Err(cached_companion_action_response(app_handle, cached).await)
        }
    }
}

async fn complete_companion_action_idempotency(
    state: &AppState,
    key: Option<String>,
    response: &crate::presentation::companion_actions::CompanionActionResponse,
) {
    let Some(key) = key else {
        return;
    };
    let cache = {
        let runtime = state.companion_runtime.read().await;
        runtime.action_cache.clone()
    };
    cache.write().await.complete(key, response);
}

async fn forget_companion_action_idempotency(state: &AppState, key: Option<String>) {
    let Some(key) = key else {
        return;
    };
    let cache = {
        let runtime = state.companion_runtime.read().await;
        runtime.action_cache.clone()
    };
    cache.write().await.forget(&key);
}

async fn handle_mutating_post(
    app_handle: AppHandle,
    req: Request<Incoming>,
    action: &str,
) -> Response<CompanionBody> {
    let Some(token) = parse_header_token(req.headers()) else {
        return text_response(StatusCode::UNAUTHORIZED, "Missing token");
    };
    let request_id = parse_request_id(req.headers());
    let request_path = req.uri().path().to_string();
    if !is_valid_token(&app_handle, &token).await {
        return text_response(StatusCode::FORBIDDEN, "Forbidden");
    }
    if !has_json_content_type(req.headers()) {
        return text_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }
    if let Err(response) = read_json_body::<serde_json::Value>(req).await {
        return response;
    }

    let state = match app_handle.try_state::<AppState>() {
        Some(state) => state,
        None => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "AppState not available"),
    };

    let idempotency_key = match begin_companion_action_idempotency(
        &app_handle,
        state.inner(),
        &token,
        &request_path,
        request_id,
    )
    .await
    {
        Ok(key) => key,
        Err(response) => return response,
    };

    let result = match action {
        "record_start" => {
            crate::presentation::companion_actions::ensure_recording_started(
                state.inner(),
                &app_handle,
            )
            .await
        }
        "record_stop" => {
            crate::presentation::companion_actions::ensure_recording_stopped(
                state.inner(),
                &app_handle,
                false,
            )
            .await
        }
        "microphone_mute" => {
            crate::presentation::companion_actions::ensure_microphone_muted(
                state.inner(),
                &app_handle,
                true,
            )
            .await
        }
        "microphone_unmute" => {
            crate::presentation::companion_actions::ensure_microphone_muted(
                state.inner(),
                &app_handle,
                false,
            )
            .await
        }
        "app_microphone_mute" => {
            crate::presentation::companion_actions::ensure_app_microphone_muted(
                state.inner(),
                &app_handle,
                true,
            )
            .await
        }
        "app_microphone_unmute" => {
            crate::presentation::companion_actions::ensure_app_microphone_muted(
                state.inner(),
                &app_handle,
                false,
            )
            .await
        }
        "desktop_blackout_enable" => {
            crate::presentation::companion_actions::ensure_desktop_blackout(
                state.inner(),
                &app_handle,
                true,
            )
            .await
        }
        "desktop_blackout_disable" => {
            crate::presentation::companion_actions::ensure_desktop_blackout(
                state.inner(),
                &app_handle,
                false,
            )
            .await
        }
        "context_clear" => {
            crate::presentation::companion_actions::ensure_context_cleared(
                state.inner(),
                &app_handle,
            )
            .await
        }
        "history_clear" => {
            crate::presentation::companion_actions::ensure_history_cleared(
                state.inner(),
                &app_handle,
            )
            .await
        }
        _ => Err("Unknown action".to_string()),
    };

    match result {
        Ok(response) => {
            complete_companion_action_idempotency(state.inner(), idempotency_key, &response).await;
            companion_action_json_response(response)
        }
        Err(err) => {
            forget_companion_action_idempotency(state.inner(), idempotency_key).await;
            text_response(StatusCode::INTERNAL_SERVER_ERROR, &err)
        }
    }
}

async fn handle_ai_request_post(
    app_handle: AppHandle,
    req: Request<Incoming>,
) -> Response<CompanionBody> {
    let Some(token) = parse_header_token(req.headers()) else {
        return text_response(StatusCode::UNAUTHORIZED, "Missing token");
    };
    let request_id = parse_request_id(req.headers());
    let request_path = req.uri().path().to_string();
    if !is_valid_token(&app_handle, &token).await {
        return text_response(StatusCode::FORBIDDEN, "Forbidden");
    }
    if !has_json_content_type(req.headers()) {
        return text_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }

    let body = match read_json_body::<CompanionAiRequestBody>(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };

    let state = match app_handle.try_state::<AppState>() {
        Some(state) => state,
        None => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "AppState not available"),
    };

    let idempotency_key = match begin_companion_action_idempotency(
        &app_handle,
        state.inner(),
        &token,
        &request_path,
        request_id,
    )
    .await
    {
        Ok(key) => key,
        Err(response) => return response,
    };

    match crate::presentation::companion_actions::request_ai(
        state.inner(),
        &app_handle,
        body.text,
        body.openai_responses_web_search,
        body.selected_message_ids,
    )
    .await
    {
        Ok(response) => {
            complete_companion_action_idempotency(state.inner(), idempotency_key, &response).await;
            companion_action_json_response(response)
        }
        Err(err) => {
            forget_companion_action_idempotency(state.inner(), idempotency_key).await;
            text_response(StatusCode::INTERNAL_SERVER_ERROR, &err)
        }
    }
}

async fn handle_prompt_send_post(
    app_handle: AppHandle,
    req: Request<Incoming>,
) -> Response<CompanionBody> {
    let Some(token) = parse_header_token(req.headers()) else {
        return text_response(StatusCode::UNAUTHORIZED, "Missing token");
    };
    let request_id = parse_request_id(req.headers());
    let request_path = req.uri().path().to_string();
    if !is_valid_token(&app_handle, &token).await {
        return text_response(StatusCode::FORBIDDEN, "Forbidden");
    }
    if !has_json_content_type(req.headers()) {
        return text_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }

    let body = match read_json_body::<CompanionPromptSendBody>(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };

    let state = match app_handle.try_state::<AppState>() {
        Some(state) => state,
        None => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "AppState not available"),
    };

    let idempotency_key = match begin_companion_action_idempotency(
        &app_handle,
        state.inner(),
        &token,
        &request_path,
        request_id,
    )
    .await
    {
        Ok(key) => key,
        Err(response) => return response,
    };

    match crate::presentation::companion_actions::send_prompt(
        state.inner(),
        &app_handle,
        body.text.unwrap_or_default(),
        body.images,
        body.openai_responses_web_search,
        body.selected_message_ids,
    )
    .await
    {
        Ok(response) => {
            complete_companion_action_idempotency(state.inner(), idempotency_key, &response).await;
            companion_action_json_response(response)
        }
        Err(err) => {
            forget_companion_action_idempotency(state.inner(), idempotency_key).await;
            text_response(StatusCode::INTERNAL_SERVER_ERROR, &err)
        }
    }
}

async fn handle_focus_copy_ingest_post(
    app_handle: AppHandle,
    req: Request<Incoming>,
) -> Response<CompanionBody> {
    let Some(token) = parse_header_token(req.headers()) else {
        return text_response(StatusCode::UNAUTHORIZED, "Missing token");
    };
    if !is_valid_token(&app_handle, &token).await {
        return text_response(StatusCode::FORBIDDEN, "Forbidden");
    }
    if !has_json_content_type(req.headers()) {
        return text_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }

    let body = match read_json_body::<FocusCopyIngestBody>(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };

    let Some(text) = body.text else {
        return text_response(StatusCode::BAD_REQUEST, "Missing text");
    };
    if text.trim().is_empty() {
        return text_response(StatusCode::BAD_REQUEST, "Empty text");
    }

    let state = match app_handle.try_state::<AppState>() {
        Some(state) => state,
        None => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "AppState not available"),
    };

    let created_at_ms = crate::presentation::companion_timeline::now_ms();
    let message_id = crate::presentation::companion_timeline::append_focus_copy_system_final(
        state.inner(),
        text,
        created_at_ms,
        Some(format!("focus-copy:{}", uuid::Uuid::new_v4())),
    )
    .await;

    let Some(message_id) = message_id else {
        return text_response(StatusCode::BAD_REQUEST, "Empty text");
    };

    match publish_snapshot(&app_handle).await {
        Ok(_) => {
            let chars = body.character_count.unwrap_or_default();
            log::info!(
                "Focus copy ingested via HTTP id={} method={:?}, source={:?}, chars={}, app={:?}, bundle={:?}, url={:?}, file={:?}, language={:?}, lines={:?}",
                message_id,
                body.method,
                body.source,
                chars,
                body.app_name,
                body.bundle_id,
                body.url,
                body.file_path,
                body.language_id,
                body.line_count
            );

            json_response(
                StatusCode::OK,
                serde_json::json!({
                    "ok": true,
                    "messageId": message_id,
                    "characterCount": chars,
                })
                .to_string(),
            )
        }
        Err(error) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

/// Тестовый режим (INTERVIEW_TEST_MODE=1): проигрывает PCM-файл в устройство вывода из процесса приложения.
async fn handle_e2e_play_audio_post(
    app_handle: AppHandle,
    req: Request<Incoming>,
) -> Response<CompanionBody> {
    if !crate::infrastructure::test_interviewer::is_enabled() {
        return text_response(StatusCode::NOT_FOUND, "Not found");
    }
    let Some(token) = parse_header_token(req.headers()) else {
        return text_response(StatusCode::UNAUTHORIZED, "Missing token");
    };
    if !is_valid_token(&app_handle, &token).await {
        return text_response(StatusCode::FORBIDDEN, "Forbidden");
    }
    if !has_json_content_type(req.headers()) {
        return text_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }
    let body = match read_json_body::<E2ePlayAudioBody>(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let (Some(path), Some(device)) = (body.path, body.device) else {
        return text_response(StatusCode::BAD_REQUEST, "Missing path or device");
    };

    let result = tokio::task::spawn_blocking(move || {
        crate::infrastructure::test_interviewer::play_pcm_to_device(&path, &device)
    })
    .await;
    match result {
        Ok(Ok(seconds)) => json_response(
            StatusCode::OK,
            serde_json::json!({ "ok": true, "seconds": seconds }).to_string(),
        ),
        Ok(Err(error)) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &error),
        Err(error) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

#[cfg(debug_assertions)]
async fn handle_e2e_system_transcript_post(
    app_handle: AppHandle,
    req: Request<Incoming>,
) -> Response<CompanionBody> {
    let Some(token) = parse_header_token(req.headers()) else {
        return text_response(StatusCode::UNAUTHORIZED, "Missing token");
    };
    if !is_valid_token(&app_handle, &token).await {
        return text_response(StatusCode::FORBIDDEN, "Forbidden");
    }
    if !has_json_content_type(req.headers()) {
        return text_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }

    let body = match read_json_body::<E2eSystemTranscriptBody>(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };

    let Some(text) = body.text.map(|value| value.trim().to_string()) else {
        return text_response(StatusCode::BAD_REQUEST, "Missing text");
    };
    if text.is_empty() {
        return text_response(StatusCode::BAD_REQUEST, "Empty text");
    }

    let state = match app_handle.try_state::<AppState>() {
        Some(state) => state,
        None => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "AppState not available"),
    };

    let session_id = body.session_id.unwrap_or_else(|| {
        crate::presentation::companion_timeline::now_ms()
            .unsigned_abs()
            .max(1)
    });
    let transcription = crate::domain::Transcription::final_result(text);
    crate::presentation::companion_timeline::append_system_final(
        state.inner(),
        session_id,
        &transcription,
    )
    .await;

    match publish_snapshot(&app_handle).await {
        Ok(_) => json_response(
            StatusCode::OK,
            serde_json::json!({
                "ok": true,
                "sessionId": session_id,
                "characterCount": transcription.text.len(),
            })
            .to_string(),
        ),
        Err(error) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

#[cfg(debug_assertions)]
async fn handle_e2e_microphone_transcript_post(
    app_handle: AppHandle,
    req: Request<Incoming>,
) -> Response<CompanionBody> {
    let Some(token) = parse_header_token(req.headers()) else {
        return text_response(StatusCode::UNAUTHORIZED, "Missing token");
    };
    if !is_valid_token(&app_handle, &token).await {
        return text_response(StatusCode::FORBIDDEN, "Forbidden");
    }
    if !has_json_content_type(req.headers()) {
        return text_response(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Expected application/json");
    }
    let body = match read_json_body::<E2eSystemTranscriptBody>(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let text = body.text.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return text_response(StatusCode::BAD_REQUEST, "Empty text");
    }
    let Some(state) = app_handle.try_state::<AppState>() else {
        return text_response(StatusCode::INTERNAL_SERVER_ERROR, "AppState not available");
    };
    let session_id = state.active_transcription_session_id.load(std::sync::atomic::Ordering::Relaxed);
    if session_id == 0 || body.session_id.is_some_and(|value| value != session_id) {
        return text_response(StatusCode::CONFLICT, "Recording session is not active");
    }
    let transcription = crate::domain::Transcription::final_result(text);
    let payload = crate::presentation::events::FinalTranscriptionPayload::from_transcription(
        transcription, session_id, "microphone",
    );
    // The endurance harness injects a controlled microphone transcript while
    // the physical input is muted, so ambient noise cannot pollute LLM context.
    // This route exists only in debug builds and restores the runtime flag.
    let was_enabled = state.microphone_transcription_enabled.swap(
        true,
        std::sync::atomic::Ordering::Relaxed,
    );
    crate::presentation::companion_timeline::on_microphone_final(state.inner(), &payload).await;
    state.microphone_transcription_enabled.store(
        was_enabled,
        std::sync::atomic::Ordering::Relaxed,
    );
    match publish_snapshot(&app_handle).await {
        Ok(_) => json_response(StatusCode::OK, serde_json::json!({"ok": true, "sessionId": session_id}).to_string()),
        Err(error) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

async fn is_valid_sse_session(
    app_handle: &AppHandle,
    connection_token: &str,
    connection_instance_id: &str,
) -> bool {
    if !is_valid_token(app_handle, connection_token).await {
        return false;
    }
    let Some(state) = app_handle.try_state::<AppState>() else {
        return false;
    };
    let runtime = state.companion_runtime.read().await.clone();
    let matches = runtime.instance_id.read().await.as_deref() == Some(connection_instance_id);
    matches
}

async fn sse_response(
    app_handle: AppHandle,
    connection_token: String,
) -> Response<CompanionBody> {
    let state = match app_handle.try_state::<AppState>() {
        Some(state) => state,
        None => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "AppState not available"),
    };
    let runtime = state.companion_runtime.read().await.clone();
    let Some(instance_id) = runtime.instance_id.read().await.clone() else {
        return text_response(StatusCode::SERVICE_UNAVAILABLE, "Companion not enabled");
    };
    // Subscribe *before* taking the initial snapshot. Any publish racing the
    // snapshot construction remains pending in watch rather than being lost.
    let rx = runtime.sse_tx.subscribe();
    let initial_snapshot = match build_current_snapshot(&app_handle).await {
        Ok(snapshot) => snapshot,
        Err(error) => return text_response(StatusCode::INTERNAL_SERVER_ERROR, &error),
    };

    let stream = stream::unfold(
        (app_handle, connection_token, instance_id, rx, Some(initial_snapshot)),
        |(app_handle, connection_token, instance_id, mut rx, initial_snapshot)| async move {
            if !is_valid_sse_session(&app_handle, &connection_token, &instance_id).await {
                return None;
            }

            let next_bytes = if let Some(snapshot) = initial_snapshot {
                sse_snapshot_bytes(&snapshot)
            } else {
                match timeout(
                    Duration::from_secs(COMPANION_SSE_HEARTBEAT_SECS),
                    rx.changed(),
                )
                .await
                {
                    Ok(Ok(())) => {
                        if !is_valid_sse_session(&app_handle, &connection_token, &instance_id).await {
                            return None;
                        }
                        let snapshot = rx.borrow_and_update().clone();
                        sse_snapshot_bytes(&snapshot)
                    }
                    Ok(Err(_)) => return None,
                    Err(_) => Bytes::from_static(b"event: heartbeat\ndata: {}\n\n"),
                }
            };

            Some((
                Ok::<Frame<Bytes>, Infallible>(Frame::data(next_bytes)),
                (app_handle, connection_token, instance_id, rx, None),
            ))
        },
    );

    let body = StreamBody::new(stream).boxed();
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        CONTENT_TYPE,
        "text/event-stream; charset=utf-8".parse().unwrap(),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(CONNECTION, "keep-alive".parse().unwrap());
    response
        .headers_mut()
        .insert(REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
        .headers_mut()
        .insert("X-Content-Type-Options", "nosniff".parse().unwrap());
    response
}

async fn companion_health_json(app_handle: &AppHandle) -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let status = get_server_status(app_handle).await.unwrap_or_default();
    serde_json::json!({
        "ok": true,
        "name": "HackInterviewAI companion",
        "enabled": status.enabled,
        "port": status.port,
        "timestamp_ms": now_ms,
    })
    .to_string()
}

async fn companion_manifest_response(
    app_handle: &AppHandle,
    uri: &hyper::Uri,
) -> Response<CompanionBody> {
    let Some(token) = parse_query_token(uri) else {
        return text_response(StatusCode::UNAUTHORIZED, "Missing token");
    };

    if !is_valid_token(app_handle, &token).await {
        return text_response(StatusCode::FORBIDDEN, "Forbidden");
    }

    let body = serde_json::json!({
        "name": "HackInterview Companion",
        "short_name": "Companion",
        "description": "Local companion controls for HackInterview",
        "id": "/companion",
        "start_url": format!("/c/{}", urlencoding::encode(&token)),
        "scope": "/",
        "display": "standalone",
        "display_override": ["standalone", "browser"],
        "background_color": "#08111f",
        "theme_color": "#0f172a",
        "orientation": "portrait",
        "icons": [
            {
                "src": "/companion-icon-128.png",
                "sizes": "128x128",
                "type": "image/png"
            },
            {
                "src": "/companion-icon-512.png",
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "any maskable"
            }
        ]
    })
    .to_string();

    let mut response = bytes_response(
        StatusCode::OK,
        Bytes::from(body),
        "application/manifest+json",
    );
    let _ = response
        .headers_mut()
        .insert(CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

fn companion_icon_response(bytes: &'static [u8]) -> Response<CompanionBody> {
    let mut response = bytes_response(StatusCode::OK, Bytes::from_static(bytes), "image/png");
    let _ = response.headers_mut().insert(
        CACHE_CONTROL,
        "public, max-age=31536000, immutable".parse().unwrap(),
    );
    response
}

fn is_companion_frontend_asset_path(path: &str) -> bool {
    path.starts_with("/assets/")
        || path.starts_with("/src/")
        || path.starts_with("/node_modules/")
        || path.starts_with("/@id/")
        || path.starts_with("/@fs/")
        || path.starts_with("/@vite/")
}

async fn serve_companion_frontend(
    app_handle: &AppHandle,
    uri: &hyper::Uri,
) -> Response<CompanionBody> {
    #[cfg(debug_assertions)]
    if app_handle.config().build.dev_url.is_some() {
        return proxy_companion_frontend_dev(app_handle, uri).await;
    }

    serve_companion_frontend_asset(app_handle, uri)
}

#[cfg(debug_assertions)]
async fn proxy_companion_frontend_dev(
    app_handle: &AppHandle,
    uri: &hyper::Uri,
) -> Response<CompanionBody> {
    let Some(base_url) = app_handle.config().build.dev_url.clone() else {
        return text_response(
            StatusCode::BAD_GATEWAY,
            "Companion dev frontend is not configured",
        );
    };

    let mut target_url = match base_url.join(uri.path().trim_start_matches('/')) {
        Ok(url) => url,
        Err(err) => {
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to build companion dev URL: {}", err),
            );
        }
    };
    target_url.set_query(uri.query());

    let response = match companion_proxy_client().get(target_url).send().await {
        Ok(response) => response,
        Err(err) => {
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to load companion frontend from Vite: {}", err),
            );
        }
    };

    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let cache_control = response
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let mut body = match response.bytes().await {
        Ok(bytes) => bytes.to_vec(),
        Err(err) => {
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to read companion frontend response: {}", err),
            );
        }
    };

    if uri.path() == "/companion.html" && content_type.starts_with("text/html") {
        let html = strip_vite_hmr_client(&String::from_utf8_lossy(&body));
        body = inject_companion_pwa_manifest_href(&html, uri).into_bytes();
    }

    let mut response = bytes_response(status, Bytes::from(body), &content_type);
    if uri.path() == "/companion.html" {
        let _ = response
            .headers_mut()
            .insert(CACHE_CONTROL, "no-store".parse().unwrap());
    }
    if uri.path() != "/companion.html" {
        if let Some(cache_control) = cache_control {
            let _ = response
                .headers_mut()
                .insert(CACHE_CONTROL, cache_control.parse().unwrap());
        }
    }
    response
}

#[cfg(not(debug_assertions))]
async fn proxy_companion_frontend_dev(
    _app_handle: &AppHandle,
    _uri: &hyper::Uri,
) -> Response<CompanionBody> {
    text_response(
        StatusCode::NOT_FOUND,
        "Companion dev frontend is not available in release mode",
    )
}

fn serve_companion_frontend_asset(
    app_handle: &AppHandle,
    uri: &hyper::Uri,
) -> Response<CompanionBody> {
    let path = uri.path();
    let asset_key = if path == "/" || path.is_empty() {
        "companion.html".to_string()
    } else {
        path.trim_start_matches('/').to_string()
    };

    match app_handle.asset_resolver().get(asset_key) {
        Some(asset) => {
            let mime_type = asset.mime_type().to_string();
            let csp_header = asset.csp_header().map(str::to_string);
            let bytes = if content_type_is_html(&mime_type)
                && (path == "/companion.html" || path == "/" || path.is_empty())
            {
                let html = String::from_utf8_lossy(&asset.bytes);
                Bytes::from(inject_companion_pwa_manifest_href(&html, uri).into_bytes())
            } else {
                Bytes::from(asset.bytes)
            };
            let mut response = bytes_response(StatusCode::OK, bytes, &mime_type);
            if path == "/companion.html" || path == "/" || path.is_empty() {
                let _ = response
                    .headers_mut()
                    .insert(CACHE_CONTROL, "no-store".parse().unwrap());
            }
            if let Some(csp_header) = csp_header {
                let _ = response
                    .headers_mut()
                    .insert("Content-Security-Policy", csp_header.parse().unwrap());
            }
            response
        }
        None => text_response(StatusCode::NOT_FOUND, "Frontend asset not found"),
    }
}

fn strip_vite_hmr_client(html: &str) -> String {
    html.lines()
        .filter(|line| !line.contains("/@vite/client"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn content_type_is_html(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .map(|value| value.trim().eq_ignore_ascii_case("text/html"))
        .unwrap_or(false)
}

fn companion_manifest_href(uri: &hyper::Uri) -> String {
    match parse_query_token(uri) {
        Some(token) if !token.trim().is_empty() => {
            format!(
                "/manifest.webmanifest?token={}",
                urlencoding::encode(&token)
            )
        }
        _ => "/manifest.webmanifest".to_string(),
    }
}

fn inject_companion_pwa_manifest_href(html: &str, uri: &hyper::Uri) -> String {
    let manifest_href = companion_manifest_href(uri);
    html.replace(
        r#"<link rel="manifest" href="/manifest.webmanifest" />"#,
        &format!(r#"<link rel="manifest" href="{}" />"#, manifest_href),
    )
}

fn companion_proxy_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("companion proxy client")
    })
}

/// The identity challenge never contains an access token. It proves that
/// the listener at the discovered port knows the persisted private token.
fn companion_identity_proof(token: &str, instance_id: &str, port: u16, nonce: &str) -> String {
    // Bind proof to the *actual* listener port. A process occupying 43821
    // cannot relay a valid identity challenge to Companion on fallback 43822.
    let value = format!("hack-interview-companion/v2:{token}:{instance_id}:{port}:{nonce}");
    hex::encode(Sha256::digest(value.as_bytes()))
}

async fn companion_identity_response(
    app_handle: &AppHandle,
    uri: &hyper::Uri,
) -> Response<CompanionBody> {
    let nonce = uri.query()
        .and_then(|query| serde_urlencoded::from_str::<IdentityQuery>(query).ok())
        .map(|query| query.nonce);
    let Some(nonce) = nonce.filter(|value| {
        value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) else {
        return text_response(StatusCode::BAD_REQUEST, "Invalid identity nonce");
    };

    let Some(state) = app_handle.try_state::<AppState>() else {
        return text_response(StatusCode::SERVICE_UNAVAILABLE, "Companion unavailable");
    };
    let runtime = state.companion_runtime.read().await.clone();
    if !*runtime.enabled.read().await {
        return text_response(StatusCode::SERVICE_UNAVAILABLE, "Companion disabled");
    }
    let Some(instance_id) = runtime.instance_id.read().await.clone() else {
        return text_response(StatusCode::SERVICE_UNAVAILABLE, "Companion unavailable");
    };
    let token = runtime.security_token.read().await.clone();
    let Some(port) = *runtime.port.read().await else {
        return text_response(StatusCode::SERVICE_UNAVAILABLE, "Companion not bound");
    };
    json_response(
        StatusCode::OK,
        serde_json::json!({
            "service": "hack-interview-companion",
            "schemaVersion": 2,
            "instanceId": instance_id,
            "proof": companion_identity_proof(&token, &instance_id, port, &nonce),
        }).to_string(),
    )
}

fn generate_security_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

async fn is_valid_token(app_handle: &AppHandle, candidate: &str) -> bool {
    if candidate.trim().is_empty() {
        return false;
    }

    let state = match app_handle.try_state::<AppState>() {
        Some(state) => state,
        None => return false,
    };
    let runtime = state.companion_runtime.read().await.clone();
    let enabled = *runtime.enabled.read().await;
    let token = runtime.security_token.read().await.clone();
    enabled && token == candidate
}

fn parse_query_token(uri: &hyper::Uri) -> Option<String> {
    let query = uri.query()?;
    serde_urlencoded::from_str::<TokenQuery>(query)
        .ok()
        .map(|value| value.token)
}

fn parse_header_token(headers: &hyper::HeaderMap) -> Option<String> {
    headers
        .get(COMPANION_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_request_id(headers: &hyper::HeaderMap) -> Option<String> {
    headers
        .get(COMPANION_REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
}

fn has_json_content_type(headers: &hyper::HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().starts_with("application/json"))
        .unwrap_or(false)
}

/// Avoid unbounded buffering of uploads from phone/extension clients. The
/// limit applies to streamed bodies as well as a declared Content-Length.
async fn collect_bounded_body<B>(
    mut body: B,
    max_bytes: usize,
) -> Result<Vec<u8>, StatusCode>
where
    B: hyper::body::Body<Data = Bytes> + Unpin,
{
    let mut collected = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| StatusCode::BAD_REQUEST)?;
        if let Ok(chunk) = frame.into_data() {
            if chunk.len() > max_bytes.saturating_sub(collected.len()) {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            collected.extend_from_slice(&chunk);
        }
    }
    Ok(collected)
}

async fn read_json_body<T: DeserializeOwned>(
    req: Request<Incoming>,
) -> Result<T, Response<CompanionBody>> {
    let bytes = match timeout(
        Duration::from_secs(COMPANION_REQUEST_BODY_TIMEOUT_SECS),
        collect_bounded_body(req.into_body(), COMPANION_MAX_REQUEST_BODY_BYTES),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(StatusCode::PAYLOAD_TOO_LARGE)) => {
            return Err(text_response(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"));
        }
        Ok(Err(_)) => {
            return Err(text_response(StatusCode::BAD_REQUEST, "Failed to read request body"));
        }
        Err(_) => {
            return Err(text_response(StatusCode::REQUEST_TIMEOUT, "Request body timed out"));
        }
    };

    if bytes.is_empty() {
        return serde_json::from_value(serde_json::json!({}))
            .map_err(|_| text_response(StatusCode::BAD_REQUEST, "Malformed JSON"));
    }
    serde_json::from_slice::<T>(&bytes)
        .map_err(|_| text_response(StatusCode::BAD_REQUEST, "Malformed JSON"))
}

async fn emit_invalidation(app_handle: &AppHandle, revision: String) {
    let _ = app_handle.emit(
        EVENT_STATE_SYNC_INVALIDATION,
        StateSyncInvalidationPayload {
            topic: COMPANION_TOPIC.to_string(),
            revision,
            source_id: Some("companion".to_string()),
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
        },
    );
}

/// A port collision is not evidence that the listener belongs to this app.
/// Never terminate a process merely because it is using our preferred port.
async fn bind_listener() -> std::io::Result<TcpListener> {
    bind_listener_with_ports(COMPANION_PORT, &COMPANION_FALLBACK_PORT_CANDIDATES).await
}

async fn bind_listener_with_ports(
    preferred_port: u16,
    fallback_ports: &[u16],
) -> std::io::Result<TcpListener> {
    match bind_companion_port(preferred_port).await {
        Ok(listener) => return Ok(listener),
        Err(error) => log::warn!(
            "Companion preferred port {} unavailable ({}); trying a fallback without interrupting its owner",
            preferred_port,
            error
        ),
    }

    for &port in fallback_ports {
        match bind_companion_port(port).await {
            Ok(listener) => {
                log::warn!(
                    "Companion falling back to port {} because preferred port {} is unavailable",
                    port,
                    preferred_port
                );
                return Ok(listener);
            }
            Err(error) => {
                log::warn!("Companion fallback port {} unavailable: {}", port, error);
            }
        }
    }

    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
    if let Ok(addr) = listener.local_addr() {
        log::warn!(
            "Companion using OS-assigned port {} because preferred port {} is unavailable",
            addr.port(),
            preferred_port
        );
    }
    Ok(listener)
}

async fn bind_companion_port(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await
}

fn sse_snapshot_bytes(snapshot: &CompanionSnapshotEnvelope) -> Bytes {
    let data = serde_json::to_string(snapshot).unwrap_or_else(|_| "{}".to_string());
    Bytes::from(format!(
        "id: {}\nevent: snapshot\nretry: {}\ndata: {}\n\n",
        snapshot.revision, COMPANION_SSE_RETRY_MS, data
    ))
}

fn json_response(status: StatusCode, body: String) -> Response<CompanionBody> {
    response_with_headers(
        status,
        body,
        "application/json; charset=utf-8",
        &[("Cache-Control", "no-store")],
    )
}

fn redirect_response(location: &str) -> Response<CompanionBody> {
    let mut response = empty_response(StatusCode::FOUND);
    let _ = response
        .headers_mut()
        .insert(LOCATION, location.parse().unwrap());
    response
}

fn text_response(status: StatusCode, body: &str) -> Response<CompanionBody> {
    response_with_headers(
        status,
        body.to_string(),
        "text/plain; charset=utf-8",
        &[("Cache-Control", "no-store")],
    )
}

fn stale_companion_link_response() -> Response<CompanionBody> {
    let body = r##"<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0f172a" />
    <meta http-equiv="refresh" content="5" />
    <title>Companion link expired</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #08111f;
        color: #e5eefb;
      }
      main {
        width: min(100%, 420px);
        border: 1px solid rgba(148, 163, 184, 0.26);
        border-radius: 8px;
        padding: 22px;
        background: rgba(15, 23, 42, 0.92);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 20px;
        line-height: 1.25;
        letter-spacing: 0;
      }
      p {
        margin: 0;
        color: #b8c4d8;
        font-size: 15px;
        line-height: 1.5;
      }
      p + p { margin-top: 12px; }
      strong { color: #ffffff; font-weight: 650; }
    </style>
  </head>
  <body>
    <main>
      <h1>Companion ссылка устарела</h1>
      <p>Эта PWA открылась со старым token. Доступ к данным закрыт, поэтому приложение не подставляет новый token автоматически.</p>
      <p>Открой окно приложения на компьютере, нажми <strong>Телефон</strong> и обнови ссылку. Если token восстановился из локального bridge-файла, эта страница сама переподключится после обновления.</p>
    </main>
  </body>
</html>"##;

    response_with_headers(
        StatusCode::FORBIDDEN,
        body.to_string(),
        "text/html; charset=utf-8",
        &[("Cache-Control", "no-store")],
    )
}

fn empty_response(status: StatusCode) -> Response<CompanionBody> {
    let mut response = Response::new(empty_body());
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("X-Content-Type-Options", "nosniff".parse().unwrap());
    response
}

fn without_body(response: Response<CompanionBody>) -> Response<CompanionBody> {
    let status = response.status();
    let headers = response.headers().clone();
    let mut head_only = Response::new(empty_body());
    *head_only.status_mut() = status;
    *head_only.headers_mut() = headers;
    head_only
}

fn response_with_headers(
    status: StatusCode,
    body: String,
    content_type: &str,
    extra_headers: &[(&str, &str)],
) -> Response<CompanionBody> {
    let mut response = Response::new(full_body(body));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, content_type.parse().unwrap());

    for (name, value) in extra_headers {
        response.headers_mut().insert(
            name.parse::<hyper::header::HeaderName>().unwrap(),
            value.parse().unwrap(),
        );
    }

    if !response.headers().contains_key(REFERRER_POLICY) {
        let _ = response
            .headers_mut()
            .insert(REFERRER_POLICY, "no-referrer".parse().unwrap());
    }
    let _ = response
        .headers_mut()
        .insert("X-Content-Type-Options", "nosniff".parse().unwrap());

    response
}

fn full_body(body: String) -> CompanionBody {
    Full::new(Bytes::from(body))
        .map_err(|never| match never {})
        .boxed()
}

fn bytes_response(status: StatusCode, body: Bytes, content_type: &str) -> Response<CompanionBody> {
    let mut response = Response::new(Full::new(body).map_err(|never| match never {}).boxed());
    *response.status_mut() = status;
    let _ = response
        .headers_mut()
        .insert(CONTENT_TYPE, content_type.parse().unwrap());
    let _ = response
        .headers_mut()
        .insert(REFERRER_POLICY, "no-referrer".parse().unwrap());
    let _ = response
        .headers_mut()
        .insert("X-Content-Type-Options", "nosniff".parse().unwrap());
    response
}

fn empty_body() -> CompanionBody {
    Full::new(Bytes::new())
        .map_err(|never| match never {})
        .boxed()
}

fn detect_primary_ipv4() -> Option<Ipv4Addr> {
    #[cfg(target_os = "windows")]
    if let Some(ip) = detect_windows_lan_ipv4() {
        return Some(ip);
    }

    detect_routed_ipv4()
}

fn detect_routed_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;

    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_lan_ipv4() -> Option<Ipv4Addr> {
    let script = r#"
$ErrorActionPreference='SilentlyContinue'
Get-NetIPConfiguration | Where-Object { $_.IPv4Address } | ForEach-Object {
  $ip = ($_.IPv4Address | Where-Object {
    $_.IPAddress -and $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*'
  } | Select-Object -First 1 -ExpandProperty IPAddress)
  $gateway = ($_.IPv4DefaultGateway | Select-Object -First 1 -ExpandProperty NextHop)
  if ($ip) {
    '{0}|{1}|{2}|{3}' -f $_.InterfaceAlias, $_.InterfaceDescription, $ip, $gateway
  }
}
"#;

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut best: Option<(i32, Ipv4Addr, String)> = None;

    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 4 {
            continue;
        }

        let alias = parts[0].trim();
        let description = parts[1].trim();
        let Ok(ip) = parts[2].trim().parse::<Ipv4Addr>() else {
            continue;
        };
        let gateway = parts[3].trim();

        if !is_usable_companion_ipv4(ip) {
            continue;
        }

        let label = format!("{} {}", alias, description).to_lowercase();
        if is_virtual_or_vpn_adapter(&label) {
            continue;
        }

        let mut score = 0;
        if !gateway.is_empty() {
            score += 100;
        }
        if label.contains("wi-fi")
            || label.contains("wifi")
            || label.contains("wireless")
            || label.contains("wlan")
            || label.contains("беспровод")
        {
            score += 50;
        }
        if label.contains("ethernet")
            || label.contains("gigabit")
            || label.contains("controller")
            || label.contains("killer")
        {
            score += 30;
        }
        if ip.octets()[0] == 192 && ip.octets()[1] == 168 {
            score += 20;
        } else if ip.octets()[0] == 172 && (16..=31).contains(&ip.octets()[1]) {
            score += 15;
        } else if ip.octets()[0] == 10 {
            score += 10;
        }

        let candidate_label = format!("{} ({})", ip, alias);
        if best
            .as_ref()
            .map_or(true, |(best_score, _, _)| score > *best_score)
        {
            best = Some((score, ip, candidate_label));
        }
    }

    if let Some((_, ip, label)) = best {
        log::info!("Companion selected LAN IPv4 for phone QR: {}", label);
        Some(ip)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn is_virtual_or_vpn_adapter(label: &str) -> bool {
    [
        "vpn",
        "wireguard",
        "wintun",
        "tap",
        "tun ",
        "tailscale",
        "zerotier",
        "hamachi",
        "vmware",
        "virtualbox",
        "host-only",
        "virtual",
        "hyper-v",
        "wsl",
        "docker",
        "loopback",
        "bluetooth",
        "npcap",
        "container",
        "vethernet",
    ]
    .iter()
    .any(|needle| label.contains(needle))
}

#[cfg(target_os = "windows")]
fn is_usable_companion_ipv4(ip: Ipv4Addr) -> bool {
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast())
}

#[cfg(test)]
mod companion_request_body_tests {
    use super::*;

    #[tokio::test]
    async fn streamed_request_is_rejected_when_the_total_exceeds_the_limit() {
        let chunks = stream::iter([
            Ok::<_, Infallible>(Frame::data(Bytes::from_static(b"123"))),
            Ok::<_, Infallible>(Frame::data(Bytes::from_static(b"456"))),
        ]);
        let body = StreamBody::new(chunks);

        let result = collect_bounded_body(body, 5).await;

        assert!(matches!(result, Err(StatusCode::PAYLOAD_TOO_LARGE)));
    }

    #[tokio::test]
    async fn request_exactly_at_limit_is_accepted() {
        let body = Full::new(Bytes::from_static(br#"{"ok":true}"#));
        let bytes = collect_bounded_body(body, 11).await.unwrap();

        assert_eq!(&bytes, br#"{"ok":true}"#);
    }
}

#[cfg(test)]
mod companion_identity_tests {
    use super::*;

    #[test]
    fn proof_binds_nonce_token_and_runtime_instance() {
        let proof = companion_identity_proof("private-token", "instance-a", 43822, "abcd1234abcd1234abcd1234abcd1234");
        assert_eq!(proof.len(), 64);
        assert!(proof.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(proof, companion_identity_proof("private-token", "instance-b", 43822, "abcd1234abcd1234abcd1234abcd1234"));
        assert_ne!(proof, companion_identity_proof("other-token", "instance-a", 43822, "abcd1234abcd1234abcd1234abcd1234"));
        assert_ne!(proof, companion_identity_proof("private-token", "instance-a", 43821, "abcd1234abcd1234abcd1234abcd1234"));
        assert_ne!(proof, companion_identity_proof("private-token", "instance-a", 43822, "ffff1234abcd1234abcd1234abcd1234"));
    }
}

#[cfg(test)]
mod companion_port_fallback_tests {
    use super::*;

    #[tokio::test]
    async fn occupied_preferred_port_falls_back_without_interrupting_its_owner() {
        let original_listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.unwrap();
        let occupied_port = original_listener.local_addr().unwrap().port();

        // This is a real TCP socket: the original listener stays alive and
        // reachable after the companion has selected a replacement port.
        let companion_listener = bind_listener_with_ports(occupied_port, &[])
            .await
            .expect("select an OS-assigned fallback port");
        assert_ne!(companion_listener.local_addr().unwrap().port(), occupied_port);

        let connection = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, occupied_port))
            .await
            .expect("existing application must remain reachable");
        let (_, _) = timeout(Duration::from_secs(2), original_listener.accept())
            .await
            .expect("existing listener must not be interrupted")
            .expect("existing listener accepts TCP");
        drop(connection);
    }
}

#[cfg(test)]
mod local_stt_snapshot_tests {
    use super::*;
    use crate::domain::{SttProviderType, Transcription};
    use crate::presentation::events::FinalTranscriptionPayload;
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn local_stt_final_is_visible_in_mobile_snapshot_and_sse() {
        let state = AppState::default();
        let session_id = 19;
        state.config.write().await.stt.provider = SttProviderType::ParakeetUltra;
        state.active_transcription_session_id.store(session_id, Ordering::Relaxed);

        // Separate microphone and system utterances, as produced by the two
        // native Parakeet providers after VAD endpointing.
        crate::presentation::companion_timeline::on_microphone_final(
            &state,
            &FinalTranscriptionPayload {
                session_id,
                source: "microphone".to_string(),
                text: "Я применял Go context".to_string(),
                confidence: None,
                language: Some("ru".to_string()),
                timestamp: chrono::Utc::now().timestamp_millis(),
                start: 0.0,
                duration: 1.5,
            },
        ).await;

        crate::presentation::companion_timeline::append_system_final(
            &state, session_id,
            &Transcription::final_result("How do you handle cancellations?".to_string()),
        ).await;

        let snapshot = build_snapshot_data(&state).await.expect("mobile snapshot");
        let mic = snapshot.timeline.iter().filter(|x| x.kind == CompanionMessageKind::Mic)
            .collect::<Vec<_>>();
        let system = snapshot.timeline.iter().filter(|x| x.kind == CompanionMessageKind::Stt)
            .collect::<Vec<_>>();

        assert_eq!(mic.len(), 1, "mobile must contain exactly one local mic final");
        assert_eq!(system.len(), 1, "mobile must contain exactly one system final");
        assert_eq!(mic[0].text, "Я применял Go context");
        assert_eq!(system[0].text, "How do you handle cancellations?");

        let envelope = CompanionSnapshotEnvelope {
            revision: "42".to_string(),
            data: snapshot,
        };
        let sse = String::from_utf8(sse_snapshot_bytes(&envelope).to_vec()).unwrap();
        assert!(sse.starts_with("id: 42\nevent: snapshot\n"));
        assert!(sse.contains("Я применял Go context"));
        assert!(sse.contains("How do you handle cancellations?"));
        assert_eq!(sse.matches("Я применял Go context").count(), 1);
    }
}

#[cfg(test)]
mod idempotency_tests {
    use super::*;
    use crate::presentation::companion_actions::CompanionActionResponse;

    #[test]
    fn action_cache_marks_duplicate_in_flight_as_busy() {
        let mut cache = CompanionActionIdempotencyCache::default();
        assert!(matches!(
            cache.begin("token:req:/api/record/start".to_string()),
            CompanionActionIdempotencyDecision::Start(_)
        ));
        assert!(matches!(
            cache.begin("token:req:/api/record/start".to_string()),
            CompanionActionIdempotencyDecision::InFlight
        ));
    }

    #[test]
    fn action_cache_returns_completed_result_without_restart() {
        let mut cache = CompanionActionIdempotencyCache::default();
        let key = match cache.begin("token:req:/api/record/start".to_string()) {
            CompanionActionIdempotencyDecision::Start(key) => key,
            other => panic!("unexpected decision: {other:?}"),
        };
        let response = CompanionActionResponse {
            ok: true,
            action_result: "started_recording".to_string(),
            snapshot: CompanionSnapshotEnvelope::default(),
        };
        cache.complete(key, &response);

        match cache.begin("token:req:/api/record/start".to_string()) {
            CompanionActionIdempotencyDecision::Completed(cached) => {
                assert!(cached.ok);
                assert_eq!(cached.action_result, "started_recording");
            }
            other => panic!("unexpected decision: {other:?}"),
        }
    }

    #[test]
    fn request_id_header_accepts_compact_ascii_ids_only() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(COMPANION_REQUEST_ID_HEADER, "abc-123_X".parse().unwrap());
        assert_eq!(parse_request_id(&headers).as_deref(), Some("abc-123_X"));

        headers.insert(COMPANION_REQUEST_ID_HEADER, "bad id".parse().unwrap());
        assert_eq!(parse_request_id(&headers), None);
    }
}

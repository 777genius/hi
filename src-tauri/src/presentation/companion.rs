use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{watch, RwLock};
use tokio::time::timeout;

use crate::domain::RecordingStatus;
use crate::presentation::events::{
    MicrophoneMuteStatePayload, StateSyncInvalidationPayload, EVENT_STATE_SYNC_INVALIDATION,
};
use crate::presentation::AppState;

const COMPANION_PORT_CANDIDATES: [u16; 3] = [43821, 43822, 43823];
const COMPANION_SSE_RETRY_MS: u64 = 1500;
const COMPANION_SSE_HEARTBEAT_SECS: u64 = 15;
const COMPANION_TOPIC: &str = "companion-ui";
pub const LIVE_STT_MESSAGE_ID: &str = "stt:live";

type CompanionBody = BoxBody<Bytes, Infallible>;
const COMPANION_TOKEN_HEADER: &str = "x-companion-token";

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
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionControlState {
    pub history_floor_seq: u64,
    pub context_floor_seq: u64,
    pub conversation_generation: u64,
    pub companion_mode_enabled: bool,
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
pub struct CompanionAttachment {
    pub id: String,
    pub kind: String,
    pub mime: String,
    pub data_url: String,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionMessage {
    pub id: String,
    pub seq: u64,
    pub kind: String,
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
    #[serde(skip_serializing_if = "is_false")]
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<CompanionAttachment>>,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSnapshot {
    pub auth_required: bool,
    pub recording: CompanionRecordingState,
    pub microphone: CompanionMicrophoneState,
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
    pub sse_tx: watch::Sender<CompanionSnapshotEnvelope>,
    pub security_token: Arc<RwLock<String>>,
    pub enabled: Arc<RwLock<bool>>,
    pub port: Arc<RwLock<Option<u16>>>,
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    token: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CompanionAiRequestBody {
    #[serde(default)]
    text: Option<String>,
}

pub fn new_runtime() -> CompanionRuntime {
    let snapshot = CompanionSnapshotEnvelope::default();
    let (sse_tx, _sse_rx) = watch::channel(snapshot.clone());

    CompanionRuntime {
        snapshot: Arc::new(RwLock::new(snapshot)),
        sse_tx,
        security_token: Arc::new(RwLock::new(generate_security_token())),
        enabled: Arc::new(RwLock::new(false)),
        port: Arc::new(RwLock::new(None)),
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
        return Ok(token);
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

    Ok(token)
}

pub async fn reset_session_timeline(state: &AppState) {
    crate::presentation::companion_timeline::reset_session_state(state).await;
    state.history.write().await.clear();
    *state.partial_transcription.write().await = None;
    *state.final_transcription.write().await = None;
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
    let revision = state.companion_revision.read().await.to_string();
    let data = build_snapshot_data(state.inner()).await?;
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
    if let Some(url) = status.local_network_url.as_deref() {
        log::info!("Companion server ready - phone URL: {}", url);
        return;
    }

    if let Some(url) = status.local_url.as_deref() {
        log::info!("Companion server ready - local URL: {}", url);
        return;
    }

    log::info!("Companion server started, but URL is not available yet");
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
    let revision = AppState::bump_revision(&state.companion_revision).await;
    let data = build_snapshot_data(state.inner()).await?;
    let envelope = CompanionSnapshotEnvelope {
        revision: revision.clone(),
        data,
    };

    let runtime = state.companion_runtime.read().await.clone();
    *runtime.snapshot.write().await = envelope.clone();
    let _ = runtime.sse_tx.send(envelope.clone());

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
    *runtime.enabled.write().await = true;
    *runtime.port.write().await = Some(port);
    *runtime.security_token.write().await = token;

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
    *runtime.enabled.write().await = false;
    *runtime.port.write().await = None;

    drop(_guard);
    let _ = publish_snapshot(app_handle).await;
    Ok(())
}

async fn build_snapshot_data(state: &AppState) -> Result<CompanionSnapshot, String> {
    let runtime = state.companion_runtime.read().await.clone();
    let companion_mode_enabled = *runtime.enabled.read().await;

    let microphone_payload = crate::presentation::commands::get_microphone_mute_state()
        .await
        .unwrap_or(MicrophoneMuteStatePayload {
            muted: false,
            supported: false,
            source: "unknown".to_string(),
            detail: None,
        });

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
    let timeline = state
        .companion_timeline
        .read()
        .await
        .iter()
        .filter(|item| item.seq > history_floor_seq)
        .cloned()
        .collect();

    Ok(CompanionSnapshot {
        auth_required: !*state.is_authenticated.read().await,
        recording: CompanionRecordingState {
            status: recording_status,
            active_session_id,
        },
        microphone: CompanionMicrophoneState {
            muted: microphone_payload.muted,
            enabled: !microphone_payload.muted,
            supported: microphone_payload.supported,
            source: microphone_payload.source,
        },
        controls: CompanionControlState {
            history_floor_seq,
            context_floor_seq,
            conversation_generation,
            companion_mode_enabled,
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

    loop {
        let (stream, peer) = listener
            .accept()
            .await
            .map_err(|e| format!("Companion server accept failed: {}", e))?;
        log::debug!("Companion server accepted connection from {}", peer);

        let app_handle_for_conn = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let io = TokioIo::new(stream);
            let service = service_fn(move |req| route_request(app_handle_for_conn.clone(), req));
            if let Err(err) = http1::Builder::new().serve_connection(io, service).await {
                log::debug!("Companion connection error: {}", err);
            }
        });
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
                    match build_current_snapshot(&app_handle).await {
                        Ok(initial_snapshot) => {
                            sse_response(app_handle.clone(), token, initial_snapshot).await
                        }
                        Err(err) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &err),
                    }
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
        (Method::POST, "/api/context/clear") => {
            handle_mutating_post(app_handle.clone(), req, "context_clear").await
        }
        (Method::POST, "/api/history/clear") => {
            handle_mutating_post(app_handle.clone(), req, "history_clear").await
        }
        (Method::POST, "/api/ai/request") => handle_ai_request_post(app_handle.clone(), req).await,
        (Method::HEAD, path) if path.starts_with("/c/") => {
            let token = path.trim_start_matches("/c/").to_string();
            if is_valid_token(&app_handle, &token).await {
                without_body(redirect_response(&format!(
                    "/companion.html?token={}",
                    urlencoding::encode(&token)
                )))
            } else {
                text_response(StatusCode::FORBIDDEN, "Forbidden")
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
                text_response(StatusCode::FORBIDDEN, "Forbidden")
            }
        }
        (Method::HEAD, "/companion.html") => match parse_query_token(req.uri()) {
            Some(token) if is_valid_token(&app_handle, &token).await => {
                without_body(serve_companion_frontend(&app_handle, req.uri()).await)
            }
            Some(_) => text_response(StatusCode::FORBIDDEN, "Forbidden"),
            None => text_response(StatusCode::UNAUTHORIZED, "Missing token"),
        },
        (Method::GET, "/companion.html") => match parse_query_token(req.uri()) {
            Some(token) if is_valid_token(&app_handle, &token).await => {
                serve_companion_frontend(&app_handle, req.uri()).await
            }
            Some(_) => text_response(StatusCode::FORBIDDEN, "Forbidden"),
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

async fn handle_mutating_post(
    app_handle: AppHandle,
    req: Request<Incoming>,
    action: &str,
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
    if let Err(response) = read_json_body::<serde_json::Value>(req).await {
        return response;
    }

    let state = match app_handle.try_state::<AppState>() {
        Some(state) => state,
        None => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "AppState not available"),
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
            let status = match response.action_result.as_str() {
                "busy_transition" => StatusCode::CONFLICT,
                "rejected_auth" => StatusCode::UNAUTHORIZED,
                _ => StatusCode::OK,
            };
            json_response(
                status,
                serde_json::to_string(&response).unwrap_or_else(|_| "{}".to_string()),
            )
        }
        Err(err) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn handle_ai_request_post(
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

    let body = match read_json_body::<CompanionAiRequestBody>(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };

    let state = match app_handle.try_state::<AppState>() {
        Some(state) => state,
        None => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "AppState not available"),
    };

    match crate::presentation::companion_actions::request_ai(state.inner(), &app_handle, body.text)
        .await
    {
        Ok(response) => {
            let status = match response.action_result.as_str() {
                "busy_transition" => StatusCode::CONFLICT,
                "rejected_auth" => StatusCode::UNAUTHORIZED,
                _ => StatusCode::OK,
            };
            json_response(
                status,
                serde_json::to_string(&response).unwrap_or_else(|_| "{}".to_string()),
            )
        }
        Err(err) => text_response(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn sse_response(
    app_handle: AppHandle,
    connection_token: String,
    initial_snapshot: CompanionSnapshotEnvelope,
) -> Response<CompanionBody> {
    let state = match app_handle.try_state::<AppState>() {
        Some(state) => state,
        None => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "AppState not available"),
    };
    let runtime = state.companion_runtime.read().await.clone();
    let rx = runtime.sse_tx.subscribe();

    let stream = stream::unfold(
        (app_handle, connection_token, rx, Some(initial_snapshot)),
        |(app_handle, connection_token, mut rx, initial_snapshot)| async move {
            if !is_valid_token(&app_handle, &connection_token).await {
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
                        if !is_valid_token(&app_handle, &connection_token).await {
                            return None;
                        }
                        let snapshot = rx.borrow().clone();
                        sse_snapshot_bytes(&snapshot)
                    }
                    Ok(Err(_)) => return None,
                    Err(_) => Bytes::from_static(b": keepalive\n\n"),
                }
            };

            Some((
                Ok::<Frame<Bytes>, Infallible>(Frame::data(next_bytes)),
                (app_handle, connection_token, rx, None),
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

    serve_companion_frontend_asset(app_handle, uri.path())
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
        body = strip_vite_hmr_client(&String::from_utf8_lossy(&body)).into_bytes();
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

fn serve_companion_frontend_asset(app_handle: &AppHandle, path: &str) -> Response<CompanionBody> {
    let asset_key = if path == "/" || path.is_empty() {
        "companion.html".to_string()
    } else {
        path.trim_start_matches('/').to_string()
    };

    match app_handle.asset_resolver().get(asset_key) {
        Some(asset) => {
            let mime_type = asset.mime_type().to_string();
            let csp_header = asset.csp_header().map(str::to_string);
            let mut response = bytes_response(StatusCode::OK, Bytes::from(asset.bytes), &mime_type);
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

fn companion_proxy_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("companion proxy client")
    })
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

fn has_json_content_type(headers: &hyper::HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().starts_with("application/json"))
        .unwrap_or(false)
}

async fn read_json_body<T: DeserializeOwned>(
    req: Request<Incoming>,
) -> Result<T, Response<CompanionBody>> {
    let collected = req
        .into_body()
        .collect()
        .await
        .map_err(|_| text_response(StatusCode::BAD_REQUEST, "Failed to read request body"))?;
    let bytes = collected.to_bytes();
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

async fn bind_listener() -> std::io::Result<TcpListener> {
    for port in COMPANION_PORT_CANDIDATES {
        match TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await {
            Ok(listener) => return Ok(listener),
            Err(err) => {
                log::warn!("Companion server failed to bind 0.0.0.0:{}: {}", port, err);
            }
        }
    }

    TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await
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
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;

    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

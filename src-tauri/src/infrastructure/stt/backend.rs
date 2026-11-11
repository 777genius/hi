//! Backend STT Provider
//!
//! Подключается к нашему API (api.voicetext.site) вместо прямого подключения к Deepgram.
//! Все транскрипции идут через наш бэкенд с лицензией и usage tracking.

use async_trait::async_trait;
use base64::Engine;
use futures_util::{stream::SplitStream, SinkExt, StreamExt};
use http::Request;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

use crate::domain::{
    AudioChunk, ConnectionQualityCallback, ErrorCallback, SttConfig, SttConnectionCategory,
    SttConnectionDetails, SttConnectionError, SttError, SttProvider, SttResult, Transcription,
    TranscriptionCallback,
};

use super::backend_messages::{ClientMessage, ServerMessage};

/// URL бэкенда для production
const PROD_BACKEND_URL: &str = "wss://api.voicetext.site";

/// URL бэкенда для development (localhost)
const DEV_BACKEND_URL: &str = "ws://localhost:8080";

// Таймауты: критичны для стабильности при плохом интернете.
// Без них connect/send могут "подвиснуть" и UI будет бесконечно ждать.
const WS_CONNECT_TIMEOUT_SECS: u64 = 8;
const WS_SEND_TIMEOUT_SECS: u64 = 3;
const WS_RESUME_GRACE_MS: u64 = 10_000;
const WS_RECONNECT_DELAYS_MS: [u64; 5] = [250, 500, 1000, 2000, 3000];
const REPLAY_BUFFER_MAX_MS: u64 = 10_000;
const REPLAY_BUFFER_MAX_BYTES: usize = 512 * 1024;
const DEFAULT_BACKEND_PROTOCOL_VERSION: u16 = 1;
const LIMIT_REMAINING_THRESHOLD_SECS: f32 = 5.0;

/// Проверяем, что URL указывает на локальный бэкенд (localhost/loopback).
///
/// Нужен для dev-режима: если у пользователя сохранён "боевой" токен, но он запускает
/// локальный бэкенд, тот токен почти наверняка невалиден для local БД/pepper → получаем 401.
fn is_local_backend_url(url: &str) -> bool {
    // Пытаемся распарсить как URI (надёжнее, чем substring).
    if let Ok(uri) = url.parse::<http::Uri>() {
        if let Some(host) = uri.host() {
            return matches!(host, "localhost" | "127.0.0.1" | "::1");
        }
    }

    // Фоллбек на случай нестандартного формата.
    url.contains("localhost") || url.contains("127.0.0.1") || url.contains("[::1]")
}

/// Получить URL бэкенда с учётом окружения
/// Приоритет: env VOICE_TO_TEXT_BACKEND_URL > auto-detect (debug/release)
fn get_default_backend_url() -> String {
    // 1. Проверяем env переменную (для staging, тестов и т.д.)
    if let Ok(url) = std::env::var("VOICE_TO_TEXT_BACKEND_URL") {
        if !url.is_empty() {
            log::info!("Using backend URL from env: {}", url);
            return url;
        }
    }

    // 2. Auto-detect по типу сборки
    if cfg!(debug_assertions) {
        log::info!("Debug build: using dev backend {}", DEV_BACKEND_URL);
        DEV_BACKEND_URL.to_string()
    } else {
        log::info!("Release build: using prod backend {}", PROD_BACKEND_URL);
        PROD_BACKEND_URL.to_string()
    }
}

fn backend_protocol_version() -> u16 {
    std::env::var("VOICE_TO_TEXT_BACKEND_PROTOCOL_V")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(DEFAULT_BACKEND_PROTOCOL_VERSION)
}

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type WsWrite = futures_util::stream::SplitSink<WsStream, Message>;
type WsRead = SplitStream<WsStream>;

/// Callback для обновления usage (seconds_used, seconds_remaining_total_or_plan)
pub type UsageUpdateCallback = Arc<dyn Fn(f32, f32) + Send + Sync>;

/// Backend STT provider — подключается к нашему API вместо прямого Deepgram
pub struct BackendProvider {
    config: Option<SttConfig>,
    is_streaming: bool,
    is_paused: bool,
    auth_token: Option<String>,
    backend_url: String,
    session_id: Arc<Mutex<Option<String>>>,
    ws_write: Option<Arc<Mutex<WsWrite>>>,
    receiver_task: Option<JoinHandle<()>>,
    keepalive_task: Option<JoinHandle<()>>,

    /// Флаг закрытия соединения (атомарный для thread-safety)
    /// Используется для предотвращения race condition при закрытии WebSocket
    is_closed: Arc<AtomicBool>,

    /// Последний известный остаток секунд (из UsageUpdate), хранится как f32 bits.
    /// Доступен и из receiver task, и из send_audio() — нужен чтобы при закрытии
    /// отличать limit_exceeded от обычного обрыва.
    last_remaining_secs: Arc<AtomicU32>,
    last_seq_acked: Arc<AtomicU64>,

    // Callbacks: active/pending (для keep-alive режима).
    //
    // Важно: receiver task живёт дольше одной "записи" (мы держим WS живым между старт/стопами).
    // Поэтому нельзя захватывать callbacks в spawn при start_stream — иначе при resume_stream
    // они не обновятся и события будут уходить в старую "сессию" UI.
    callbacks: Arc<Mutex<CallbackState>>,
    on_usage_update_callback: Option<UsageUpdateCallback>,

    // Статистика
    sent_chunks_count: usize,
    sent_bytes_total: usize,
    next_audio_seq: u64,
    replay_buffer: Vec<ReplayFrame>,
    replay_buffer_bytes: usize,

    audio_batch: Vec<u8>,
    audio_batch_frames: usize,

    next_send_at: Option<std::time::Instant>,
    batch_started_at: Option<std::time::Instant>,
}

#[derive(Clone)]
struct ReplayFrame {
    seq: u64,
    bytes: Vec<u8>,
    captured_at: Instant,
}

#[derive(Clone)]
struct CallbackSet {
    on_partial: TranscriptionCallback,
    on_final: TranscriptionCallback,
    on_error: ErrorCallback,
    on_connection_quality: ConnectionQualityCallback,
}

#[derive(Default)]
struct CallbackState {
    active: Option<CallbackSet>,
    pending: Option<CallbackSet>,
    // При keep-alive: новые callbacks активируем только после первого ACK,
    // чтобы "поздние" сообщения от предыдущей записи не попадали в новую UI-сессию.
    swap_on_next_ack: bool,
    // Защита от "поздних" ACK старой записи:
    // активируем pending только когда получили ACK с seq БОЛЬШЕ последнего отправленного seq на момент resume_stream.
    swap_after_seq: u64,
}

impl CallbackState {
    fn error_callback(&self) -> Option<ErrorCallback> {
        if self.swap_on_next_ack {
            if let Some(pending) = self.pending.as_ref() {
                return Some(pending.on_error.clone());
            }
        }
        self.active.as_ref().map(|c| c.on_error.clone())
    }

    fn connection_quality_callback(&self) -> Option<ConnectionQualityCallback> {
        if self.swap_on_next_ack {
            if let Some(pending) = self.pending.as_ref() {
                return Some(pending.on_connection_quality.clone());
            }
        }
        self.active
            .as_ref()
            .map(|c| c.on_connection_quality.clone())
    }
}

fn category_for_server_error(code: &str) -> SttConnectionCategory {
    match code {
        "timeout" | "TIMEOUT" => SttConnectionCategory::Timeout,
        "rate_limit" | "too_many_sessions" | "RATE_LIMIT_EXCEEDED" | "TOO_MANY_SESSIONS" => {
            SttConnectionCategory::RateLimited
        }
        "LIMIT_EXCEEDED" => SttConnectionCategory::LimitExceeded,
        "PROVIDER_UNAVAILABLE" | "PROVIDER_ERROR" | "INTERNAL_ERROR" => {
            SttConnectionCategory::ServerUnavailable
        }
        _ => SttConnectionCategory::Unknown,
    }
}

fn server_error_closes_stream(code: &str) -> bool {
    matches!(
        code,
        "RATE_LIMIT_EXCEEDED"
            | "TOO_MANY_SESSIONS"
            | "LIMIT_EXCEEDED"
            | "PROVIDER_UNAVAILABLE"
            | "PROVIDER_ERROR"
            | "INTERNAL_ERROR"
    )
}

fn category_for_backend_close(code_u16: Option<u16>, remaining_secs: f32) -> SttConnectionCategory {
    let mut category = match code_u16 {
        Some(1008) => SttConnectionCategory::LimitExceeded,
        Some(1012) | Some(1013) | Some(1014) => SttConnectionCategory::ServerUnavailable,
        Some(1000) => SttConnectionCategory::Closed,
        _ => SttConnectionCategory::ServerUnavailable,
    };

    if category != SttConnectionCategory::LimitExceeded
        && remaining_secs < LIMIT_REMAINING_THRESHOLD_SECS
    {
        log::warn!(
            "Close frame without 1008, but last remaining={:.1}s < {:.0}s, treating as limit_exceeded",
            remaining_secs,
            LIMIT_REMAINING_THRESHOLD_SECS
        );
        category = SttConnectionCategory::LimitExceeded;
    }

    category
}

fn backend_close_should_emit_error(category: &SttConnectionCategory) -> bool {
    matches!(category, SttConnectionCategory::LimitExceeded)
}

async fn handle_backend_server_message(
    server_msg: ServerMessage,
    callbacks_state: &Arc<Mutex<CallbackState>>,
    on_usage_cb: &Option<UsageUpdateCallback>,
    shared_remaining: &Arc<AtomicU32>,
    session_id_state: &Arc<Mutex<Option<String>>>,
    last_seq_acked: &Arc<AtomicU64>,
) -> bool {
    match server_msg {
        ServerMessage::Ready { session_id } => {
            log::info!("Session ready: {}", session_id);
            *session_id_state.lock().await = Some(session_id);
            last_seq_acked.store(0, Ordering::SeqCst);
            let cb = {
                let state = callbacks_state.lock().await;
                state
                    .active
                    .as_ref()
                    .map(|c| c.on_connection_quality.clone())
            };
            if let Some(cb) = cb {
                cb("Good".to_string(), None);
            }
            false
        }
        ServerMessage::Ack { seq } => {
            log::trace!("Ack received: seq={}", seq);
            last_seq_acked.fetch_max(seq, Ordering::SeqCst);
            let swapped = {
                let mut state = callbacks_state.lock().await;
                if state.swap_on_next_ack && seq > state.swap_after_seq {
                    state.swap_on_next_ack = false;
                    state.swap_after_seq = 0;
                    if state.pending.is_some() {
                        state.active = state.pending.take();
                    }
                    true
                } else {
                    false
                }
            };
            if swapped {
                log::debug!("Callbacks switched after first ACK (new recording session)");
            }
            false
        }
        ServerMessage::Partial {
            text,
            confidence,
            is_segment_final,
            start_ms,
            duration_ms,
        } => {
            log::debug!("Partial: {} (conf: {:?})", text, confidence);
            let mut transcription = Transcription::new(text, is_segment_final.unwrap_or(false))
                .with_timing(
                    start_ms.unwrap_or(0) as f64 / 1000.0,
                    duration_ms.unwrap_or(0) as f64 / 1000.0,
                );
            if let Some(conf) = confidence {
                transcription = transcription.with_confidence(conf);
            }
            let cb = {
                let state = callbacks_state.lock().await;
                state.active.as_ref().map(|c| c.on_partial.clone())
            };
            if let Some(cb) = cb {
                cb(transcription);
            }
            false
        }
        ServerMessage::Final {
            text,
            confidence,
            start_ms,
            duration_ms,
        } => {
            log::debug!(
                "Final: {} (conf: {:?}, dur: {}ms)",
                text,
                confidence,
                duration_ms
            );
            let mut transcription = Transcription::final_result(text).with_timing(
                start_ms.unwrap_or(0) as f64 / 1000.0,
                duration_ms as f64 / 1000.0,
            );
            if let Some(conf) = confidence {
                transcription = transcription.with_confidence(conf);
            }
            let cb = {
                let state = callbacks_state.lock().await;
                state.active.as_ref().map(|c| c.on_final.clone())
            };
            if let Some(cb) = cb {
                cb(transcription);
            }
            false
        }
        ServerMessage::UsageUpdate {
            seconds_used,
            seconds_remaining_plan,
            seconds_remaining_total,
            ..
        } => {
            let remaining = seconds_remaining_total.unwrap_or(seconds_remaining_plan);
            shared_remaining.store(remaining.to_bits(), Ordering::SeqCst);
            log::debug!(
                "Usage: used={:.1}s, remaining={:.1}s",
                seconds_used,
                remaining
            );
            if let Some(cb) = on_usage_cb {
                cb(seconds_used, remaining);
            }
            false
        }
        ServerMessage::Resumed {
            session_id,
            last_seq_acked: server_last_seq,
        } => {
            log::info!(
                "Session resumed: {}, last_seq: {}",
                session_id,
                server_last_seq
            );
            *session_id_state.lock().await = Some(session_id);
            last_seq_acked.store(server_last_seq, Ordering::SeqCst);
            let cb = {
                let state = callbacks_state.lock().await;
                state
                    .active
                    .as_ref()
                    .map(|c| c.on_connection_quality.clone())
            };
            if let Some(cb) = cb {
                cb("Good".to_string(), None);
            }
            false
        }
        ServerMessage::Error { code, message } => {
            log::error!("Server error: {} - {}", code, message);
            let closes_stream = server_error_closes_stream(&code);
            let cb = {
                let state = callbacks_state.lock().await;
                state.error_callback()
            };
            if let Some(cb) = cb {
                cb(SttError::Connection(SttConnectionError {
                    message,
                    details: SttConnectionDetails {
                        category: Some(category_for_server_error(&code)),
                        server_code: Some(code),
                        ..Default::default()
                    },
                }));
            }
            closes_stream
        }
    }
}

fn spawn_backend_receiver_task(
    mut read: WsRead,
    callbacks_state: Arc<Mutex<CallbackState>>,
    on_usage_cb: Option<UsageUpdateCallback>,
    is_closed_flag: Arc<AtomicBool>,
    shared_remaining: Arc<AtomicU32>,
    session_id_state: Arc<Mutex<Option<String>>>,
    last_seq_acked: Arc<AtomicU64>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        log::debug!("Backend receiver task started");

        let mut server_error_reported = false;

        while let Some(msg_result) = read.next().await {
            match msg_result {
                Ok(Message::Text(text)) => match serde_json::from_str::<ServerMessage>(&text) {
                    Ok(server_msg) => {
                        if handle_backend_server_message(
                            server_msg,
                            &callbacks_state,
                            &on_usage_cb,
                            &shared_remaining,
                            &session_id_state,
                            &last_seq_acked,
                        )
                        .await
                        {
                            server_error_reported = true;
                        }
                    }
                    Err(e) => {
                        log::warn!("Failed to parse server message: {} - {}", e, text);
                    }
                },

                Ok(Message::Close(frame)) => {
                    log::info!("WebSocket closed by server: {:?}", frame);
                    if is_closed_flag.load(Ordering::SeqCst) || server_error_reported {
                        break;
                    }
                    is_closed_flag.store(true, Ordering::SeqCst);
                    let code_u16 = frame.as_ref().map(|f| u16::from(f.code));
                    let remaining = f32::from_bits(shared_remaining.load(Ordering::SeqCst));
                    let category = category_for_backend_close(code_u16, remaining);

                    if backend_close_should_emit_error(&category) {
                        let cb = {
                            let state = callbacks_state.lock().await;
                            state.error_callback()
                        };
                        if let Some(cb) = cb {
                            cb(SttError::Connection(SttConnectionError {
                                message: "WebSocket closed by server".to_string(),
                                details: SttConnectionDetails {
                                    category: Some(category),
                                    ws_close_code: code_u16,
                                    ..Default::default()
                                },
                            }));
                        }
                    } else {
                        let cb = {
                            let state = callbacks_state.lock().await;
                            state.connection_quality_callback()
                        };
                        if let Some(cb) = cb {
                            cb(
                                "Poor".to_string(),
                                Some(
                                    "STT connection closed, reconnecting on next audio".to_string(),
                                ),
                            );
                        }
                    }
                    break;
                }

                Ok(Message::Ping(data)) => {
                    log::trace!("Ping received");
                    let _ = data;
                }

                Ok(_) => {}

                Err(e) => {
                    log::error!("WebSocket error: {}", e);
                    if is_closed_flag.load(Ordering::SeqCst) || server_error_reported {
                        break;
                    }
                    is_closed_flag.store(true, Ordering::SeqCst);
                    let mut details = match &e {
                        tokio_tungstenite::tungstenite::Error::Io(ioe) => {
                            let kind = ioe.kind();
                            let kind_str = format!("{:?}", kind);
                            let os_error = ioe.raw_os_error();
                            let category = match kind {
                                std::io::ErrorKind::ConnectionRefused => {
                                    SttConnectionCategory::Refused
                                }
                                std::io::ErrorKind::ConnectionReset => SttConnectionCategory::Reset,
                                std::io::ErrorKind::BrokenPipe => {
                                    SttConnectionCategory::ServerUnavailable
                                }
                                std::io::ErrorKind::NotConnected
                                | std::io::ErrorKind::NetworkUnreachable
                                | std::io::ErrorKind::HostUnreachable
                                | std::io::ErrorKind::AddrNotAvailable => {
                                    SttConnectionCategory::Offline
                                }
                                std::io::ErrorKind::TimedOut => SttConnectionCategory::Timeout,
                                _ => SttConnectionCategory::Unknown,
                            };
                            SttConnectionDetails {
                                category: Some(category),
                                io_error_kind: Some(kind_str),
                                os_error,
                                ..Default::default()
                            }
                        }
                        tokio_tungstenite::tungstenite::Error::Tls(_) => SttConnectionDetails {
                            category: Some(SttConnectionCategory::Tls),
                            ..Default::default()
                        },
                        tokio_tungstenite::tungstenite::Error::ConnectionClosed
                        | tokio_tungstenite::tungstenite::Error::AlreadyClosed => {
                            SttConnectionDetails {
                                category: Some(SttConnectionCategory::Closed),
                                ..Default::default()
                            }
                        }
                        _ => SttConnectionDetails {
                            category: Some(SttConnectionCategory::Unknown),
                            ..Default::default()
                        },
                    };

                    let remaining = f32::from_bits(shared_remaining.load(Ordering::SeqCst));
                    if details.category != Some(SttConnectionCategory::LimitExceeded)
                        && remaining < LIMIT_REMAINING_THRESHOLD_SECS
                    {
                        log::warn!(
                            "WS error with last remaining={:.1}s < {:.0}s, treating as limit_exceeded",
                            remaining,
                            LIMIT_REMAINING_THRESHOLD_SECS
                        );
                        details.category = Some(SttConnectionCategory::LimitExceeded);
                    }

                    if details.category == Some(SttConnectionCategory::LimitExceeded) {
                        let cb = {
                            let state = callbacks_state.lock().await;
                            state.error_callback()
                        };
                        if let Some(cb) = cb {
                            cb(SttError::Connection(SttConnectionError {
                                message: e.to_string(),
                                details,
                            }));
                        }
                    } else {
                        let cb = {
                            let state = callbacks_state.lock().await;
                            state.connection_quality_callback()
                        };
                        if let Some(cb) = cb {
                            cb("Poor".to_string(), Some(e.to_string()));
                        }
                    }
                    break;
                }
            }
        }

        is_closed_flag.store(true, Ordering::SeqCst);
        log::info!("Backend receiver task finished");
    })
}

async fn wait_for_backend_ready(
    mut read: WsRead,
    callbacks_state: &Arc<Mutex<CallbackState>>,
    on_usage_cb: &Option<UsageUpdateCallback>,
    shared_remaining: &Arc<AtomicU32>,
    session_id_state: &Arc<Mutex<Option<String>>>,
    last_seq_acked: &Arc<AtomicU64>,
) -> SttResult<WsRead> {
    tokio::time::timeout(Duration::from_secs(WS_CONNECT_TIMEOUT_SECS), async move {
        while let Some(msg_result) = read.next().await {
            match msg_result {
                Ok(Message::Text(text)) => {
                    let server_msg = serde_json::from_str::<ServerMessage>(&text).map_err(|e| {
                        SttError::Processing(format!("Invalid backend ready response: {}", e))
                    })?;

                    match server_msg {
                        ServerMessage::Ready { .. } => {
                            handle_backend_server_message(
                                server_msg,
                                callbacks_state,
                                on_usage_cb,
                                shared_remaining,
                                session_id_state,
                                last_seq_acked,
                            )
                            .await;
                            return Ok(read);
                        }
                        ServerMessage::Error { code, message } => {
                            return Err(SttError::Connection(SttConnectionError {
                                message,
                                details: SttConnectionDetails {
                                    category: Some(category_for_server_error(&code)),
                                    server_code: Some(code),
                                    ..Default::default()
                                },
                            }));
                        }
                        other => {
                            handle_backend_server_message(
                                other,
                                callbacks_state,
                                on_usage_cb,
                                shared_remaining,
                                session_id_state,
                                last_seq_acked,
                            )
                            .await;
                        }
                    }
                }
                Ok(Message::Close(frame)) => {
                    return Err(SttError::Connection(SttConnectionError {
                        message: "WebSocket closed before backend session was ready".to_string(),
                        details: SttConnectionDetails {
                            category: Some(SttConnectionCategory::Closed),
                            ws_close_code: frame.as_ref().map(|f| u16::from(f.code)),
                            ..Default::default()
                        },
                    }));
                }
                Ok(_) => {}
                Err(e) => {
                    return Err(SttError::Connection(SttConnectionError::simple(format!(
                        "WS ready wait error: {}",
                        e
                    ))));
                }
            }
        }

        Err(SttError::Connection(SttConnectionError::with_category(
            "WebSocket ended before backend session was ready".to_string(),
            SttConnectionCategory::Closed,
        )))
    })
    .await
    .map_err(|_| {
        SttError::Connection(SttConnectionError::with_category(
            "Backend session ready timeout".to_string(),
            SttConnectionCategory::Timeout,
        ))
    })?
}

fn spawn_backend_keepalive_task(
    ws_write: Arc<Mutex<WsWrite>>,
    is_closed: Arc<AtomicBool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        log::debug!("Backend keepalive task started");
        loop {
            tokio::time::sleep(Duration::from_secs(20)).await;
            if is_closed.load(Ordering::SeqCst) {
                break;
            }
            let ping_fut = async {
                let mut guard = ws_write.lock().await;
                guard.send(Message::Ping(Vec::new())).await
            };

            if tokio::time::timeout(Duration::from_secs(WS_SEND_TIMEOUT_SECS), ping_fut)
                .await
                .ok()
                .and_then(|r| r.ok())
                .is_none()
            {
                is_closed.store(true, Ordering::SeqCst);
                break;
            }
        }
        log::debug!("Backend keepalive task ended");
    })
}

impl BackendProvider {
    pub fn new() -> Self {
        Self {
            config: None,
            is_streaming: false,
            is_paused: false,
            auth_token: None,
            backend_url: get_default_backend_url(),
            session_id: Arc::new(Mutex::new(None)),
            ws_write: None,
            receiver_task: None,
            keepalive_task: None,
            is_closed: Arc::new(AtomicBool::new(true)), // Изначально закрыто
            last_remaining_secs: Arc::new(AtomicU32::new(f32::MAX.to_bits())),
            last_seq_acked: Arc::new(AtomicU64::new(0)),
            callbacks: Arc::new(Mutex::new(CallbackState::default())),
            on_usage_update_callback: None,
            sent_chunks_count: 0,
            sent_bytes_total: 0,
            next_audio_seq: 1,
            replay_buffer: Vec::new(),
            replay_buffer_bytes: 0,
            audio_batch: Vec::new(),
            audio_batch_frames: 0,
            next_send_at: None,
            batch_started_at: None,
        }
    }

    /// Установить callback для UsageUpdate сообщений
    pub fn set_usage_callback(&mut self, callback: UsageUpdateCallback) {
        self.on_usage_update_callback = Some(callback);
    }

    async fn emit_connection_quality(&self, quality: &str, reason: Option<String>) {
        let cb = {
            let state = self.callbacks.lock().await;
            state
                .active
                .as_ref()
                .map(|callbacks| callbacks.on_connection_quality.clone())
        };
        if let Some(cb) = cb {
            cb(quality.to_string(), reason);
        }
    }

    fn build_ws_request(&self) -> SttResult<Request<()>> {
        let auth_token = self
            .auth_token
            .as_ref()
            .ok_or_else(|| SttError::Authentication("Auth token not set".to_string()))?;
        let ws_url = format!("{}/api/v1/transcribe/stream", self.backend_url);

        Request::builder()
            .method("GET")
            .uri(&ws_url)
            .header(
                "Host",
                self.backend_url.replace("wss://", "").replace("ws://", ""),
            )
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header(
                "Sec-WebSocket-Key",
                tokio_tungstenite::tungstenite::handshake::client::generate_key(),
            )
            .header("Authorization", format!("Bearer {}", auth_token))
            .body(())
            .map_err(|e| {
                SttError::Connection(SttConnectionError::simple(format!(
                    "Failed to build WS request: {}",
                    e
                )))
            })
    }

    async fn connect_backend_ws(&self) -> SttResult<WsStream> {
        let request = self.build_ws_request()?;
        let (ws_stream, _response) = tokio::time::timeout(
            Duration::from_secs(WS_CONNECT_TIMEOUT_SECS),
            connect_async(request),
        )
        .await
        .map_err(|_| {
            SttError::Connection(SttConnectionError {
                message: "WS connection timeout".to_string(),
                details: SttConnectionDetails {
                    category: Some(SttConnectionCategory::Timeout),
                    ..Default::default()
                },
            })
        })?
        .map_err(|e| {
            SttError::Connection(SttConnectionError::simple(format!(
                "WS connection failed: {}",
                e
            )))
        })?;

        Ok(ws_stream)
    }

    async fn send_json_to(
        &self,
        ws_write: &Arc<Mutex<WsWrite>>,
        msg: &ClientMessage,
    ) -> SttResult<()> {
        let json = serde_json::to_string(msg)
            .map_err(|e| SttError::Processing(format!("JSON serialize error: {}", e)))?;

        let send_fut = async {
            let mut guard = ws_write.lock().await;
            guard.send(Message::Text(json)).await
        };

        match tokio::time::timeout(Duration::from_secs(WS_SEND_TIMEOUT_SECS), send_fut).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                self.is_closed.store(true, Ordering::SeqCst);
                Err(SttError::Connection(SttConnectionError {
                    message: format!("WS send error: {}", e),
                    details: SttConnectionDetails::default(),
                }))
            }
            Err(_) => {
                self.is_closed.store(true, Ordering::SeqCst);
                Err(SttError::Connection(SttConnectionError {
                    message: "WS send timeout".to_string(),
                    details: SttConnectionDetails {
                        category: Some(SttConnectionCategory::Timeout),
                        ..Default::default()
                    },
                }))
            }
        }
    }

    async fn send_audio_frame_to(
        &self,
        ws_write: &Arc<Mutex<WsWrite>>,
        seq: u64,
        bytes: &[u8],
    ) -> SttResult<()> {
        let msg = ClientMessage::Audio {
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            seq,
        };
        self.send_json_to(ws_write, &msg).await
    }

    fn prune_acknowledged_replay_frames(&mut self) {
        let last_acked = self.last_seq_acked.load(Ordering::SeqCst);
        if last_acked == 0 {
            return;
        }
        self.replay_buffer.retain(|frame| frame.seq > last_acked);
        self.replay_buffer_bytes = self
            .replay_buffer
            .iter()
            .map(|frame| frame.bytes.len())
            .sum();
    }

    fn ensure_replay_buffer_within_limits(&self) -> SttResult<()> {
        if self.replay_buffer_bytes > REPLAY_BUFFER_MAX_BYTES {
            return Err(SttError::Connection(SttConnectionError::with_category(
                "STT reconnect buffer overflowed before backend resume".to_string(),
                SttConnectionCategory::Timeout,
            )));
        }

        if let Some(oldest) = self.replay_buffer.first() {
            if Instant::now()
                .saturating_duration_since(oldest.captured_at)
                .as_millis()
                > REPLAY_BUFFER_MAX_MS as u128
            {
                return Err(SttError::Connection(SttConnectionError::with_category(
                    "STT reconnect buffer exceeded 10 seconds".to_string(),
                    SttConnectionCategory::Timeout,
                )));
            }
        }

        Ok(())
    }

    fn push_replay_frame(&mut self, seq: u64, bytes: &[u8]) -> SttResult<()> {
        self.prune_acknowledged_replay_frames();
        self.replay_buffer.push(ReplayFrame {
            seq,
            bytes: bytes.to_vec(),
            captured_at: Instant::now(),
        });
        self.replay_buffer_bytes += bytes.len();
        self.ensure_replay_buffer_within_limits()
    }

    async fn replay_unacked_frames(&mut self, ws_write: &Arc<Mutex<WsWrite>>) -> SttResult<()> {
        self.prune_acknowledged_replay_frames();
        self.ensure_replay_buffer_within_limits()?;
        let frames = self.replay_buffer.clone();
        if !frames.is_empty() {
            log::info!("Replaying {} unacked STT audio frames", frames.len());
        }
        for frame in frames {
            self.send_audio_frame_to(ws_write, frame.seq, &frame.bytes)
                .await?;
        }
        Ok(())
    }

    async fn send_queued_audio_bytes(&mut self, bytes: Vec<u8>) -> SttResult<()> {
        let seq = self.next_audio_seq;
        self.next_audio_seq += 1;
        self.sent_chunks_count += 1;
        self.sent_bytes_total += bytes.len();
        self.push_replay_frame(seq, &bytes)?;

        if self.sent_chunks_count % 50 == 0 {
            log::debug!(
                "Backend: sent {} chunks, {} bytes total",
                self.sent_chunks_count,
                self.sent_bytes_total
            );
        }

        if self.is_closed.load(Ordering::SeqCst) {
            self.resume_after_disconnect().await?;
            return Ok(());
        }

        let Some(ws_write) = self.ws_write.clone() else {
            self.is_closed.store(true, Ordering::SeqCst);
            self.resume_after_disconnect().await?;
            return Ok(());
        };

        match self.send_audio_frame_to(&ws_write, seq, &bytes).await {
            Ok(()) => Ok(()),
            Err(send_error) => {
                log::warn!("Audio send failed, attempting STT resume: {}", send_error);
                self.resume_after_disconnect().await?;
                Ok(())
            }
        }
    }

    async fn flush_audio_batch(&mut self) -> SttResult<()> {
        if self.audio_batch.is_empty() {
            return Ok(());
        }
        let bytes = std::mem::take(&mut self.audio_batch);
        self.audio_batch_frames = 0;
        self.next_send_at = None;
        self.batch_started_at = None;
        self.send_queued_audio_bytes(bytes).await
    }

    async fn resume_after_disconnect(&mut self) -> SttResult<()> {
        if !self.is_streaming {
            return Err(SttError::Processing("Stream not active".to_string()));
        }

        let remaining = f32::from_bits(self.last_remaining_secs.load(Ordering::SeqCst));
        if remaining < 5.0 {
            return Err(SttError::Connection(SttConnectionError::with_category(
                "Connection closed".to_string(),
                SttConnectionCategory::LimitExceeded,
            )));
        }

        let session_id = self.session_id.lock().await.clone().ok_or_else(|| {
            SttError::Connection(SttConnectionError::with_category(
                "Cannot resume STT stream before backend session is ready".to_string(),
                SttConnectionCategory::Closed,
            ))
        })?;

        self.ensure_replay_buffer_within_limits()?;
        self.emit_connection_quality(
            "Poor",
            Some("STT connection lost, reconnecting".to_string()),
        )
        .await;

        if let Some(task) = self.receiver_task.take() {
            task.abort();
        }
        if let Some(task) = self.keepalive_task.take() {
            task.abort();
        }
        self.ws_write = None;
        self.is_closed.store(true, Ordering::SeqCst);

        let started_at = Instant::now();
        let mut attempt = 0usize;
        let mut last_error: Option<SttError> = None;

        loop {
            if started_at.elapsed().as_millis() >= WS_RESUME_GRACE_MS as u128 {
                break;
            }

            if attempt > 0 {
                let delay_ms = WS_RECONNECT_DELAYS_MS
                    .get((attempt - 1).min(WS_RECONNECT_DELAYS_MS.len() - 1))
                    .copied()
                    .unwrap_or(3000);
                let elapsed_ms = started_at.elapsed().as_millis() as u64;
                let remaining_ms = WS_RESUME_GRACE_MS.saturating_sub(elapsed_ms);
                tokio::time::sleep(Duration::from_millis(delay_ms.min(remaining_ms))).await;
            }
            attempt += 1;

            match self.try_resume_once(&session_id).await {
                Ok(()) => return Ok(()),
                Err(err) => {
                    log::warn!("STT resume attempt {} failed: {}", attempt, err);
                    last_error = Some(err);
                    self.is_closed.store(true, Ordering::SeqCst);
                }
            }
        }

        let message = last_error
            .map(|e| e.to_string())
            .unwrap_or_else(|| "STT resume timeout".to_string());
        Err(SttError::Connection(SttConnectionError::with_category(
            format!("STT resume failed after 10 seconds: {}", message),
            SttConnectionCategory::Timeout,
        )))
    }

    async fn try_resume_once(&mut self, session_id: &str) -> SttResult<()> {
        let ws_stream = self.connect_backend_ws().await?;
        let (write, mut read) = ws_stream.split();
        let ws_write = Arc::new(Mutex::new(write));
        self.is_closed.store(false, Ordering::SeqCst);

        let last_seq = self.last_seq_acked.load(Ordering::SeqCst);
        self.send_json_to(
            &ws_write,
            &ClientMessage::Resume {
                session_id: session_id.to_string(),
                last_seq,
            },
        )
        .await?;

        let resumed = tokio::time::timeout(Duration::from_secs(WS_CONNECT_TIMEOUT_SECS), async {
            while let Some(msg_result) = read.next().await {
                match msg_result {
                    Ok(Message::Text(text)) => match serde_json::from_str::<ServerMessage>(&text) {
                        Ok(ServerMessage::Resumed {
                            session_id,
                            last_seq_acked,
                        }) => {
                            return Ok((session_id, last_seq_acked));
                        }
                        Ok(ServerMessage::Error { code, message }) => {
                            return Err(SttError::Connection(SttConnectionError {
                                message,
                                details: SttConnectionDetails {
                                    category: Some(category_for_server_error(&code)),
                                    server_code: Some(code),
                                    ..Default::default()
                                },
                            }));
                        }
                        Ok(other) => {
                            log::debug!("Ignoring pre-resume server message: {:?}", other);
                        }
                        Err(e) => {
                            return Err(SttError::Processing(format!(
                                "Invalid resume response: {}",
                                e
                            )));
                        }
                    },
                    Ok(Message::Close(frame)) => {
                        return Err(SttError::Connection(SttConnectionError {
                            message: "WebSocket closed during resume".to_string(),
                            details: SttConnectionDetails {
                                category: Some(SttConnectionCategory::Closed),
                                ws_close_code: frame.as_ref().map(|f| u16::from(f.code)),
                                ..Default::default()
                            },
                        }));
                    }
                    Ok(_) => {}
                    Err(e) => {
                        return Err(SttError::Connection(SttConnectionError::simple(format!(
                            "WS resume error: {}",
                            e
                        ))));
                    }
                }
            }
            Err(SttError::Connection(SttConnectionError::with_category(
                "WebSocket ended during resume".to_string(),
                SttConnectionCategory::Closed,
            )))
        })
        .await
        .map_err(|_| {
            SttError::Connection(SttConnectionError::with_category(
                "WS resume handshake timeout".to_string(),
                SttConnectionCategory::Timeout,
            ))
        })??;

        let (resumed_session_id, server_last_seq) = resumed;
        *self.session_id.lock().await = Some(resumed_session_id);
        self.last_seq_acked.store(server_last_seq, Ordering::SeqCst);
        self.ws_write = Some(ws_write.clone());

        self.receiver_task = Some(spawn_backend_receiver_task(
            read,
            self.callbacks.clone(),
            self.on_usage_update_callback.clone(),
            self.is_closed.clone(),
            self.last_remaining_secs.clone(),
            self.session_id.clone(),
            self.last_seq_acked.clone(),
        ));
        self.keepalive_task = Some(spawn_backend_keepalive_task(
            ws_write.clone(),
            self.is_closed.clone(),
        ));

        self.emit_connection_quality(
            "Recovering",
            Some("Replaying unconfirmed STT audio".to_string()),
        )
        .await;
        self.replay_unacked_frames(&ws_write).await?;
        self.emit_connection_quality("Good", None).await;
        Ok(())
    }

    /// Отправить JSON сообщение через WebSocket
    async fn send_json(&self, msg: &ClientMessage) -> SttResult<()> {
        // Не пытаемся отправить если соединение уже закрыто
        if self.is_closed.load(Ordering::SeqCst) {
            return Ok(()); // Игнорируем — соединение уже закрыто
        }

        if let Some(ref ws_write) = self.ws_write {
            self.send_json_to(ws_write, msg).await
        } else {
            Err(SttError::Processing("WebSocket not connected".to_string()))
        }
    }
}

impl Default for BackendProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SttProvider for BackendProvider {
    async fn initialize(&mut self, config: &SttConfig) -> SttResult<()> {
        log::info!("BackendProvider: Initializing");

        // Получаем URL бэкенда (из конфига или авто-детект по окружению)
        let backend_url = config
            .backend_url
            .clone()
            .unwrap_or_else(get_default_backend_url);

        log::info!("BackendProvider: Using backend URL: {}", backend_url);

        // Получаем auth token из конфига
        //
        // В dev режиме для локального бэкенда (localhost) всегда используем dev-local-token.
        // Это защищает от ситуации "я уже логинился в прод, а сейчас запускаю local" → 401.
        log::info!(
            "BackendProvider: config.backend_auth_token present: {}, len: {}",
            config.backend_auth_token.is_some(),
            config
                .backend_auth_token
                .as_ref()
                .map(|t| t.len())
                .unwrap_or(0)
        );

        let auth_token = if cfg!(debug_assertions) {
            if is_local_backend_url(&backend_url) {
                if config.backend_auth_token.as_deref() != Some("dev-local-token") {
                    log::info!(
                        "DEV MODE: Local backend detected ({}). Using dev-local-token instead of saved token",
                        backend_url
                    );
                } else {
                    log::info!(
                        "DEV MODE: Local backend detected ({}). Using dev-local-token",
                        backend_url
                    );
                }
                "dev-local-token".to_string()
            } else {
                config.backend_auth_token.clone().unwrap_or_else(|| {
                    log::info!("DEV MODE: Using dev-local-token (no real token configured)");
                    "dev-local-token".to_string()
                })
            }
        } else {
            config.backend_auth_token.clone().ok_or_else(|| {
                SttError::Configuration(
                    "Backend auth token is required. Please activate your license.".to_string(),
                )
            })?
        };

        log::info!("BackendProvider: auth_token len: {}", auth_token.len());

        self.auth_token = Some(auth_token);
        self.backend_url = backend_url;
        self.config = Some(config.clone());

        Ok(())
    }

    async fn start_stream(
        &mut self,
        on_partial: TranscriptionCallback,
        on_final: TranscriptionCallback,
        on_error: ErrorCallback,
        on_connection_quality: ConnectionQualityCallback,
    ) -> SttResult<()> {
        log::info!("BackendProvider: Starting stream");

        if self.is_streaming {
            return Err(SttError::Processing("Stream already active".to_string()));
        }

        *self.session_id.lock().await = None;
        self.last_seq_acked.store(0, Ordering::SeqCst);
        self.next_audio_seq = 1;
        self.replay_buffer.clear();
        self.replay_buffer_bytes = 0;

        let auth_token = self
            .auth_token
            .as_ref()
            .ok_or_else(|| SttError::Configuration("Auth token not set".to_string()))?
            .clone();

        let config = self
            .config
            .as_ref()
            .ok_or_else(|| SttError::Configuration("Config not set".to_string()))?
            .clone();

        // WebSocket URL
        let ws_url = format!("{}/api/v1/transcribe/stream", self.backend_url);

        log::debug!("Connecting to backend: {}", ws_url);

        // Формируем WebSocket запрос с Authorization header
        let request = Request::builder()
            .method("GET")
            .uri(&ws_url)
            .header(
                "Host",
                self.backend_url.replace("wss://", "").replace("ws://", ""),
            )
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header(
                "Sec-WebSocket-Key",
                tokio_tungstenite::tungstenite::handshake::client::generate_key(),
            )
            .header("Authorization", format!("Bearer {}", auth_token))
            .body(())
            .map_err(|e| {
                SttError::Connection(SttConnectionError::simple(format!(
                    "Failed to build WS request: {}",
                    e
                )))
            })?;

        let (ws_stream, _response) = tokio::time::timeout(
            Duration::from_secs(WS_CONNECT_TIMEOUT_SECS),
            connect_async(request),
        )
        .await
        .map_err(|_| {
            SttError::Connection(SttConnectionError {
                message: "WS connection timeout".to_string(),
                details: SttConnectionDetails {
                    category: Some(SttConnectionCategory::Timeout),
                    ..Default::default()
                },
            })
        })?
        .map_err(|e| match e {
            tokio_tungstenite::tungstenite::Error::Http(resp) => {
                let status = resp.status();

                if status == http::StatusCode::UNAUTHORIZED {
                    // В dev режиме это почти всегда означает, что local backend не принял dev токен
                    // (например, не выставлен SECURITY_ALLOW_DEV_TOKEN=true).
                    if cfg!(debug_assertions) && is_local_backend_url(&self.backend_url) {
                        return SttError::Authentication(
                            "401 Unauthorized от локального бэкенда. Проверь, что backend запущен с SECURITY_ALLOW_DEV_TOKEN=true (и APP_ENV=local). Если хочешь использовать свой сохранённый токен — укажи VOICE_TO_TEXT_BACKEND_URL=wss://api.voicetext.site"
                                .to_string(),
                        );
                    }

                    return SttError::Authentication(
                        "401 Unauthorized. Токен недействителен/истёк — попробуй перелогиниться."
                            .to_string(),
                    );
                }

                if status == http::StatusCode::TOO_MANY_REQUESTS {
                    // Парсим body от сервера для точной причины (rate_limit vs too_many_sessions).
                    //
                    // Важно: backend API ошибки имеют форму:
                    // { success:false, error:{ code, message, details? } }
                    // Но некоторые WS/proxy могут вернуть { code, message } без envelope.
                    let mut server_message: Option<String> = None;
                    let mut server_code: Option<String> = None;
                    let mut retry_after_secs: Option<u64> = None;

                    if let Some(body) = resp.body().as_ref() {
                        if let Ok(text) = std::str::from_utf8(body) {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
                                // API envelope: { error: { code, message, details } }
                                if let Some(err) = json.get("error") {
                                    server_message = err
                                        .get("message")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string());
                                    server_code = err
                                        .get("code")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string());
                                    retry_after_secs = err
                                        .get("details")
                                        .and_then(|d| d.get("retry_after_seconds"))
                                        .and_then(|v| v.as_u64());
                                } else {
                                    // Fallback: { code, message }
                                    server_message = json
                                        .get("message")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string());
                                    server_code = json
                                        .get("code")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string());
                                }
                            }
                        }
                    }

                    // Для WS-handshake ошибок tungstenite часто не отдаёт body, поэтому
                    // backend дублирует код в заголовке.
                    if server_code.is_none() {
                        server_code = resp
                            .headers()
                            .get("x-voicetext-error-code")
                            .and_then(|v| v.to_str().ok())
                            .map(|s| s.to_string());
                    }

                    // Иногда retry-after приходит только хедером (например, глобальный rate limit middleware).
                    if retry_after_secs.is_none() {
                        retry_after_secs = resp
                            .headers()
                            .get("Retry-After")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|s| s.parse::<u64>().ok());
                    }

                    let display_message = match (&server_message, &server_code, retry_after_secs) {
                        (Some(msg), Some(code), Some(secs)) => {
                            format!("WS connection failed: 429 ({}): {} (retry after {}s)", code, msg, secs)
                        }
                        (Some(msg), Some(code), None) => {
                            format!("WS connection failed: 429 ({}): {}", code, msg)
                        }
                        (Some(msg), None, Some(secs)) => {
                            format!("WS connection failed: 429 — {} (retry after {}s)", msg, secs)
                        }
                        (Some(msg), None, None) => format!("WS connection failed: 429 — {}", msg),
                        (None, Some(code), Some(secs)) => {
                            format!("WS connection failed: 429 ({}) (retry after {}s)", code, secs)
                        }
                        (None, Some(code), None) => format!("WS connection failed: 429 ({})", code),
                        (None, None, Some(secs)) => {
                            format!("WS connection failed: HTTP error: {} (retry after {}s)", status, secs)
                        }
                        (None, None, None) => format!("WS connection failed: HTTP error: {}", status),
                    };

                    let category = match server_code.as_deref() {
                        // Важно: backend использует HTTP 429 и для limit_exceeded и для rate limiting,
                        // поэтому определяем категорию по коду.
                        Some("LIMIT_EXCEEDED") => SttConnectionCategory::LimitExceeded,
                        Some("TOO_MANY_SESSIONS") | Some("RATE_LIMIT_EXCEEDED") => {
                            SttConnectionCategory::RateLimited
                        }
                        _ => SttConnectionCategory::RateLimited,
                    };

                    return SttError::Connection(SttConnectionError {
                        message: display_message,
                        details: SttConnectionDetails {
                            category: Some(category),
                            http_status: Some(429),
                            server_code,
                            ..Default::default()
                        },
                    });
                }

                {
                    let status_u16 = status.as_u16();
                    let category = if matches!(status_u16, 502 | 503 | 504) {
                        SttConnectionCategory::ServerUnavailable
                    } else {
                        SttConnectionCategory::Http
                    };
                    SttError::Connection(SttConnectionError {
                        message: format!("WS connection failed: HTTP error: {}", status),
                        details: SttConnectionDetails {
                            category: Some(category),
                            http_status: Some(status_u16),
                            ..Default::default()
                        },
                    })
                }
            }
            tokio_tungstenite::tungstenite::Error::Tls(other) => SttError::Connection(SttConnectionError {
                message: format!("WS connection failed: {}", other),
                details: SttConnectionDetails {
                    category: Some(SttConnectionCategory::Tls),
                    ..Default::default()
                },
            }),
            tokio_tungstenite::tungstenite::Error::Io(ioe) => {
                let kind = ioe.kind();
                let kind_str = format!("{:?}", kind);
                let os_error = ioe.raw_os_error();
                let category = match kind {
                    std::io::ErrorKind::ConnectionRefused => SttConnectionCategory::Refused,
                    std::io::ErrorKind::ConnectionReset => SttConnectionCategory::Reset,
                    std::io::ErrorKind::NotConnected
                    | std::io::ErrorKind::NetworkUnreachable
                    | std::io::ErrorKind::HostUnreachable
                    | std::io::ErrorKind::AddrNotAvailable => SttConnectionCategory::Offline,
                    std::io::ErrorKind::TimedOut => SttConnectionCategory::Timeout,
                    _ => SttConnectionCategory::Unknown,
                };
                SttError::Connection(SttConnectionError {
                    message: format!("WS connection failed: {}", ioe),
                    details: SttConnectionDetails {
                        category: Some(category),
                        io_error_kind: Some(kind_str),
                        os_error,
                        ..Default::default()
                    },
                })
            }
            other => SttError::Connection(SttConnectionError {
                message: format!("WS connection failed: {}", other),
                details: SttConnectionDetails::default(),
            }),
        })?;

        log::info!("Backend WebSocket connected");

        // Сбрасываем флаг закрытия — соединение установлено
        self.is_closed.store(false, Ordering::SeqCst);

        let (write, read) = ws_stream.split();
        let ws_write = Arc::new(Mutex::new(write));
        self.ws_write = Some(ws_write.clone());

        // Сохраняем callbacks как "active" (для receiver task).
        {
            let mut state = self.callbacks.lock().await;
            state.active = Some(CallbackSet {
                on_partial: on_partial.clone(),
                on_final: on_final.clone(),
                on_error: on_error.clone(),
                on_connection_quality: on_connection_quality.clone(),
            });
            state.pending = None;
            state.swap_on_next_ack = false;
            state.swap_after_seq = 0;
        }

        // Отправляем Config message
        let provider_name = match config.provider {
            crate::domain::SttProviderType::Deepgram => "deepgram",
            crate::domain::SttProviderType::AssemblyAI => "assemblyai",
            _ => "deepgram", // fallback
        };

        // Парсим keyterms из строки через запятую в Vec<String>
        let keyterms = config
            .deepgram_keyterms
            .as_deref()
            .map(|raw| {
                raw.split(',')
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<String>>()
            })
            .filter(|v| !v.is_empty());

        let protocol_v = backend_protocol_version();
        log::info!("BackendProvider: Using backend protocol_v={}", protocol_v);

        let config_msg = ClientMessage::Config {
            protocol_v,
            provider: provider_name.to_string(),
            language: config.language.clone(),
            sample_rate: 16000,
            channels: 1,
            encoding: "pcm_s16le".to_string(),
            keyterms,
        };

        self.send_json(&config_msg).await?;
        log::debug!("Config message sent");

        let read = match wait_for_backend_ready(
            read,
            &self.callbacks,
            &self.on_usage_update_callback,
            &self.last_remaining_secs,
            &self.session_id,
            &self.last_seq_acked,
        )
        .await
        {
            Ok(read) => read,
            Err(err) => {
                self.is_closed.store(true, Ordering::SeqCst);
                self.ws_write = None;
                let close_fut = async {
                    let mut guard = ws_write.lock().await;
                    guard.close().await
                };
                let _ = tokio::time::timeout(Duration::from_secs(WS_SEND_TIMEOUT_SECS), close_fut)
                    .await;
                return Err(err);
            }
        };

        // Запускаем receiver task для обработки сообщений от сервера.
        // Берём callbacks из self.callbacks, чтобы они могли обновляться при resume_stream.
        self.last_remaining_secs
            .store(f32::MAX.to_bits(), Ordering::SeqCst);
        self.receiver_task = Some(spawn_backend_receiver_task(
            read,
            self.callbacks.clone(),
            self.on_usage_update_callback.clone(),
            self.is_closed.clone(),
            self.last_remaining_secs.clone(),
            self.session_id.clone(),
            self.last_seq_acked.clone(),
        ));

        // KeepAlive task (best-effort): поддерживает соединение живым, когда пользователь
        // быстро старт/стопит запись или просто прячет окно на пару секунд.
        self.keepalive_task = Some(spawn_backend_keepalive_task(
            ws_write.clone(),
            self.is_closed.clone(),
        ));

        self.is_streaming = true;
        self.is_paused = false;
        self.sent_chunks_count = 0;
        self.sent_bytes_total = 0;

        log::info!("BackendProvider: Stream started");
        Ok(())
    }

    async fn send_audio(&mut self, chunk: &AudioChunk) -> SttResult<()> {
        if !self.is_streaming {
            return Err(SttError::Processing("Stream not active".to_string()));
        }

        const SAMPLE_RATE_HZ: usize = 16_000;
        const FRAME_MS: usize = 30;
        const SAMPLES_PER_FRAME: usize = SAMPLE_RATE_HZ * FRAME_MS / 1000; // 480
        const BYTES_PER_SAMPLE: usize = 2;
        const FRAME_BYTES: usize = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE; // 960

        const MIN_FRAMES_PER_MESSAGE: usize = 1; // ~30ms
        const MAX_FRAMES_PER_MESSAGE: usize = 10; // ~300ms, чтобы догонять беклог без роста msg/sec
        const MAX_BATCH_WAIT_MS: u64 = 30; // верхняя граница задержки перед отправкой
        const MIN_SEND_INTERVAL_MS: u64 = 25; // 40 msg/s верхняя граница на клиенте

        self.audio_batch.reserve(chunk.data.len() * 2);
        let now = Instant::now();
        if self.audio_batch_frames == 0 {
            self.batch_started_at = Some(now);
        }
        for &sample in &chunk.data {
            self.audio_batch.extend_from_slice(&sample.to_le_bytes());
        }
        self.audio_batch_frames += 1;

        let batch_age_ms = self
            .batch_started_at
            .map(|t| now.saturating_duration_since(t).as_millis() as u64)
            .unwrap_or(0);
        let ready_to_send =
            self.audio_batch_frames >= MIN_FRAMES_PER_MESSAGE || batch_age_ms >= MAX_BATCH_WAIT_MS;
        if !ready_to_send {
            return Ok(());
        }

        let frames_to_send = self.audio_batch_frames.min(MAX_FRAMES_PER_MESSAGE);
        let bytes_to_send = frames_to_send * FRAME_BYTES;
        if self.audio_batch.len() < bytes_to_send {
            return Ok(());
        }

        let remainder = self.audio_batch.split_off(bytes_to_send);
        let bytes = std::mem::replace(&mut self.audio_batch, remainder);
        self.audio_batch_frames -= frames_to_send;

        let now2 = Instant::now();
        let next_at = self.next_send_at.unwrap_or(now2);
        if next_at > now2 {
            tokio::time::sleep_until(tokio::time::Instant::from_std(next_at)).await;
        }
        self.next_send_at =
            Some(Instant::now() + std::time::Duration::from_millis(MIN_SEND_INTERVAL_MS));

        self.send_queued_audio_bytes(bytes).await?;

        if self.audio_batch_frames == 0 {
            self.batch_started_at = None;
        }

        Ok(())
    }

    async fn stop_stream(&mut self) -> SttResult<()> {
        log::info!("BackendProvider: Stopping stream");

        if !self.is_streaming {
            return Ok(());
        }

        let flush_result = self.flush_audio_batch().await;

        // Отправляем Close message
        if let Some(ref ws_write) = self.ws_write {
            let _ = self.send_json_to(ws_write, &ClientMessage::Close).await;
        }

        // ПЕРВЫМ ДЕЛОМ перед cleanup ставим флаг закрытия — это предотвращает race condition
        self.is_closed.store(true, Ordering::SeqCst);

        // Закрываем WebSocket
        if let Some(ref ws_write) = self.ws_write {
            let close_fut = async {
                let mut guard = ws_write.lock().await;
                guard.close().await
            };
            let _ =
                tokio::time::timeout(Duration::from_secs(WS_SEND_TIMEOUT_SECS), close_fut).await;
        }

        // Останавливаем receiver task
        if let Some(task) = self.receiver_task.take() {
            task.abort();
            let _ = task.await;
        }

        // Останавливаем keepalive task
        if let Some(task) = self.keepalive_task.take() {
            task.abort();
            let _ = task.await;
        }

        self.ws_write = None;
        self.is_streaming = false;
        self.is_paused = false;
        *self.session_id.lock().await = None;
        self.last_seq_acked.store(0, Ordering::SeqCst);
        self.next_audio_seq = 1;
        self.replay_buffer.clear();
        self.replay_buffer_bytes = 0;
        self.next_send_at = None;
        self.batch_started_at = None;
        {
            let mut state = self.callbacks.lock().await;
            state.active = None;
            state.pending = None;
            state.swap_on_next_ack = false;
            state.swap_after_seq = 0;
        }

        log::info!(
            "BackendProvider: Stream stopped (sent {} chunks, {} bytes)",
            self.sent_chunks_count,
            self.sent_bytes_total
        );

        flush_result
    }

    async fn abort(&mut self) -> SttResult<()> {
        log::info!("BackendProvider: Aborting");

        // ПЕРВЫМ ДЕЛОМ ставим флаг закрытия
        self.is_closed.store(true, Ordering::SeqCst);

        if let Some(task) = self.keepalive_task.take() {
            task.abort();
        }

        // Принудительно закрываем без отправки Close
        if let Some(ref ws_write) = self.ws_write {
            let close_fut = async {
                let mut guard = ws_write.lock().await;
                guard.close().await
            };
            let _ =
                tokio::time::timeout(Duration::from_secs(WS_SEND_TIMEOUT_SECS), close_fut).await;
        }

        if let Some(task) = self.receiver_task.take() {
            task.abort();
        }

        self.ws_write = None;
        self.is_streaming = false;
        self.is_paused = false;
        *self.session_id.lock().await = None;
        self.last_seq_acked.store(0, Ordering::SeqCst);
        self.next_audio_seq = 1;
        self.replay_buffer.clear();
        self.replay_buffer_bytes = 0;
        {
            let mut state = self.callbacks.lock().await;
            state.active = None;
            state.pending = None;
            state.swap_on_next_ack = false;
            state.swap_after_seq = 0;
        }

        Ok(())
    }

    async fn pause_stream(&mut self) -> SttResult<()> {
        if !self.is_streaming {
            return Err(SttError::Processing("Stream not active".to_string()));
        }
        if self.is_paused {
            return Ok(());
        }

        // Флашим хвост батча, чтобы не потерять последние миллисекунды аудио перед паузой.
        self.flush_audio_batch().await?;

        // Best-effort: просим сервер форсировать финализацию провайдера (Deepgram Finalize),
        // чтобы "хвост" последней фразы пришёл ДО следующей записи и не протёк в новую UI-сессию.
        if let Err(e) = self.send_json(&ClientMessage::Finalize).await {
            log::warn!("BackendProvider: finalize failed on pause: {}", e);
        }

        self.is_paused = true;
        Ok(())
    }

    async fn resume_stream(
        &mut self,
        on_partial: TranscriptionCallback,
        on_final: TranscriptionCallback,
        on_error: ErrorCallback,
        on_connection_quality: ConnectionQualityCallback,
    ) -> SttResult<()> {
        if !self.is_streaming {
            return Err(SttError::Processing("Stream not active".to_string()));
        }

        // Готовим pending callbacks. Активируем их только после первого ACK на новое аудио,
        // чтобы не словить "поздние" результаты от предыдущей записи в новую UI-сессию.
        {
            let mut state = self.callbacks.lock().await;
            state.pending = Some(CallbackSet {
                on_partial,
                on_final,
                on_error,
                on_connection_quality,
            });
            state.swap_on_next_ack = true;
            state.swap_after_seq = self.next_audio_seq.saturating_sub(1);
        }

        if self.is_closed.load(Ordering::SeqCst) {
            self.resume_after_disconnect().await?;
        }

        self.is_paused = false;
        Ok(())
    }

    fn name(&self) -> &str {
        "backend"
    }

    fn supports_streaming(&self) -> bool {
        true
    }

    fn supports_keep_alive(&self) -> bool {
        false
    }

    fn is_connection_alive(&self) -> bool {
        if !(self.is_streaming && self.is_paused && self.ws_write.is_some()) {
            return false;
        }
        if self.is_closed.load(Ordering::SeqCst) {
            return false;
        }
        if let Some(task) = &self.receiver_task {
            if task.is_finished() {
                return false;
            }
        }
        if let Some(task) = &self.keepalive_task {
            if task.is_finished() {
                return false;
            }
        }
        true
    }

    fn is_online(&self) -> bool {
        true // Backend всегда онлайн (облачный сервис)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Mutex as StdMutex;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    static BACKEND_PROTOCOL_ENV_LOCK: StdMutex<()> = StdMutex::new(());
    static BACKEND_URL_ENV_LOCK: StdMutex<()> = StdMutex::new(());

    #[test]
    fn test_backend_provider_new() {
        let _guard = BACKEND_URL_ENV_LOCK.lock().unwrap();
        let _old = std::env::var("VOICE_TO_TEXT_BACKEND_URL").ok();
        std::env::remove_var("VOICE_TO_TEXT_BACKEND_URL");
        let provider = BackendProvider::new();
        assert!(!provider.is_streaming);
        assert!(provider.auth_token.is_none());
        // В debug сборке (тесты) должен быть dev URL
        #[cfg(debug_assertions)]
        assert_eq!(provider.backend_url, DEV_BACKEND_URL);
        #[cfg(not(debug_assertions))]
        assert_eq!(provider.backend_url, PROD_BACKEND_URL);
        // Восстанавливаем оригинальное значение (если было)
        if let Some(val) = _old {
            std::env::set_var("VOICE_TO_TEXT_BACKEND_URL", val);
        }
    }

    #[test]
    fn test_backend_provider_new_env_override() {
        let _guard = BACKEND_URL_ENV_LOCK.lock().unwrap();
        // Проверяем, что VOICE_TO_TEXT_BACKEND_URL переопределяет DEV_BACKEND_URL
        let _old = std::env::var("VOICE_TO_TEXT_BACKEND_URL").ok();
        std::env::set_var("VOICE_TO_TEXT_BACKEND_URL", "wss://custom.example.com");
        let provider = BackendProvider::new();
        assert_eq!(provider.backend_url, "wss://custom.example.com");
        if let Some(val) = _old {
            std::env::set_var("VOICE_TO_TEXT_BACKEND_URL", val);
        } else {
            std::env::remove_var("VOICE_TO_TEXT_BACKEND_URL");
        }
    }

    #[test]
    fn test_backend_provider_name() {
        let provider = BackendProvider::new();
        assert_eq!(provider.name(), "backend");
    }

    #[test]
    fn test_backend_provider_is_online() {
        let provider = BackendProvider::new();
        assert!(provider.is_online());
    }

    #[test]
    fn test_backend_provider_supports_streaming() {
        let provider = BackendProvider::new();
        assert!(provider.supports_streaming());
    }

    #[test]
    fn test_backend_provider_does_not_keep_alive_between_recordings() {
        let provider = BackendProvider::new();
        assert!(!provider.supports_keep_alive());
    }

    #[test]
    fn test_server_error_code_categories() {
        assert_eq!(
            category_for_server_error("RATE_LIMIT_EXCEEDED"),
            SttConnectionCategory::RateLimited
        );
        assert_eq!(
            category_for_server_error("TOO_MANY_SESSIONS"),
            SttConnectionCategory::RateLimited
        );
        assert_eq!(
            category_for_server_error("PROVIDER_UNAVAILABLE"),
            SttConnectionCategory::ServerUnavailable
        );
    }

    #[test]
    fn backend_protocol_version_defaults_to_prod_compatible_v1() {
        let _guard = BACKEND_PROTOCOL_ENV_LOCK.lock().unwrap();
        let previous = std::env::var("VOICE_TO_TEXT_BACKEND_PROTOCOL_V").ok();
        std::env::remove_var("VOICE_TO_TEXT_BACKEND_PROTOCOL_V");
        assert_eq!(backend_protocol_version(), 1);
        match previous {
            Some(value) => std::env::set_var("VOICE_TO_TEXT_BACKEND_PROTOCOL_V", value),
            None => std::env::remove_var("VOICE_TO_TEXT_BACKEND_PROTOCOL_V"),
        }
    }

    #[test]
    fn backend_protocol_version_can_be_overridden_for_new_backend() {
        let _guard = BACKEND_PROTOCOL_ENV_LOCK.lock().unwrap();
        let previous = std::env::var("VOICE_TO_TEXT_BACKEND_PROTOCOL_V").ok();
        std::env::set_var("VOICE_TO_TEXT_BACKEND_PROTOCOL_V", "2");
        assert_eq!(backend_protocol_version(), 2);
        match previous {
            Some(value) => std::env::set_var("VOICE_TO_TEXT_BACKEND_PROTOCOL_V", value),
            None => std::env::remove_var("VOICE_TO_TEXT_BACKEND_PROTOCOL_V"),
        }
    }

    #[test]
    fn test_only_fatal_server_errors_suppress_following_close() {
        assert!(server_error_closes_stream("RATE_LIMIT_EXCEEDED"));
        assert!(server_error_closes_stream("PROVIDER_UNAVAILABLE"));
        assert!(!server_error_closes_stream("BAD_REQUEST"));
    }

    #[test]
    fn test_backend_close_classification_is_recoverable_for_normal_close() {
        let category = category_for_backend_close(Some(1000), 120.0);

        assert_eq!(category, SttConnectionCategory::Closed);
        assert!(!backend_close_should_emit_error(&category));
    }

    #[test]
    fn test_backend_close_classification_is_fatal_for_limit_close() {
        let policy_category = category_for_backend_close(Some(1008), 120.0);
        let low_remaining_category = category_for_backend_close(Some(1000), 2.0);

        assert_eq!(policy_category, SttConnectionCategory::LimitExceeded);
        assert_eq!(low_remaining_category, SttConnectionCategory::LimitExceeded);
        assert!(backend_close_should_emit_error(&policy_category));
        assert!(backend_close_should_emit_error(&low_remaining_category));
    }

    #[test]
    fn test_error_callback_prefers_pending_during_resume() {
        fn callback_set(marker: Arc<AtomicUsize>, value: usize) -> CallbackSet {
            CallbackSet {
                on_partial: Arc::new(|_| {}),
                on_final: Arc::new(|_| {}),
                on_error: Arc::new(move |_| {
                    marker.store(value, AtomicOrdering::Relaxed);
                }),
                on_connection_quality: Arc::new(|_, _| {}),
            }
        }

        let marker = Arc::new(AtomicUsize::new(0));
        let state = CallbackState {
            active: Some(callback_set(marker.clone(), 1)),
            pending: Some(callback_set(marker.clone(), 2)),
            swap_on_next_ack: true,
            swap_after_seq: 10,
        };

        let cb = state.error_callback().expect("error callback");
        cb(SttError::Processing("boom".to_string()));

        assert_eq!(marker.load(AtomicOrdering::Relaxed), 2);
    }

    #[test]
    fn test_replay_buffer_prunes_acked_frames() {
        let mut provider = BackendProvider::new();
        provider.push_replay_frame(1, &[1, 2, 3]).unwrap();
        provider.push_replay_frame(2, &[4, 5]).unwrap();

        provider.last_seq_acked.store(1, Ordering::SeqCst);
        provider.prune_acknowledged_replay_frames();

        assert_eq!(provider.replay_buffer.len(), 1);
        assert_eq!(provider.replay_buffer[0].seq, 2);
        assert_eq!(provider.replay_buffer_bytes, 2);
    }

    #[test]
    fn test_replay_buffer_overflow_fails_explicitly() {
        let mut provider = BackendProvider::new();
        let oversized = vec![0; REPLAY_BUFFER_MAX_BYTES + 1];

        let err = provider.push_replay_frame(1, &oversized).unwrap_err();

        match err {
            SttError::Connection(connection) => {
                assert_eq!(
                    connection.details.category,
                    Some(SttConnectionCategory::Timeout)
                );
                assert!(connection.message.contains("buffer overflowed"));
            }
            other => panic!("expected connection error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_backend_provider_start_stream_waits_for_ready_before_returning() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_url = format!("ws://{}", listener.local_addr().unwrap());
        let (config_seen_tx, config_seen_rx) = tokio::sync::oneshot::channel();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (audio_seen_tx, audio_seen_rx) = tokio::sync::oneshot::channel();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();

            let config = ws.next().await.unwrap().unwrap();
            let config_text = config.into_text().unwrap();
            assert!(config_text.contains(r#""type":"config""#));
            config_seen_tx.send(()).unwrap();

            ready_rx.await.unwrap();
            ws.send(Message::Text(
                r#"{"type":"ready","session_id":"session-ready"}"#.to_string(),
            ))
            .await
            .unwrap();

            let audio = ws.next().await.unwrap().unwrap();
            let audio_text = audio.into_text().unwrap();
            let audio_json: serde_json::Value = serde_json::from_str(&audio_text).unwrap();
            audio_seen_tx
                .send(audio_json["seq"].as_u64().unwrap())
                .unwrap();
        });

        let mut provider = BackendProvider::new();
        let mut config = SttConfig::default();
        config.backend_url = Some(backend_url);
        config.backend_auth_token = Some("test-token".to_string());
        provider.initialize(&config).await.unwrap();

        {
            let start_stream = provider.start_stream(
                Arc::new(|_| {}),
                Arc::new(|_| {}),
                Arc::new(|_| {}),
                Arc::new(|_, _| {}),
            );
            tokio::pin!(start_stream);

            assert!(
                tokio::time::timeout(Duration::from_millis(50), &mut start_stream)
                    .await
                    .is_err(),
                "start_stream returned before backend ready"
            );
            tokio::time::timeout(Duration::from_secs(1), config_seen_rx)
                .await
                .unwrap()
                .unwrap();

            ready_tx.send(()).unwrap();
            start_stream.await.unwrap();
        }
        assert_eq!(
            provider.session_id.lock().await.as_deref(),
            Some("session-ready")
        );

        let chunk = AudioChunk::new(vec![0; 480], 16_000, 1);
        provider.send_audio(&chunk).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), audio_seen_rx)
                .await
                .unwrap()
                .unwrap(),
            1
        );

        let _ = provider.abort().await;
        server.await.unwrap();
    }

    #[tokio::test]
    async fn test_backend_provider_replays_unacked_audio_after_resume() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_url = format!("ws://{}", listener.local_addr().unwrap());
        let replayed = Arc::new(Mutex::new(Vec::<u64>::new()));
        let replayed_for_server = replayed.clone();

        let server = tokio::spawn(async move {
            let (stream1, _) = listener.accept().await.unwrap();
            let mut ws1 = accept_async(stream1).await.unwrap();

            let config = ws1.next().await.unwrap().unwrap();
            let config_text = config.into_text().unwrap();
            assert!(config_text.contains(r#""type":"config""#));
            ws1.send(Message::Text(
                r#"{"type":"ready","session_id":"session-1"}"#.to_string(),
            ))
            .await
            .unwrap();

            let audio1 = ws1.next().await.unwrap().unwrap();
            let audio1_text = audio1.into_text().unwrap();
            let audio1_json: serde_json::Value = serde_json::from_str(&audio1_text).unwrap();
            assert_eq!(audio1_json["type"], "audio");
            assert_eq!(audio1_json["seq"], 1);
            drop(ws1);

            let (stream2, _) = listener.accept().await.unwrap();
            let mut ws2 = accept_async(stream2).await.unwrap();
            let resume = ws2.next().await.unwrap().unwrap();
            let resume_text = resume.into_text().unwrap();
            let resume_json: serde_json::Value = serde_json::from_str(&resume_text).unwrap();
            assert_eq!(resume_json["type"], "resume");
            assert_eq!(resume_json["session_id"], "session-1");
            assert_eq!(resume_json["last_seq"], 0);
            ws2.send(Message::Text(
                r#"{"type":"resumed","session_id":"session-1","last_seq_acked":0}"#.to_string(),
            ))
            .await
            .unwrap();

            for _ in 0..2 {
                let audio = ws2.next().await.unwrap().unwrap();
                let audio_text = audio.into_text().unwrap();
                let audio_json: serde_json::Value = serde_json::from_str(&audio_text).unwrap();
                replayed_for_server
                    .lock()
                    .await
                    .push(audio_json["seq"].as_u64().unwrap());
            }
            ws2.send(Message::Text(r#"{"type":"ack","seq":2}"#.to_string()))
                .await
                .unwrap();
        });

        let mut provider = BackendProvider::new();
        let mut config = SttConfig::default();
        config.backend_url = Some(backend_url);
        config.backend_auth_token = Some("test-token".to_string());
        provider.initialize(&config).await.unwrap();
        provider
            .start_stream(
                Arc::new(|_| {}),
                Arc::new(|_| {}),
                Arc::new(|_| {}),
                Arc::new(|_, _| {}),
            )
            .await
            .unwrap();

        for _ in 0..20 {
            if provider.session_id.lock().await.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            provider.session_id.lock().await.as_deref(),
            Some("session-1")
        );

        let chunk = AudioChunk::new(vec![0; 480], 16_000, 1);
        provider.send_audio(&chunk).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        provider.send_audio(&chunk).await.unwrap();

        server.await.unwrap();
        assert_eq!(*replayed.lock().await, vec![1, 2]);
        let _ = provider.abort().await;
    }

    #[tokio::test]
    async fn test_backend_provider_prunes_server_acked_frames_before_resume_replay() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_url = format!("ws://{}", listener.local_addr().unwrap());
        let replayed = Arc::new(Mutex::new(Vec::<u64>::new()));
        let replayed_for_server = replayed.clone();

        let server = tokio::spawn(async move {
            let (stream1, _) = listener.accept().await.unwrap();
            let mut ws1 = accept_async(stream1).await.unwrap();

            let config = ws1.next().await.unwrap().unwrap();
            let config_text = config.into_text().unwrap();
            assert!(config_text.contains(r#""type":"config""#));
            ws1.send(Message::Text(
                r#"{"type":"ready","session_id":"session-acked"}"#.to_string(),
            ))
            .await
            .unwrap();

            let audio1 = ws1.next().await.unwrap().unwrap();
            let audio1_text = audio1.into_text().unwrap();
            let audio1_json: serde_json::Value = serde_json::from_str(&audio1_text).unwrap();
            assert_eq!(audio1_json["seq"], 1);
            ws1.send(Message::Text(r#"{"type":"ack","seq":1}"#.to_string()))
                .await
                .unwrap();

            let audio2 = ws1.next().await.unwrap().unwrap();
            let audio2_text = audio2.into_text().unwrap();
            let audio2_json: serde_json::Value = serde_json::from_str(&audio2_text).unwrap();
            assert_eq!(audio2_json["seq"], 2);
            drop(ws1);

            let (stream2, _) = listener.accept().await.unwrap();
            let mut ws2 = accept_async(stream2).await.unwrap();
            let resume = ws2.next().await.unwrap().unwrap();
            let resume_text = resume.into_text().unwrap();
            let resume_json: serde_json::Value = serde_json::from_str(&resume_text).unwrap();
            assert_eq!(resume_json["type"], "resume");
            assert_eq!(resume_json["session_id"], "session-acked");
            assert_eq!(resume_json["last_seq"], 1);
            ws2.send(Message::Text(
                r#"{"type":"resumed","session_id":"session-acked","last_seq_acked":1}"#.to_string(),
            ))
            .await
            .unwrap();

            for _ in 0..2 {
                let audio = ws2.next().await.unwrap().unwrap();
                let audio_text = audio.into_text().unwrap();
                let audio_json: serde_json::Value = serde_json::from_str(&audio_text).unwrap();
                replayed_for_server
                    .lock()
                    .await
                    .push(audio_json["seq"].as_u64().unwrap());
            }
            ws2.send(Message::Text(r#"{"type":"ack","seq":3}"#.to_string()))
                .await
                .unwrap();
        });

        let mut provider = BackendProvider::new();
        let mut config = SttConfig::default();
        config.backend_url = Some(backend_url);
        config.backend_auth_token = Some("test-token".to_string());
        provider.initialize(&config).await.unwrap();
        provider
            .start_stream(
                Arc::new(|_| {}),
                Arc::new(|_| {}),
                Arc::new(|_| {}),
                Arc::new(|_, _| {}),
            )
            .await
            .unwrap();

        for _ in 0..20 {
            if provider.session_id.lock().await.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            provider.session_id.lock().await.as_deref(),
            Some("session-acked")
        );

        let chunk = AudioChunk::new(vec![0; 480], 16_000, 1);
        provider.send_audio(&chunk).await.unwrap();
        for _ in 0..50 {
            if provider.last_seq_acked.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(provider.last_seq_acked.load(Ordering::SeqCst), 1);

        provider.send_audio(&chunk).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        provider.send_audio(&chunk).await.unwrap();

        server.await.unwrap();
        assert_eq!(*replayed.lock().await, vec![2, 3]);
        let _ = provider.abort().await;
    }

    #[tokio::test]
    async fn test_backend_provider_retries_resume_after_transient_resume_drop() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_url = format!("ws://{}", listener.local_addr().unwrap());
        let replayed = Arc::new(Mutex::new(Vec::<u64>::new()));
        let replayed_for_server = replayed.clone();

        let server = tokio::spawn(async move {
            let (stream1, _) = listener.accept().await.unwrap();
            let mut ws1 = accept_async(stream1).await.unwrap();

            let config = ws1.next().await.unwrap().unwrap();
            let config_text = config.into_text().unwrap();
            assert!(config_text.contains(r#""type":"config""#));
            ws1.send(Message::Text(
                r#"{"type":"ready","session_id":"session-retry"}"#.to_string(),
            ))
            .await
            .unwrap();

            let audio1 = ws1.next().await.unwrap().unwrap();
            let audio1_text = audio1.into_text().unwrap();
            let audio1_json: serde_json::Value = serde_json::from_str(&audio1_text).unwrap();
            assert_eq!(audio1_json["seq"], 1);
            drop(ws1);

            let (stream2, _) = listener.accept().await.unwrap();
            let mut ws2 = accept_async(stream2).await.unwrap();
            let resume1 = ws2.next().await.unwrap().unwrap();
            let resume1_text = resume1.into_text().unwrap();
            let resume1_json: serde_json::Value = serde_json::from_str(&resume1_text).unwrap();
            assert_eq!(resume1_json["type"], "resume");
            assert_eq!(resume1_json["session_id"], "session-retry");
            assert_eq!(resume1_json["last_seq"], 0);
            drop(ws2);

            let (stream3, _) = listener.accept().await.unwrap();
            let mut ws3 = accept_async(stream3).await.unwrap();
            let resume2 = ws3.next().await.unwrap().unwrap();
            let resume2_text = resume2.into_text().unwrap();
            let resume2_json: serde_json::Value = serde_json::from_str(&resume2_text).unwrap();
            assert_eq!(resume2_json["type"], "resume");
            assert_eq!(resume2_json["session_id"], "session-retry");
            assert_eq!(resume2_json["last_seq"], 0);
            ws3.send(Message::Text(
                r#"{"type":"resumed","session_id":"session-retry","last_seq_acked":0}"#.to_string(),
            ))
            .await
            .unwrap();

            for _ in 0..2 {
                let audio = ws3.next().await.unwrap().unwrap();
                let audio_text = audio.into_text().unwrap();
                let audio_json: serde_json::Value = serde_json::from_str(&audio_text).unwrap();
                replayed_for_server
                    .lock()
                    .await
                    .push(audio_json["seq"].as_u64().unwrap());
            }
            ws3.send(Message::Text(r#"{"type":"ack","seq":2}"#.to_string()))
                .await
                .unwrap();
        });

        let quality_events = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let quality_events_cb = quality_events.clone();

        let mut provider = BackendProvider::new();
        let mut config = SttConfig::default();
        config.backend_url = Some(backend_url);
        config.backend_auth_token = Some("test-token".to_string());
        provider.initialize(&config).await.unwrap();
        provider
            .start_stream(
                Arc::new(|_| {}),
                Arc::new(|_| {}),
                Arc::new(|_| {}),
                Arc::new(move |quality, _| {
                    quality_events_cb.lock().unwrap().push(quality);
                }),
            )
            .await
            .unwrap();

        for _ in 0..20 {
            if provider.session_id.lock().await.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            provider.session_id.lock().await.as_deref(),
            Some("session-retry")
        );

        let chunk = AudioChunk::new(vec![0; 480], 16_000, 1);
        provider.send_audio(&chunk).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        provider.send_audio(&chunk).await.unwrap();

        server.await.unwrap();
        assert_eq!(*replayed.lock().await, vec![1, 2]);

        let events = quality_events.lock().unwrap().clone();
        assert!(events.iter().any(|event| event == "Poor"));
        assert!(events.iter().any(|event| event == "Recovering"));
        assert!(events.iter().any(|event| event == "Good"));

        let _ = provider.abort().await;
    }

    #[tokio::test]
    async fn test_backend_provider_recovers_after_close_without_error_callback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_url = format!("ws://{}", listener.local_addr().unwrap());
        let replayed = Arc::new(Mutex::new(Vec::<u64>::new()));
        let replayed_for_server = replayed.clone();

        let server = tokio::spawn(async move {
            let (stream1, _) = listener.accept().await.unwrap();
            let mut ws1 = accept_async(stream1).await.unwrap();

            let config = ws1.next().await.unwrap().unwrap();
            let config_text = config.into_text().unwrap();
            assert!(config_text.contains(r#""type":"config""#));
            ws1.send(Message::Text(
                r#"{"type":"ready","session_id":"session-close"}"#.to_string(),
            ))
            .await
            .unwrap();

            let audio1 = ws1.next().await.unwrap().unwrap();
            let audio1_text = audio1.into_text().unwrap();
            let audio1_json: serde_json::Value = serde_json::from_str(&audio1_text).unwrap();
            assert_eq!(audio1_json["seq"], 1);
            ws1.send(Message::Close(None)).await.unwrap();
            drop(ws1);

            let (stream2, _) = listener.accept().await.unwrap();
            let mut ws2 = accept_async(stream2).await.unwrap();
            let resume = ws2.next().await.unwrap().unwrap();
            let resume_text = resume.into_text().unwrap();
            let resume_json: serde_json::Value = serde_json::from_str(&resume_text).unwrap();
            assert_eq!(resume_json["type"], "resume");
            assert_eq!(resume_json["session_id"], "session-close");
            assert_eq!(resume_json["last_seq"], 0);
            ws2.send(Message::Text(
                r#"{"type":"resumed","session_id":"session-close","last_seq_acked":0}"#.to_string(),
            ))
            .await
            .unwrap();

            for _ in 0..2 {
                let audio = ws2.next().await.unwrap().unwrap();
                let audio_text = audio.into_text().unwrap();
                let audio_json: serde_json::Value = serde_json::from_str(&audio_text).unwrap();
                replayed_for_server
                    .lock()
                    .await
                    .push(audio_json["seq"].as_u64().unwrap());
            }
        });

        let error_count = Arc::new(AtomicUsize::new(0));
        let error_count_cb = error_count.clone();
        let quality_events = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let quality_events_cb = quality_events.clone();

        let mut provider = BackendProvider::new();
        let mut config = SttConfig::default();
        config.backend_url = Some(backend_url);
        config.backend_auth_token = Some("test-token".to_string());
        provider.initialize(&config).await.unwrap();
        provider
            .start_stream(
                Arc::new(|_| {}),
                Arc::new(|_| {}),
                Arc::new(move |_| {
                    error_count_cb.fetch_add(1, AtomicOrdering::Relaxed);
                }),
                Arc::new(move |quality, _| {
                    quality_events_cb.lock().unwrap().push(quality);
                }),
            )
            .await
            .unwrap();

        let chunk = AudioChunk::new(vec![0; 480], 16_000, 1);
        provider.send_audio(&chunk).await.unwrap();

        for _ in 0..50 {
            if provider.is_closed.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(provider.is_closed.load(Ordering::SeqCst));
        assert_eq!(error_count.load(AtomicOrdering::Relaxed), 0);

        provider.send_audio(&chunk).await.unwrap();

        server.await.unwrap();
        assert_eq!(*replayed.lock().await, vec![1, 2]);
        assert_eq!(error_count.load(AtomicOrdering::Relaxed), 0);
        assert!(quality_events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event == "Poor"));

        let _ = provider.abort().await;
    }

    #[tokio::test]
    async fn test_v2_segment_final_partial_preserves_timing() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_cb = captured.clone();
        let callbacks_state = Arc::new(Mutex::new(CallbackState {
            active: Some(CallbackSet {
                on_partial: Arc::new(move |t| {
                    let captured = captured_cb.clone();
                    tokio::spawn(async move {
                        captured.lock().await.push(t);
                    });
                }),
                on_final: Arc::new(|_| {}),
                on_error: Arc::new(|_| {}),
                on_connection_quality: Arc::new(|_, _| {}),
            }),
            pending: None,
            swap_on_next_ack: false,
            swap_after_seq: 0,
        }));
        let shared_remaining = Arc::new(AtomicU32::new(f32::NAN.to_bits()));
        let session_id_state = Arc::new(Mutex::new(None));
        let last_seq_acked = Arc::new(AtomicU64::new(0));

        handle_backend_server_message(
            ServerMessage::Partial {
                text: "первый кусок".to_string(),
                confidence: Some(0.9),
                is_segment_final: Some(true),
                start_ms: Some(120),
                duration_ms: Some(980),
            },
            &callbacks_state,
            &None,
            &shared_remaining,
            &session_id_state,
            &last_seq_acked,
        )
        .await;

        tokio::task::yield_now().await;
        let got = captured.lock().await;
        assert_eq!(got.len(), 1);
        assert!(got[0].is_final);
        assert_eq!(got[0].text, "первый кусок");
        assert!((got[0].start - 0.12).abs() < f64::EPSILON);
        assert!((got[0].duration - 0.98).abs() < f64::EPSILON);
    }
}

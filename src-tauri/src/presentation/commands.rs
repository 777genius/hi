use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, Window};

use crate::application::TranscriptionService;
use crate::domain::{
    AudioCapture, LlmProviderFactory, RecordingStatus, SttConnectionCategory, SttError,
};
use crate::infrastructure::{AuthSession, AuthStore, AuthUser, ConfigStore};
use crate::presentation::{
    companion::{CompanionServerStatus, CompanionSnapshotEnvelope},
    events::*,
    AppState, AudioLevelPayload, ConnectionQualityPayload, FinalTranscriptionPayload,
    MicrophoneMuteStatePayload, MicrophoneTestLevelPayload, PartialTranscriptionPayload,
    RecordingStatusPayload, TranscriptionErrorPayload,
};

#[derive(Debug, Clone, serde::Serialize)]
pub struct AudioPermissionStatus {
    pub system_audio_granted: bool,
    pub microphone_granted: bool,
}

const DEFAULT_MICROPHONE_MUTE_HOTKEY: &str = "Alt+Z";
const APP_MICROPHONE_MUTE_SOURCE: &str = "app-microphone-toggle";

pub(crate) enum SttTranscriptionEvent {
    Partial(crate::domain::Transcription),
    Final(crate::domain::Transcription),
    Barrier(tokio::sync::oneshot::Sender<()>),
}

struct CompanionDeltaWriter {
    tx: tokio::sync::mpsc::UnboundedSender<String>,
    handle: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Debug, Clone)]
struct HaikuCandidateMeta {
    id: String,
    label: String,
    provider: String,
    model: String,
}

fn spawn_companion_delta_writer(
    app_handle: AppHandle,
    request_id: String,
    candidate_id: Option<String>,
) -> CompanionDeltaWriter {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let handle = tauri::async_runtime::spawn(async move {
        let mut last_publish: Option<std::time::Instant> = None;
        while let Some(mut delta_text) = rx.recv().await {
            if let Some(last) = last_publish {
                let interval = std::time::Duration::from_millis(50);
                if let Some(wait) = interval.checked_sub(last.elapsed()) {
                    tokio::time::sleep(wait).await;
                }
            }
            while let Ok(next) = rx.try_recv() {
                delta_text.push_str(&next);
            }
            if let Some(state) = app_handle.try_state::<AppState>() {
                crate::presentation::companion_timeline::append_haiku_candidate_delta(
                    state.inner(),
                    &request_id,
                    candidate_id.as_deref(),
                    &delta_text,
                )
                .await;
                let _ =
                    crate::presentation::companion::publish_snapshot_sse_only(&app_handle).await;
                last_publish = Some(std::time::Instant::now());
            }
        }
    });

    CompanionDeltaWriter { tx, handle }
}

async fn drain_companion_delta_writer(writer: CompanionDeltaWriter) {
    drop(writer.tx);
    let _ = writer.handle.await;
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn candidate_start_payload(
    request_id: &str,
    candidate: &HaikuCandidateMeta,
) -> HaikuCandidateStartPayload {
    HaikuCandidateStartPayload {
        request_id: request_id.to_string(),
        candidate_id: candidate.id.clone(),
        candidate_label: candidate.label.clone(),
        provider: candidate.provider.clone(),
        model: candidate.model.clone(),
    }
}

fn candidate_delta_payload(
    request_id: &str,
    delta: String,
    candidate: Option<&HaikuCandidateMeta>,
) -> HaikuDeltaPayload {
    HaikuDeltaPayload {
        request_id: request_id.to_string(),
        delta,
        candidate_id: candidate.map(|value| value.id.clone()),
        candidate_label: candidate.map(|value| value.label.clone()),
        provider: candidate.map(|value| value.provider.clone()),
        model: candidate.map(|value| value.model.clone()),
    }
}

fn candidate_done_payload(
    request_id: &str,
    candidate: Option<&HaikuCandidateMeta>,
) -> HaikuDonePayload {
    HaikuDonePayload {
        request_id: request_id.to_string(),
        candidate_id: candidate.map(|value| value.id.clone()),
        candidate_label: candidate.map(|value| value.label.clone()),
        provider: candidate.map(|value| value.provider.clone()),
        model: candidate.map(|value| value.model.clone()),
    }
}

fn candidate_error_payload(
    request_id: &str,
    error: String,
    candidate: Option<&HaikuCandidateMeta>,
) -> HaikuErrorPayload {
    HaikuErrorPayload {
        request_id: request_id.to_string(),
        error,
        candidate_id: candidate.map(|value| value.id.clone()),
        candidate_label: candidate.map(|value| value.label.clone()),
        provider: candidate.map(|value| value.provider.clone()),
        model: candidate.map(|value| value.model.clone()),
    }
}

async fn settle_parallel_candidate(
    app_handle: &AppHandle,
    request_id: &str,
    candidate: &HaikuCandidateMeta,
    result: crate::domain::LlmResult<()>,
) -> bool {
    match result {
        Ok(()) => {
            if let Some(state) = app_handle.try_state::<AppState>() {
                crate::presentation::companion_timeline::finalize_haiku_candidate(
                    state.inner(),
                    request_id,
                    Some(&candidate.id),
                )
                .await;
                let _ = crate::presentation::companion::publish_snapshot_sse_only(app_handle).await;
            }
            let _ = app_handle.emit(
                EVENT_HAIKU_DONE,
                candidate_done_payload(request_id, Some(candidate)),
            );
            true
        }
        Err(e) => {
            let error = e.to_string();
            if let Some(state) = app_handle.try_state::<AppState>() {
                crate::presentation::companion_timeline::fail_haiku_candidate(
                    state.inner(),
                    request_id,
                    Some(&candidate.id),
                    &error,
                )
                .await;
                let _ = crate::presentation::companion::publish_snapshot_sse_only(app_handle).await;
            }
            let _ = app_handle.emit(
                EVENT_HAIKU_ERROR,
                candidate_error_payload(request_id, error, Some(candidate)),
            );
            false
        }
    }
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
fn is_system_audio_permission_granted_macos() -> bool {
    // ScreenCaptureKit системного аудио зависит от Screen Recording permission.
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
fn is_microphone_permission_granted_macos() -> bool {
    use cocoa::base::nil;
    use cocoa::foundation::NSString;

    unsafe {
        let cls = class!(AVCaptureDevice);
        // AVMediaTypeAudio == "soun"
        let media_type = NSString::alloc(nil).init_str("soun");
        let status: i32 = msg_send![cls, authorizationStatusForMediaType: media_type];
        // AVAuthorizationStatus: 3 = authorized
        status == 3
    }
}

#[cfg(not(target_os = "macos"))]
fn is_system_audio_permission_granted_macos() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
fn is_microphone_permission_granted_macos() -> bool {
    true
}

/// Возвращает статус OS-разрешений для захвата системного звука и микрофона.
#[tauri::command]
pub async fn get_audio_permission_status() -> Result<AudioPermissionStatus, String> {
    Ok(AudioPermissionStatus {
        system_audio_granted: is_system_audio_permission_granted_macos(),
        microphone_granted: is_microphone_permission_granted_macos(),
    })
}

/// Тестовый режим интервьюера включён (INTERVIEW_TEST_MODE=1)?
#[tauri::command]
pub async fn get_test_interviewer_state() -> Result<(bool, usize), String> {
    Ok((
        crate::infrastructure::test_interviewer::is_enabled(),
        crate::infrastructure::test_interviewer::total_questions(),
    ))
}

/// Озвучивает следующий вопрос тестового интервьюера через системный вывод.
#[tauri::command]
pub async fn test_interviewer_next_question(
) -> Result<crate::infrastructure::test_interviewer::TestInterviewQuestion, String> {
    crate::infrastructure::test_interviewer::speak_next_question()
}

/// Сбрасывает тестового интервьюера к первому вопросу и обрывает озвучку.
#[tauri::command]
pub async fn test_interviewer_reset() -> Result<(), String> {
    crate::infrastructure::test_interviewer::reset();
    Ok(())
}

/// Просим у macOS разрешение на микрофон. Системный диалог появляется только
/// пока статус "not determined"; если доступ уже запрещён, нужно включить его в Настройках.
#[tauri::command]
pub async fn request_microphone_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use block::ConcreteBlock;
        use cocoa::base::nil;
        use cocoa::foundation::NSString;

        unsafe {
            let cls = class!(AVCaptureDevice);
            // AVMediaTypeAudio == "soun"
            let media_type = NSString::alloc(nil).init_str("soun");
            let handler = ConcreteBlock::new(|_granted: objc::runtime::BOOL| {}).copy();
            let _: () = msg_send![
                cls,
                requestAccessForMediaType: media_type
                completionHandler: &*handler
            ];
        }
    }

    Ok(())
}

/// Просим у macOS разрешение Screen Recording (для системного звука).
#[tauri::command]
pub async fn request_system_audio_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(unsafe { CGRequestScreenCaptureAccess() })
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

fn to_microphone_mute_state_payload(
    status: crate::infrastructure::microphone_mute::MicrophoneMuteStatus,
    detail: Option<String>,
) -> MicrophoneMuteStatePayload {
    MicrophoneMuteStatePayload {
        muted: status.muted,
        supported: status.supported,
        source: status.source,
        detail,
    }
}

fn app_microphone_mute_status(
    state: &AppState,
) -> crate::infrastructure::microphone_mute::MicrophoneMuteStatus {
    let enabled = state
        .microphone_transcription_enabled
        .load(Ordering::Relaxed);

    crate::infrastructure::microphone_mute::MicrophoneMuteStatus {
        muted: !enabled,
        supported: true,
        source: APP_MICROPHONE_MUTE_SOURCE.to_string(),
    }
}

pub fn get_app_microphone_mute_state(state: &AppState) -> MicrophoneMuteStatePayload {
    to_microphone_mute_state_payload(app_microphone_mute_status(state), None)
}

pub fn get_system_microphone_mute_state() -> Result<MicrophoneMuteStatePayload, String> {
    let os_status = crate::infrastructure::microphone_mute::get_microphone_mute_status()
        .map_err(|e| format!("Не удалось получить статус микрофона: {}", e))?;
    Ok(to_microphone_mute_state_payload(os_status, None))
}

fn effective_microphone_mute_status(
    state: &AppState,
    os_status: crate::infrastructure::microphone_mute::MicrophoneMuteStatus,
) -> crate::infrastructure::microphone_mute::MicrophoneMuteStatus {
    if os_status.supported {
        os_status
    } else {
        app_microphone_mute_status(state)
    }
}

pub async fn get_effective_microphone_mute_state(
    state: &AppState,
) -> Result<MicrophoneMuteStatePayload, String> {
    let os_status = crate::infrastructure::microphone_mute::get_microphone_mute_status()
        .map_err(|e| format!("Не удалось получить статус микрофона: {}", e))?;
    Ok(to_microphone_mute_state_payload(
        effective_microphone_mute_status(state, os_status),
        None,
    ))
}

async fn emit_microphone_mute_state(app_handle: &AppHandle, payload: &MicrophoneMuteStatePayload) {
    let _ = app_handle.emit(EVENT_MICROPHONE_MUTE_STATE, payload.clone());
}

pub async fn set_app_microphone_muted_raw(
    state: &AppState,
    app_handle: AppHandle,
    muted: bool,
) -> Result<MicrophoneMuteStatePayload, String> {
    let current = get_app_microphone_mute_state(state);
    if current.muted == muted {
        return Ok(current);
    }

    sync_microphone_transcription_enabled_internal(state, app_handle, !muted).await?;
    Ok(get_app_microphone_mute_state(state))
}

async fn sync_microphone_transcription_enabled_internal(
    state: &AppState,
    app_handle: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    state
        .microphone_transcription_enabled
        .store(enabled, Ordering::Relaxed);

    if !enabled {
        let mic = &state.microphone_transcription_service;
        let result = match mic.get_status().await {
            RecordingStatus::Starting => mic.abort_starting().await,
            RecordingStatus::Recording => mic.stop_recording().await,
            _ => Ok("Microphone already stopped".to_string()),
        };
        if let Err(error) = result {
            log::warn!("Microphone mute could not stop transcription: {}", error);
        }
        crate::presentation::companion_timeline::clear_microphone_live_buffers(state).await;
        return Ok(());
    }

    let status = state.transcription_service.get_status().await;
    if matches!(
        status,
        RecordingStatus::Starting | RecordingStatus::Recording | RecordingStatus::Processing
    ) {
        let session_id = state
            .active_transcription_session_id
            .load(Ordering::Relaxed);
        if session_id > 0 {
            let microphone_device = state.config.read().await.selected_audio_device.clone();
            spawn_microphone_transcription_start(
                state.microphone_transcription_service.clone(),
                app_handle.clone(),
                session_id,
                microphone_device,
            );
        }
    }

    Ok(())
}

pub async fn set_microphone_muted_raw(
    state: &AppState,
    app_handle: AppHandle,
    muted: bool,
) -> Result<MicrophoneMuteStatePayload, String> {
    let os_current = crate::infrastructure::microphone_mute::get_microphone_mute_status()
        .map_err(|e| format!("Не удалось получить статус микрофона: {}", e))?;
    let current = effective_microphone_mute_status(state, os_current.clone());
    if current.muted == muted {
        let payload = to_microphone_mute_state_payload(current, None);
        emit_microphone_mute_state(&app_handle, &payload).await;
        sync_microphone_transcription_enabled_internal(state, app_handle.clone(), !payload.muted)
            .await?;
        return Ok(payload);
    }

    if !os_current.supported {
        sync_microphone_transcription_enabled_internal(state, app_handle.clone(), !muted).await?;
        let payload = to_microphone_mute_state_payload(app_microphone_mute_status(state), None);
        emit_microphone_mute_state(&app_handle, &payload).await;
        return Ok(payload);
    }

    // Hotkey path не проходит через optimistic update на frontend как обычный клик по кнопке,
    // поэтому публикуем целевое состояние заранее, чтобы иконка/tooltip менялись без задержки.
    let optimistic_payload = to_microphone_mute_state_payload(
        crate::infrastructure::microphone_mute::MicrophoneMuteStatus {
            muted,
            supported: current.supported,
            source: current.source.clone(),
        },
        None,
    );
    emit_microphone_mute_state(&app_handle, &optimistic_payload).await;

    let restore_hint = *state.microphone_restore_input_volume.read().await;
    let outcome =
        match crate::infrastructure::microphone_mute::set_microphone_muted(muted, restore_hint) {
            Ok(outcome) => outcome,
            Err(e) => {
                let rollback_payload = to_microphone_mute_state_payload(current, None);
                emit_microphone_mute_state(&app_handle, &rollback_payload).await;
                sync_microphone_transcription_enabled_internal(
                    state,
                    app_handle.clone(),
                    !rollback_payload.muted,
                )
                .await?;
                return Err(format!("Не удалось переключить mute микрофона: {}", e));
            }
        };

    {
        let mut restore = state.microphone_restore_input_volume.write().await;
        if muted {
            *restore = outcome.restore_input_volume;
        } else if !outcome.status.muted {
            *restore = outcome.restore_input_volume.or(*restore);
        }
    }

    sync_microphone_transcription_enabled_internal(
        state,
        app_handle.clone(),
        !outcome.status.muted,
    )
    .await?;

    let payload = to_microphone_mute_state_payload(
        outcome.status,
        if outcome.applied_methods.is_empty() {
            None
        } else {
            Some(outcome.applied_methods.join(","))
        },
    );
    emit_microphone_mute_state(&app_handle, &payload).await;
    Ok(payload)
}

pub async fn toggle_microphone_muted_internal(
    state: &AppState,
    app_handle: AppHandle,
) -> Result<MicrophoneMuteStatePayload, String> {
    let current = get_effective_microphone_mute_state(state).await?;
    set_microphone_muted_raw(state, app_handle, !current.muted).await
}

#[tauri::command]
pub async fn get_microphone_mute_state(
    state: State<'_, AppState>,
) -> Result<MicrophoneMuteStatePayload, String> {
    get_effective_microphone_mute_state(state.inner()).await
}

#[tauri::command]
pub async fn set_microphone_muted(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    muted: bool,
) -> Result<MicrophoneMuteStatePayload, String> {
    let response = crate::presentation::companion_actions::ensure_microphone_muted(
        state.inner(),
        &app_handle,
        muted,
    )
    .await?;
    match response.action_result.as_str() {
        "busy_transition" => Err("Transition in progress".to_string()),
        "rejected_auth" => Err("Authentication required".to_string()),
        _ => get_effective_microphone_mute_state(state.inner()).await,
    }
}

#[tauri::command]
pub async fn toggle_microphone_muted(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<MicrophoneMuteStatePayload, String> {
    let current = get_effective_microphone_mute_state(state.inner()).await?;
    let response = crate::presentation::companion_actions::ensure_microphone_muted(
        state.inner(),
        &app_handle,
        !current.muted,
    )
    .await?;
    match response.action_result.as_str() {
        "busy_transition" => Err("Transition in progress".to_string()),
        "rejected_auth" => Err("Authentication required".to_string()),
        _ => get_effective_microphone_mute_state(state.inner()).await,
    }
}

/// A pending microphone start must not survive Stop, a new session, or mute.
fn microphone_session_should_run(state: &AppState, session_id: u64) -> bool {
    state.active_transcription_session_id.load(Ordering::Relaxed) == session_id
        && state.microphone_transcription_enabled.load(Ordering::Relaxed)
}

fn spawn_microphone_transcription_start(
    mic_service: Arc<TranscriptionService>,
    app_handle: AppHandle,
    session_id: u64,
    device_name: Option<String>,
) {
    let app_handle_partial = app_handle.clone();

    tauri::async_runtime::spawn(async move {
        // Keep a previous, slow model initialization from replacing or
        // stopping the microphone capture of the next recording session.
        let start_lock = match app_handle_partial.try_state::<AppState>() {
            Some(state) => Arc::clone(&state.microphone_start_lock),
            None => return,
        };
        let _start_guard = start_lock.lock().await;
        let Some(state) = app_handle_partial.try_state::<AppState>() else { return; };
        if !microphone_session_should_run(state.inner(), session_id) {
            return;
        }
        drop(state);

        // Важно: если выбран "Default" (device_name=None), то при подключении/смене микрофона
        // системное устройство по умолчанию может измениться во время работы приложения.
        // Поэтому перед стартом микрофонной транскрибации пересоздаём захват.
        match crate::infrastructure::audio::SystemAudioCapture::with_device(device_name.clone()) {
            Ok(capture) => {
                if let Err(e) = mic_service.replace_audio_capture(Box::new(capture)).await {
                    log::warn!("Failed to replace microphone capture before start: {}", e);
                }
            }
            Err(e) => {
                log::warn!(
                    "Failed to create microphone capture for {:?}: {}",
                    device_name,
                    e
                );
            }
        }

        // Device setup itself is asynchronous. Re-check before creating a new
        // provider stream; Stop or mute may have happened meanwhile.
        let Some(state) = app_handle_partial.try_state::<AppState>() else { return; };
        if !microphone_session_should_run(state.inner(), session_id) {
            return;
        }
        drop(state);
        let (mic_event_tx, mut mic_event_rx) =
            tokio::sync::mpsc::unbounded_channel::<SttTranscriptionEvent>();
        if let Some(state) = app_handle_partial.try_state::<AppState>() {
            if microphone_session_should_run(state.inner(), session_id) {
                *state.microphone_stt_event_tx.write().await = Some(mic_event_tx.clone());
            }
        }
        let app_handle_mic_events = app_handle_partial.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = mic_event_rx.recv().await {
                let Some(state) = app_handle_mic_events.try_state::<AppState>() else {
                    continue;
                };
                if state
                    .active_transcription_session_id
                    .load(Ordering::Relaxed)
                    != session_id
                {
                    continue;
                }

                match event {
                    SttTranscriptionEvent::Partial(transcription) => {
                        let payload = PartialTranscriptionPayload::from_transcription(
                            transcription,
                            session_id,
                            "microphone",
                        );
                        crate::presentation::companion_timeline::on_microphone_partial(
                            state.inner(),
                            &payload,
                        )
                        .await;
                        let _ = app_handle_mic_events.emit(EVENT_TRANSCRIPTION_PARTIAL, payload);
                        let _ = crate::presentation::companion::publish_snapshot_sse_only(
                            &app_handle_mic_events,
                        )
                        .await;
                    }
                    SttTranscriptionEvent::Final(transcription) => {
                        let payload = FinalTranscriptionPayload::from_transcription(
                            transcription,
                            session_id,
                            "microphone",
                        );
                        crate::presentation::companion_timeline::on_microphone_final(
                            state.inner(),
                            &payload,
                        )
                        .await;
                        let _ = app_handle_mic_events.emit(EVENT_TRANSCRIPTION_FINAL, payload);
                        let _ = crate::presentation::companion::publish_snapshot_sse_only(
                            &app_handle_mic_events,
                        )
                        .await;
                    }
                    SttTranscriptionEvent::Barrier(ack) => {
                        let _ = ack.send(());
                    }
                }
            }
        });

        let mic_partial_tx = mic_event_tx.clone();
        let on_partial_mic = Arc::new(move |transcription: crate::domain::Transcription| {
            if let Err(error) = mic_partial_tx.send(SttTranscriptionEvent::Partial(transcription)) {
                log::debug!(
                    "Failed to enqueue microphone partial transcription: {}",
                    error
                );
            }
        });

        let mic_final_tx = mic_event_tx.clone();
        let on_final_mic = Arc::new(move |transcription: crate::domain::Transcription| {
            if let Err(error) = mic_final_tx.send(SttTranscriptionEvent::Final(transcription)) {
                log::debug!(
                    "Failed to enqueue microphone final transcription: {}",
                    error
                );
            }
        });

        let app_handle_mic_level = app_handle_partial.clone();
        let on_audio_level_mic = Arc::new(move |level: f32| {
            if let Some(state) = app_handle_mic_level.try_state::<AppState>() {
                crate::presentation::companion_timeline::update_microphone_audio_level(
                    state.inner(),
                    level,
                );
            }
            let payload = AudioLevelPayload { level };
            let _ = app_handle_mic_level.emit(EVENT_MICROPHONE_AUDIO_LEVEL, payload);
        });

        let on_audio_spectrum_noop = Arc::new(|_bars: [f32; 48]| {});
        let on_error_log = Arc::new(|err: SttError| {
            log::warn!("Microphone transcription error: {}", err);
        });
        let on_quality_noop = Arc::new(|_quality: String, _reason: Option<String>| {});

        if let Err(e) = mic_service
            .start_recording(
                on_partial_mic,
                on_final_mic,
                on_audio_level_mic,
                on_audio_spectrum_noop,
                on_error_log,
                on_quality_noop,
            )
            .await
        {
            log::warn!("Microphone transcription failed to start: {}", e);
        } else if let Some(state) = app_handle_partial.try_state::<AppState>() {
            // The mic starts asynchronously after the system capture. A quick
            // Stop can invalidate the session while the model is still loading.
            // Do not leave an orphaned mic recording in that race.
            if !microphone_session_should_run(state.inner(), session_id) {
                log::info!("Mic startup completed after Stop or mute; shutting down stale mic session");
                let _ = mic_service.stop_recording().await;
            }
        }
    });
}

fn classify_transcription_error_type_from_stt(err: &SttError) -> String {
    // ВАЖНО: во фронте error_type используется для connect-retry, поэтому
    // тут нельзя делать "умный" парсинг строки — только типы и детали.
    match err {
        SttError::Authentication(_) => "authentication".to_string(),
        SttError::Configuration(_) => "configuration".to_string(),
        SttError::Connection(conn) => {
            if conn.details.category == Some(SttConnectionCategory::Timeout) {
                "timeout".to_string()
            } else if conn.details.category == Some(SttConnectionCategory::LimitExceeded) {
                "limit_exceeded".to_string()
            } else {
                "connection".to_string()
            }
        }
        SttError::Processing(_) | SttError::Unsupported(_) | SttError::Internal(_) => {
            "processing".to_string()
        }
    }
}

fn error_details_from_stt(err: &SttError) -> Option<TranscriptionErrorDetailsPayload> {
    match err {
        SttError::Connection(conn) => Some(conn.details.clone().into()),
        _ => None,
    }
}

fn next_recording_session_id(state: &AppState) -> u64 {
    state.transcription_session_seq.load(Ordering::Relaxed) + 1
}

/// A device can disappear before TranscriptionService enters Starting.
/// Release the provisional session and reducer even when no provider was started.
async fn abandon_failed_recording_start(state: &AppState, session_id: u64) {
    if state.active_transcription_session_id.compare_exchange(
        session_id,
        0,
        Ordering::SeqCst,
        Ordering::Relaxed,
    ).is_ok() {
        *state.system_stt_event_tx.write().await = None;
    }
}

/// The microphone starts in parallel with system audio. If system audio then fails
/// to start, nothing else would stop a microphone that already began capturing.
/// Taking the start lock waits for an in-flight microphone start, and the session
/// was already abandoned, so a start that has not begun yet exits on its own.
async fn stop_microphone_after_failed_start(state: &AppState) {
    let _start_guard = state.microphone_start_lock.lock().await;
    if state.microphone_transcription_service.get_status().await == RecordingStatus::Idle {
        return;
    }
    if let Err(error) = state.microphone_transcription_service.stop_recording_hard().await {
        log::warn!("Could not stop the microphone after a failed recording start: {error}");
    }
}

/// Start recording voice on the backend path shared with companion actions.
pub async fn start_recording_raw(
    state: &AppState,
    app_handle: AppHandle,
) -> Result<String, String> {
    log::info!("Command: start_recording");

    // Не коммитим seq заранее: если старт упадёт до реального запуска, не хотим "сжигать" session_id.
    let session_id = next_recording_session_id(state);
    state
        .active_transcription_session_id
        .store(session_id, Ordering::Relaxed);
    crate::presentation::companion_timeline::clear_system_live_buffers(state).await;
    crate::presentation::companion_timeline::clear_microphone_live_buffers(state).await;
    log::info!("Recording session started: session_id={}", session_id);

    // A disabled microphone must not reuse the previous session's reducer.
    *state.microphone_stt_event_tx.write().await = None;
    let (system_event_tx, mut system_event_rx) =
        tokio::sync::mpsc::unbounded_channel::<SttTranscriptionEvent>();
    *state.system_stt_event_tx.write().await = Some(system_event_tx.clone());
    let app_handle_events = app_handle.clone();
    let state_final_events = state.final_transcription.clone();
    let state_history_events = state.history.clone();
    let state_config_events = state.config.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = system_event_rx.recv().await {
            let Some(state) = app_handle_events.try_state::<AppState>() else {
                continue;
            };
            if state
                .active_transcription_session_id
                .load(Ordering::Relaxed)
                != session_id
            {
                continue;
            }

            match event {
                SttTranscriptionEvent::Partial(transcription) => {
                    let payload = PartialTranscriptionPayload::from_transcription(
                        transcription,
                        session_id,
                        "system",
                    );
                    crate::presentation::companion_timeline::on_system_partial(
                        state.inner(),
                        &payload,
                    )
                    .await;

                    // Emit event to frontend
                    if let Err(e) = app_handle_events.emit(EVENT_TRANSCRIPTION_PARTIAL, payload) {
                        log::error!("Failed to emit partial transcription event: {}", e);
                    }
                    if let Err(e) = crate::presentation::companion::publish_snapshot_sse_only(
                        &app_handle_events,
                    )
                    .await
                    {
                        log::debug!("Failed to publish companion partial snapshot: {}", e);
                    }
                }
                SttTranscriptionEvent::Final(transcription) => {
                    let canonical_transcription =
                        match crate::presentation::companion_timeline::finalize_system_transcription(
                        state.inner(),
                        session_id,
                        &transcription,
                    )
                    .await
                    {
                        Some(canonical) => canonical,
                        None => {
                            continue;
                        }
                    };

                    // Update state
                    *state_final_events.write().await = Some(canonical_transcription.text.clone());

                    // Add to history
                    state_history_events
                        .write()
                        .await
                        .push(canonical_transcription.clone());

                    // Keep only last N items
                    let max_items = state_config_events.read().await.max_history_items;
                    let mut history = state_history_events.write().await;
                    let len = history.len();
                    if len > max_items {
                        history.drain(0..len - max_items);
                    }
                    drop(history);

                    // Emit event to frontend
                    let payload = FinalTranscriptionPayload::from_transcription(
                        canonical_transcription.clone(),
                        session_id,
                        "system",
                    );
                    if let Err(e) = app_handle_events.emit(EVENT_TRANSCRIPTION_FINAL, payload) {
                        log::error!("Failed to emit final transcription event: {}", e);
                    }
                    if let Err(e) = crate::presentation::companion::publish_snapshot_sse_only(
                        &app_handle_events,
                    )
                    .await
                    {
                        log::debug!("Failed to publish companion final snapshot: {}", e);
                    }
                }
                SttTranscriptionEvent::Barrier(ack) => {
                    let _ = ack.send(());
                }
            }
        }
    });

    let system_partial_tx = system_event_tx.clone();
    // Callback for partial transcriptions
    let on_partial = Arc::new(move |transcription: crate::domain::Transcription| {
        if let Err(error) = system_partial_tx.send(SttTranscriptionEvent::Partial(transcription)) {
            log::debug!("Failed to enqueue system partial transcription: {}", error);
        }
    });

    let system_final_tx = system_event_tx.clone();
    // Callback for final transcription
    let on_final = Arc::new(move |transcription: crate::domain::Transcription| {
        if let Err(error) = system_final_tx.send(SttTranscriptionEvent::Final(transcription)) {
            log::debug!("Failed to enqueue system final transcription: {}", error);
        }
    });

    let app_handle_level = app_handle.clone();

    // Callback for audio level visualization
    let on_audio_level = Arc::new(move |level: f32| {
        let app_handle = app_handle_level.clone();
        if let Some(state) = app_handle.try_state::<AppState>() {
            crate::presentation::companion_timeline::update_system_audio_level(
                state.inner(),
                level,
            );
        }

        // Don't spawn task for every level update - just emit directly
        let payload = AudioLevelPayload { level };
        let _ = app_handle.emit(EVENT_AUDIO_LEVEL, payload);
    });

    let app_handle_spectrum = app_handle.clone();

    // Callback for audio spectrum visualization (48 bars)
    let on_audio_spectrum = Arc::new(move |bars: [f32; 48]| {
        let app_handle = app_handle_spectrum.clone();
        let payload = AudioSpectrumPayload {
            bars: bars.to_vec(),
        };
        let _ = app_handle.emit(EVENT_AUDIO_SPECTRUM, payload);
    });

    let app_handle_error = app_handle.clone();

    // Callback for error handling
    let on_error = Arc::new(move |err: SttError| {
        let app_handle = app_handle_error.clone();

        tokio::spawn(async move {
            let error_type = classify_transcription_error_type_from_stt(&err);
            let error_details = error_details_from_stt(&err);
            let error = err.to_string();

            log::error!("STT error occurred: {} (type: {})", error, error_type);

            // Emit error event to frontend
            let payload = TranscriptionErrorPayload {
                session_id,
                error,
                error_type,
                error_details,
            };
            if let Err(e) = app_handle.emit(EVENT_TRANSCRIPTION_ERROR, payload) {
                log::error!("Failed to emit transcription error event: {}", e);
            }

            // Emit Error status
            let _ = app_handle.emit(
                EVENT_RECORDING_STATUS,
                RecordingStatusPayload {
                    session_id,
                    status: RecordingStatus::Error,
                    stopped_via_hotkey: false,
                },
            );
            if let Err(e) = crate::presentation::companion::publish_snapshot(&app_handle).await {
                log::debug!("Failed to publish companion error snapshot: {}", e);
            }
        });
    });

    let app_handle_quality = app_handle.clone();

    // Callback for connection quality updates
    let on_connection_quality = Arc::new(move |quality: String, reason: Option<String>| {
        let app_handle = app_handle_quality.clone();

        tokio::spawn(async move {
            log::info!(
                "Connection quality changed: {} (reason: {:?})",
                quality,
                reason
            );

            // Emit connection quality event to frontend
            let payload = ConnectionQualityPayload {
                session_id,
                quality: match quality.as_str() {
                    "Good" => crate::presentation::events::ConnectionQuality::Good,
                    "Poor" => crate::presentation::events::ConnectionQuality::Poor,
                    "Recovering" => crate::presentation::events::ConnectionQuality::Recovering,
                    _ => crate::presentation::events::ConnectionQuality::Good,
                },
                reason,
            };

            if let Err(e) = app_handle.emit(EVENT_CONNECTION_QUALITY, payload) {
                log::error!("Failed to emit connection quality event: {}", e);
            }
        });
    });

    // Emit Starting status immediately
    log::debug!("Emitting status: Starting (stopped_via_hotkey: false)");
    let _ = app_handle.emit(
        EVENT_RECORDING_STATUS,
        RecordingStatusPayload {
            session_id,
            status: RecordingStatus::Starting,
            stopped_via_hotkey: false,
        },
    );

    // Перед стартом записи пересоздаём audio capture по текущему конфигу.
    // Это критично для кейса "Default" → пользователь подключил новое устройство, и default сменился.
    let (output_device, microphone_device) = {
        let cfg = state.config.read().await;
        (
            cfg.selected_output_audio_device.clone(),
            cfg.selected_audio_device.clone(),
        )
    };
    if let Err(error) = state
        .recreate_audio_capture_with_device(output_device, app_handle.clone())
        .await
    {
        let message = format!("Не удалось инициализировать устройство записи: {}", error);
        abandon_failed_recording_start(state, session_id).await;
        // Match the provider-start error contract: otherwise the UI may keep
        // showing Starting after an unplugged or unavailable audio device.
        on_error(SttError::Configuration(message.clone()));
        return Err(message);
    }

    // Local Parakeet loads a separate microphone model. Start both sources in
    // parallel so the microphone is ready at the same time as system audio.
    if state
        .microphone_transcription_enabled
        .load(Ordering::Relaxed)
    {
        spawn_microphone_transcription_start(
            state.microphone_transcription_service.clone(),
            app_handle.clone(),
            session_id,
            microphone_device,
        );
    }

    // Start recording (async - WebSocket connect, audio capture start)
    let start_result = state
        .transcription_service
        .start_recording(
            on_partial,
            on_final,
            on_audio_level,
            on_audio_spectrum,
            on_error.clone(),
            on_connection_quality.clone(),
        )
        .await;

    // Важно: если старт провалился ДО того, как провайдер успел вызвать on_error (например, упали на handshake/connection refused),
    // UI останется в Starting и будет ощущение "подключение идёт, но ничего не происходит".
    // Поэтому здесь явно отправляем error + status=Error тем же контрактом, что и в runtime-ошибках.
    if let Err(e) = start_result {
        abandon_failed_recording_start(state, session_id).await;
        stop_microphone_after_failed_start(state).await;
        // Стараемся извлечь исходную причину максимально надёжно (без парсинга строки).
        let stt = e
            .downcast_ref::<SttError>()
            .cloned()
            .unwrap_or_else(|| SttError::Internal(e.to_string()));
        let error = stt.to_string();
        let error_type = classify_transcription_error_type_from_stt(&stt);

        log::error!(
            "Failed to start recording: {} (type: {})",
            error,
            error_type
        );

        // Сначала transcription:error, потом recording:status=Error (во фронте есть логика suppression/retry).
        on_error(stt);

        return Err(error);
    }

    state
        .transcription_session_seq
        .store(session_id, Ordering::Relaxed);

    // Emit Recording status after successful start
    log::debug!("Emitting status: Recording (stopped_via_hotkey: false)");
    let _ = app_handle.emit(
        EVENT_RECORDING_STATUS,
        RecordingStatusPayload {
            session_id,
            status: RecordingStatus::Recording,
            stopped_via_hotkey: false,
        },
    );

    Ok("Recording started".to_string())
}

/// Drain both reducer queues before invalidating the recording session ID.
/// Each worker's final callback only enqueues its result; the timeline update
/// happens on the event receiver and is not synchronous with worker completion.
async fn drain_stt_event_queue(
    slot: &Arc<tokio::sync::RwLock<Option<tokio::sync::mpsc::UnboundedSender<SttTranscriptionEvent>>>>,
    source: &str,
) -> Result<(), String> {
    let Some(tx) = slot.write().await.take() else {
        return Ok(());
    };
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
    tx.send(SttTranscriptionEvent::Barrier(ack_tx))
        .map_err(|_| format!("Failed to queue {source} final transcription drain"))?;
    match tokio::time::timeout(std::time::Duration::from_secs(3), ack_rx).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(format!("{source} transcription reducer stopped before drain")),
        Err(_) => Err(format!("Timed out draining {source} final transcription events")),
    }
}

#[cfg(test)]
mod stt_drain_tests {
    use super::*;

    #[tokio::test]
    async fn stt_drain_barrier_waits_for_prior_final_events() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let slot = Arc::new(tokio::sync::RwLock::new(Some(tx.clone())));
        tx.send(SttTranscriptionEvent::Final(
            crate::domain::Transcription::final_result("last word".to_string())
        )).unwrap();
        drop(tx);
        let worker = tokio::spawn(async move {
            let mut saw_final = false;
            while let Some(event) = rx.recv().await {
                match event {
                    SttTranscriptionEvent::Final(result) => {
                        assert_eq!(result.text, "last word");
                        saw_final = true;
                    }
                    SttTranscriptionEvent::Barrier(ack) => {
                        assert!(saw_final);
                        let _ = ack.send(());
                        return;
                    }
                    _ => {}
                }
            }
            panic!("lost final event before Stop barrier");
        });
        drain_stt_event_queue(&slot, "test").await.unwrap();
        worker.await.unwrap();
    }

    #[tokio::test]
    async fn a_failed_capture_start_releases_its_session_and_event_reducer() {
        let state = AppState::default();
        state.active_transcription_session_id.store(41, Ordering::Relaxed);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        *state.system_stt_event_tx.write().await = Some(tx);

        abandon_failed_recording_start(&state, 41).await;

        assert_eq!(state.active_transcription_session_id.load(Ordering::Relaxed), 0);
        assert!(state.system_stt_event_tx.read().await.is_none());
    }

    #[tokio::test]
    async fn an_old_failure_does_not_clear_a_new_recording_session() {
        let state = AppState::default();
        state.active_transcription_session_id.store(42, Ordering::Relaxed);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        *state.system_stt_event_tx.write().await = Some(tx);

        abandon_failed_recording_start(&state, 41).await;

        assert_eq!(state.active_transcription_session_id.load(Ordering::Relaxed), 42);
        assert!(state.system_stt_event_tx.read().await.is_some());
    }

    #[test]
    fn stale_or_muted_microphone_session_cannot_start() {
        let state = AppState::default();
        state.active_transcription_session_id.store(41, Ordering::Relaxed);
        assert!(microphone_session_should_run(&state, 41));
        state.microphone_transcription_enabled.store(false, Ordering::Relaxed);
        assert!(!microphone_session_should_run(&state, 41));
        state.microphone_transcription_enabled.store(true, Ordering::Relaxed);
        state.active_transcription_session_id.store(42, Ordering::Relaxed);
        assert!(!microphone_session_should_run(&state, 41));
        assert!(microphone_session_should_run(&state, 42));
    }

    #[tokio::test]
    async fn stt_drain_barrier_reports_closed_receiver() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        drop(rx);
        let slot = Arc::new(tokio::sync::RwLock::new(Some(tx)));
        assert!(drain_stt_event_queue(&slot, "test").await.is_err());
    }
}

/// Stop recording voice
pub async fn stop_recording_raw(
    state: &AppState,
    app_handle: AppHandle,
    stopped_via_hotkey: bool,
) -> Result<String, String> {
    log::info!("Command: stop_recording");

    let session_id = state
        .active_transcription_session_id
        .load(Ordering::Relaxed);
    let local_stt_enabled = state.config.read().await.stt.provider.is_local_utterance();
    let mic_expected = state.microphone_transcription_enabled.load(Ordering::Relaxed);

    // Always finish the second channel and drain both reducers even if the
    // system provider reports that its final utterance could not be decoded.
    let result = state
        .transcription_service
        .stop_recording()
        .await
        .map_err(|e| e.to_string());

    // The mic may still be in Starting while its local model is loading.
    // Abort that startup rather than leaving a recording to start after Stop.
    let mic_service = &state.microphone_transcription_service;
    let mut mic_stop_error = None;
    match mic_service.get_status().await {
        RecordingStatus::Recording => {
            if let Err(e) = mic_service.stop_recording().await {
                log::warn!("Microphone transcription stop failed: {}", e);
                mic_stop_error = Some(e.to_string());
            }
        }
        RecordingStatus::Starting => {
            if let Err(e) = mic_service.abort_starting().await {
                log::warn!("Microphone startup abort failed: {}", e);
                mic_stop_error = Some(e.to_string());
            } else if local_stt_enabled && mic_expected {
                mic_stop_error = Some("Microphone had not finished starting before Stop".to_string());
            }
        }
        _ if local_stt_enabled && mic_expected => {
            // An enabled local microphone that never started (or failed earlier)
            // must not be silently reported as a complete two-channel session.
            mic_stop_error = Some("Microphone was not recording when local STT stopped".to_string());
        }
        _ => {}
    }

    // The STT workers have stopped emitting callbacks. Ensure their finals
    // reached the canonical timeline before deactivating this session.
    let (system_drain, microphone_drain) = tokio::join!(
        drain_stt_event_queue(&state.system_stt_event_tx, "system"),
        drain_stt_event_queue(&state.microphone_stt_event_tx, "microphone"),
    );

    crate::presentation::companion_timeline::finalize_or_clear_system_live_on_stop(
        state, session_id,
    )
    .await;
    crate::presentation::companion_timeline::finalize_or_clear_microphone_live_on_stop(
        state, session_id,
    )
    .await;

    state
        .active_transcription_session_id
        .store(0, Ordering::Relaxed);

    // Emit status change
    log::debug!("Emitting status: Idle (stopped_via_hotkey: false)");
    let _ = app_handle.emit(
        EVENT_RECORDING_STATUS,
        RecordingStatusPayload {
            session_id,
            status: RecordingStatus::Idle,
            stopped_via_hotkey,
        },
    );

    // Offline local STT must never report a clean Stop if mic data or reducer
    // events were lost. Keep the legacy cloud mic best-effort semantics.
    if local_stt_enabled {
        let mut failures = Vec::new();
        if let Err(error) = &result {
            failures.push(format!("system: {error}"));
        }
        if let Some(error) = mic_stop_error {
            failures.push(format!("microphone: {error}"));
        }
        if let Err(error) = system_drain {
            failures.push(error);
        }
        if let Err(error) = microphone_drain {
            failures.push(error);
        }
        if !failures.is_empty() {
            log::warn!("Local STT stop finished with problems: {}", failures.join("; "));
            return Err(format!("Local STT Stop did not preserve all finals: {}", failures.join("; ")));
        }
    } else {
        if let Err(error) = system_drain {
            log::warn!("{}", error);
        }
        if let Err(error) = microphone_drain {
            log::warn!("{}", error);
        }
    }

    result
}

/// Abort recording start while the service is still in `Starting`.
pub async fn abort_starting_recording_raw(
    state: &AppState,
    app_handle: AppHandle,
    stopped_via_hotkey: bool,
) -> Result<String, String> {
    log::info!("Command: abort_starting_recording");

    let session_id = state
        .active_transcription_session_id
        .load(Ordering::Relaxed);

    let result = state
        .transcription_service
        .abort_starting()
        .await
        .map_err(|e| e.to_string())?;

    if let Err(e) = state
        .microphone_transcription_service
        .stop_recording()
        .await
    {
        log::debug!(
            "Microphone transcription stop after start-abort skipped/failed: {}",
            e
        );
    }

    state
        .active_transcription_session_id
        .store(0, Ordering::Relaxed);
    crate::presentation::companion_timeline::clear_system_live_buffers(state).await;
    *state.final_transcription.write().await = None;
    crate::presentation::companion_timeline::clear_microphone_live_buffers(state).await;

    let _ = app_handle.emit(
        EVENT_RECORDING_STATUS,
        RecordingStatusPayload {
            session_id,
            status: RecordingStatus::Idle,
            stopped_via_hotkey,
        },
    );

    Ok(result)
}

/// Start recording voice
#[tauri::command]
pub async fn start_recording(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let response = crate::presentation::companion_actions::ensure_recording_started(
        state.inner(),
        &app_handle,
    )
    .await?;
    match response.action_result.as_str() {
        "started" => Ok("Recording started".to_string()),
        "noop" => Ok("Recording already active".to_string()),
        "busy_transition" => Err("Transition in progress".to_string()),
        "rejected_auth" => Err("Authentication required".to_string()),
        other => Ok(other.to_string()),
    }
}

/// Stop recording voice
#[tauri::command]
pub async fn stop_recording(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let response = crate::presentation::companion_actions::ensure_recording_stopped(
        state.inner(),
        &app_handle,
        false,
    )
    .await?;
    match response.action_result.as_str() {
        "stopped" => Ok("Recording stopped".to_string()),
        "noop" => Ok("Recording already idle".to_string()),
        "busy_transition" => Err("Transition in progress".to_string()),
        "rejected_auth" => Err("Authentication required".to_string()),
        other => Ok(other.to_string()),
    }
}

/// Enable/disable parallel microphone transcription.
/// When disabled: stops mic stream (best-effort).
/// When enabled during an active recording session: starts mic stream (best-effort).
#[tauri::command]
pub async fn set_microphone_transcription_enabled(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    sync_microphone_transcription_enabled_internal(state.inner(), app_handle, enabled).await
}

/// Get current recording status
#[tauri::command]
pub async fn get_recording_status(state: State<'_, AppState>) -> Result<RecordingStatus, String> {
    log::debug!("Command: get_recording_status");
    Ok(state.transcription_service.get_status().await)
}

use tauri::{PhysicalPosition, Position};

/// Показывает окно на активном мониторе (где находится курсор мыши) - для Window
pub fn show_window_on_active_monitor(window: &Window) -> Result<(), String> {
    show_window_on_active_monitor_impl(
        || window.current_monitor(),
        || window.primary_monitor(),
        || window.outer_size(),
        |pos| window.set_position(pos),
        || window.show(),
    )
}

/// Показывает окно на активном мониторе (где находится курсор мыши) - для WebviewWindow
pub fn show_webview_window_on_active_monitor<R: tauri::Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    show_window_on_active_monitor_impl(
        || window.current_monitor(),
        || window.primary_monitor(),
        || window.outer_size(),
        |pos| window.set_position(pos),
        || window.show(),
    )
}

/// Общая реализация для позиционирования окна по центру текущего монитора
fn show_window_on_active_monitor_impl<F1, F2, F3, F4, F5>(
    get_current_monitor: F1,
    get_primary_monitor: F2,
    get_outer_size: F3,
    set_position: F4,
    show: F5,
) -> Result<(), String>
where
    F1: FnOnce() -> tauri::Result<Option<tauri::Monitor>>,
    F2: FnOnce() -> tauri::Result<Option<tauri::Monitor>>,
    F3: FnOnce() -> tauri::Result<tauri::PhysicalSize<u32>>,
    F4: FnOnce(Position) -> tauri::Result<()>,
    F5: FnOnce() -> tauri::Result<()>,
{
    log::debug!("Определяем активный монитор для позиционирования окна...");

    // Определяем текущий монитор (где находится окно)
    let current_monitor = get_current_monitor()
        .map_err(|e| format!("Failed to get current monitor: {}", e))?
        .or_else(|| {
            log::warn!("current_monitor() вернул None, использую primary монитор");
            get_primary_monitor().ok().flatten()
        })
        .ok_or("No monitor found")?;

    // Получаем размеры и позицию монитора
    let monitor_size = current_monitor.size();
    let monitor_position = current_monitor.position();

    log::debug!(
        "Монитор: позиция ({}, {}), размер {}x{}",
        monitor_position.x,
        monitor_position.y,
        monitor_size.width,
        monitor_size.height
    );

    // Получаем размеры окна
    let window_size = get_outer_size().map_err(|e| format!("Failed to get window size: {}", e))?;

    // Вычисляем центральную позицию на мониторе
    let x = monitor_position.x + (monitor_size.width as i32 - window_size.width as i32) / 2;
    let y = monitor_position.y + (monitor_size.height as i32 - window_size.height as i32) / 2;

    log::debug!("Устанавливаю позицию окна: ({}, {})", x, y);

    // Устанавливаем позицию окна
    set_position(Position::Physical(PhysicalPosition { x, y }))
        .map_err(|e| format!("Failed to set window position: {}", e))?;

    // Показываем окно
    show().map_err(|e| e.to_string())?;

    log::info!("✅ Окно показано по центру монитора");

    Ok(())
}

#[cfg(test)]
mod snapshot_contract_tests {
    use super::{AppConfigSnapshotData, SnapshotEnvelope, SttConfigSnapshotData};
    use crate::domain::{AnswerAudience, AnswerImperfectionLevel, AnswerLanguage, SttProviderType};

    fn assert_absent(json: &str, needles: &[&str]) {
        for needle in needles {
            assert!(
                !json.contains(needle),
                "snapshot JSON must not contain `{}`; got: {}",
                needle,
                json
            );
        }
    }

    #[test]
    fn app_config_snapshot_is_public_and_does_not_leak_secrets() {
        let env = SnapshotEnvelope {
            revision: "1".to_string(),
            data: AppConfigSnapshotData {
                microphone_sensitivity: 95,
                recording_hotkey: "CmdOrCtrl+Shift+X".to_string(),
                auto_copy_to_clipboard: true,
                auto_paste_text: false,
                selected_audio_device: None,
                selected_output_audio_device: None,
                interview_memory_enabled: true,
                answer_language: AnswerLanguage::English,
                answer_audience: AnswerAudience::Internal,
                natural_answer_style_enabled: true,
                answer_imperfection_level: AnswerImperfectionLevel::Light,
            },
        };

        let json = serde_json::to_string(&env).expect("must serialize");

        // Жёсткий запрет на потенциально чувствительные поля + запрет на вложенный stt.
        assert_absent(
            &json,
            &[
                "backend_auth_token",
                "backend_url",
                "refresh_token",
                "access_token",
                "\"stt\"",
            ],
        );

        // И базовая проверка наличия ожидаемых ключей.
        let v: serde_json::Value = serde_json::from_str(&json).expect("must parse json");
        let data = v
            .get("data")
            .and_then(|x| x.as_object())
            .expect("data object");
        assert!(data.contains_key("microphone_sensitivity"));
        assert!(data.contains_key("recording_hotkey"));
        assert!(data.contains_key("auto_copy_to_clipboard"));
        assert!(data.contains_key("auto_paste_text"));
        assert!(data.contains_key("selected_audio_device"));
        assert!(data.contains_key("selected_output_audio_device"));
    }

    #[test]
    fn stt_config_snapshot_is_public_and_does_not_leak_backend_token_or_url() {
        let env = SnapshotEnvelope {
            revision: "7".to_string(),
            data: SttConfigSnapshotData {
                provider: SttProviderType::Backend,
                language: "ru".to_string(),
                auto_detect_language: false,
                enable_punctuation: true,
                filter_profanity: false,
                deepgram_api_key: None,
                assemblyai_api_key: None,
                model: None,
                keep_connection_alive: true,
                deepgram_keyterms: None,
            },
        };

        let json = serde_json::to_string(&env).expect("must serialize");
        assert_absent(
            &json,
            &[
                "backend_auth_token",
                "backend_url",
                "refresh_token",
                "access_token",
            ],
        );

        // Проверяем, что JSON-форма стабильная (ожидаемые ключи присутствуют).
        let v: serde_json::Value = serde_json::from_str(&json).expect("must parse json");
        let data = v
            .get("data")
            .and_then(|x| x.as_object())
            .expect("data object");
        assert!(data.contains_key("provider"));
        assert!(data.contains_key("language"));
        assert!(data.contains_key("keep_connection_alive"));
    }
}
/// Toggle window visibility
#[tauri::command]
pub async fn toggle_window(state: State<'_, AppState>, window: Window) -> Result<(), String> {
    log::info!("Command: toggle_window");

    if window.is_visible().map_err(|e| e.to_string())? {
        window.hide().map_err(|e| e.to_string())?;
    } else {
        // Перед показом окна сохраняем bundle ID текущего активного приложения
        // (чтобы потом вставлять текст в правильное окно)
        #[cfg(target_os = "macos")]
        {
            if let Some(bundle_id) = crate::infrastructure::auto_paste::get_active_app_bundle_id() {
                *state.last_focused_app_bundle_id.write().await = Some(bundle_id.clone());
                log::info!("Saved last focused app bundle ID: {}", bundle_id);
            }
        }

        show_window_on_active_monitor(&window)?;

        // Сообщаем фронту, что окно показано (для надёжного reset UI).
        // Не используем focus, т.к. main на macOS может быть nonactivating NSPanel.
        let _ = window.emit(EVENT_RECORDING_WINDOW_SHOWN, ());
    }

    Ok(())
}

/// Toggle recording and show window if hidden
#[tauri::command]
pub async fn toggle_recording_with_window(
    state: State<'_, AppState>,
    window: Window,
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!("Command: toggle_recording_with_window");

    // Если пользователь не авторизован — не показываем recording окно.
    // Иначе получается странное поведение: окно может получить фокус, но UI в нём "none" (скрыт правилами windowMode).
    let is_authenticated = state.has_local_access().await;
    if !is_authenticated {
        log::info!(
            "toggle_recording_with_window: user not authenticated -> redirect to auth window"
        );
        show_auth_window(app_handle).await?;
        return Ok(());
    }

    // Переключаем состояние записи
    let current_status = state.transcription_service.get_status().await;

    match current_status {
        RecordingStatus::Idle => {
            // Показываем окно если оно скрыто (не забираем фокус)
            if !window.is_visible().map_err(|e| e.to_string())? {
                // Перед показом окна сохраняем bundle ID текущего активного приложения
                #[cfg(target_os = "macos")]
                {
                    if let Some(bundle_id) =
                        crate::infrastructure::auto_paste::get_active_app_bundle_id()
                    {
                        *state.last_focused_app_bundle_id.write().await = Some(bundle_id.clone());
                        log::info!("Saved last focused app bundle ID: {}", bundle_id);
                    }
                }

                show_window_on_active_monitor(&window)?;

                // Сообщаем фронту, что окно показано (для надёжного reset UI).
                let _ = window.emit(EVENT_RECORDING_WINDOW_SHOWN, ());
            }

            // Запускаем запись через shared backend path
            let _ = crate::presentation::companion_actions::ensure_recording_started(
                state.inner(),
                &app_handle,
            )
            .await?;
            log::info!("Recording started via hotkey");
        }
        RecordingStatus::Starting => {
            let _ = crate::presentation::companion_actions::ensure_recording_stopped(
                state.inner(),
                &app_handle,
                true,
            )
            .await?;
            log::info!("Recording start aborted via hotkey");
        }
        RecordingStatus::Recording => {
            // Останавливаем запись через shared backend path
            let _ = crate::presentation::companion_actions::ensure_recording_stopped(
                state.inner(),
                &app_handle,
                true,
            )
            .await?;

            log::info!("Recording stopped via hotkey");
        }
        RecordingStatus::Processing => {
            // Игнорируем - запись уже останавливается
            log::debug!("Ignoring toggle - recording is already being processed");
        }
        RecordingStatus::Error => {
            log::warn!("Cannot toggle recording - system is in error state");
        }
    }

    Ok(())
}

/// Internal version for calling from hotkey handler (without State wrapper)
pub async fn toggle_recording_with_window_internal(
    state: &AppState,
    window: tauri::WebviewWindow,
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!("toggle_recording_with_window_internal (from hotkey)");

    // Проверяем авторизацию - если не авторизован, показываем auth окно
    let is_authenticated = state.has_local_access().await;
    if !is_authenticated {
        log::info!("User not authenticated - showing auth window");
        if let Some(auth) = app_handle.get_webview_window("auth") {
            auth.show().map_err(|e| e.to_string())?;
            auth.set_focus().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let current_status = state.transcription_service.get_status().await;

    match current_status {
        RecordingStatus::Idle => {
            // Показываем окно если оно скрыто
            if !window.is_visible().map_err(|e| e.to_string())? {
                #[cfg(target_os = "macos")]
                {
                    if let Some(bundle_id) =
                        crate::infrastructure::auto_paste::get_active_app_bundle_id()
                    {
                        *state.last_focused_app_bundle_id.write().await = Some(bundle_id.clone());
                        log::info!("Saved last focused app bundle ID: {}", bundle_id);
                    }
                }
                show_webview_window_on_active_monitor(&window)?;

                // Сообщаем фронту, что окно показано (для надёжного reset UI).
                let _ = window.emit(EVENT_RECORDING_WINDOW_SHOWN, ());
            }

            // ВАЖНО: стартуем запись на Rust-стороне.
            // Иначе, когда окно было скрыто, WebView/JS могут быть "усыплены" и не обработать event,
            // из-за чего хоткей откроет окно, но запись не стартует и UI останется в старом состоянии.
            let _ = crate::presentation::companion_actions::ensure_recording_started(
                state,
                &app_handle,
            )
            .await?;
            log::info!("Recording started via hotkey (internal)");
        }
        RecordingStatus::Starting => {
            let _ = crate::presentation::companion_actions::ensure_recording_stopped(
                state,
                &app_handle,
                true,
            )
            .await?;
            log::info!("Recording start aborted via hotkey");
        }
        RecordingStatus::Recording => {
            let _ = crate::presentation::companion_actions::ensure_recording_stopped(
                state,
                &app_handle,
                true,
            )
            .await?;

            log::info!("Recording stopped via hotkey");
        }
        RecordingStatus::Processing => {
            log::debug!("Ignoring toggle - recording is processing");
        }
        RecordingStatus::Error => {
            log::warn!("Cannot toggle recording - error state");
        }
    }

    Ok(())
}

/// Minimize window
#[tauri::command]
pub async fn minimize_window(window: Window) -> Result<(), String> {
    log::info!("Command: minimize_window");
    window.minimize().map_err(|e| e.to_string())?;
    Ok(())
}

//
// STT Configuration Commands
//

use crate::domain::SttProviderType;

/// Update STT configuration
#[tauri::command]
pub async fn update_stt_config(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    window: Window,
    provider: String,
    language: String,
    deepgram_api_key: Option<String>,
    assemblyai_api_key: Option<String>,
    model: Option<String>,
    // Важно: двойной Option позволяет отличить "поле не прислали" (None)
    // от "поле прислали как null" (Some(None)). Это нужно, чтобы
    // частичные обновления (например, только language) не затирали keyterms.
    deepgram_keyterms: Option<Option<String>>,
) -> Result<(), String> {
    log::info!(
        "Command: update_stt_config - provider: {}, language: {}, model: {:?}",
        provider,
        language,
        model
    );

    let _guard = state.stt_config_guard.lock().await;

    // An explicit choice; do not silently switch offline transcription to cloud.
    let provider_type = match provider.trim().to_ascii_lowercase().as_str() {
        "backend" => SttProviderType::Backend,
        "parakeetultra" => SttProviderType::ParakeetUltra,
        "whisperlargev3" => SttProviderType::WhisperLargeV3,
        "whisperlargev3turbo" => SttProviderType::WhisperLargeV3Turbo,
        other => return Err(format!("Unsupported STT provider: {other}")),
    };

    // Снимаем текущее состояние для сравнения после сохранения
    let old_stt = {
        let config = state.config.read().await;
        config.stt.clone()
    };

    // Загружаем существующую конфигурацию из файла (если есть)
    let mut config = ConfigStore::load_config().await.unwrap_or_default();

    // Обновляем только переданные параметры
    config.provider = provider_type;
    config.language = language;

    // Preserve the model path on partial language updates. A path belongs to one
    // provider: clear it on any provider change so the new model is auto-discovered
    // (a Parakeet file must never be handed to Whisper, or the reverse).
    if provider_type != old_stt.provider {
        config.model = None;
    }
    if let Some(model) = model {
        config.model = (!model.trim().is_empty()).then_some(model);
    }

    // Backend keep-alive deliberately stays disabled: Deepgram/Backend pause+resume is
    // harder to make reliable than reconnecting, and transcription stability is more important.
    config.keep_connection_alive = false;

    log::debug!(
        "Setting keep_connection_alive={} for provider {:?}",
        config.keep_connection_alive,
        provider_type
    );

    // API ключи больше не используем в настройках (backend-only).
    let _ = deepgram_api_key;
    let _ = assemblyai_api_key;
    config.deepgram_api_key = None;
    config.assemblyai_api_key = None;

    // Keyterms для улучшения распознавания Deepgram
    // - None: не меняем существующее значение
    // - Some(None): очищаем
    // - Some(Some(v)): устанавливаем v
    if let Some(next) = deepgram_keyterms {
        config.deepgram_keyterms = next;
    }

    // Do not partially switch only one of the two audio services while a
    // local-model session is active (including asynchronous mic startup).
    let local_model_change =
        (old_stt.provider.is_local_utterance() || config.provider.is_local_utterance())
            && (old_stt.provider != config.provider
                || old_stt.model != config.model
                || old_stt.language != config.language);
    if local_model_change {
        let (system_status, mic_status) = tokio::join!(
            state.transcription_service.get_status(),
            state.microphone_transcription_service.get_status(),
        );
        if system_status != RecordingStatus::Idle || mic_status != RecordingStatus::Idle {
            return Err(
                "Stop both audio streams before changing the local STT provider or model"
                    .to_string(),
            );
        }
    }

    // Fail the switch up front, with install instructions, instead of at the
    // first Start press when the selected local model file is missing.
    if config.provider.is_local_utterance() {
        crate::infrastructure::stt::ensure_local_model_present(&config)
            .map_err(|e| e.to_string())?;
    }

    // Обновляем конфигурацию в сервисе
    state
        .transcription_service
        .update_config(config.clone())
        .await
        .map_err(|e| e.to_string())?;

    // Микрофонная транскрибация использует тот же STT конфиг (best-effort).
    if let Err(e) = state
        .microphone_transcription_service
        .update_config(config.clone())
        .await
    {
        log::warn!("Failed to update microphone transcription config: {}", e);
    }

    // ВАЖНО: синхронизируем STT конфигурацию в AppConfig чтобы при сохранении
    // app_config.json не перезаписывались старые значения
    {
        let mut app_config = state.config.write().await;
        app_config.stt = config.clone();
    }

    // Сохраняем конфигурацию на диск (без API ключа)
    ConfigStore::save_config(&config)
        .await
        .map_err(|e| format!("Failed to save config: {}", e))?;

    // Синхронизация между окнами — бампим ревизию при любых изменениях STT конфига,
    // чтобы state-sync корректно подтягивал актуальный snapshot (включая keyterms и т.д.)
    let stt_changed = config.language != old_stt.language
        || config.deepgram_keyterms != old_stt.deepgram_keyterms
        || config.provider != old_stt.provider
        || config.model != old_stt.model;
    if stt_changed {
        let revision = AppState::bump_revision(&state.stt_config_revision).await;
        let _ = app_handle.emit(
            EVENT_STATE_SYNC_INVALIDATION,
            crate::presentation::StateSyncInvalidationPayload {
                topic: "stt-config".to_string(),
                revision,
                source_id: Some(window.label().to_string()),
                timestamp_ms: chrono::Utc::now().timestamp_millis(),
            },
        );
    }

    if local_model_change && config.provider.is_local_utterance() {
        state.spawn_local_model_warm_up();
    }

    log::info!("STT configuration updated and saved successfully");
    Ok(())
}

//
// App Configuration Commands
//

/// Обёртка snapshot для state-sync протокола
#[derive(Debug, Clone, serde::Serialize)]
pub struct SnapshotEnvelope<T: serde::Serialize> {
    pub revision: String,
    pub data: T,
}

/// Минимальный "public" снапшот app-config для фронтенда.
///
/// Важно: не включаем STT конфиг и тем более токены — снапшоты идут во все окна через IPC.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AppConfigSnapshotData {
    pub microphone_sensitivity: u8,
    pub recording_hotkey: String,
    pub auto_copy_to_clipboard: bool,
    pub auto_paste_text: bool,
    pub selected_audio_device: Option<String>,
    pub selected_output_audio_device: Option<String>,
    pub interview_memory_enabled: bool,
    pub answer_language: crate::domain::AnswerLanguage,
    pub answer_audience: crate::domain::AnswerAudience,
    pub natural_answer_style_enabled: bool,
    pub answer_imperfection_level: crate::domain::AnswerImperfectionLevel,
}

/// Get current application configuration + revision (for cross-window sync)
#[tauri::command]
pub async fn get_app_config_snapshot(
    state: State<'_, AppState>,
) -> Result<SnapshotEnvelope<AppConfigSnapshotData>, String> {
    log::debug!("Command: get_app_config_snapshot");
    let config = state.config.read().await.clone();
    let data = AppConfigSnapshotData {
        microphone_sensitivity: config.microphone_sensitivity,
        recording_hotkey: config.recording_hotkey,
        auto_copy_to_clipboard: false,
        auto_paste_text: false,
        selected_audio_device: config.selected_audio_device,
        selected_output_audio_device: config.selected_output_audio_device,
        interview_memory_enabled: config.interview_memory_enabled,
        answer_language: config.answer_style.language,
        answer_audience: config.answer_style.audience,
        natural_answer_style_enabled: config.answer_style.natural_answer_style_enabled,
        answer_imperfection_level: config.answer_style.imperfection_level,
    };
    let revision = state.app_config_revision.read().await.to_string();
    Ok(SnapshotEnvelope { revision, data })
}

/// Минимальный "public" снапшот stt-config для фронтенда.
///
/// Важно: не включаем backend_auth_token / backend_url (секреты), потому что снапшоты идут во все окна через IPC.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SttConfigSnapshotData {
    pub provider: crate::domain::SttProviderType,
    pub language: String,
    pub auto_detect_language: bool,
    pub enable_punctuation: bool,
    pub filter_profanity: bool,
    pub deepgram_api_key: Option<String>,
    pub assemblyai_api_key: Option<String>,
    pub model: Option<String>,
    pub keep_connection_alive: bool,
    pub deepgram_keyterms: Option<String>,
}

/// Get current STT configuration snapshot
#[tauri::command]
pub async fn get_stt_config_snapshot(
    state: State<'_, AppState>,
) -> Result<SnapshotEnvelope<SttConfigSnapshotData>, String> {
    log::debug!("Command: get_stt_config_snapshot");
    let config = state.transcription_service.get_config().await;
    let data = SttConfigSnapshotData {
        provider: config.provider,
        language: config.language,
        auto_detect_language: config.auto_detect_language,
        enable_punctuation: config.enable_punctuation,
        filter_profanity: config.filter_profanity,
        deepgram_api_key: config.deepgram_api_key,
        assemblyai_api_key: config.assemblyai_api_key,
        model: config.model,
        keep_connection_alive: config.keep_connection_alive,
        deepgram_keyterms: config.deepgram_keyterms,
    };
    let revision = state.stt_config_revision.read().await.to_string();
    Ok(SnapshotEnvelope { revision, data })
}

/// Данные для snapshot авторизации
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthStateData {
    pub is_authenticated: bool,
    pub local_no_auth: bool,
}

/// Get current auth state snapshot
#[tauri::command]
pub async fn get_auth_state_snapshot(
    state: State<'_, AppState>,
) -> Result<SnapshotEnvelope<AuthStateData>, String> {
    log::trace!("Command: get_auth_state_snapshot");
    let is_authenticated = state.has_local_access().await;
    let revision = state.auth_state_revision.read().await.to_string();
    Ok(SnapshotEnvelope {
        revision,
        data: AuthStateData { is_authenticated, local_no_auth: AppState::local_no_auth_mode() },
    })
}

/// Полный снапшот auth-session (device_id + tokens).
///
/// В отличие от auth-state, этот снапшот содержит секреты (access/refresh),
/// поэтому его нельзя логировать/сериализовать в публичные конфиги.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthSessionSnapshotData {
    pub device_id: String,
    pub session: Option<AuthSessionSnapshotSessionData>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthSessionSnapshotSessionData {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub access_expires_at: String,
    pub refresh_expires_at: Option<String>,
    pub user: Option<AuthSessionSnapshotUserData>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthSessionSnapshotUserData {
    pub id: String,
    pub email: String,
    pub email_verified: bool,
}

fn ms_to_rfc3339(ms: i64) -> String {
    // Важно: если ms некорректный — fallback на epoch, чтобы не падать.
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(|| chrono::DateTime::<chrono::Utc>::from_timestamp(0, 0).unwrap())
        .to_rfc3339()
}

/// Get current auth session snapshot (for cross-window sync).
#[tauri::command]
pub async fn get_auth_session_snapshot(
    state: State<'_, AppState>,
) -> Result<SnapshotEnvelope<AuthSessionSnapshotData>, String> {
    log::trace!("Command: get_auth_session_snapshot");

    let store = state.auth_store.read().await.clone();
    let data = AuthSessionSnapshotData {
        device_id: store.device_id,
        session: store.session.map(|s| AuthSessionSnapshotSessionData {
            access_token: s.access_token,
            refresh_token: s.refresh_token,
            access_expires_at: ms_to_rfc3339(s.access_expires_at_ms),
            refresh_expires_at: s.refresh_expires_at_ms.map(ms_to_rfc3339),
            user: s.user.map(|u| AuthSessionSnapshotUserData {
                id: u.id,
                email: u.email,
                email_verified: u.email_verified,
            }),
        }),
    };

    let revision = state.auth_session_revision.read().await.to_string();
    Ok(SnapshotEnvelope { revision, data })
}

/// Get current UI preferences snapshot
#[tauri::command]
pub async fn get_ui_preferences_snapshot(
    state: State<'_, AppState>,
) -> Result<SnapshotEnvelope<crate::domain::UiPreferences>, String> {
    log::debug!("Command: get_ui_preferences_snapshot");
    let data = state.ui_preferences.read().await.clone();
    let revision = state.ui_preferences_revision.read().await.to_string();
    Ok(SnapshotEnvelope { revision, data })
}

#[tauri::command]
pub async fn get_companion_snapshot(
    app_handle: AppHandle,
) -> Result<CompanionSnapshotEnvelope, String> {
    crate::presentation::companion::build_current_snapshot(&app_handle).await
}

#[tauri::command]
pub async fn get_companion_server_status(
    app_handle: AppHandle,
) -> Result<CompanionServerStatus, String> {
    crate::presentation::companion::get_server_status(&app_handle).await
}

#[tauri::command]
pub async fn enable_companion_mode(app_handle: AppHandle) -> Result<CompanionServerStatus, String> {
    crate::presentation::companion::enable_mode(&app_handle).await
}

#[tauri::command]
pub async fn disable_companion_mode(
    app_handle: AppHandle,
) -> Result<CompanionServerStatus, String> {
    crate::presentation::companion::disable_mode(&app_handle).await?;
    crate::presentation::companion::get_server_status(&app_handle).await
}

#[tauri::command]
pub async fn companion_clear_context(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<crate::presentation::companion_actions::CompanionActionResponse, String> {
    crate::presentation::companion_actions::ensure_context_cleared(state.inner(), &app_handle).await
}

#[tauri::command]
pub async fn companion_clear_history(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<crate::presentation::companion_actions::CompanionActionResponse, String> {
    crate::presentation::companion_actions::ensure_history_cleared(state.inner(), &app_handle).await
}

#[tauri::command]
pub async fn companion_request_ai(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    question_text: Option<String>,
    openai_responses_web_search: Option<bool>,
    selected_message_ids: Option<Vec<String>>,
) -> Result<crate::presentation::companion_actions::CompanionActionResponse, String> {
    crate::presentation::companion_actions::request_ai(
        state.inner(),
        &app_handle,
        question_text,
        openai_responses_web_search,
        selected_message_ids,
    )
    .await
}

#[tauri::command]
pub async fn companion_send_prompt(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    text: String,
    images: Option<Vec<LlmImageInput>>,
    openai_responses_web_search: Option<bool>,
    selected_message_ids: Option<Vec<String>>,
) -> Result<crate::presentation::companion_actions::CompanionActionResponse, String> {
    crate::presentation::companion_actions::send_prompt(
        state.inner(),
        &app_handle,
        text,
        images.unwrap_or_default(),
        openai_responses_web_search,
        selected_message_ids,
    )
    .await
}

#[tauri::command]
pub async fn cancel_haiku_streams(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<crate::presentation::companion_actions::CompanionActionResponse, String> {
    crate::presentation::companion_actions::cancel_ai(state.inner(), &app_handle).await
}

#[tauri::command]
pub async fn companion_set_desktop_blackout(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    enabled: bool,
) -> Result<crate::presentation::companion_actions::CompanionActionResponse, String> {
    crate::presentation::companion_actions::ensure_desktop_blackout(
        state.inner(),
        &app_handle,
        enabled,
    )
    .await
}

#[tauri::command]
pub async fn set_companion_system_prompt(
    state: State<'_, AppState>,
    prompt: String,
) -> Result<(), String> {
    *state.companion_system_prompt.write().await = prompt.trim().to_string();
    Ok(())
}

/// Обновить UI-настройки (тема, локаль) и уведомить все окна
#[tauri::command]
pub async fn update_ui_preferences(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    window: Window,
    theme: String,
    locale: String,
    use_system_theme: Option<bool>,
) -> Result<(), String> {
    let use_system_theme = use_system_theme.unwrap_or(false);
    log::info!(
        "Command: update_ui_preferences - theme: {}, locale: {}, use_system_theme: {}",
        theme,
        locale,
        use_system_theme
    );

    {
        let current = state.ui_preferences.read().await;
        if current.theme == theme
            && current.locale == locale
            && current.use_system_theme == use_system_theme
        {
            return Ok(());
        }
    }

    let prefs = crate::domain::UiPreferences {
        theme: theme.clone(),
        locale: locale.clone(),
        use_system_theme,
    };

    // Сохраняем в state
    *state.ui_preferences.write().await = prefs.clone();

    // Сохраняем на диск
    ConfigStore::save_ui_preferences(&prefs)
        .await
        .map_err(|e| format!("Failed to save UI preferences: {}", e))?;

    // Bump revision и отправляем invalidation
    let revision = AppState::bump_revision(&state.ui_preferences_revision).await;
    let _ = app_handle.emit(
        EVENT_STATE_SYNC_INVALIDATION,
        crate::presentation::StateSyncInvalidationPayload {
            topic: "ui-preferences".to_string(),
            revision,
            source_id: Some(window.label().to_string()),
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
        },
    );

    Ok(())
}

/// Update application configuration (e.g., microphone sensitivity, recording hotkey, auto-copy/paste)
#[tauri::command]
pub async fn update_app_config(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    window: Window,
    microphone_sensitivity: Option<u8>,
    recording_hotkey: Option<String>,
    auto_copy_to_clipboard: Option<bool>,
    auto_paste_text: Option<bool>,
    selected_audio_device: Option<String>,
    selected_output_audio_device: Option<String>,
    interview_memory_enabled: Option<bool>,
    answer_language: Option<crate::domain::AnswerLanguage>,
    answer_audience: Option<crate::domain::AnswerAudience>,
    natural_answer_style_enabled: Option<bool>,
    answer_imperfection_level: Option<crate::domain::AnswerImperfectionLevel>,
) -> Result<(), String> {
    log::info!("Command: update_app_config - sensitivity: {:?}, hotkey: {:?}, auto_copy: {:?}, auto_paste: {:?}, device: {:?}, memory_enabled: {:?}, answer_language: {:?}, answer_audience: {:?}, natural_answer_style: {:?}, answer_imperfection: {:?}",
        microphone_sensitivity, recording_hotkey, auto_copy_to_clipboard, auto_paste_text, selected_audio_device, interview_memory_enabled, answer_language, answer_audience, natural_answer_style_enabled, answer_imperfection_level);

    // Защита от "тихих" провалов: если фронт случайно отправил snake_case ключи,
    // Tauri не сматчит аргументы, и сюда придут одни None.
    // Тогда лучше вернуть явную ошибку, чем сделать вид что всё ок.
    if microphone_sensitivity.is_none()
        && recording_hotkey.is_none()
        && auto_copy_to_clipboard.is_none()
        && auto_paste_text.is_none()
        && selected_audio_device.is_none()
        && selected_output_audio_device.is_none()
        && interview_memory_enabled.is_none()
        && answer_language.is_none()
        && answer_audience.is_none()
        && natural_answer_style_enabled.is_none()
        && answer_imperfection_level.is_none()
    {
        return Err("update_app_config: не получены поля для обновления. Проверьте, что фронтенд отправляет args в camelCase (например microphoneSensitivity, recordingHotkey, autoCopyToClipboard, autoPasteText, selectedAudioDevice, interviewMemoryEnabled, answerLanguage).".to_string());
    }

    let mut config = state.config.write().await;
    let mut hotkey_changed = false;
    let mut any_changed = false;

    if let Some(sensitivity) = microphone_sensitivity {
        let clamped = sensitivity.min(200); // Ensure 0-200 range
        if config.microphone_sensitivity != clamped {
            log::info!(
                "Updating microphone sensitivity: {} -> {}",
                config.microphone_sensitivity,
                clamped
            );
            config.microphone_sensitivity = clamped;
            any_changed = true;
        }

        // Обновляем также в TranscriptionService для применения в реальном времени
        state
            .microphone_transcription_service
            .set_microphone_sensitivity(clamped)
            .await;
    }

    if let Some(new_hotkey) = recording_hotkey {
        if new_hotkey != config.recording_hotkey {
            // Валидируем что это корректная комбинация клавиш
            use tauri_plugin_global_shortcut::Shortcut;
            if new_hotkey.parse::<Shortcut>().is_err() {
                return Err(format!("Неверный формат горячей клавиши: {}", new_hotkey));
            }

            log::info!(
                "Updating recording hotkey: {} -> {}",
                config.recording_hotkey,
                new_hotkey
            );
            config.recording_hotkey = new_hotkey;
            hotkey_changed = true;
            any_changed = true;
        }
    }

    // Автодействия принудительно выключены.
    // Даже если фронт отправит true — игнорируем.
    if auto_copy_to_clipboard.is_some() || auto_paste_text.is_some() {
        if config.auto_copy_to_clipboard {
            config.auto_copy_to_clipboard = false;
            any_changed = true;
        }
        if config.auto_paste_text {
            config.auto_paste_text = false;
            any_changed = true;
        }
    }

    let mut mic_device_changed = false;
    if let Some(device) = selected_audio_device {
        let normalized = device.trim().to_string();
        let device_opt = if normalized.is_empty() {
            None
        } else {
            Some(normalized)
        };

        // Проверяем изменилось ли устройство
        if config.selected_audio_device != device_opt {
            log::info!(
                "Updating selected_audio_device: {:?} -> {:?}",
                config.selected_audio_device,
                device_opt
            );
            config.selected_audio_device = device_opt;
            mic_device_changed = true;
            any_changed = true;
        }
    }

    let mut output_device_changed = false;
    if let Some(device) = selected_output_audio_device {
        let normalized = device.trim().to_string();
        let device_opt = if normalized.is_empty() {
            None
        } else {
            Some(normalized)
        };
        if config.selected_output_audio_device != device_opt {
            log::info!(
                "Updating selected_output_audio_device: {:?} -> {:?}",
                config.selected_output_audio_device,
                device_opt
            );
            config.selected_output_audio_device = device_opt;
            output_device_changed = true;
            any_changed = true;
        }
    }

    let mut interview_memory_changed = false;
    if let Some(enabled) = interview_memory_enabled {
        if config.interview_memory_enabled != enabled {
            log::info!(
                "Updating interview_memory_enabled: {} -> {}",
                config.interview_memory_enabled,
                enabled
            );
            config.interview_memory_enabled = enabled;
            interview_memory_changed = true;
            any_changed = true;
        }
    }

    if let Some(language) = answer_language {
        if config.answer_style.language != language {
            log::info!(
                "Updating answer language: {:?} -> {:?}",
                config.answer_style.language,
                language
            );
            config.answer_style.language = language;
            any_changed = true;
        }
    }

    if let Some(audience) = answer_audience {
        if config.answer_style.audience != audience {
            log::info!(
                "Updating answer audience: {:?} -> {:?}",
                config.answer_style.audience,
                audience
            );
            config.answer_style.audience = audience;
            any_changed = true;
        }
    }

    if let Some(enabled) = natural_answer_style_enabled {
        if config.answer_style.natural_answer_style_enabled != enabled {
            log::info!(
                "Updating natural_answer_style_enabled: {} -> {}",
                config.answer_style.natural_answer_style_enabled,
                enabled
            );
            config.answer_style.natural_answer_style_enabled = enabled;
            any_changed = true;
        }
    }

    if let Some(level) = answer_imperfection_level {
        if config.answer_style.imperfection_level != level {
            log::info!(
                "Updating answer imperfection level: {:?} -> {:?}",
                config.answer_style.imperfection_level,
                level
            );
            config.answer_style.imperfection_level = level;
            any_changed = true;
        }
    }

    // Если ничего не менялось — выходим без лишнего I/O и invalidation
    if !any_changed {
        drop(config);
        log::info!("App config unchanged, skipping save");
        return Ok(());
    }

    log::info!("Saving app config to disk: sensitivity={}, hotkey={}, provider={:?}, language={}, device={:?}",
        config.microphone_sensitivity, config.recording_hotkey, config.stt.provider, config.stt.language, config.selected_audio_device);

    // Запоминаем устройства для применения после сохранения
    let mic_device_to_apply = if mic_device_changed {
        Some(config.selected_audio_device.clone())
    } else {
        None
    };
    let output_device_to_apply = if output_device_changed {
        Some(config.selected_output_audio_device.clone())
    } else {
        None
    };

    // Сохраняем конфигурацию на диск
    ConfigStore::save_app_config(&config)
        .await
        .map_err(|e| format!("Failed to save app config: {}", e))?;

    // Если горячая клавиша изменилась - перерегистрируем её
    if hotkey_changed {
        drop(config); // освобождаем lock перед async операцией

        log::info!("Re-registering recording hotkey");

        // Перерегистрируем горячую клавишу
        register_recording_hotkey(state.clone(), app_handle.clone()).await?;
    } else {
        drop(config); // освобождаем lock если не было hotkey_changed
    }

    // Если выбранный микрофон изменился - применяем в mic transcription service (best-effort).
    if let Some(device_opt) = mic_device_to_apply {
        log::info!("Applying changed microphone device: {:?}", device_opt);
        let capture =
            crate::infrastructure::audio::SystemAudioCapture::with_device(device_opt.clone())
                .map_err(|e| format!("Failed to create microphone capture: {}", e))?;
        state
            .microphone_transcription_service
            .replace_audio_capture(Box::new(capture))
            .await
            .map_err(|e| {
                log::error!("Failed to apply new microphone device: {}", e);
                format!(
                    "Настройки сохранены, но не удалось применить новое устройство микрофона: {}",
                    e
                )
            })?;
    }

    // Если выбранный выход (system audio) изменился - пересоздаем loopback/system capture.
    if let Some(device_opt) = output_device_to_apply {
        log::info!("Applying changed system output device: {:?}", device_opt);
        state
            .recreate_audio_capture_with_device(device_opt.clone(), app_handle.clone())
            .await
            .map_err(|e| {
                log::error!("Failed to apply new system audio device: {}", e);
                format!("Настройки сохранены, но не удалось применить новое устройство системного звука: {}", e)
            })?;
    }

    // Синхронизация между окнами через state-sync
    let revision = AppState::bump_revision(&state.app_config_revision).await;
    let _ = app_handle.emit(
        EVENT_STATE_SYNC_INVALIDATION,
        crate::presentation::StateSyncInvalidationPayload {
            topic: "app-config".to_string(),
            revision,
            source_id: Some(window.label().to_string()),
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
        },
    );

    if interview_memory_changed {
        if let Err(err) = crate::presentation::companion::publish_snapshot(&app_handle).await {
            log::debug!(
                "Failed to publish companion snapshot after memory config change: {}",
                err
            );
        }
    }

    log::info!("App configuration updated and saved successfully");
    Ok(())
}

//
// Microphone Test Commands
//

use crate::domain::AudioConfig;
use crate::infrastructure::audio::create_output_audio_capture_for_device;
use crate::infrastructure::audio::SystemAudioCapture;

/// Start microphone test
#[tauri::command]
pub async fn start_microphone_test(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    sensitivity: Option<u8>,
    device_name: Option<String>,
) -> Result<(), String> {
    log::info!("Command: start_microphone_test - device: {:?}", device_name);

    let mut test_state = state.microphone_test.write().await;

    if test_state.is_testing {
        return Err("Microphone test already running".to_string());
    }

    // Создаем новый audio capture для теста с выбранным устройством
    let device_to_use = device_name.filter(|s| !s.is_empty()); // None если пустая строка
    let mut capture = Box::new(
        SystemAudioCapture::with_device(device_to_use.clone())
            .map_err(|e| format!("Failed to create audio capture: {}", e))?,
    );

    // Инициализируем захват
    capture
        .initialize(AudioConfig::default())
        .await
        .map_err(|e| format!("Failed to initialize audio capture: {}", e))?;

    // Сбрасываем буфер
    test_state.buffer.lock().await.clear();

    // Получаем ссылку на shared buffer
    let buffer_for_task = test_state.buffer.clone();

    // Используем переданную чувствительность или загружаем из сохраненной конфигурации
    let sensitivity = match sensitivity {
        Some(s) => s.min(200),
        None => state.config.read().await.microphone_sensitivity,
    };

    log::info!(
        "Starting microphone test with sensitivity: {}%",
        sensitivity
    );

    // Создаем канал для передачи данных из callback
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

    let on_chunk = Arc::new(move |chunk: crate::domain::AudioChunk| {
        let _ = tx.send(chunk);
    });

    // Запускаем обработчик чанков в async контексте
    let app_handle_clone = app_handle.clone();

    tokio::spawn(async move {
        // Вычисляем коэффициент усиления (та же логика что в TranscriptionService)
        let gain = if sensitivity <= 100 {
            // 0-100% → 0.0x-1.0x (приглушение/нормальный уровень)
            sensitivity as f32 / 100.0
        } else {
            // 100-200% → 1.0x-5.0x (усиление для тихих микрофонов)
            1.0 + (sensitivity - 100) as f32 / 100.0 * 4.0
        };

        log::info!(
            "Microphone test: sensitivity={}%, gain={:.2}x",
            sensitivity,
            gain
        );

        while let Some(chunk) = rx.recv().await {
            // Вычисляем уровень громкости ДО усиления
            let max_amplitude = chunk.data.iter().map(|&s| s.abs()).max().unwrap_or(0);
            let normalized_level = (max_amplitude as f32 / 32767.0).sqrt().min(1.0);

            // Отправляем событие в UI (показываем уровень ДО усиления для честной индикации)
            let _ = app_handle_clone.emit(
                EVENT_MICROPHONE_TEST_LEVEL,
                MicrophoneTestLevelPayload {
                    level: normalized_level,
                },
            );

            // Применяем gain к каждому сэмплу с защитой от clipping
            let amplified_data: Vec<i16> = chunk
                .data
                .iter()
                .map(|&sample| {
                    let amplified = (sample as f32 * gain).clamp(-32767.0, 32767.0);
                    amplified as i16
                })
                .collect();

            // Сохраняем усиленный звук в буфер (для честного воспроизведения)
            let mut buffer = buffer_for_task.lock().await;
            buffer.extend_from_slice(&amplified_data);
            // Ограничиваем размер буфера (максимум 5 секунд = 80000 samples @ 16kHz)
            let buffer_len = buffer.len();
            if buffer_len > 80000 {
                buffer.drain(0..buffer_len - 80000);
            }
        }
    });

    // Запускаем захват
    capture
        .start_capture(on_chunk)
        .await
        .map_err(|e| format!("Failed to start audio capture: {}", e))?;

    test_state.capture = Some(capture);
    test_state.is_testing = true;

    log::info!("Microphone test started");
    Ok(())
}

/// Stop microphone test and return recorded audio
#[tauri::command]
pub async fn stop_microphone_test(state: State<'_, AppState>) -> Result<Vec<i16>, String> {
    log::info!("Command: stop_microphone_test");

    let mut test_state = state.microphone_test.write().await;

    if !test_state.is_testing {
        return Err("Microphone test not running".to_string());
    }

    // Останавливаем захват
    if let Some(mut capture) = test_state.capture.take() {
        capture
            .stop_capture()
            .await
            .map_err(|e| format!("Failed to stop audio capture: {}", e))?;
    }

    test_state.is_testing = false;

    // Возвращаем копию буфера и очищаем его
    let mut buffer_guard = test_state.buffer.lock().await;
    let buffer = buffer_guard.clone();
    buffer_guard.clear();
    drop(buffer_guard);

    log::info!(
        "Microphone test stopped, buffer size: {} samples",
        buffer.len()
    );
    Ok(buffer)
}

//
// System Audio (Output/Loopback) Test Commands
//

/// Start system audio test (captures what the user hears).
#[tauri::command]
pub async fn start_system_audio_test(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    device_name: Option<String>,
) -> Result<(), String> {
    log::info!(
        "Command: start_system_audio_test - device: {:?}",
        device_name
    );

    let mut test_state = state.system_audio_test.write().await;
    if test_state.is_testing {
        return Err("System audio test already running".to_string());
    }

    let device_to_use = device_name.filter(|s| !s.is_empty());

    let mut capture = create_output_audio_capture_for_device(device_to_use.clone())
        .map_err(|e| format!("Failed to create system audio capture: {}", e))?;

    capture
        .initialize(AudioConfig::default())
        .await
        .map_err(|e| format!("Failed to initialize audio capture: {}", e))?;

    test_state.buffer.lock().await.clear();
    let buffer_for_task = test_state.buffer.clone();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let on_chunk = Arc::new(move |chunk: crate::domain::AudioChunk| {
        let _ = tx.send(chunk);
    });

    let app_handle_clone = app_handle.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let max_amplitude = chunk.data.iter().map(|&s| s.abs()).max().unwrap_or(0);
            let normalized_level = (max_amplitude as f32 / 32767.0).sqrt().min(1.0);

            let _ = app_handle_clone.emit(
                EVENT_SYSTEM_AUDIO_TEST_LEVEL,
                SystemAudioTestLevelPayload {
                    level: normalized_level,
                },
            );

            let mut buffer = buffer_for_task.lock().await;
            buffer.extend_from_slice(&chunk.data);

            // Ограничиваем размер буфера (максимум 5 секунд = 80000 samples @ 16kHz)
            let buffer_len = buffer.len();
            if buffer_len > 80000 {
                buffer.drain(0..buffer_len - 80000);
            }
        }
    });

    capture
        .start_capture(on_chunk)
        .await
        .map_err(|e| format!("Failed to start audio capture: {}", e))?;

    test_state.capture = Some(capture);
    test_state.is_testing = true;

    log::info!("System audio test started");
    Ok(())
}

/// Stop system audio test and return recorded audio
#[tauri::command]
pub async fn stop_system_audio_test(state: State<'_, AppState>) -> Result<Vec<i16>, String> {
    log::info!("Command: stop_system_audio_test");

    let mut test_state = state.system_audio_test.write().await;
    if !test_state.is_testing {
        return Err("System audio test not running".to_string());
    }

    if let Some(mut capture) = test_state.capture.take() {
        capture
            .stop_capture()
            .await
            .map_err(|e| format!("Failed to stop audio capture: {}", e))?;
    }

    test_state.is_testing = false;

    let mut buffer_guard = test_state.buffer.lock().await;
    let buffer = buffer_guard.clone();
    buffer_guard.clear();
    drop(buffer_guard);

    log::info!(
        "System audio test stopped, buffer size: {} samples",
        buffer.len()
    );
    Ok(buffer)
}

//
// Hotkey Management Commands
//

/// Register or update recording hotkey
#[tauri::command]
pub async fn register_recording_hotkey(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let hotkey = state.config.read().await.recording_hotkey.clone();
    log::info!("Command: register_recording_hotkey - hotkey: {}", hotkey);

    // ВАЖНО: сначала убеждаемся, что хоткей парсится, и только потом снимаем текущие регистрации.
    // Иначе при ошибке парсинга мы останемся вообще без хоткея.
    let (effective_hotkey, shortcut) = match hotkey.parse::<Shortcut>() {
        Ok(sc) => (hotkey.clone(), sc),
        Err(parse_err) => {
            // Пытаемся нормализовать строку (например Backquote -> `).
            if let Some(normalized) =
                crate::infrastructure::hotkey::normalize_recording_hotkey(&hotkey)
            {
                match normalized.parse::<Shortcut>() {
                    Ok(sc) => {
                        log::warn!(
                            "Hotkey '{}' failed to parse ({}), using normalized '{}'",
                            hotkey,
                            parse_err,
                            normalized
                        );
                        // Best-effort: фиксируем нормализованное значение в SoT + на диск,
                        // чтобы UI и фактический хоткей не расходились.
                        if normalized != hotkey {
                            let (should_save, config_snapshot) = {
                                let mut cfg = state.config.write().await;
                                let changed = cfg.recording_hotkey != normalized;
                                if changed {
                                    cfg.recording_hotkey = normalized.clone();
                                }
                                (changed, cfg.clone())
                            };
                            if should_save {
                                if let Err(e) = crate::infrastructure::ConfigStore::save_app_config(
                                    &config_snapshot,
                                )
                                .await
                                {
                                    log::warn!("Failed to persist normalized hotkey to app_config.json: {}", e);
                                }
                            }
                        }
                        (normalized, sc)
                    }
                    Err(_) => {
                        // Фоллбек на дефолт: всегда должен работать.
                        let fallback =
                            crate::infrastructure::hotkey::DEFAULT_RECORDING_HOTKEY.to_string();
                        let sc = fallback.parse::<Shortcut>().map_err(|e| {
                            format!("Failed to parse fallback hotkey '{}': {}", fallback, e)
                        })?;
                        log::error!(
                            "Failed to parse hotkey '{}' ({}). Falling back to '{}'",
                            hotkey,
                            parse_err,
                            fallback
                        );

                        // Синхронизируем SoT на дефолт, чтобы UI не показывал неработающее значение.
                        let config_snapshot = {
                            let mut cfg = state.config.write().await;
                            cfg.recording_hotkey = fallback.clone();
                            cfg.clone()
                        };
                        if let Err(e) =
                            crate::infrastructure::ConfigStore::save_app_config(&config_snapshot)
                                .await
                        {
                            log::warn!(
                                "Failed to persist fallback hotkey to app_config.json: {}",
                                e
                            );
                        }

                        // Пинаем invalidation, чтобы UI получил реальный (рабочий) хоткей.
                        let revision = AppState::bump_revision(&state.app_config_revision).await;
                        let _ = app_handle.emit(
                            EVENT_STATE_SYNC_INVALIDATION,
                            crate::presentation::StateSyncInvalidationPayload {
                                topic: "app-config".to_string(),
                                revision,
                                source_id: None,
                                timestamp_ms: chrono::Utc::now().timestamp_millis(),
                            },
                        );

                        (fallback, sc)
                    }
                }
            } else {
                let fallback = crate::infrastructure::hotkey::DEFAULT_RECORDING_HOTKEY.to_string();
                let sc = fallback.parse::<Shortcut>().map_err(|e| {
                    format!("Failed to parse fallback hotkey '{}': {}", fallback, e)
                })?;
                log::error!(
                    "Failed to parse hotkey '{}' ({}). Falling back to '{}'",
                    hotkey,
                    parse_err,
                    fallback
                );

                let config_snapshot = {
                    let mut cfg = state.config.write().await;
                    cfg.recording_hotkey = fallback.clone();
                    cfg.clone()
                };
                if let Err(e) =
                    crate::infrastructure::ConfigStore::save_app_config(&config_snapshot).await
                {
                    log::warn!(
                        "Failed to persist fallback hotkey to app_config.json: {}",
                        e
                    );
                }

                let revision = AppState::bump_revision(&state.app_config_revision).await;
                let _ = app_handle.emit(
                    EVENT_STATE_SYNC_INVALIDATION,
                    crate::presentation::StateSyncInvalidationPayload {
                        topic: "app-config".to_string(),
                        revision,
                        source_id: None,
                        timestamp_ms: chrono::Utc::now().timestamp_millis(),
                    },
                );

                (fallback, sc)
            }
        }
    };

    // Отменяем все старые регистрации
    if let Err(e) = app_handle.global_shortcut().unregister_all() {
        log::warn!("Failed to unregister all shortcuts: {}", e);
    }

    // Создаем обработчик - вызываем toggle напрямую вместо события
    // Важно: фильтруем только Pressed события, иначе срабатывает и на key down, и на key up
    app_handle
        .global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            use tauri_plugin_global_shortcut::ShortcutState;
            if event.state != ShortcutState::Pressed {
                return;
            }
            log::debug!("Recording hotkey pressed");
            let app_clone = app.clone();
            let _ = tauri::async_runtime::spawn(async move {
                let state_opt = app_clone.try_state::<crate::presentation::state::AppState>();
                let window_opt = app_clone.get_webview_window("main");

                if let (Some(state), Some(window)) = (state_opt, window_opt) {
                    let app_for_call = app_clone.clone();

                    // Дебаунс: защищаемся от key repeat / двойных срабатываний.
                    // Иначе окно может "мигать" (показ/скрытие несколько раз подряд).
                    let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
                    let last_ms = state
                        .inner()
                        .last_recording_hotkey_ms
                        .load(Ordering::Relaxed);
                    let delta = now_ms.saturating_sub(last_ms);
                    if delta < 450 {
                        log::debug!("Hotkey ignored (debounced): {}ms since last trigger", delta);
                        return;
                    }
                    state
                        .inner()
                        .last_recording_hotkey_ms
                        .store(now_ms, Ordering::Relaxed);

                    if let Err(e) =
                        crate::presentation::commands::toggle_recording_with_window_internal(
                            state.inner(),
                            window,
                            app_for_call,
                        )
                        .await
                    {
                        log::error!("Failed to toggle recording: {}", e);
                    }
                }
            });
        })
        .map_err(|e| format!("Failed to register hotkey '{}': {}", effective_hotkey, e))?;

    let mute_shortcut = match DEFAULT_MICROPHONE_MUTE_HOTKEY.parse::<Shortcut>() {
        Ok(shortcut) => shortcut,
        Err(e) => {
            log::warn!(
                "Failed to parse built-in microphone mute hotkey '{}': {}",
                DEFAULT_MICROPHONE_MUTE_HOTKEY,
                e
            );
            log::info!("Successfully registered hotkey: {}", effective_hotkey);
            return Ok(());
        }
    };

    if effective_hotkey != DEFAULT_MICROPHONE_MUTE_HOTKEY {
        if let Err(e) =
            app_handle
                .global_shortcut()
                .on_shortcut(mute_shortcut, move |app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state != ShortcutState::Pressed {
                        return;
                    }

                    let app_clone = app.clone();
                    let _ = tauri::async_runtime::spawn(async move {
                        let state_opt =
                            app_clone.try_state::<crate::presentation::state::AppState>();
                        if let Some(state) = state_opt {
                            if let Err(e) =
                                crate::presentation::commands::toggle_microphone_muted_internal(
                                    state.inner(),
                                    app_clone.clone(),
                                )
                                .await
                            {
                                log::error!("Failed to toggle microphone mute: {}", e);
                            }
                        }
                    });
                })
        {
            log::warn!(
                "Failed to register built-in microphone mute hotkey '{}': {}",
                DEFAULT_MICROPHONE_MUTE_HOTKEY,
                e
            );
        } else {
            log::info!(
                "Successfully registered microphone mute hotkey: {}",
                DEFAULT_MICROPHONE_MUTE_HOTKEY
            );
        }
    }

    log::info!("Successfully registered hotkey: {}", effective_hotkey);
    Ok(())
}

/// Временно снять регистрацию горячей клавиши (пока пользователь настраивает новую)
#[tauri::command]
pub async fn unregister_recording_hotkey(app_handle: AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    log::info!("Command: unregister_recording_hotkey - временно снимаем хоткей");

    if let Err(e) = app_handle.global_shortcut().unregister_all() {
        log::warn!("Failed to unregister all shortcuts: {}", e);
    }

    Ok(())
}

//
// Update Commands
//

/// Check for application updates
#[tauri::command]
pub async fn check_for_updates(
    app_handle: AppHandle,
) -> Result<Option<crate::infrastructure::updater::UpdateInfo>, String> {
    log::info!("Command: check_for_updates");
    crate::infrastructure::updater::check_for_update(app_handle).await
}

/// Check and install application update with user confirmation
#[tauri::command]
pub async fn install_update(app_handle: AppHandle) -> Result<String, String> {
    log::info!("Command: install_update");
    crate::infrastructure::updater::check_and_install_update(app_handle).await
}

//
// Whisper Model Management Commands
//

use crate::infrastructure::models::{
    delete_model, download_model, get_available_models, get_model_size, is_model_downloaded,
    WhisperModelInfo,
};

/// Get list of available Whisper models
#[tauri::command]
pub async fn get_available_whisper_models() -> Result<Vec<WhisperModelInfo>, String> {
    log::debug!("Command: get_available_whisper_models");

    let mut models = get_available_models();

    // Обогащаем данными о локальном наличии
    for model in &mut models {
        let is_downloaded = is_model_downloaded(&model.name);
        let local_size = if is_downloaded {
            get_model_size(&model.name)
        } else {
            None
        };

        // Добавляем информацию в description если модель скачана
        if is_downloaded {
            if let Some(size) = local_size {
                model.description = format!(
                    "{} (Скачана, {} на диске)",
                    model.description,
                    format_size_human(size)
                );
            } else {
                model.description = format!("{} (Скачана)", model.description);
            }
        }
    }

    Ok(models)
}

/// Check if specific Whisper model is downloaded
#[tauri::command]
pub async fn check_whisper_model(model_name: String) -> Result<bool, String> {
    log::debug!("Command: check_whisper_model - model: {}", model_name);
    Ok(is_model_downloaded(&model_name))
}

/// Download Whisper model with progress tracking
#[tauri::command]
pub async fn download_whisper_model(
    app_handle: AppHandle,
    model_name: String,
) -> Result<String, String> {
    log::info!("Command: download_whisper_model - model: {}", model_name);

    // Проверяем что модель еще не скачана
    if is_model_downloaded(&model_name) {
        return Err(format!("Model '{}' is already downloaded", model_name));
    }

    // Эмитируем событие начала загрузки
    let _ = app_handle.emit("whisper-model:download-started", model_name.clone());

    // Создаем callback для отслеживания прогресса
    let app_handle_progress = app_handle.clone();
    let model_name_progress = model_name.clone();

    let progress_callback = move |downloaded: u64, total: u64| {
        let progress = if total > 0 {
            (downloaded as f64 / total as f64 * 100.0) as u8
        } else {
            0
        };

        #[derive(Clone, serde::Serialize)]
        struct DownloadProgressPayload {
            model_name: String,
            downloaded: u64,
            total: u64,
            progress: u8,
        }

        let _ = app_handle_progress.emit(
            "whisper-model:download-progress",
            DownloadProgressPayload {
                model_name: model_name_progress.clone(),
                downloaded,
                total,
                progress,
            },
        );
    };

    // Загружаем модель
    let model_path = download_model(&model_name, progress_callback)
        .await
        .map_err(|e| format!("Failed to download model: {}", e))?;

    // Эмитируем событие завершения загрузки
    let _ = app_handle.emit("whisper-model:download-completed", model_name.clone());

    log::info!(
        "Model '{}' downloaded successfully to {:?}",
        model_name,
        model_path
    );
    Ok(format!("Model '{}' downloaded successfully", model_name))
}

/// Delete Whisper model
#[tauri::command]
pub async fn delete_whisper_model(model_name: String) -> Result<String, String> {
    log::info!("Command: delete_whisper_model - model: {}", model_name);

    delete_model(&model_name).map_err(|e| format!("Failed to delete model: {}", e))?;

    Ok(format!("Model '{}' deleted successfully", model_name))
}

/// Get available audio input devices
#[tauri::command]
pub async fn get_audio_devices() -> Result<Vec<String>, String> {
    log::info!("Command: get_audio_devices");

    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();

    let devices: Vec<String> = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {}", e))?
        .filter_map(|device| device.name().ok())
        .collect();

    log::info!("Found {} audio input devices", devices.len());

    Ok(devices)
}

/// Get available audio output devices (system sound sources).
#[tauri::command]
pub async fn get_output_audio_devices() -> Result<Vec<String>, String> {
    log::info!("Command: get_output_audio_devices");

    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();

    let devices: Vec<String> = host
        .output_devices()
        .map_err(|e| format!("Failed to enumerate output devices: {}", e))?
        .filter_map(|device| device.name().ok())
        .collect();

    log::info!("Found {} audio output devices", devices.len());

    Ok(devices)
}

const INTERVIEW_ANSWER_STYLE_GUARD: &str = r#"Правила стиля ответа:
- Начинай сразу с ответа. Не повторяй вопрос пользователя и не пиши заголовки "Вопрос:"/"Ответ:".
- Запрещено начинать с "Вопрос", "Ответ", заголовка # Ответ, "**Вопрос:**" или краткого пересказа вопроса.
- Первая строка должна быть содержательным тезисом ответа, без мета-комментариев.
- Не начинай с фраз вроде "Понял", "Конечно", "Хорошо" - сразу давай содержательный ответ.
- Если пользователь спрашивает "что сказать" или "как ответить", выдай сам готовый ответ от первого лица, а не инструкцию. Не начинай с "I'd say", "You can say", "Say:" или похожих фраз.
- Если пользователь спрашивает про конкретную компанию, проект, библиотеку или инструмент и это релевантно, сохрани точное название в ответе.
- Для technical interview/profile ответов сохраняй центральные идентификаторы из контекста точно, включая API names, struct names, field names, crate names, protocol names и snake_case/camelCase термины.
- Для вопросов про проекты, навыки или опыт сохраняй самый сильный proof: точное название проекта/достижения плюс одну конкретную технологию или метрику, если они есть в контексте.
- Если в контексте есть и feature description, и стек/бенчмарк проекта, сначала сохрани стек/бенчмарк, а низкоценные workflow-детали убери.
- Лучше убери общие прилагательные, чем конкретные proof-факты вроде названия проекта, технологий, бенчмарка или измеримого результата.
- В project summary не заменяй конкретные технологии или метрики общим описанием фич, если в памяти доступны оба типа фактов.
- Не добавляй общую концовку с предложением продолжить, если пользователь прямо не попросил продолжение.
- Не используй символы "—" или "–". Только обычный дефис "-" или запятую.
- Если личный опыт или детали реализации не подтверждены контекстом, не выдумывай их и не сообщай, что контекста недостаточно. Дай полезный технический ответ как подход: "Я бы...".
- Если распознавание неточно или вопрос неполный, выбери наиболее вероятный смысл и ответь без уточняющих вопросов.
- Никогда не задавай вопросов, в том числе риторических, и не проси уточнений или подтверждений. Не заканчивай ответ вопросом.
- Длина ответа зависит от сложности вопроса, но всегда без воды, только по делу: простой фактологический вопрос - 1-2 предложения; обычный теоретический - 3-4 предложения; сложный, многосоставной или длинный вопрос (сравнение подходов, проектирование, несколько условий) - до 6-8 предложений или короткий список по пунктам вопроса. Каждое предложение несёт новый факт, без вступлений, повторов вопроса и итогов.
- Говори о себе в мужском роде: "я бы настроил", "я сделал", "я использовал".
- Вопрос по коду или картинке с кодом: сначала 1-2 предложения с главной проблемой и причиной, затем исправленный фрагмент кода с короткими комментариями на русском, затем 1-2 предложения о компромиссах. Объём вне кода растёт со сложностью кода (обычно 60-150 слов), без разбора второстепенных мелочей.
- По умолчанию отвечай коротким связным абзацем. Список используй только для нескольких самостоятельных пунктов или по явной просьбе.
- Не добавляй предложение продолжить."#;

fn with_interview_answer_style_guard(system_prompt: String) -> String {
    if system_prompt.contains(INTERVIEW_ANSWER_STYLE_GUARD) {
        system_prompt
    } else {
        format!(
            "{}\n\n{}",
            system_prompt.trim_end(),
            INTERVIEW_ANSWER_STYLE_GUARD
        )
    }
}

/// Запускает стриминг-ответ Haiku (Anthropic) по текущему тексту.
///
/// Возвращает `request_id`, а прогресс стриминга приходит через события:
/// - `haiku:delta`
/// - `haiku:done`
/// - `haiku:error`
#[tauri::command]
pub async fn start_haiku_stream(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    text: String,
    system_prompt: Option<String>,
    companion_meta: Option<CompanionAiRequestMeta>,
    openai_responses_web_search: Option<bool>,
    memory_context_evidence: Option<
        crate::presentation::interview_memory_bridge::MemoryContextEvidenceInput,
    >,
) -> Result<String, String> {
    let prompt = text.trim();
    if prompt.is_empty() {
        return Err("Empty text".to_string());
    }

    let provider = match std::env::var("LLM_PROVIDER")
        .ok()
        .unwrap_or_else(|| "anthropic".to_string())
        .to_lowercase()
        .as_str()
    {
        "anthropic" => crate::domain::LlmProviderType::Anthropic,
        "openai" | "openai_compatible" | "openrouter" => {
            crate::domain::LlmProviderType::OpenAiCompatible
        }
        "openai_responses" | "responses" => crate::domain::LlmProviderType::OpenAiResponses,
        "backend" => crate::domain::LlmProviderType::Backend,
        other => {
            log::warn!(
                "Unknown LLM_PROVIDER='{}', falling back to anthropic",
                other
            );
            crate::domain::LlmProviderType::Anthropic
        }
    };
    let max_tokens: u32 = std::env::var("LLM_MAX_TOKENS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| match provider {
            crate::domain::LlmProviderType::Anthropic => std::env::var("ANTHROPIC_MAX_TOKENS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1024),
            crate::domain::LlmProviderType::OpenAiCompatible => std::env::var("OPENAI_MAX_TOKENS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1024),
            crate::domain::LlmProviderType::OpenAiResponses => {
                std::env::var("OPENAI_RESPONSES_MAX_TOKENS")
                    .or_else(|_| std::env::var("OPENAI_MAX_TOKENS"))
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1024)
            }
            crate::domain::LlmProviderType::Backend => 1024,
        });

    let temperature: f32 = std::env::var("LLM_TEMPERATURE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| match provider {
            crate::domain::LlmProviderType::Anthropic => std::env::var("ANTHROPIC_TEMPERATURE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.2),
            crate::domain::LlmProviderType::OpenAiCompatible => std::env::var("OPENAI_TEMPERATURE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.2),
            crate::domain::LlmProviderType::OpenAiResponses => {
                std::env::var("OPENAI_RESPONSES_TEMPERATURE")
                    .or_else(|_| std::env::var("OPENAI_TEMPERATURE"))
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0.2)
            }
            crate::domain::LlmProviderType::Backend => 0.2,
        });

    // Язык ответов всегда русский (самый понятный язык владельца), даже если вопрос на украинском/английском.
    let default_system_prompt = r#"Ты - ассистент на техническом собеседовании. Всегда отвечай по-русски, даже если вопрос задан на украинском или английском. Технические термины оставляй на английском.

Контекст ниже - транскрипция, возможны ошибки распознавания. В нём есть строки:
- "ОС:" - то, что я слышу (обычно реплики собеседника/вопросы).
- "МИКРОФОН:" - то, что говорю я (мои ответы/мысли/иногда могу повторить вопрос).
- "ПОМОЩНИК:" - предыдущие ответы ассистента (можно использовать как контекст).

Твоя задача:
1) Найти последний явный или неявный вопрос/задачу: в первую очередь из строк "ОС:". Если строк "ОС:" нет - используй строки "МИКРОФОН:".
2) Дать лучший краткий ответ по делу (без воды), можно с короткими примерами/шагами.
3) Если распознавание неточно, выбери наиболее вероятный смысл и ответь без уточняющих вопросов.
4) Возможно в вопросах не будет "?". Ты должен понимать где вопросы.

Формат ответа:
- Начинай сразу с ответа. Не повторяй вопрос пользователя и не пиши заголовки "Вопрос:"/"Ответ:".
- Запрещено начинать с "Вопрос", "Ответ", заголовка # Ответ, "**Вопрос:**" или краткого пересказа вопроса.
- Первая строка должна быть содержательным тезисом ответа.
- Не начинай с фраз вроде "Понял", "Конечно", "Хорошо" - сразу давай содержательный ответ.
- По умолчанию отвечай коротким связным абзацем. Список нужен только для нескольких самостоятельных пунктов или по просьбе пользователя.
- Затем (если нужно) короткий пример кода.
- Не пересказывай весь контекст и не цитируй теги "ОС:"/"МИКРОФОН:"/"ПОМОЩНИК:".

Правила для кода:
- Если приводишь код, выводи его в Markdown fenced-блоке:
  ```<language>
  ...код...
  ```
- Вместо <language> подставляй реальный язык (например: dart, ts, js, python, go, rust, bash, sql).
- Для упоминаний технических идентификаторов (имя переменной/класса/функции/пакета/файла/поля/метода) используй inline code в Markdown (одинарные обратные кавычки).
- Если это именно код (даже короткий фрагмент/выражение) и важна подсветка - используй fenced-блок с языком.
- Код должен быть ровно отформатирован: без нумерации строк, с корректными отступами, без мусорных префиксов.
- Старайся давать минимально‑самодостаточный пример, который иллюстрирует главную идею (как на собеседовании).
- Если полный код слишком длинный, допускается сокращать только с помощью комментариев соответствующего языка (например `// ...`, `# ...`, `/* ... */`) и после блока 1 строкой объяснить, что именно опущено. Не вставляй голые "..." как код."#;

    let system_prompt = system_prompt
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var("LLM_SYSTEM_PROMPT").ok())
        .or_else(|| match provider {
            crate::domain::LlmProviderType::Anthropic => {
                std::env::var("ANTHROPIC_SYSTEM_PROMPT").ok()
            }
            crate::domain::LlmProviderType::OpenAiCompatible => {
                std::env::var("OPENAI_SYSTEM_PROMPT").ok()
            }
            crate::domain::LlmProviderType::OpenAiResponses => {
                std::env::var("OPENAI_RESPONSES_SYSTEM_PROMPT")
                    .or_else(|_| std::env::var("OPENAI_SYSTEM_PROMPT"))
                    .ok()
            }
            crate::domain::LlmProviderType::Backend => {
                std::env::var("BACKEND_LLM_SYSTEM_PROMPT").ok()
            }
        })
        .unwrap_or_else(|| default_system_prompt.to_string());
    let system_prompt = with_interview_answer_style_guard(system_prompt);
    let answer_style = { state.config.read().await.answer_style.clone() };
    let system_prompt = crate::presentation::answer_style_prompt::with_answer_style_policy(
        system_prompt,
        &answer_style,
    );
    let system_prompt = crate::presentation::candidate_profile::with_candidate_profile(system_prompt);
    let temperature = crate::presentation::answer_style_prompt::adjusted_answer_temperature(
        temperature,
        &answer_style,
    );
    let final_answer_normalizer = answer_style.natural_answer_style_enabled.then_some(
        crate::presentation::answer_style_prompt::compact_final_chat_answer as fn(&str) -> String,
    );

    let model = match provider {
        crate::domain::LlmProviderType::Anthropic => std::env::var("ANTHROPIC_MODEL")
            .unwrap_or_else(|_| crate::domain::DEFAULT_ANTHROPIC_MODEL.to_string()),
        crate::domain::LlmProviderType::OpenAiCompatible => std::env::var("OPENAI_MODEL")
            .or_else(|_| std::env::var("LLM_MODEL"))
            .map_err(|_| "OPENAI_MODEL (or LLM_MODEL) is not set".to_string())?,
        crate::domain::LlmProviderType::OpenAiResponses => openai_responses_model(),
        crate::domain::LlmProviderType::Backend => {
            std::env::var("LLM_MODEL").unwrap_or_else(|_| "default".to_string())
        }
    };

    let api_key = match provider {
        crate::domain::LlmProviderType::Anthropic => Some(
            std::env::var("ANTHROPIC_API_KEY")
                .map_err(|_| "ANTHROPIC_API_KEY is not set".to_string())?,
        ),
        crate::domain::LlmProviderType::OpenAiCompatible => Some(
            std::env::var("OPENAI_API_KEY").map_err(|_| "OPENAI_API_KEY is not set".to_string())?,
        ),
        crate::domain::LlmProviderType::OpenAiResponses => Some(
            std::env::var("OPENAI_API_KEY").map_err(|_| "OPENAI_API_KEY is not set".to_string())?,
        ),
        crate::domain::LlmProviderType::Backend => None,
    };

    let backend_auth_token = if provider == crate::domain::LlmProviderType::Backend {
        state
            .auth_store
            .read()
            .await
            .session
            .as_ref()
            .map(|s| s.access_token.clone())
            .or_else(|| std::env::var("LLM_BACKEND_AUTH_TOKEN").ok())
    } else {
        None
    };

    let runtime_cfg = crate::domain::LlmRuntimeConfig {
        provider,
        api_key,
        base_url: std::env::var("OPENAI_BASE_URL").ok(),
        backend_url: std::env::var("LLM_BACKEND_URL").ok(),
        backend_auth_token,
    };

    let llm_factory = crate::infrastructure::DefaultLlmProviderFactory::new();
    let llm_provider = llm_factory
        .create(&runtime_cfg)
        .map_err(|e| e.to_string())?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let companion_meta = companion_meta.unwrap_or_default();
    let effective_prompt =
        crate::presentation::interview_memory_bridge::assemble_stream_context_or_fallback(
            state.inner(),
            prompt,
            memory_context_evidence.as_ref(),
        )
        .await;
    *state.companion_system_prompt.write().await = system_prompt.clone();

    let parallel_openai_enabled = provider == crate::domain::LlmProviderType::Anthropic
        && env_flag("LLM_PARALLEL_OPENAI_RESPONSES")
        && std::env::var("OPENAI_API_KEY")
            .ok()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);

    if parallel_openai_enabled {
        let openai_mini_model = openai_responses_model();
        let openai_runtime_cfg = openai_responses_runtime_config()?;
        match llm_factory.create(&openai_runtime_cfg) {
            Ok(openai_mini_provider) => {
                let anthropic_candidate = HaikuCandidateMeta {
                    id: "anthropic".to_string(),
                    label: "Anthropic".to_string(),
                    provider: "anthropic".to_string(),
                    model: model.clone(),
                };
                let openai_mini_candidate = HaikuCandidateMeta {
                    id: "openai_responses".to_string(),
                    label: "OpenAI 5.4 mini".to_string(),
                    provider: "openai_responses".to_string(),
                    model: openai_mini_model.clone(),
                };

                crate::presentation::companion_timeline::begin_haiku_message(
                    state.inner(),
                    crate::presentation::companion_timeline::CompanionHaikuStart {
                        request_id: request_id.clone(),
                        insert_after_id: companion_meta.insert_after_id.clone(),
                        created_at_ms: companion_meta
                            .created_at_ms
                            .unwrap_or_else(crate::presentation::companion_timeline::now_ms),
                        candidates: vec![
                            crate::presentation::companion::CompanionLlmCandidate {
                                id: anthropic_candidate.id.clone(),
                                label: anthropic_candidate.label.clone(),
                                provider: anthropic_candidate.provider.clone(),
                                model: anthropic_candidate.model.clone(),
                                status: "streaming".to_string(),
                                text: String::new(),
                                error: None,
                            },
                            crate::presentation::companion::CompanionLlmCandidate {
                                id: openai_mini_candidate.id.clone(),
                                label: openai_mini_candidate.label.clone(),
                                provider: openai_mini_candidate.provider.clone(),
                                model: openai_mini_candidate.model.clone(),
                                status: "streaming".to_string(),
                                text: String::new(),
                                error: None,
                            },
                        ],
                        active_candidate_id: Some(anthropic_candidate.id.clone()),
                    },
                )
                .await;
                let _ = app_handle.emit(
                    EVENT_HAIKU_CANDIDATE_START,
                    candidate_start_payload(&request_id, &anthropic_candidate),
                );
                let _ = app_handle.emit(
                    EVENT_HAIKU_CANDIDATE_START,
                    candidate_start_payload(&request_id, &openai_mini_candidate),
                );
                let _ = crate::presentation::companion::publish_snapshot(&app_handle).await;

                log::info!(
                    "Command: start_haiku_stream parallel request_id={} prompt_len={}",
                    request_id,
                    effective_prompt.len()
                );

                let request_id_clone = request_id.clone();
                let app_handle_clone = app_handle.clone();
                let user_text = effective_prompt.clone();
                let anthropic_model = model.clone();
                let system_prompt_clone = system_prompt.clone();
                let anthropic_candidate_clone = anthropic_candidate.clone();
                let openai_mini_candidate_clone = openai_mini_candidate.clone();

                tauri::async_runtime::spawn(async move {
                    let anthropic_writer = spawn_companion_delta_writer(
                        app_handle_clone.clone(),
                        request_id_clone.clone(),
                        Some(anthropic_candidate_clone.id.clone()),
                    );
                    let openai_mini_writer = spawn_companion_delta_writer(
                        app_handle_clone.clone(),
                        request_id_clone.clone(),
                        Some(openai_mini_candidate_clone.id.clone()),
                    );

                    let anthropic_request = crate::domain::LlmStreamRequest::new(
                        anthropic_model,
                        system_prompt_clone.clone(),
                        user_text.clone(),
                        max_tokens,
                        temperature,
                    );
                    let openai_mini_request = build_openai_responses_request(
                        openai_mini_model,
                        system_prompt_clone.clone(),
                        user_text.clone(),
                        max_tokens,
                        temperature,
                        Vec::new(),
                        Some(false),
                        openai_responses_reasoning_effort(),
                        openai_responses_verbosity(),
                    );

                    let anthropic_future = async {
                        let app_handle_delta = app_handle_clone.clone();
                        let request_id_delta = request_id_clone.clone();
                        let delta_meta = anthropic_candidate_clone.clone();
                        let companion_delta_tx = anthropic_writer.tx.clone();
                        let result = llm_provider
                            .stream_text(
                                &anthropic_request,
                                Box::new(move |delta| {
                                    let delta_text = delta.to_string();
                                    let _ = app_handle_delta.emit(
                                        EVENT_HAIKU_DELTA,
                                        candidate_delta_payload(
                                            &request_id_delta,
                                            delta_text.clone(),
                                            Some(&delta_meta),
                                        ),
                                    );
                                    let _ = companion_delta_tx.send(delta_text);
                                }),
                            )
                            .await;
                        drain_companion_delta_writer(anthropic_writer).await;
                        result
                    };

                    let openai_mini_future = async {
                        let app_handle_delta = app_handle_clone.clone();
                        let request_id_delta = request_id_clone.clone();
                        let delta_meta = openai_mini_candidate_clone.clone();
                        let companion_delta_tx = openai_mini_writer.tx.clone();
                        let result = openai_mini_provider
                            .stream_text(
                                &openai_mini_request,
                                Box::new(move |delta| {
                                    let delta_text = delta.to_string();
                                    let _ = app_handle_delta.emit(
                                        EVENT_HAIKU_DELTA,
                                        candidate_delta_payload(
                                            &request_id_delta,
                                            delta_text.clone(),
                                            Some(&delta_meta),
                                        ),
                                    );
                                    let _ = companion_delta_tx.send(delta_text);
                                }),
                            )
                            .await;
                        drain_companion_delta_writer(openai_mini_writer).await;
                        result
                    };

                    let (anthropic_result, openai_mini_result) =
                        tokio::join!(anthropic_future, openai_mini_future);
                    let anthropic_ok = settle_parallel_candidate(
                        &app_handle_clone,
                        &request_id_clone,
                        &anthropic_candidate_clone,
                        anthropic_result,
                    )
                    .await;
                    let openai_mini_ok = settle_parallel_candidate(
                        &app_handle_clone,
                        &request_id_clone,
                        &openai_mini_candidate_clone,
                        openai_mini_result,
                    )
                    .await;

                    if anthropic_ok || openai_mini_ok {
                        let _ = app_handle_clone.emit(
                            EVENT_HAIKU_DONE,
                            candidate_done_payload(&request_id_clone, None),
                        );
                    } else {
                        let _ = app_handle_clone.emit(
                            EVENT_HAIKU_ERROR,
                            candidate_error_payload(
                                &request_id_clone,
                                "All LLM candidates failed".to_string(),
                                None,
                            ),
                        );
                    }
                });

                return Ok(request_id);
            }
            Err(err) => {
                log::warn!(
                    "Failed to create OpenAI Responses parallel provider, falling back to single provider: {}",
                    err
                );
            }
        }
    }

    crate::presentation::companion_timeline::begin_haiku_message(
        state.inner(),
        crate::presentation::companion_timeline::CompanionHaikuStart {
            request_id: request_id.clone(),
            insert_after_id: companion_meta.insert_after_id.clone(),
            created_at_ms: companion_meta
                .created_at_ms
                .unwrap_or_else(crate::presentation::companion_timeline::now_ms),
            candidates: Vec::new(),
            active_candidate_id: None,
        },
    )
    .await;
    let _ = crate::presentation::companion::publish_snapshot(&app_handle).await;
    log::info!(
        "Command: start_haiku_stream request_id={} prompt_len={}",
        request_id,
        effective_prompt.len()
    );

    let request_id_clone = request_id.clone();
    let app_handle_clone = app_handle.clone();
    let user_text = effective_prompt;
    let model_clone = model.clone();
    let system_prompt_clone = system_prompt.clone();
    let provider_clone = provider;

    tauri::async_runtime::spawn(async move {
        let app_handle_delta = app_handle_clone.clone();
        let request_id_delta = request_id_clone.clone();
        let companion_delta_writer =
            spawn_companion_delta_writer(app_handle_clone.clone(), request_id_clone.clone(), None);
        let companion_delta_tx = companion_delta_writer.tx.clone();

        let request = if provider_clone == crate::domain::LlmProviderType::OpenAiResponses {
            build_openai_responses_request(
                model_clone,
                system_prompt_clone,
                user_text,
                max_tokens,
                temperature,
                Vec::new(),
                openai_responses_web_search,
                openai_responses_reasoning_effort(),
                openai_responses_verbosity(),
            )
        } else {
            crate::domain::LlmStreamRequest::new(
                model_clone,
                system_prompt_clone,
                user_text,
                max_tokens,
                temperature,
            )
        };

        let result = llm_provider
            .stream_text(
                &request,
                Box::new(move |delta| {
                    let delta_text = delta.to_string();
                    let _ = app_handle_delta.emit(
                        EVENT_HAIKU_DELTA,
                        candidate_delta_payload(&request_id_delta, delta_text.clone(), None),
                    );
                    let _ = companion_delta_tx.send(delta_text);
                }),
            )
            .await;

        drain_companion_delta_writer(companion_delta_writer).await;

        match result {
            Ok(()) => {
                if let Some(state) = app_handle_clone.try_state::<AppState>() {
                    crate::presentation::companion_timeline::finalize_haiku_message_with_normalizer(
                        state.inner(),
                        &request_id_clone,
                        final_answer_normalizer,
                    )
                    .await;
                    let _ = crate::presentation::companion::publish_snapshot_sse_only(
                        &app_handle_clone,
                    )
                    .await;
                }
                let _ = app_handle_clone.emit(
                    EVENT_HAIKU_DONE,
                    candidate_done_payload(&request_id_clone, None),
                );
            }
            Err(e) => {
                if let Some(state) = app_handle_clone.try_state::<AppState>() {
                    crate::presentation::companion_timeline::fail_haiku_message(
                        state.inner(),
                        &request_id_clone,
                        &e.to_string(),
                    )
                    .await;
                    let _ = crate::presentation::companion::publish_snapshot_sse_only(
                        &app_handle_clone,
                    )
                    .await;
                }
                let _ = app_handle_clone.emit(
                    EVENT_HAIKU_ERROR,
                    candidate_error_payload(&request_id_clone, e.to_string(), None),
                );
            }
        }
    });

    Ok(request_id)
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmImageInput {
    pub media_type: String,
    pub data_base64: String,
}

pub(crate) fn validate_llm_image_inputs(images: Vec<LlmImageInput>) -> Result<Vec<LlmImageInput>, String> {
    use base64::Engine;

    const MAX_IMAGES: usize = 10;
    const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
    const MAX_TOTAL_BYTES: usize = 25 * 1024 * 1024;
    if images.len() > MAX_IMAGES {
        return Err(format!("Слишком много изображений: максимум {MAX_IMAGES} за запрос"));
    }

    let mut total_bytes = 0;
    let mut validated = Vec::with_capacity(images.len());
    for image in images {
        let mime = image.media_type.trim().to_ascii_lowercase();
        let mime = if mime == "image/jpg" { "image/jpeg".to_string() } else { mime };
        if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/webp" | "image/gif") {
            return Err("Поддерживаются изображения PNG, JPEG, WebP и GIF; HEIC сначала преобразуйте в JPEG".to_string());
        }
        let encoded = image.data_base64.trim();
        if encoded.is_empty() || encoded.len() > (MAX_IMAGE_BYTES * 4 / 3 + 8) {
            return Err("Изображение пустое или больше 5 МБ".to_string());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "Повреждённые данные изображения".to_string())?;
        let matches_mime = match mime.as_str() {
            "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
            "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            _ => false,
        };
        if !matches_mime || bytes.len() > MAX_IMAGE_BYTES {
            return Err("Формат изображения не совпадает с содержимым или файл больше 5 МБ".to_string());
        }
        total_bytes += bytes.len();
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("Общий размер изображений превышает 25 МБ".to_string());
        }
        validated.push(LlmImageInput { media_type: mime, data_base64: encoded.to_string() });
    }
    Ok(validated)
}

#[cfg(test)]
mod llm_image_input_tests {
    use super::*;
    use base64::Engine;

    fn image(mime: &str, bytes: &[u8]) -> LlmImageInput {
        LlmImageInput {
            media_type: mime.to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }

    #[test]
    fn preserves_multiple_screenshots_and_normalizes_jpeg_alias() {
        let images = vec![
            image("image/png", b"\x89PNG\r\n\x1a\nfixture"),
            image("image/jpg", b"\xff\xd8\xfffixture"),
            image("image/webp", b"RIFF0000WEBPfixture"),
        ];
        let validated = validate_llm_image_inputs(images).unwrap();
        assert_eq!(validated.len(), 3);
        assert_eq!(validated[0].media_type, "image/png");
        assert_eq!(validated[1].media_type, "image/jpeg");
        assert_eq!(validated[2].media_type, "image/webp");
    }

    #[test]
    fn rejects_unsupported_or_mismatched_images_instead_of_dropping_them() {
        assert!(validate_llm_image_inputs(vec![image("image/heic", b"fixture")]).is_err());
        assert!(validate_llm_image_inputs(vec![image("image/png", b"\xff\xd8\xfffixture")]).is_err());
        assert!(validate_llm_image_inputs(vec![LlmImageInput {
            media_type: "image/png".into(),
            data_base64: "not-base64".into(),
        }]).is_err());
    }
}

fn to_llm_image_content(images: &[LlmImageInput]) -> Vec<crate::domain::LlmImageContent> {
    images
        .iter()
        .map(|image| crate::domain::LlmImageContent {
            media_type: image.media_type.trim().to_string(),
            data_base64: image.data_base64.trim().to_string(),
        })
        .collect()
}

fn openai_responses_model() -> String {
    std::env::var("OPENAI_RESPONSES_MODEL")
        .or_else(|_| std::env::var("OPENAI_MODEL"))
        .unwrap_or_else(|_| crate::domain::DEFAULT_OPENAI_RESPONSES_MODEL.to_string())
}

fn openai_responses_reasoning_effort() -> String {
    std::env::var("OPENAI_RESPONSES_REASONING_EFFORT").unwrap_or_else(|_| "low".to_string())
}

fn openai_responses_verbosity() -> String {
    std::env::var("OPENAI_RESPONSES_VERBOSITY").unwrap_or_else(|_| "low".to_string())
}

fn openai_responses_web_search(
    request_enabled: Option<bool>,
) -> Option<crate::domain::LlmWebSearchOptions> {
    let enabled = request_enabled.unwrap_or_else(|| env_flag("OPENAI_RESPONSES_WEB_SEARCH"));
    enabled.then(|| crate::domain::LlmWebSearchOptions {
        tool_type: std::env::var("OPENAI_RESPONSES_WEB_SEARCH_TOOL_TYPE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "web_search_preview".to_string()),
        context_size: std::env::var("OPENAI_RESPONSES_WEB_SEARCH_CONTEXT_SIZE")
            .unwrap_or_else(|_| "low".to_string()),
    })
}

fn openai_responses_runtime_config() -> Result<crate::domain::LlmRuntimeConfig, String> {
    Ok(crate::domain::LlmRuntimeConfig {
        provider: crate::domain::LlmProviderType::OpenAiResponses,
        api_key: Some(
            std::env::var("OPENAI_API_KEY").map_err(|_| "OPENAI_API_KEY is not set".to_string())?,
        ),
        base_url: std::env::var("OPENAI_BASE_URL").ok(),
        backend_url: None,
        backend_auth_token: None,
    })
}

fn build_openai_responses_request(
    model: String,
    system_prompt: String,
    user_text: String,
    max_tokens: u32,
    temperature: f32,
    images: Vec<crate::domain::LlmImageContent>,
    web_search_enabled: Option<bool>,
    reasoning_effort: String,
    verbosity: String,
) -> crate::domain::LlmStreamRequest {
    let mut request = crate::domain::LlmStreamRequest::new(
        model,
        system_prompt,
        user_text,
        max_tokens,
        temperature,
    )
    .with_reasoning_effort(reasoning_effort)
    .with_verbosity(verbosity)
    .with_images(images);

    if let Some(web_search) = openai_responses_web_search(web_search_enabled) {
        request = request.with_web_search(web_search);
    }

    request
}

fn build_anthropic_chat_user_content(text: &str, images: &[LlmImageInput]) -> serde_json::Value {
    let trimmed_text = text.trim();
    if images.is_empty() {
        return serde_json::json!(trimmed_text);
    }

    let mut parts: Vec<serde_json::Value> = Vec::new();
    if !trimmed_text.is_empty() {
        parts.push(serde_json::json!({
            "type": "text",
            "text": trimmed_text
        }));
    }

    for image in images {
        parts.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": image.media_type.trim(),
                "data": image.data_base64.trim()
            }
        }));
    }

    serde_json::json!(parts)
}

fn build_chat_user_text(context: &str, question: &str) -> String {
    let context = context.trim();
    let question = question.trim();
    if context.is_empty() {
        question.to_string()
    } else if question.is_empty() {
        context.to_string()
    } else {
        format!("{context}\n\nЗАПРОС: {question}")
    }
}

#[cfg(test)]
mod ai_prompt_payload_tests {
    use super::{
        build_anthropic_chat_user_content, build_chat_user_text, with_interview_answer_style_guard,
        LlmImageInput,
    };

    fn image(media_type: &str, data_base64: &str) -> LlmImageInput {
        LlmImageInput {
            media_type: media_type.to_string(),
            data_base64: data_base64.to_string(),
        }
    }

    #[test]
    fn anthropic_chat_user_content_keeps_text_only_requests_as_plain_text() {
        let payload = build_anthropic_chat_user_content("  ОС: question  ", &[]);

        assert_eq!(payload, serde_json::json!("ОС: question"));
    }

    #[test]
    fn anthropic_chat_user_content_omits_empty_text_block_for_image_only_requests() {
        let payload = build_anthropic_chat_user_content("", &[image("image/png", "AAA=")]);
        let blocks = payload
            .as_array()
            .expect("image request must use content blocks");

        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "image");
    }

    #[test]
    fn chat_user_text_keeps_question_as_final_explicit_request() {
        let text = build_chat_user_text(
            "[current_request]\nold embedded request\n[retrieved_memory]\nlarge memory",
            "current user question",
        );

        assert!(text.contains("[retrieved_memory]\nlarge memory"));
        assert!(text.ends_with("ЗАПРОС: current user question"));
    }

    #[test]
    fn interview_answer_style_guard_appends_to_custom_prompts() {
        let prompt = with_interview_answer_style_guard("custom interview prompt".to_string());

        assert!(prompt.contains("custom interview prompt"));
        assert!(prompt.contains("Начинай сразу с ответа"));
        assert!(prompt.contains("Не повторяй вопрос пользователя"));
        assert!(prompt.contains("\"Вопрос:\"/\"Ответ:\""));
        assert!(prompt.contains("Запрещено начинать с \"Вопрос\""));
        assert!(prompt.contains("выдай сам готовый ответ от первого лица"));
        assert!(prompt.contains("Не начинай с \"I'd say\""));
        assert!(prompt.contains("точное название"));
        assert!(prompt.contains("самый сильный proof"));
        assert!(prompt.contains("Не используй символы"));
        assert!(prompt.contains("Дай полезный технический ответ"));
        assert!(prompt.contains("без уточняющих вопросов"));
    }

    #[test]
    fn interview_answer_style_guard_upgrades_old_existing_rule() {
        let prompt = with_interview_answer_style_guard(
            "custom\nНе повторяй вопрос пользователя и отвечай кратко".to_string(),
        );

        assert!(prompt.contains("Правила стиля ответа:"));
        assert!(prompt.contains("выдай сам готовый ответ от первого лица"));
    }

    #[test]
    fn interview_answer_style_guard_does_not_duplicate_current_marker() {
        let prompt = with_interview_answer_style_guard(
            "custom\nПравила стиля ответа:\n- Уже есть актуальный guard".to_string(),
        );

        assert_eq!(prompt.matches("Правила стиля ответа:").count(), 2);
    }
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionAiRequestMeta {
    pub insert_after_id: Option<String>,
    pub created_at_ms: Option<i64>,
    pub prompt_message_id: Option<String>,
    pub prompt_created_at_ms: Option<i64>,
}

/// Стриминговый запрос в LLM из чата: контекст + явный вопрос + (опционально) изображения из clipboard.
///
/// Возвращает `request_id`, а прогресс стриминга приходит через события:
/// - `haiku:delta`
/// - `haiku:done`
/// - `haiku:error`
#[tauri::command]
pub async fn start_haiku_chat_stream(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    context_text: String,
    question_text: String,
    images: Option<Vec<LlmImageInput>>,
    context_images: Option<Vec<LlmImageInput>>,
    system_prompt: Option<String>,
    companion_meta: Option<CompanionAiRequestMeta>,
    openai_responses_web_search: Option<bool>,
    memory_context_evidence: Option<
        crate::presentation::interview_memory_bridge::MemoryContextEvidenceInput,
    >,
) -> Result<String, String> {
    let context = context_text.trim().to_string();
    let question = question_text.trim().to_string();
    let mut all_images = context_images.unwrap_or_default();
    let context_image_count = all_images.len();
    all_images.extend(images.unwrap_or_default());
    let all_images = validate_llm_image_inputs(all_images)?;
    let images = all_images[context_image_count..].to_vec();

    if context.is_empty() && question.is_empty() && images.is_empty() {
        return Err("Empty input".to_string());
    }

    let provider = match std::env::var("LLM_PROVIDER")
        .ok()
        .unwrap_or_else(|| "anthropic".to_string())
        .to_lowercase()
        .as_str()
    {
        "anthropic" => crate::domain::LlmProviderType::Anthropic,
        "openai" | "openai_compatible" | "openrouter" => {
            crate::domain::LlmProviderType::OpenAiCompatible
        }
        "openai_responses" | "responses" => crate::domain::LlmProviderType::OpenAiResponses,
        "backend" => crate::domain::LlmProviderType::Backend,
        other => {
            log::warn!(
                "Unknown LLM_PROVIDER='{}', falling back to anthropic",
                other
            );
            crate::domain::LlmProviderType::Anthropic
        }
    };
    let max_tokens: u32 = std::env::var("LLM_MAX_TOKENS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| match provider {
            crate::domain::LlmProviderType::Anthropic => std::env::var("ANTHROPIC_MAX_TOKENS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1024),
            crate::domain::LlmProviderType::OpenAiCompatible => std::env::var("OPENAI_MAX_TOKENS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1024),
            crate::domain::LlmProviderType::OpenAiResponses => {
                std::env::var("OPENAI_RESPONSES_MAX_TOKENS")
                    .or_else(|_| std::env::var("OPENAI_MAX_TOKENS"))
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1024)
            }
            crate::domain::LlmProviderType::Backend => 1024,
        });

    let temperature: f32 = std::env::var("LLM_TEMPERATURE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| match provider {
            crate::domain::LlmProviderType::Anthropic => std::env::var("ANTHROPIC_TEMPERATURE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.2),
            crate::domain::LlmProviderType::OpenAiCompatible => std::env::var("OPENAI_TEMPERATURE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.2),
            crate::domain::LlmProviderType::OpenAiResponses => {
                std::env::var("OPENAI_RESPONSES_TEMPERATURE")
                    .or_else(|_| std::env::var("OPENAI_TEMPERATURE"))
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0.2)
            }
            crate::domain::LlmProviderType::Backend => 0.2,
        });

    // Язык ответов всегда русский (самый понятный язык владельца), даже если вопрос на украинском/английском.
    let default_system_prompt = r#"Ты - ассистент на техническом собеседовании. Всегда отвечай по-русски, даже если вопрос задан на украинском или английском. Технические термины оставляй на английском.

Контекст ниже - транскрипция, возможны ошибки распознавания. В нём есть строки:
- "ОС:" - то, что я слышу (обычно реплики собеседника/вопросы).
- "МИКРОФОН:" - то, что говорю я (мои ответы/мысли/иногда могу повторить вопрос).
- "ЗАПРОС:" - мой ручной вопрос/вставка.
- "ПОМОЩНИК:" - предыдущие ответы ассистента (можно использовать как контекст).

Твоя задача:
1) Ответить на "ЗАПРОС:" с учётом контекста выше.
2) Если "ЗАПРОС:" пустой, но есть изображения — объясни что на изображениях и ответь по ним, используя контекст.
3) Если деталей не хватает, дай наиболее полезный ответ по вероятному смыслу без уточняющих вопросов.

Формат ответа:
- Начинай сразу с ответа. Не повторяй "ЗАПРОС:" и не пиши заголовки "Вопрос:"/"Ответ:".
- Запрещено начинать с "Вопрос", "Ответ", заголовка # Ответ, "**Вопрос:**" или краткого пересказа вопроса.
- Первая строка должна быть содержательным тезисом ответа.
- Не начинай с фраз вроде "Понял", "Конечно", "Хорошо" - сразу давай содержательный ответ.
- По умолчанию отвечай коротким связным абзацем. Список нужен только для нескольких самостоятельных пунктов или по просьбе пользователя.
- Затем (если нужно) короткий пример кода.

Правила для кода:
- Если приводишь код, выводи его в Markdown fenced-блоке:
  ```<language>
  ...код...
  ```
- Вместо <language> подставляй реальный язык (например: dart, ts, js, python, go, rust, bash, sql)."#;

    let system_prompt = system_prompt
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var("LLM_SYSTEM_PROMPT").ok())
        .or_else(|| match provider {
            crate::domain::LlmProviderType::Anthropic => {
                std::env::var("ANTHROPIC_SYSTEM_PROMPT").ok()
            }
            crate::domain::LlmProviderType::OpenAiCompatible => {
                std::env::var("OPENAI_SYSTEM_PROMPT").ok()
            }
            crate::domain::LlmProviderType::OpenAiResponses => {
                std::env::var("OPENAI_RESPONSES_SYSTEM_PROMPT")
                    .or_else(|_| std::env::var("OPENAI_SYSTEM_PROMPT"))
                    .ok()
            }
            crate::domain::LlmProviderType::Backend => {
                std::env::var("BACKEND_LLM_SYSTEM_PROMPT").ok()
            }
        })
        .unwrap_or_else(|| default_system_prompt.to_string());
    let system_prompt = with_interview_answer_style_guard(system_prompt);
    let answer_style = { state.config.read().await.answer_style.clone() };
    let system_prompt = crate::presentation::answer_style_prompt::with_answer_style_policy(
        system_prompt,
        &answer_style,
    );
    let system_prompt = crate::presentation::candidate_profile::with_candidate_profile(system_prompt);
    let temperature = crate::presentation::answer_style_prompt::adjusted_answer_temperature(
        temperature,
        &answer_style,
    );
    let final_answer_normalizer = answer_style.natural_answer_style_enabled.then_some(
        crate::presentation::answer_style_prompt::compact_final_chat_answer as fn(&str) -> String,
    );

    let model = match provider {
        crate::domain::LlmProviderType::Anthropic => std::env::var("ANTHROPIC_MODEL")
            .unwrap_or_else(|_| crate::domain::DEFAULT_ANTHROPIC_MODEL.to_string()),
        crate::domain::LlmProviderType::OpenAiCompatible => std::env::var("OPENAI_MODEL")
            .or_else(|_| std::env::var("LLM_MODEL"))
            .map_err(|_| "OPENAI_MODEL (or LLM_MODEL) is not set".to_string())?,
        crate::domain::LlmProviderType::OpenAiResponses => openai_responses_model(),
        crate::domain::LlmProviderType::Backend => {
            std::env::var("LLM_MODEL").unwrap_or_else(|_| "default".to_string())
        }
    };

    let api_key = match provider {
        crate::domain::LlmProviderType::Anthropic => Some(
            std::env::var("ANTHROPIC_API_KEY")
                .map_err(|_| "ANTHROPIC_API_KEY is not set".to_string())?,
        ),
        crate::domain::LlmProviderType::OpenAiCompatible => Some(
            std::env::var("OPENAI_API_KEY").map_err(|_| "OPENAI_API_KEY is not set".to_string())?,
        ),
        crate::domain::LlmProviderType::OpenAiResponses => Some(
            std::env::var("OPENAI_API_KEY").map_err(|_| "OPENAI_API_KEY is not set".to_string())?,
        ),
        crate::domain::LlmProviderType::Backend => None,
    };

    let backend_auth_token = if provider == crate::domain::LlmProviderType::Backend {
        state
            .auth_store
            .read()
            .await
            .session
            .as_ref()
            .map(|s| s.access_token.clone())
            .or_else(|| std::env::var("LLM_BACKEND_AUTH_TOKEN").ok())
    } else {
        None
    };

    let runtime_cfg = crate::domain::LlmRuntimeConfig {
        provider,
        api_key: api_key.clone(),
        base_url: std::env::var("OPENAI_BASE_URL").ok(),
        backend_url: std::env::var("LLM_BACKEND_URL").ok(),
        backend_auth_token,
    };

    let llm_factory = crate::infrastructure::DefaultLlmProviderFactory::new();
    let llm_provider = llm_factory
        .create(&runtime_cfg)
        .map_err(|e| e.to_string())?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let companion_meta = companion_meta.unwrap_or_default();
    *state.companion_system_prompt.write().await = system_prompt.clone();
    if let Some(prompt_message_id) = companion_meta
        .prompt_message_id
        .clone()
        .filter(|value| !value.trim().is_empty())
    {
        crate::presentation::companion_timeline::append_prompt_message(
            state.inner(),
            crate::presentation::companion_timeline::CompanionPromptDraft {
                id: prompt_message_id.clone(),
                text: question.clone(),
                created_at_ms: companion_meta
                    .prompt_created_at_ms
                    .unwrap_or_else(crate::presentation::companion_timeline::now_ms),
                attachments: images
                    .iter()
                    .enumerate()
                    .map(
                        |(idx, image)| crate::presentation::companion::CompanionAttachment {
                            id: format!("{}:img:{}", prompt_message_id, idx),
                            kind: "image".to_string(),
                            mime: image.media_type.clone(),
                            data_url: format!(
                                "data:{};base64,{}",
                                image.media_type.trim(),
                                image.data_base64.trim()
                            ),
                        },
                    )
                    .collect(),
            },
        )
        .await;
    }

    let memory_mode =
        crate::presentation::interview_memory_bridge::resolved_mode_for_state(state.inner()).await;
    let mut llm_context = if memory_mode.minimal_local_prompt_context_enabled() {
        crate::presentation::interview_memory_bridge::local_prompt_fallback_context(&context)
    } else {
        context.clone()
    };
    let llm_question = question.clone();
    if let Some(memory_context) =
        crate::presentation::interview_memory_bridge::assemble_chat_context_or_fallback(
            state.inner(),
            &context,
            &question,
            memory_context_evidence.as_ref(),
        )
        .await
    {
        llm_context = memory_context;
    }

    let parallel_openai_enabled = provider == crate::domain::LlmProviderType::Anthropic
        && env_flag("LLM_PARALLEL_OPENAI_RESPONSES")
        && std::env::var("OPENAI_API_KEY")
            .ok()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);

    if parallel_openai_enabled {
        let openai_mini_model = openai_responses_model();
        let openai_runtime_cfg = openai_responses_runtime_config()?;
        match llm_factory.create(&openai_runtime_cfg) {
            Ok(openai_mini_provider) => {
                let anthropic_candidate = HaikuCandidateMeta {
                    id: "anthropic".to_string(),
                    label: "Anthropic".to_string(),
                    provider: "anthropic".to_string(),
                    model: model.clone(),
                };
                let openai_mini_candidate = HaikuCandidateMeta {
                    id: "openai_responses".to_string(),
                    label: "OpenAI 5.4 mini".to_string(),
                    provider: "openai_responses".to_string(),
                    model: openai_mini_model.clone(),
                };

                crate::presentation::companion_timeline::begin_haiku_message(
                    state.inner(),
                    crate::presentation::companion_timeline::CompanionHaikuStart {
                        request_id: request_id.clone(),
                        insert_after_id: companion_meta
                            .insert_after_id
                            .clone()
                            .or_else(|| companion_meta.prompt_message_id.clone()),
                        created_at_ms: companion_meta
                            .created_at_ms
                            .unwrap_or_else(crate::presentation::companion_timeline::now_ms),
                        candidates: vec![
                            crate::presentation::companion::CompanionLlmCandidate {
                                id: anthropic_candidate.id.clone(),
                                label: anthropic_candidate.label.clone(),
                                provider: anthropic_candidate.provider.clone(),
                                model: anthropic_candidate.model.clone(),
                                status: "streaming".to_string(),
                                text: String::new(),
                                error: None,
                            },
                            crate::presentation::companion::CompanionLlmCandidate {
                                id: openai_mini_candidate.id.clone(),
                                label: openai_mini_candidate.label.clone(),
                                provider: openai_mini_candidate.provider.clone(),
                                model: openai_mini_candidate.model.clone(),
                                status: "streaming".to_string(),
                                text: String::new(),
                                error: None,
                            },
                        ],
                        active_candidate_id: Some(anthropic_candidate.id.clone()),
                    },
                )
                .await;
                let _ = app_handle.emit(
                    EVENT_HAIKU_CANDIDATE_START,
                    candidate_start_payload(&request_id, &anthropic_candidate),
                );
                let _ = app_handle.emit(
                    EVENT_HAIKU_CANDIDATE_START,
                    candidate_start_payload(&request_id, &openai_mini_candidate),
                );
                let _ = crate::presentation::companion::publish_snapshot(&app_handle).await;

                log::info!(
                    "Command: start_haiku_chat_stream parallel request_id={} ctx_len={} q_len={} images={}",
                    request_id,
                    llm_context.len(),
                    llm_question.len(),
                    all_images.len()
                );

                let request_id_clone = request_id.clone();
                let app_handle_clone = app_handle.clone();
                let anthropic_model = model.clone();
                let system_prompt_clone = system_prompt.clone();
                let images_clone = all_images.clone();
                let context_clone = llm_context.clone();
                let question_clone = llm_question.clone();
                let api_key_clone = api_key.clone();
                let anthropic_candidate_clone = anthropic_candidate.clone();
                let openai_mini_candidate_clone = openai_mini_candidate.clone();

                tauri::async_runtime::spawn(async move {
                    let combined_text = build_chat_user_text(&context_clone, &question_clone);

                    let anthropic_writer = spawn_companion_delta_writer(
                        app_handle_clone.clone(),
                        request_id_clone.clone(),
                        Some(anthropic_candidate_clone.id.clone()),
                    );
                    let openai_mini_writer = spawn_companion_delta_writer(
                        app_handle_clone.clone(),
                        request_id_clone.clone(),
                        Some(openai_mini_candidate_clone.id.clone()),
                    );

                    let openai_mini_request = build_openai_responses_request(
                        openai_mini_model,
                        system_prompt_clone.clone(),
                        combined_text.clone(),
                        max_tokens,
                        temperature,
                        to_llm_image_content(&images_clone),
                        Some(false),
                        openai_responses_reasoning_effort(),
                        openai_responses_verbosity(),
                    );

                    let anthropic_future = async {
                        let key: Result<String, crate::domain::LlmError> = match api_key_clone {
                            Some(k) if !k.trim().is_empty() => Ok(k),
                            _ => Err(crate::domain::LlmError::Authentication(
                                "Missing API key".to_string(),
                            )),
                        };

                        let result = match key {
                            Ok(k) => {
                                let user_content = build_anthropic_chat_user_content(
                                    &combined_text,
                                    &images_clone,
                                );
                                let app_handle_delta = app_handle_clone.clone();
                                let request_id_delta = request_id_clone.clone();
                                let delta_meta = anthropic_candidate_clone.clone();
                                let companion_delta_tx = anthropic_writer.tx.clone();

                                crate::infrastructure::ai::anthropic::stream_user_content_deltas(
                                    crate::infrastructure::ai::anthropic::StreamUserContentOptions {
                                        api_key: &k,
                                        model: &anthropic_model,
                                        system_prompt: &system_prompt_clone,
                                        user_content: &user_content,
                                        max_tokens,
                                        temperature,
                                    },
                                    move |delta| {
                                        let delta_text = delta.to_string();
                                        let _ = app_handle_delta.emit(
                                            EVENT_HAIKU_DELTA,
                                            candidate_delta_payload(
                                                &request_id_delta,
                                                delta_text.clone(),
                                                Some(&delta_meta),
                                            ),
                                        );
                                        let _ = companion_delta_tx.send(delta_text);
                                    },
                                )
                                .await
                                .map_err(|e| match e {
                                    crate::infrastructure::ai::anthropic::AnthropicError::MissingApiKey => {
                                        crate::domain::LlmError::Authentication("Missing API key".to_string())
                                    }
                                    crate::infrastructure::ai::anthropic::AnthropicError::Http {
                                        status,
                                        body,
                                    } => crate::domain::LlmError::Http { status, body },
                                    crate::infrastructure::ai::anthropic::AnthropicError::Network(err) => {
                                        crate::domain::LlmError::Network(err.to_string())
                                    }
                                    crate::infrastructure::ai::anthropic::AnthropicError::InvalidResponse(
                                        err,
                                    ) => crate::domain::LlmError::InvalidResponse(err),
                                })
                            }
                            Err(e) => Err(e),
                        };

                        drain_companion_delta_writer(anthropic_writer).await;
                        result
                    };

                    let openai_mini_future = async {
                        let app_handle_delta = app_handle_clone.clone();
                        let request_id_delta = request_id_clone.clone();
                        let delta_meta = openai_mini_candidate_clone.clone();
                        let companion_delta_tx = openai_mini_writer.tx.clone();
                        let result = openai_mini_provider
                            .stream_text(
                                &openai_mini_request,
                                Box::new(move |delta| {
                                    let delta_text = delta.to_string();
                                    let _ = app_handle_delta.emit(
                                        EVENT_HAIKU_DELTA,
                                        candidate_delta_payload(
                                            &request_id_delta,
                                            delta_text.clone(),
                                            Some(&delta_meta),
                                        ),
                                    );
                                    let _ = companion_delta_tx.send(delta_text);
                                }),
                            )
                            .await;
                        drain_companion_delta_writer(openai_mini_writer).await;
                        result
                    };

                    let (anthropic_result, openai_mini_result) =
                        tokio::join!(anthropic_future, openai_mini_future);
                    let anthropic_ok = settle_parallel_candidate(
                        &app_handle_clone,
                        &request_id_clone,
                        &anthropic_candidate_clone,
                        anthropic_result,
                    )
                    .await;
                    let openai_mini_ok = settle_parallel_candidate(
                        &app_handle_clone,
                        &request_id_clone,
                        &openai_mini_candidate_clone,
                        openai_mini_result,
                    )
                    .await;

                    if anthropic_ok || openai_mini_ok {
                        let _ = app_handle_clone.emit(
                            EVENT_HAIKU_DONE,
                            candidate_done_payload(&request_id_clone, None),
                        );
                    } else {
                        let _ = app_handle_clone.emit(
                            EVENT_HAIKU_ERROR,
                            candidate_error_payload(
                                &request_id_clone,
                                "All LLM candidates failed".to_string(),
                                None,
                            ),
                        );
                    }
                });

                return Ok(request_id);
            }
            Err(err) => {
                log::warn!(
                    "Failed to create OpenAI Responses parallel provider, falling back to single provider: {}",
                    err
                );
            }
        }
    }

    crate::presentation::companion_timeline::begin_haiku_message(
        state.inner(),
        crate::presentation::companion_timeline::CompanionHaikuStart {
            request_id: request_id.clone(),
            insert_after_id: companion_meta
                .insert_after_id
                .clone()
                .or_else(|| companion_meta.prompt_message_id.clone()),
            created_at_ms: companion_meta
                .created_at_ms
                .unwrap_or_else(crate::presentation::companion_timeline::now_ms),
            candidates: Vec::new(),
            active_candidate_id: None,
        },
    )
    .await;
    let _ = crate::presentation::companion::publish_snapshot(&app_handle).await;
    log::info!(
        "Command: start_haiku_chat_stream request_id={} ctx_len={} q_len={} images={}",
        request_id,
        llm_context.len(),
        llm_question.len(),
        all_images.len()
    );

    let request_id_clone = request_id.clone();
    let app_handle_clone = app_handle.clone();
    let app_handle_delta = app_handle.clone();

    let model_clone = model.clone();
    let system_prompt_clone = system_prompt.clone();
    let provider_clone = provider;
    let api_key_clone = api_key.clone();
    let images_clone = all_images.clone();
    let context_clone = llm_context.clone();
    let question_clone = llm_question.clone();

    tauri::async_runtime::spawn(async move {
        let request_id_for_done = request_id_clone.clone();
        let request_id_for_error = request_id_clone.clone();
        let request_id_for_delta_anthropic = request_id_clone.clone();
        let request_id_for_delta_openai = request_id_clone.clone();
        let app_handle_delta_anthropic = app_handle_delta.clone();
        let app_handle_delta_openai = app_handle_delta.clone();
        let companion_delta_writer =
            spawn_companion_delta_writer(app_handle_clone.clone(), request_id_clone.clone(), None);

        let combined_text = build_chat_user_text(&context_clone, &question_clone);

        let combined_text_for_anthropic = combined_text.clone();

        let result = if provider_clone == crate::domain::LlmProviderType::Anthropic {
            let key: Result<&str, crate::domain::LlmError> = match api_key_clone.as_deref() {
                Some(k) if !k.trim().is_empty() => Ok(k),
                _ => Err(crate::domain::LlmError::Authentication(
                    "Missing API key".to_string(),
                )),
            };

            match key {
                Ok(k) => {
                    let user_content = build_anthropic_chat_user_content(
                        &combined_text_for_anthropic,
                        &images_clone,
                    );
                    let companion_delta_tx = companion_delta_writer.tx.clone();

                    crate::infrastructure::ai::anthropic::stream_user_content_deltas(
                        crate::infrastructure::ai::anthropic::StreamUserContentOptions {
                            api_key: k,
                            model: &model_clone,
                            system_prompt: &system_prompt_clone,
                            user_content: &user_content,
                            max_tokens,
                            temperature,
                        },
                        move |delta| {
                            let delta_text = delta.to_string();
                            let _ = app_handle_delta_anthropic.emit(
                                EVENT_HAIKU_DELTA,
                                candidate_delta_payload(
                                    &request_id_for_delta_anthropic,
                                    delta_text.clone(),
                                    None,
                                ),
                            );
                            let _ = companion_delta_tx.send(delta_text);
                        },
                    )
                    .await
                    .map_err(|e| match e {
                        crate::infrastructure::ai::anthropic::AnthropicError::MissingApiKey => {
                            crate::domain::LlmError::Authentication("Missing API key".to_string())
                        }
                        crate::infrastructure::ai::anthropic::AnthropicError::Http {
                            status,
                            body,
                        } => crate::domain::LlmError::Http { status, body },
                        crate::infrastructure::ai::anthropic::AnthropicError::Network(err) => {
                            crate::domain::LlmError::Network(err.to_string())
                        }
                        crate::infrastructure::ai::anthropic::AnthropicError::InvalidResponse(
                            err,
                        ) => crate::domain::LlmError::InvalidResponse(err),
                    })
                }
                Err(e) => Err(e),
            }
        } else {
            if !images_clone.is_empty()
                && provider_clone != crate::domain::LlmProviderType::OpenAiResponses
            {
                log::warn!(
                    "LLM provider '{}' does not support images in this request path; ignoring attachments",
                    llm_provider.name()
                );
            }

            let companion_delta_tx = companion_delta_writer.tx.clone();
            let request = if provider_clone == crate::domain::LlmProviderType::OpenAiResponses {
                build_openai_responses_request(
                    model_clone.clone(),
                    system_prompt_clone.clone(),
                    combined_text,
                    max_tokens,
                    temperature,
                    to_llm_image_content(&images_clone),
                    openai_responses_web_search,
                    openai_responses_reasoning_effort(),
                    openai_responses_verbosity(),
                )
            } else {
                crate::domain::LlmStreamRequest::new(
                    model_clone.clone(),
                    system_prompt_clone.clone(),
                    combined_text,
                    max_tokens,
                    temperature,
                )
            };

            let stream_started_at = std::time::Instant::now();
            let mut first_delta_logged = false;
            llm_provider
                .stream_text(
                    &request,
                    Box::new(move |delta| {
                        if !first_delta_logged {
                            first_delta_logged = true;
                            log::info!(
                                "First LLM delta after {}ms (request sent to the provider, not counting context assembly)",
                                stream_started_at.elapsed().as_millis()
                            );
                        }
                        let delta_text = delta.to_string();
                        let _ = app_handle_delta_openai.emit(
                            EVENT_HAIKU_DELTA,
                            candidate_delta_payload(
                                &request_id_for_delta_openai,
                                delta_text.clone(),
                                None,
                            ),
                        );
                        let _ = companion_delta_tx.send(delta_text);
                    }),
                )
                .await
        };

        drain_companion_delta_writer(companion_delta_writer).await;

        match result {
            Ok(()) => {
                if let Some(state) = app_handle_clone.try_state::<AppState>() {
                    crate::presentation::companion_timeline::finalize_haiku_message_with_normalizer(
                        state.inner(),
                        &request_id_for_done,
                        final_answer_normalizer,
                    )
                    .await;
                    let _ = crate::presentation::companion::publish_snapshot_sse_only(
                        &app_handle_clone,
                    )
                    .await;
                }
                let _ = app_handle_clone.emit(
                    EVENT_HAIKU_DONE,
                    candidate_done_payload(&request_id_for_done, None),
                );
            }
            Err(e) => {
                if let Some(state) = app_handle_clone.try_state::<AppState>() {
                    crate::presentation::companion_timeline::fail_haiku_message(
                        state.inner(),
                        &request_id_for_error,
                        &e.to_string(),
                    )
                    .await;
                    let _ = crate::presentation::companion::publish_snapshot_sse_only(
                        &app_handle_clone,
                    )
                    .await;
                }
                let _ = app_handle_clone.emit(
                    EVENT_HAIKU_ERROR,
                    candidate_error_payload(&request_id_for_error, e.to_string(), None),
                );
            }
        }
    });

    Ok(request_id)
}

/// Стриминговое объяснение кода (отдельный канал событий, не попадает в чат).
///
/// Возвращает `request_id`, а прогресс стриминга приходит через события:
/// - `code_explain:delta`
/// - `code_explain:done`
/// - `code_explain:error`
#[tauri::command]
pub async fn start_code_explain_stream(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    text: String,
    system_prompt: Option<String>,
    request_id: Option<String>,
) -> Result<String, String> {
    let prompt = text.trim();
    if prompt.is_empty() {
        return Err("Empty text".to_string());
    }

    let provider = match std::env::var("LLM_PROVIDER")
        .ok()
        .unwrap_or_else(|| "anthropic".to_string())
        .to_lowercase()
        .as_str()
    {
        "anthropic" => crate::domain::LlmProviderType::Anthropic,
        "openai" | "openai_compatible" | "openrouter" => {
            crate::domain::LlmProviderType::OpenAiCompatible
        }
        "openai_responses" | "responses" => crate::domain::LlmProviderType::OpenAiResponses,
        "backend" => crate::domain::LlmProviderType::Backend,
        other => {
            log::warn!(
                "Unknown LLM_PROVIDER='{}', falling back to anthropic",
                other
            );
            crate::domain::LlmProviderType::Anthropic
        }
    };
    let max_tokens: u32 = std::env::var("LLM_MAX_TOKENS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| match provider {
            crate::domain::LlmProviderType::Anthropic => std::env::var("ANTHROPIC_MAX_TOKENS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1024),
            crate::domain::LlmProviderType::OpenAiCompatible => std::env::var("OPENAI_MAX_TOKENS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1024),
            crate::domain::LlmProviderType::OpenAiResponses => {
                std::env::var("OPENAI_RESPONSES_MAX_TOKENS")
                    .or_else(|_| std::env::var("OPENAI_MAX_TOKENS"))
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1024)
            }
            crate::domain::LlmProviderType::Backend => 1024,
        });

    let temperature: f32 = std::env::var("LLM_TEMPERATURE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| match provider {
            crate::domain::LlmProviderType::Anthropic => std::env::var("ANTHROPIC_TEMPERATURE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.2),
            crate::domain::LlmProviderType::OpenAiCompatible => std::env::var("OPENAI_TEMPERATURE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.2),
            crate::domain::LlmProviderType::OpenAiResponses => {
                std::env::var("OPENAI_RESPONSES_TEMPERATURE")
                    .or_else(|_| std::env::var("OPENAI_TEMPERATURE"))
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0.2)
            }
            crate::domain::LlmProviderType::Backend => 0.2,
        });

    // Язык ответов всегда русский (самый понятный язык владельца), даже если вопрос на украинском/английском.
    let default_system_prompt = r#"Ты - ассистент на техническом собеседовании. Всегда отвечай по-русски, даже если вопрос задан на украинском или английском. Технические термины оставляй на английском.

Тебе дают:
- "Выделенный фрагмент" - текст или код, на который нужно ответить/объяснить.
- "Контекст чата" - история сообщений ДО выбранного сообщения включительно.

В контексте чата есть строки:
- "ОС:" - то, что я слышу (обычно реплики собеседника/вопросы).
- "МИКРОФОН:" - то, что говорю я (мои ответы/мысли/иногда могу повторить вопрос).
- "ПОМОЩНИК:" - предыдущие ответы ассистента.

Твоя задача:
1) Понять, что пользователь хочет про выделенный фрагмент: объяснить, исправить, улучшить, ответить на вопрос, или дать краткий разбор.
2) Дать лучший краткий ответ по делу (без воды), используя контекст чата, но не пересказывая его целиком.
3) Если запрос неясен из-за распознавания/обрывков, выбери наиболее вероятный смысл и ответь без уточняющих вопросов.

Формат ответа:
- По умолчанию отвечай 1-2 короткими предложениями одним компактным абзацем.
- Используй буллеты только если пользователь явно просит список, план, код или подробный разбор.
- Затем (если нужно) короткий пример кода (в fenced-блоке).

Правила для кода:
- Для упоминаний технических идентификаторов используй inline code (одинарные обратные кавычки).
- Для кода/выражений (даже коротких), если важна подсветка, используй fenced-блок с языком.
- Код - без нумерации строк, с корректными отступами."#;

    let system_prompt = system_prompt
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var("LLM_CODE_EXPLAIN_SYSTEM_PROMPT").ok())
        .unwrap_or_else(|| default_system_prompt.to_string());
    let system_prompt = with_interview_answer_style_guard(system_prompt);
    let system_prompt = crate::presentation::candidate_profile::with_candidate_profile(system_prompt);

    let model = match provider {
        crate::domain::LlmProviderType::Anthropic => std::env::var("ANTHROPIC_MODEL")
            .unwrap_or_else(|_| crate::domain::DEFAULT_ANTHROPIC_MODEL.to_string()),
        crate::domain::LlmProviderType::OpenAiCompatible => std::env::var("OPENAI_MODEL")
            .or_else(|_| std::env::var("LLM_MODEL"))
            .map_err(|_| "OPENAI_MODEL (or LLM_MODEL) is not set".to_string())?,
        crate::domain::LlmProviderType::OpenAiResponses => openai_responses_model(),
        crate::domain::LlmProviderType::Backend => {
            std::env::var("LLM_MODEL").unwrap_or_else(|_| "default".to_string())
        }
    };

    let api_key = match provider {
        crate::domain::LlmProviderType::Anthropic => Some(
            std::env::var("ANTHROPIC_API_KEY")
                .map_err(|_| "ANTHROPIC_API_KEY is not set".to_string())?,
        ),
        crate::domain::LlmProviderType::OpenAiCompatible => Some(
            std::env::var("OPENAI_API_KEY").map_err(|_| "OPENAI_API_KEY is not set".to_string())?,
        ),
        crate::domain::LlmProviderType::OpenAiResponses => Some(
            std::env::var("OPENAI_API_KEY").map_err(|_| "OPENAI_API_KEY is not set".to_string())?,
        ),
        crate::domain::LlmProviderType::Backend => None,
    };

    let backend_auth_token = if provider == crate::domain::LlmProviderType::Backend {
        state
            .auth_store
            .read()
            .await
            .session
            .as_ref()
            .map(|s| s.access_token.clone())
            .or_else(|| std::env::var("LLM_BACKEND_AUTH_TOKEN").ok())
    } else {
        None
    };

    let runtime_cfg = crate::domain::LlmRuntimeConfig {
        provider,
        api_key,
        base_url: std::env::var("OPENAI_BASE_URL").ok(),
        backend_url: std::env::var("LLM_BACKEND_URL").ok(),
        backend_auth_token,
    };

    let llm_factory = crate::infrastructure::DefaultLlmProviderFactory::new();
    let llm_provider = llm_factory
        .create(&runtime_cfg)
        .map_err(|e| e.to_string())?;

    let request_id = request_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    log::info!(
        "Command: start_code_explain_stream request_id={} prompt_len={}",
        request_id,
        prompt.len()
    );

    let request_id_clone = request_id.clone();
    let app_handle_clone = app_handle.clone();
    let user_text = prompt.to_string();
    let model_clone = model.clone();
    let system_prompt_clone = system_prompt.clone();

    tauri::async_runtime::spawn(async move {
        let app_handle_delta = app_handle_clone.clone();
        let request_id_delta = request_id_clone.clone();

        let request = crate::domain::LlmStreamRequest::new(
            model_clone,
            system_prompt_clone,
            user_text,
            max_tokens,
            temperature,
        );

        let result = llm_provider
            .stream_text(
                &request,
                Box::new(move |delta| {
                    let _ = app_handle_delta.emit(
                        EVENT_CODE_EXPLAIN_DELTA,
                        CodeExplainDeltaPayload {
                            request_id: request_id_delta.clone(),
                            delta: delta.to_string(),
                        },
                    );
                }),
            )
            .await;

        match result {
            Ok(()) => {
                let _ = app_handle_clone.emit(
                    EVENT_CODE_EXPLAIN_DONE,
                    CodeExplainDonePayload {
                        request_id: request_id_clone,
                    },
                );
            }
            Err(e) => {
                let _ = app_handle_clone.emit(
                    EVENT_CODE_EXPLAIN_ERROR,
                    CodeExplainErrorPayload {
                        request_id: request_id_clone,
                        error: e.to_string(),
                    },
                );
            }
        }
    });

    Ok(request_id)
}

fn format_size_human(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.0} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.0} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

//
// Auto-Paste Commands
//

/// Проверяет есть ли разрешение Accessibility на macOS
/// На других платформах всегда возвращает true
#[tauri::command]
pub async fn check_accessibility_permission() -> Result<bool, String> {
    log::debug!("Command: check_accessibility_permission");
    Ok(crate::infrastructure::auto_paste::check_accessibility_permission())
}

/// Открывает системные настройки macOS в разделе Privacy & Security > Accessibility
/// На других платформах ничего не делает
#[tauri::command]
pub async fn request_accessibility_permission() -> Result<(), String> {
    log::info!("Command: request_accessibility_permission");
    crate::infrastructure::auto_paste::request_accessibility_permission()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct FocusCopyHelperInfo {
    pub app_bundle_path: String,
    pub executable_path: String,
    pub accessibility_target_path: String,
    pub accessibility_target_exists: bool,
}

#[cfg(target_os = "macos")]
fn focus_copy_helper_info() -> FocusCopyHelperInfo {
    let repo_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let helper_root = repo_root.join("tools").join("macos-focus-copy-helper");
    let app_bundle = helper_root.join("dist").join("Telegram.app");
    let executable = helper_root
        .join(".build")
        .join("release")
        .join("MacOSFocusCopyHelper");
    let accessibility_target = app_bundle.clone();

    FocusCopyHelperInfo {
        app_bundle_path: app_bundle.to_string_lossy().to_string(),
        executable_path: executable.to_string_lossy().to_string(),
        accessibility_target_exists: accessibility_target.exists(),
        accessibility_target_path: accessibility_target.to_string_lossy().to_string(),
    }
}

#[cfg(target_os = "macos")]
fn focus_copy_helper_check_executable() -> std::path::PathBuf {
    let info = focus_copy_helper_info();
    std::path::PathBuf::from(&info.app_bundle_path)
        .join("Contents")
        .join("MacOS")
        .join("Telegram")
}

#[cfg(not(target_os = "macos"))]
fn focus_copy_helper_info() -> FocusCopyHelperInfo {
    FocusCopyHelperInfo {
        app_bundle_path: String::new(),
        executable_path: String::new(),
        accessibility_target_path: String::new(),
        accessibility_target_exists: false,
    }
}

#[tauri::command]
pub async fn get_focus_copy_helper_info() -> Result<FocusCopyHelperInfo, String> {
    Ok(focus_copy_helper_info())
}

#[tauri::command]
pub async fn check_focus_copy_helper_accessibility() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let executable = focus_copy_helper_check_executable();
        if !executable.exists() {
            return Err(format!(
                "Focus copy helper is not built: {}",
                executable.to_string_lossy()
            ));
        }

        let output = Command::new(&executable)
            .arg("--check-accessibility")
            .output()
            .map_err(|e| {
                format!(
                    "Failed to run helper accessibility check '{}': {}",
                    executable.to_string_lossy(),
                    e
                )
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::info!(
            "Focus copy helper accessibility check: status={:?}, stdout={}, stderr={}",
            output.status.code(),
            stdout.trim(),
            stderr.trim()
        );

        return Ok(output.status.success());
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub async fn reveal_focus_copy_helper() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let info = focus_copy_helper_info();
        let target = std::path::PathBuf::from(&info.accessibility_target_path);
        if target.exists() {
            let status = Command::new("open")
                .arg("-R")
                .arg(&target)
                .status()
                .map_err(|e| format!("Failed to reveal helper in Finder: {}", e))?;

            if !status.success() {
                return Err("Failed to reveal helper in Finder".to_string());
            }
            return Ok(());
        }

        let fallback_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("tools")
            .join("macos-focus-copy-helper");
        let status = Command::new("open")
            .arg(&fallback_dir)
            .status()
            .map_err(|e| format!("Failed to open helper folder: {}", e))?;

        if !status.success() {
            return Err("Failed to open helper folder".to_string());
        }
    }

    Ok(())
}

/// Автоматически вставляет текст в последнее активное окно
/// Требует разрешения Accessibility на macOS
#[tauri::command]
pub async fn auto_paste_text(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    text: String,
) -> Result<(), String> {
    log::info!("Command: auto_paste_text - text length: {}", text.len());

    // Проверяем разрешение Accessibility на macOS
    #[cfg(target_os = "macos")]
    {
        if !crate::infrastructure::auto_paste::check_accessibility_permission() {
            return Err("Accessibility permission not granted. Please enable it in System Settings > Privacy & Security > Accessibility".to_string());
        }
    }

    // Получаем bundle ID последнего активного окна
    let last_bundle_id = state.last_focused_app_bundle_id.read().await.clone();

    // Не скрываем окно HackInterviewAI - оставляем его видимым поверх всех
    // (оно уже настроено с alwaysOnTop: true в tauri.conf.json)

    // Если есть сохраненное окно - пытаемся активировать его
    if let Some(bundle_id) = last_bundle_id {
        log::info!("Attempting to activate last focused app: {}", bundle_id);

        match crate::infrastructure::auto_paste::activate_app_by_bundle_id(&bundle_id) {
            Ok(_) => {
                log::info!("✅ Successfully activated app: {}", bundle_id);
                // Даем время окну активироваться
                tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
            }
            Err(e) => {
                log::warn!("⚠️ Failed to activate app '{}': {}", bundle_id, e);
                log::info!("💡 Will paste to currently active window instead");
                // Не критично - просто вставим в текущее активное окно
                // Даем небольшую паузу для переключения фокуса вручную если нужно
                tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            }
        }
    } else {
        log::info!("ℹ️ No saved window - pasting to currently active window");
    }

    // Вставляем текст в blocking thread (enigo работает с синхронными нативными API)
    let text_clone = text.clone();
    tokio::task::spawn_blocking(move || crate::infrastructure::auto_paste::paste_text(&text_clone))
        .await
        .map_err(|e| format!("Failed to join blocking task: {}", e))?
        .map_err(|e| format!("Failed to paste text: {}", e))?;

    // Возвращаем окно HackInterviewAI поверх всех окон (но без фокуса)
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.set_always_on_top(true);
        log::debug!("HackInterviewAI window kept on top");
    }

    log::info!("Text auto-pasted successfully");
    Ok(())
}

/// Копирует текст в системный clipboard используя arboard (кроссплатформенно)
/// Работает БЕЗ активации приложения - решает проблему с nonactivating_panel на macOS
#[tauri::command]
pub async fn copy_to_clipboard_native(text: String) -> Result<(), String> {
    log::debug!(
        "Command: copy_to_clipboard_native - text length: {}",
        text.len()
    );

    // Используем blocking task (arboard работает с синхронными системными API, как enigo)
    tokio::task::spawn_blocking(move || crate::infrastructure::copy_to_clipboard(&text))
        .await
        .map_err(|e| format!("Failed to join blocking task: {}", e))?
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))?;

    log::info!("Text copied to clipboard successfully");
    Ok(())
}

/// Показывает auth окно и скрывает recording (main)
#[tauri::command]
pub async fn show_auth_window(app_handle: AppHandle) -> Result<(), String> {
    log::info!("Command: show_auth_window");

    // Скрываем recording окно (main)
    if let Some(main) = app_handle.get_webview_window("main") {
        // На macOS main может быть NSPanel с высоким уровнем; перед hide сбрасываем always-on-top
        if let Err(e) = main.set_always_on_top(false) {
            log::warn!("Failed to disable always-on-top for main window: {}", e);
        }
        if let Err(e) = main.hide() {
            log::warn!("Failed to hide main window: {}", e);
        }
    }

    // Скрываем settings окно (если было открыто)
    if let Some(settings) = app_handle.get_webview_window("settings") {
        if let Err(e) = settings.hide() {
            log::warn!("Failed to hide settings window: {}", e);
        }
    }

    // Скрываем profile окно (если было открыто)
    if let Some(profile) = app_handle.get_webview_window("profile") {
        if let Err(e) = profile.hide() {
            log::warn!("Failed to hide profile window: {}", e);
        }
    }

    // Показываем auth окно
    if let Some(auth) = app_handle.get_webview_window("auth") {
        // Центрируем и показываем на активном мониторе, чтобы окно точно было видно
        show_webview_window_on_active_monitor(&auth)?;
        auth.set_focus().map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Показывает recording окно (main) и скрывает auth
#[tauri::command]
pub async fn show_recording_window(app_handle: AppHandle) -> Result<(), String> {
    log::info!("Command: show_recording_window");

    // Скрываем auth окно
    if let Some(auth) = app_handle.get_webview_window("auth") {
        if let Err(e) = auth.hide() {
            log::warn!("Failed to hide auth window: {}", e);
        }
    }

    // Скрываем settings окно
    if let Some(settings) = app_handle.get_webview_window("settings") {
        if let Err(e) = settings.hide() {
            log::warn!("Failed to hide settings window: {}", e);
        }
    }

    // Скрываем profile окно
    if let Some(profile) = app_handle.get_webview_window("profile") {
        if let Err(e) = profile.hide() {
            log::warn!("Failed to hide profile window: {}", e);
        }
    }

    // Показываем recording окно (NSPanel - появляется поверх fullscreen, без фокуса)
    if let Some(window) = app_handle.get_webview_window("main") {
        show_webview_window_on_active_monitor(&window)?;
        let _ = window.emit(EVENT_RECORDING_WINDOW_SHOWN, ());
        if let Err(e) = window.set_always_on_top(true) {
            log::warn!("Failed to enable always-on-top for main window: {}", e);
        }
    }

    Ok(())
}

/// Показывает settings окно и скрывает recording (main)
#[tauri::command]
pub async fn show_settings_window(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!("Command: show_settings_window");

    // Настройки доступны только авторизованному пользователю.
    // Если не авторизован — открываем auth окно, а settings держим скрытым.
    if !state.has_local_access().await {
        log::info!("show_settings_window: user is not authenticated -> redirect to auth window");
        show_auth_window(app_handle).await?;
        return Err("Not authenticated".to_string());
    }

    // Скрываем recording окно (main)
    if let Some(main) = app_handle.get_webview_window("main") {
        // На macOS main может быть NSPanel с высоким уровнем; перед hide сбрасываем always-on-top
        if let Err(e) = main.set_always_on_top(false) {
            log::warn!("Failed to disable always-on-top for main window: {}", e);
        }
        if let Err(e) = main.hide() {
            log::warn!("Failed to hide main window: {}", e);
        }
    }

    // Скрываем auth окно (на всякий случай)
    if let Some(auth) = app_handle.get_webview_window("auth") {
        if let Err(e) = auth.hide() {
            log::warn!("Failed to hide auth window: {}", e);
        }
    }

    // Скрываем profile окно
    if let Some(profile) = app_handle.get_webview_window("profile") {
        if let Err(e) = profile.hide() {
            log::warn!("Failed to hide profile window: {}", e);
        }
    }

    // Показываем settings окно
    if let Some(settings) = app_handle.get_webview_window("settings") {
        show_webview_window_on_active_monitor(&settings)?;
        settings.set_focus().map_err(|e| e.to_string())?;
        let _ = settings.emit("settings-window-opened", true);
    }

    Ok(())
}

/// Показывает profile окно и скрывает остальные
#[tauri::command]
pub async fn show_profile_window(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    initial_section: Option<String>,
) -> Result<(), String> {
    log::info!("Command: show_profile_window");

    if !state.has_local_access().await {
        log::info!("show_profile_window: not authenticated -> redirect to auth");
        show_auth_window(app_handle).await?;
        return Err("Not authenticated".to_string());
    }

    // Скрываем все окна
    if let Some(main) = app_handle.get_webview_window("main") {
        let _ = main.set_always_on_top(false);
        let _ = main.hide();
    }
    if let Some(auth) = app_handle.get_webview_window("auth") {
        let _ = auth.hide();
    }
    if let Some(settings) = app_handle.get_webview_window("settings") {
        let _ = settings.hide();
    }

    // Показываем profile
    if let Some(profile) = app_handle.get_webview_window("profile") {
        show_webview_window_on_active_monitor(&profile)?;
        profile.set_focus().map_err(|e| e.to_string())?;
        let _ = profile.emit(
            "profile-window-opened",
            serde_json::json!({
                "initialSection": initial_section.unwrap_or_else(|| "none".to_string())
            }),
        );
    }

    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionInputUser {
    pub id: String,
    pub email: String,
    pub email_verified: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionInput {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub access_expires_at: String,
    pub refresh_expires_at: Option<String>,
    pub device_id: Option<String>, // ignore: Rust SoT
    pub user: Option<AuthSessionInputUser>,
}

fn parse_rfc3339_to_ms(s: &str) -> Result<i64, String> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.timestamp_millis())
        .map_err(|e| format!("Invalid RFC3339 datetime: {} ({})", s, e))
}

async fn emit_invalidation(
    app_handle: &AppHandle,
    topic: &str,
    revision: String,
    source_id: Option<String>,
) {
    let _ = app_handle.emit(
        EVENT_STATE_SYNC_INVALIDATION,
        crate::presentation::StateSyncInvalidationPayload {
            topic: topic.to_string(),
            revision,
            source_id,
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
        },
    );
}

/// Устанавливает/очищает auth session в Rust (SoT) и запускает фоновые refresh-таймеры.
#[tauri::command]
pub async fn set_auth_session(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    window: Window,
    session: Option<AuthSessionInput>,
) -> Result<(), String> {
    // 1) Обновляем store в памяти + сохраняем на диск
    let mut next = state.auth_store.read().await.clone();

    let prev_is_auth = next.is_authenticated();

    next.session = match session {
        Some(s) => {
            // device_id критичен: refresh token привязан к client_id на сервере.
            // Поэтому если frontend прислал device_id (например, после login/refresh),
            // обновляем Rust SoT, чтобы background refresh работал корректно.
            if let Some(did) = s.device_id.as_deref() {
                let did = did.trim();
                if !did.is_empty() && did != next.device_id {
                    next.device_id = did.to_string();
                }
            }

            let access_expires_at_ms = parse_rfc3339_to_ms(&s.access_expires_at)?;
            let refresh_expires_at_ms = match s.refresh_expires_at.as_deref() {
                Some(v) => Some(parse_rfc3339_to_ms(v)?),
                None => None,
            };

            Some(AuthSession {
                access_token: s.access_token,
                refresh_token: s.refresh_token,
                access_expires_at_ms,
                refresh_expires_at_ms,
                user: s.user.map(|u| AuthUser {
                    id: u.id,
                    email: u.email,
                    email_verified: u.email_verified,
                }),
            })
        }
        None => None,
    };

    if let Err(e) = AuthStore::save(&next).await {
        return Err(format!("Failed to save auth store: {}", e));
    }

    *state.auth_store.write().await = next.clone();

    // 2) Обновляем derived auth flag
    let next_is_auth = next.is_authenticated();
    *state.is_authenticated.write().await = next_is_auth;

    // 3) Обновляем токен для STT (чтобы hotkey start_recording всегда имел актуальный access)
    let stt_token = next.session.as_ref().map(|s| s.access_token.clone());
    state.apply_backend_auth_token_to_stt(stt_token).await;

    // 4) Bump revisions + invalidations
    // auth-state только если поменялся флаг
    if prev_is_auth != next_is_auth {
        let rev_state = AppState::bump_revision(&state.auth_state_revision).await;
        emit_invalidation(
            &app_handle,
            "auth-state",
            rev_state,
            Some(window.label().to_string()),
        )
        .await;
    }

    // auth-session всегда: и login/logout, и refresh.
    let rev_session = AppState::bump_revision(&state.auth_session_revision).await;
    emit_invalidation(
        &app_handle,
        "auth-session",
        rev_session,
        Some(window.label().to_string()),
    )
    .await;

    // 5) Перезапускаем фоновый refresh
    state.restart_auth_refresh_task(app_handle.clone()).await;

    if !next_is_auth && !AppState::local_no_auth_mode() {
        let _ = crate::presentation::companion::disable_mode(&app_handle).await;
    } else if let Err(e) = crate::presentation::companion::publish_snapshot(&app_handle).await {
        log::debug!(
            "Failed to publish companion snapshot after set_auth_session: {}",
            e
        );
    }

    Ok(())
}

/// Обновляет флаг авторизации в backend (синхронизация из frontend)
#[tauri::command]
pub async fn set_authenticated(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    window: Window,
    authenticated: bool,
    token: Option<String>,
) -> Result<(), String> {
    log::info!(
        "Command: set_authenticated - authenticated: {}",
        authenticated
    );

    let current_auth = *state.is_authenticated.read().await;
    if current_auth == authenticated {
        // Токен мог обновиться — проверяем и обновляем тихо (без bump revision)
        if authenticated {
            if let Some(ref t) = token {
                let current_token = state
                    .transcription_service
                    .get_config()
                    .await
                    .backend_auth_token;
                if current_token.as_deref() != Some(t.as_str()) {
                    state.apply_backend_auth_token_to_stt(Some(t.clone())).await;
                }
            }
        }
        return Ok(());
    }

    *state.is_authenticated.write().await = authenticated;

    // Обновляем только токен в текущем in-memory STT конфиге, чтобы не перетирать keyterms
    // и другие поля конкурентным чтением старой disk-версии.
    if authenticated {
        if let Some(ref t) = token {
            log::info!("set_authenticated: received token with len: {}", t.len());
            state.apply_backend_auth_token_to_stt(Some(t.clone())).await;
            log::info!("Backend auth token saved to config");
        } else {
            log::warn!("set_authenticated: authenticated=true but token is None!");
            state.apply_backend_auth_token_to_stt(None).await;
        }
    } else {
        state.apply_backend_auth_token_to_stt(None).await;
        log::info!("Backend auth token cleared from config");
    }

    // Синхронизация между окнами через state-sync
    let revision = AppState::bump_revision(&state.auth_state_revision).await;
    let _ = app_handle.emit(
        EVENT_STATE_SYNC_INVALIDATION,
        crate::presentation::StateSyncInvalidationPayload {
            topic: "auth-state".to_string(),
            revision,
            source_id: Some(window.label().to_string()),
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
        },
    );

    if !authenticated && !AppState::local_no_auth_mode() {
        let _ = crate::presentation::companion::disable_mode(&app_handle).await;
    } else if let Err(e) = crate::presentation::companion::publish_snapshot(&app_handle).await {
        log::debug!(
            "Failed to publish companion snapshot after set_authenticated: {}",
            e
        );
    }

    Ok(())
}

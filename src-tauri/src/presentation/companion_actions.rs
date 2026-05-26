use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::MutexGuard;
use tokio::time::timeout;

use crate::domain::RecordingStatus;
use crate::presentation::{commands, companion, companion::CompanionSnapshotEnvelope, AppState};

const COMPANION_ACTION_LOCK_TIMEOUT_MS: u64 = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionActionResponse {
    pub ok: bool,
    pub action_result: String,
    pub snapshot: CompanionSnapshotEnvelope,
}

async fn current_snapshot(app_handle: &AppHandle) -> Result<CompanionSnapshotEnvelope, String> {
    companion::build_current_snapshot(app_handle).await
}

async fn busy_transition(app_handle: &AppHandle) -> Result<CompanionActionResponse, String> {
    Ok(CompanionActionResponse {
        ok: false,
        action_result: "busy_transition".to_string(),
        snapshot: current_snapshot(app_handle).await?,
    })
}

async fn rejected_auth(app_handle: &AppHandle) -> Result<CompanionActionResponse, String> {
    Ok(CompanionActionResponse {
        ok: false,
        action_result: "rejected_auth".to_string(),
        snapshot: current_snapshot(app_handle).await?,
    })
}

async fn noop(
    app_handle: &AppHandle,
    action_result: &str,
) -> Result<CompanionActionResponse, String> {
    Ok(CompanionActionResponse {
        ok: true,
        action_result: action_result.to_string(),
        snapshot: current_snapshot(app_handle).await?,
    })
}

async fn success(
    state: &AppState,
    app_handle: &AppHandle,
    action_result: &str,
) -> Result<CompanionActionResponse, String> {
    *state.companion_last_action.write().await = Some(action_result.to_string());
    Ok(CompanionActionResponse {
        ok: true,
        action_result: action_result.to_string(),
        snapshot: companion::publish_snapshot(app_handle).await?,
    })
}

async fn ok_with_current_snapshot(
    app_handle: &AppHandle,
    action_result: &str,
) -> Result<CompanionActionResponse, String> {
    Ok(CompanionActionResponse {
        ok: true,
        action_result: action_result.to_string(),
        snapshot: current_snapshot(app_handle).await?,
    })
}

async fn acquire_action_lock<'a>(state: &'a AppState) -> Option<MutexGuard<'a, ()>> {
    timeout(
        Duration::from_millis(COMPANION_ACTION_LOCK_TIMEOUT_MS),
        state.companion_action_lock.lock(),
    )
    .await
    .ok()
}

pub async fn ensure_recording_started(
    state: &AppState,
    app_handle: &AppHandle,
) -> Result<CompanionActionResponse, String> {
    let Some(_guard) = acquire_action_lock(state).await else {
        return busy_transition(app_handle).await;
    };

    if !*state.is_authenticated.read().await {
        return rejected_auth(app_handle).await;
    }

    match state.transcription_service.get_status().await {
        RecordingStatus::Idle | RecordingStatus::Error => {
            commands::start_recording_raw(state, app_handle.clone()).await?;
            success(state, app_handle, "started").await
        }
        RecordingStatus::Starting | RecordingStatus::Recording => noop(app_handle, "noop").await,
        RecordingStatus::Processing => busy_transition(app_handle).await,
    }
}

pub async fn ensure_recording_stopped(
    state: &AppState,
    app_handle: &AppHandle,
    stopped_via_hotkey: bool,
) -> Result<CompanionActionResponse, String> {
    let Some(_guard) = acquire_action_lock(state).await else {
        return busy_transition(app_handle).await;
    };

    if !*state.is_authenticated.read().await {
        return rejected_auth(app_handle).await;
    }

    match state.transcription_service.get_status().await {
        RecordingStatus::Starting => {
            commands::abort_starting_recording_raw(state, app_handle.clone(), stopped_via_hotkey)
                .await?;
            success(state, app_handle, "stopped").await
        }
        RecordingStatus::Recording => {
            commands::stop_recording_raw(state, app_handle.clone(), stopped_via_hotkey).await?;
            success(state, app_handle, "stopped").await
        }
        RecordingStatus::Idle | RecordingStatus::Error | RecordingStatus::Processing => {
            noop(app_handle, "noop").await
        }
    }
}

pub async fn ensure_microphone_muted(
    state: &AppState,
    app_handle: &AppHandle,
    muted: bool,
) -> Result<CompanionActionResponse, String> {
    let Some(_guard) = acquire_action_lock(state).await else {
        return busy_transition(app_handle).await;
    };

    if !*state.is_authenticated.read().await {
        return rejected_auth(app_handle).await;
    }

    let current = commands::get_effective_microphone_mute_state(state).await?;
    if current.muted == muted {
        return noop(app_handle, "noop").await;
    }

    commands::set_microphone_muted_raw(state, app_handle.clone(), muted).await?;
    success(state, app_handle, if muted { "muted" } else { "unmuted" }).await
}

pub async fn ensure_app_microphone_muted(
    state: &AppState,
    app_handle: &AppHandle,
    muted: bool,
) -> Result<CompanionActionResponse, String> {
    let Some(_guard) = acquire_action_lock(state).await else {
        return busy_transition(app_handle).await;
    };

    if !*state.is_authenticated.read().await {
        return rejected_auth(app_handle).await;
    }

    let current = commands::get_app_microphone_mute_state(state);
    if current.muted == muted {
        return noop(app_handle, "noop").await;
    }

    commands::set_app_microphone_muted_raw(state, app_handle.clone(), muted).await?;
    success(
        state,
        app_handle,
        if muted {
            "app_microphone_muted"
        } else {
            "app_microphone_unmuted"
        },
    )
    .await
}

pub async fn ensure_desktop_blackout(
    state: &AppState,
    app_handle: &AppHandle,
    enabled: bool,
) -> Result<CompanionActionResponse, String> {
    let Some(_guard) = acquire_action_lock(state).await else {
        return busy_transition(app_handle).await;
    };

    if !*state.is_authenticated.read().await {
        return rejected_auth(app_handle).await;
    }

    let previous = state
        .companion_desktop_blackout_enabled
        .swap(enabled, Ordering::Relaxed);
    if previous == enabled {
        return noop(app_handle, "noop").await;
    }

    success(
        state,
        app_handle,
        if enabled {
            "desktop_blackout_enabled"
        } else {
            "desktop_blackout_disabled"
        },
    )
    .await
}

pub async fn ensure_context_cleared(
    state: &AppState,
    app_handle: &AppHandle,
) -> Result<CompanionActionResponse, String> {
    let Some(_guard) = acquire_action_lock(state).await else {
        return busy_transition(app_handle).await;
    };

    if !*state.is_authenticated.read().await {
        return rejected_auth(app_handle).await;
    }

    let max_seq = companion::current_max_seq(state);
    let previous_floor = state.companion_context_floor_seq.load(Ordering::Relaxed);
    let settled_active_ai =
        crate::presentation::companion_timeline::settle_active_haiku_generation(state).await;
    if max_seq <= previous_floor && !settled_active_ai {
        return noop(app_handle, "noop").await;
    }

    state
        .companion_context_floor_seq
        .store(max_seq, Ordering::Relaxed);
    state
        .companion_conversation_generation
        .fetch_add(1, Ordering::Relaxed);
    crate::presentation::interview_memory_bridge::reset_session(state).await;

    success(state, app_handle, "cleared_context").await
}

pub async fn ensure_history_cleared(
    state: &AppState,
    app_handle: &AppHandle,
) -> Result<CompanionActionResponse, String> {
    let Some(_guard) = acquire_action_lock(state).await else {
        return busy_transition(app_handle).await;
    };

    if !*state.is_authenticated.read().await {
        return rejected_auth(app_handle).await;
    }

    let max_seq = companion::current_max_seq(state);
    let previous_history_floor = state.companion_history_floor_seq.load(Ordering::Relaxed);
    let previous_context_floor = state.companion_context_floor_seq.load(Ordering::Relaxed);
    let settled_active_ai =
        crate::presentation::companion_timeline::settle_active_haiku_generation(state).await;
    let has_live_system_text =
        crate::presentation::companion_timeline::has_system_live_text(state).await;
    let has_live_microphone_text = {
        let accumulated = state
            .companion_microphone_accumulated_text
            .read()
            .await
            .clone();
        let partial = state.companion_microphone_partial_text.read().await.clone();
        !accumulated.trim().is_empty() || !partial.trim().is_empty()
    };
    if max_seq <= previous_history_floor
        && max_seq <= previous_context_floor
        && !settled_active_ai
        && !has_live_system_text
        && !has_live_microphone_text
    {
        return noop(app_handle, "noop").await;
    }

    state
        .companion_history_floor_seq
        .store(max_seq, Ordering::Relaxed);
    state
        .companion_context_floor_seq
        .store(max_seq, Ordering::Relaxed);
    state
        .companion_conversation_generation
        .fetch_add(1, Ordering::Relaxed);
    crate::presentation::interview_memory_bridge::reset_session(state).await;
    crate::presentation::companion_timeline::clear_system_live_buffers(state).await;
    *state.final_transcription.write().await = None;
    crate::presentation::companion_timeline::clear_microphone_live_buffers(state).await;
    state
        .companion_microphone_dominant_until_ms
        .store(0, Ordering::Relaxed);
    state
        .companion_system_audio_level_bits
        .store(0.0f32.to_bits(), Ordering::Relaxed);
    state
        .companion_microphone_audio_level_bits
        .store(0.0f32.to_bits(), Ordering::Relaxed);

    success(state, app_handle, "cleared_history").await
}

pub async fn cancel_ai(
    state: &AppState,
    app_handle: &AppHandle,
) -> Result<CompanionActionResponse, String> {
    let changed =
        crate::presentation::companion_timeline::cancel_active_haiku_generation(state).await;
    if !changed {
        return noop(app_handle, "noop").await;
    }

    success(state, app_handle, "cancelled_ai").await
}

pub async fn request_ai(
    state: &AppState,
    app_handle: &AppHandle,
    question_text: Option<String>,
    openai_responses_web_search: Option<bool>,
    selected_message_ids: Option<Vec<String>>,
) -> Result<CompanionActionResponse, String> {
    let Some(_guard) = acquire_action_lock(state).await else {
        return busy_transition(app_handle).await;
    };

    if !*state.is_authenticated.read().await {
        return rejected_auth(app_handle).await;
    }

    let command_state = app_handle
        .try_state::<AppState>()
        .ok_or_else(|| "AppState не доступен".to_string())?;
    let system_prompt = {
        let prompt = state.companion_system_prompt.read().await.clone();
        let trimmed = prompt.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    };
    let created_at_ms = crate::presentation::companion_timeline::now_ms();
    let question = question_text.unwrap_or_default().trim().to_string();
    let selected_message_ids = selected_message_ids.unwrap_or_default();
    let selected_message_ids = (!selected_message_ids.is_empty()).then_some(selected_message_ids);

    if question.is_empty() {
        let (context_text, memory_context_evidence) =
            build_request_context(state, selected_message_ids.as_deref()).await;
        if context_text.trim().is_empty() {
            return noop(app_handle, "noop").await;
        }
        let insert_after_id =
            crate::presentation::companion_timeline::resolve_insert_after_id(state).await;
        commands::start_haiku_stream(
            command_state,
            app_handle.clone(),
            context_text,
            system_prompt,
            Some(commands::CompanionAiRequestMeta {
                insert_after_id,
                created_at_ms: Some(created_at_ms),
                prompt_message_id: None,
                prompt_created_at_ms: None,
            }),
            openai_responses_web_search,
            Some(memory_context_evidence),
        )
        .await?;
    } else {
        let (context_text, memory_context_evidence) =
            build_request_context(state, selected_message_ids.as_deref()).await;
        let prompt_message_id = format!("prompt:{}", uuid::Uuid::new_v4());
        commands::start_haiku_chat_stream(
            command_state,
            app_handle.clone(),
            context_text,
            question,
            Some(Vec::new()),
            system_prompt,
            Some(commands::CompanionAiRequestMeta {
                insert_after_id: Some(prompt_message_id.clone()),
                created_at_ms: Some(created_at_ms),
                prompt_message_id: Some(prompt_message_id),
                prompt_created_at_ms: Some(created_at_ms),
            }),
            openai_responses_web_search,
            Some(memory_context_evidence),
        )
        .await?;
    }

    ok_with_current_snapshot(app_handle, "started_ai").await
}

pub async fn send_prompt(
    state: &AppState,
    app_handle: &AppHandle,
    text: String,
    images: Vec<commands::LlmImageInput>,
    openai_responses_web_search: Option<bool>,
    selected_message_ids: Option<Vec<String>>,
) -> Result<CompanionActionResponse, String> {
    let Some(_guard) = acquire_action_lock(state).await else {
        return busy_transition(app_handle).await;
    };

    if !*state.is_authenticated.read().await {
        return rejected_auth(app_handle).await;
    }

    let command_state = app_handle
        .try_state::<AppState>()
        .ok_or_else(|| "AppState не доступен".to_string())?;
    let prompt_text = text.trim().to_string();
    let prompt_images = images
        .into_iter()
        .filter(|image| {
            let mime = image.media_type.trim();
            let data = image.data_base64.trim();
            mime.starts_with("image/") && !data.is_empty()
        })
        .collect::<Vec<_>>();

    if prompt_text.is_empty() && prompt_images.is_empty() {
        return noop(app_handle, "noop").await;
    }

    let system_prompt = {
        let prompt = state.companion_system_prompt.read().await.clone();
        let trimmed = prompt.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    };
    let created_at_ms = crate::presentation::companion_timeline::now_ms();
    let selected_message_ids = selected_message_ids.unwrap_or_default();
    let selected_message_ids = (!selected_message_ids.is_empty()).then_some(selected_message_ids);
    let (context_text, memory_context_evidence) =
        build_request_context(state, selected_message_ids.as_deref()).await;
    let prompt_message_id = format!("prompt:{}", uuid::Uuid::new_v4());

    commands::start_haiku_chat_stream(
        command_state,
        app_handle.clone(),
        context_text,
        prompt_text,
        Some(prompt_images),
        system_prompt,
        Some(commands::CompanionAiRequestMeta {
            insert_after_id: Some(prompt_message_id.clone()),
            created_at_ms: Some(created_at_ms),
            prompt_message_id: Some(prompt_message_id),
            prompt_created_at_ms: Some(created_at_ms),
        }),
        openai_responses_web_search,
        Some(memory_context_evidence),
    )
    .await?;

    ok_with_current_snapshot(app_handle, "started_prompt").await
}

async fn build_request_context(
    state: &AppState,
    selected_message_ids: Option<&[String]>,
) -> (
    String,
    crate::presentation::interview_memory_bridge::MemoryContextEvidenceInput,
) {
    if let Some(ids) = selected_message_ids {
        return crate::presentation::companion_timeline::build_selected_context_text_and_memory_evidence(
            state, ids,
        )
        .await;
    }

    crate::presentation::companion_timeline::build_context_text_and_memory_evidence(state, false)
        .await
}

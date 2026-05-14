use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::RecordingStatus;
use crate::presentation::companion::{CompanionAttachment, CompanionMessage, LIVE_STT_MESSAGE_ID};
use crate::presentation::events::{FinalTranscriptionPayload, PartialTranscriptionPayload};
use crate::presentation::AppState;

const CROSS_STREAM_DEDUP_WINDOW_MS: i64 = 8_000;
const CROSS_STREAM_DEDUP_RECENT_LIMIT: usize = 6;
const MIC_DOMINANCE_HOLD_MS: u64 = 1_200;
const MIC_SYSTEM_LOOKBACK_MS: i64 = 20_000;

#[derive(Debug, Clone, Default)]
pub struct CompanionPromptDraft {
    pub id: String,
    pub text: String,
    pub created_at_ms: i64,
    pub attachments: Vec<CompanionAttachment>,
}

#[derive(Debug, Clone, Default)]
pub struct CompanionHaikuStart {
    pub request_id: String,
    pub insert_after_id: Option<String>,
    pub created_at_ms: i64,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn next_seq(state: &AppState) -> u64 {
    state.companion_next_seq.fetch_add(1, Ordering::Relaxed) + 1
}

async fn max_items(state: &AppState) -> usize {
    state.config.read().await.max_history_items
}

async fn prune_timeline(state: &AppState) {
    let max_items = max_items(state).await;
    let mut timeline = state.companion_timeline.write().await;
    let len = timeline.len();
    if len > max_items {
        timeline.drain(0..len - max_items);
    }
}

pub async fn reset_session_state(state: &AppState) {
    state.companion_next_seq.store(0, Ordering::Relaxed);
    state.companion_next_stt_index.store(0, Ordering::Relaxed);
    state
        .companion_history_floor_seq
        .store(0, Ordering::Relaxed);
    state
        .companion_context_floor_seq
        .store(0, Ordering::Relaxed);
    state
        .companion_conversation_generation
        .store(0, Ordering::Relaxed);
    state
        .companion_live_system_started_at_ms
        .store(0, Ordering::Relaxed);
    state
        .companion_live_microphone_started_at_ms
        .store(0, Ordering::Relaxed);
    state
        .companion_microphone_dominant_until_ms
        .store(0, Ordering::Relaxed);
    state
        .companion_system_audio_level_bits
        .store(0.0f32.to_bits(), Ordering::Relaxed);
    state
        .companion_microphone_audio_level_bits
        .store(0.0f32.to_bits(), Ordering::Relaxed);
    *state.companion_last_action.write().await = None;
    *state.companion_microphone_partial_text.write().await = String::new();
    *state.companion_microphone_accumulated_text.write().await = String::new();
    *state
        .companion_microphone_current_utterance_start
        .write()
        .await = None;
    *state.companion_microphone_last_finalized_text.write().await = String::new();
    state.companion_request_generations.write().await.clear();
    state.companion_timeline.write().await.clear();
}

pub async fn clear_microphone_live_buffers(state: &AppState) {
    *state.companion_microphone_partial_text.write().await = String::new();
    *state.companion_microphone_accumulated_text.write().await = String::new();
    *state
        .companion_microphone_current_utterance_start
        .write()
        .await = None;
    *state.companion_microphone_last_finalized_text.write().await = String::new();
    state
        .companion_live_microphone_started_at_ms
        .store(0, Ordering::Relaxed);
}

pub fn update_system_audio_level(state: &AppState, level: f32) {
    state
        .companion_system_audio_level_bits
        .store(level.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    update_mic_dominance(state);
}

pub fn update_microphone_audio_level(state: &AppState, level: f32) {
    state
        .companion_microphone_audio_level_bits
        .store(level.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    update_mic_dominance(state);
}

fn update_mic_dominance(state: &AppState) {
    let mic = f32::from_bits(
        state
            .companion_microphone_audio_level_bits
            .load(Ordering::Relaxed),
    )
    .clamp(0.0, 1.0);
    let sys = f32::from_bits(
        state
            .companion_system_audio_level_bits
            .load(Ordering::Relaxed),
    )
    .clamp(0.0, 1.0);

    if mic < 0.08 {
        return;
    }

    let dominant = if sys < 0.02 {
        mic >= 0.10
    } else {
        mic >= sys * 1.8 || mic >= sys + 0.12
    };

    if dominant {
        let until = now_ms().max(0) as u64 + MIC_DOMINANCE_HOLD_MS;
        state
            .companion_microphone_dominant_until_ms
            .store(until, Ordering::Relaxed);
    }
}

pub fn is_mic_dominant_now(state: &AppState, now: i64) -> bool {
    state
        .companion_microphone_dominant_until_ms
        .load(Ordering::Relaxed)
        > now.max(0) as u64
}

async fn live_mic_text(state: &AppState) -> String {
    let accumulated = state
        .companion_microphone_accumulated_text
        .read()
        .await
        .clone();
    let partial = state.companion_microphone_partial_text.read().await.clone();
    [accumulated, partial]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn normalize_for_dedup(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch.is_whitespace() {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn jaccard(a: &str, b: &str) -> f32 {
    let a_tokens = normalize_for_dedup(a)
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .map(|token| token.to_string())
        .collect::<std::collections::BTreeSet<_>>();
    let b_tokens = normalize_for_dedup(b)
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .map(|token| token.to_string())
        .collect::<std::collections::BTreeSet<_>>();

    if a_tokens.is_empty() || b_tokens.is_empty() {
        return 0.0;
    }

    let inter = a_tokens.intersection(&b_tokens).count() as f32;
    let union = a_tokens.union(&b_tokens).count() as f32;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

fn is_near_duplicate_text(a: &str, b: &str) -> bool {
    let normalized_a = normalize_for_dedup(a);
    let normalized_b = normalize_for_dedup(b);
    if normalized_a.is_empty() || normalized_b.is_empty() {
        return false;
    }
    if normalized_a == normalized_b {
        return true;
    }
    let min_len = normalized_a.len().min(normalized_b.len());
    let max_len = normalized_a.len().max(normalized_b.len());
    if min_len >= 10
        && (normalized_a.contains(&normalized_b) || normalized_b.contains(&normalized_a))
        && (min_len as f32 / max_len as f32) >= 0.85
    {
        return true;
    }
    jaccard(&normalized_a, &normalized_b) >= 0.9
}

async fn is_system_text_duplicate_of_mic(
    state: &AppState,
    text: &str,
    system_timestamp_ms: i64,
) -> bool {
    let candidate = text.trim();
    if candidate.is_empty() {
        return false;
    }

    let timeline = state.companion_timeline.read().await;
    let mut recent_checked = 0usize;
    for message in timeline.iter().rev() {
        if message.kind != "mic" || message.status != "final" {
            continue;
        }
        recent_checked += 1;
        if recent_checked > CROSS_STREAM_DEDUP_RECENT_LIMIT {
            break;
        }
        if (system_timestamp_ms - message.created_at_ms).abs() > CROSS_STREAM_DEDUP_WINDOW_MS {
            continue;
        }
        if is_near_duplicate_text(candidate, &message.text) {
            return true;
        }
    }
    drop(timeline);

    let live_mic = live_mic_text(state).await;
    if !live_mic.is_empty()
        && (now_ms() - system_timestamp_ms).abs() <= 2_500
        && is_mic_dominant_now(state, now_ms())
        && is_near_duplicate_text(candidate, &live_mic)
    {
        return true;
    }

    false
}

async fn is_mic_text_duplicate_of_system(state: &AppState, text: &str, now: i64) -> bool {
    let candidate = text.trim();
    if candidate.is_empty() {
        return false;
    }

    let timeline = state.companion_timeline.read().await;
    let mut recent_checked = 0usize;
    for message in timeline.iter().rev() {
        if message.kind != "stt" || message.status != "final" {
            continue;
        }
        recent_checked += 1;
        if recent_checked > 6 {
            break;
        }
        if now - message.created_at_ms > MIC_SYSTEM_LOOKBACK_MS {
            continue;
        }
        if is_near_duplicate_text(candidate, &message.text) {
            return true;
        }
    }
    drop(timeline);

    let sys_live = state
        .partial_transcription
        .read()
        .await
        .clone()
        .unwrap_or_default();
    !sys_live.trim().is_empty() && is_near_duplicate_text(candidate, &sys_live)
}

pub async fn visible_system_partial_text(state: &AppState) -> Option<String> {
    let text = state
        .partial_transcription
        .read()
        .await
        .clone()
        .unwrap_or_default();
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    if is_system_text_duplicate_of_mic(state, &trimmed, now_ms()).await {
        return None;
    }
    Some(trimmed)
}

pub async fn visible_microphone_partial_text(state: &AppState) -> Option<String> {
    let text = live_mic_text(state).await;
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed)
}

pub async fn append_system_final(
    state: &AppState,
    session_id: u64,
    transcription: &crate::domain::Transcription,
) {
    if is_system_text_duplicate_of_mic(state, &transcription.text, transcription.timestamp).await {
        return;
    }

    let seq = next_seq(state);
    let stt_index = state
        .companion_next_stt_index
        .fetch_add(1, Ordering::Relaxed);
    let generation = state
        .companion_conversation_generation
        .load(Ordering::Relaxed);
    let message_id = format!("stt:{}:{}", session_id, seq);

    let mut timeline = state.companion_timeline.write().await;
    timeline.push(CompanionMessage {
        id: message_id.clone(),
        seq,
        kind: "stt".to_string(),
        role: "incoming".to_string(),
        status: "final".to_string(),
        text: transcription.text.clone(),
        created_at_ms: transcription.timestamp,
        session_id: Some(session_id),
        request_id: None,
        generation: Some(generation),
        insert_after_id: None,
        stt_index: Some(stt_index),
        deleted: false,
        attachments: None,
    });

    for item in timeline.iter_mut() {
        if item.kind == "haiku" && item.insert_after_id.as_deref() == Some(LIVE_STT_MESSAGE_ID) {
            item.insert_after_id = Some(message_id.clone());
        }
    }
    drop(timeline);

    prune_timeline(state).await;
    state
        .companion_live_system_started_at_ms
        .store(0, Ordering::Relaxed);
}

pub async fn append_focus_copy_system_final(
    state: &AppState,
    text: String,
    created_at_ms: i64,
    source_id: Option<String>,
) -> Option<String> {
    if text.trim().is_empty() {
        return None;
    }

    let seq = next_seq(state);
    let stt_index = state
        .companion_next_stt_index
        .fetch_add(1, Ordering::Relaxed);
    let generation = state
        .companion_conversation_generation
        .load(Ordering::Relaxed);
    let message_id = source_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| format!("focus-copy:{}:{}", created_at_ms, seq));

    let mut timeline = state.companion_timeline.write().await;
    timeline.push(CompanionMessage {
        id: message_id.clone(),
        seq,
        kind: "stt".to_string(),
        role: "incoming".to_string(),
        status: "final".to_string(),
        text,
        created_at_ms,
        session_id: None,
        request_id: None,
        generation: Some(generation),
        insert_after_id: None,
        stt_index: Some(stt_index),
        deleted: false,
        attachments: None,
    });

    for item in timeline.iter_mut() {
        if item.kind == "haiku" && item.insert_after_id.as_deref() == Some(LIVE_STT_MESSAGE_ID) {
            item.insert_after_id = Some(message_id.clone());
        }
    }
    drop(timeline);

    prune_timeline(state).await;
    state
        .companion_live_system_started_at_ms
        .store(0, Ordering::Relaxed);

    Some(message_id)
}

pub async fn append_prompt_message(state: &AppState, prompt: CompanionPromptDraft) {
    if prompt.id.trim().is_empty() {
        return;
    }

    let generation = state
        .companion_conversation_generation
        .load(Ordering::Relaxed);
    let seq = next_seq(state);
    state
        .companion_timeline
        .write()
        .await
        .push(CompanionMessage {
            id: prompt.id,
            seq,
            kind: "prompt".to_string(),
            role: "outgoing".to_string(),
            status: "final".to_string(),
            text: prompt.text,
            created_at_ms: prompt.created_at_ms,
            session_id: None,
            request_id: None,
            generation: Some(generation),
            insert_after_id: None,
            stt_index: None,
            deleted: false,
            attachments: (!prompt.attachments.is_empty()).then_some(prompt.attachments),
        });
    prune_timeline(state).await;
}

pub async fn begin_haiku_message(state: &AppState, request: CompanionHaikuStart) {
    let generation = state
        .companion_conversation_generation
        .load(Ordering::Relaxed);
    state
        .companion_request_generations
        .write()
        .await
        .insert(request.request_id.clone(), generation);

    let seq = next_seq(state);
    state
        .companion_timeline
        .write()
        .await
        .push(CompanionMessage {
            id: request.request_id.clone(),
            seq,
            kind: "haiku".to_string(),
            role: "outgoing".to_string(),
            status: "streaming".to_string(),
            text: String::new(),
            created_at_ms: request.created_at_ms,
            session_id: None,
            request_id: Some(request.request_id),
            generation: Some(generation),
            insert_after_id: request.insert_after_id,
            stt_index: None,
            deleted: false,
            attachments: None,
        });
    prune_timeline(state).await;
}

pub async fn settle_active_haiku_generation(state: &AppState) -> bool {
    let current_generation = state
        .companion_conversation_generation
        .load(Ordering::Relaxed);
    let mut settled_request_ids = Vec::new();
    let mut changed = false;

    {
        let mut timeline = state.companion_timeline.write().await;
        for message in timeline.iter_mut() {
            if message.kind != "haiku"
                || message.status != "streaming"
                || message.generation != Some(current_generation)
            {
                continue;
            }

            settled_request_ids.push(message.id.clone());
            message.status = "final".to_string();
            if message.text.trim().is_empty() {
                message.deleted = true;
            }
            changed = true;
        }
    }

    if settled_request_ids.is_empty() {
        return changed;
    }

    state
        .companion_request_generations
        .write()
        .await
        .retain(|request_id, generation| {
            *generation != current_generation
                || !settled_request_ids.iter().any(|id| id == request_id)
        });

    true
}

pub async fn append_haiku_delta(state: &AppState, request_id: &str, delta: &str) {
    if request_id.trim().is_empty() || delta.is_empty() {
        return;
    }

    let current_generation = state
        .companion_conversation_generation
        .load(Ordering::Relaxed);
    let mut timeline = state.companion_timeline.write().await;
    if let Some(message) = timeline.iter_mut().find(|item| item.id == request_id) {
        if message.generation != Some(current_generation) {
            return;
        }
        message.status = "streaming".to_string();
        message.text.push_str(delta);
    }
}

pub async fn finalize_haiku_message(state: &AppState, request_id: &str) {
    if request_id.trim().is_empty() {
        return;
    }

    let current_generation = state
        .companion_conversation_generation
        .load(Ordering::Relaxed);
    if state
        .companion_request_generations
        .read()
        .await
        .get(request_id)
        .copied()
        != Some(current_generation)
    {
        return;
    }

    if let Some(message) = state
        .companion_timeline
        .write()
        .await
        .iter_mut()
        .find(|item| item.id == request_id)
    {
        message.status = "final".to_string();
    }
    state
        .companion_request_generations
        .write()
        .await
        .remove(request_id);
}

pub async fn fail_haiku_message(state: &AppState, request_id: &str, error: &str) {
    if request_id.trim().is_empty() {
        return;
    }

    let current_generation = state
        .companion_conversation_generation
        .load(Ordering::Relaxed);
    if state
        .companion_request_generations
        .read()
        .await
        .get(request_id)
        .copied()
        != Some(current_generation)
    {
        return;
    }

    if let Some(message) = state
        .companion_timeline
        .write()
        .await
        .iter_mut()
        .find(|item| item.id == request_id)
    {
        message.status = "error".to_string();
        if message.text.trim().is_empty() {
            message.text = format!("Ошибка: {}", error.trim());
        }
    }
    state
        .companion_request_generations
        .write()
        .await
        .remove(request_id);
}

pub async fn on_microphone_partial(state: &AppState, payload: &PartialTranscriptionPayload) {
    if !state
        .microphone_transcription_enabled
        .load(Ordering::Relaxed)
    {
        clear_microphone_live_buffers(state).await;
        return;
    }

    let status = state.transcription_service.get_status().await;
    if !matches!(
        status,
        RecordingStatus::Starting | RecordingStatus::Recording | RecordingStatus::Processing
    ) {
        return;
    }

    let now = now_ms();
    if !is_mic_dominant_now(state, now) {
        clear_microphone_live_buffers(state).await;
        return;
    }

    if payload.is_segment_final {
        let new_text = payload.text.trim().to_string();
        if new_text.is_empty() {
            return;
        }
        if *state.companion_microphone_last_finalized_text.read().await == new_text {
            return;
        }
        if is_mic_text_duplicate_of_system(state, &new_text, now).await {
            clear_microphone_live_buffers(state).await;
            return;
        }

        let mut accumulated = state.companion_microphone_accumulated_text.write().await;
        if accumulated.trim().is_empty() {
            *accumulated = new_text.clone();
        } else {
            *accumulated = format!("{} {}", accumulated.trim(), new_text)
                .trim()
                .to_string();
        }
        drop(accumulated);

        *state.companion_microphone_last_finalized_text.write().await = new_text;
        *state.companion_microphone_partial_text.write().await = String::new();
        return;
    }

    let utterance_start = payload.start;
    let current_start = *state
        .companion_microphone_current_utterance_start
        .read()
        .await;

    if current_start.is_none() || current_start == Some(utterance_start) {
        *state
            .companion_microphone_current_utterance_start
            .write()
            .await = Some(utterance_start);
        let partial = payload.text.trim().to_string();
        if !partial.is_empty() && is_mic_text_duplicate_of_system(state, &partial, now).await {
            clear_microphone_live_buffers(state).await;
            return;
        }
        if !partial.is_empty()
            && state
                .companion_live_microphone_started_at_ms
                .load(Ordering::Relaxed)
                == 0
        {
            state
                .companion_live_microphone_started_at_ms
                .store(now.max(0) as u64, Ordering::Relaxed);
        }
        *state.companion_microphone_partial_text.write().await = partial;
        return;
    }

    let accumulated = state
        .companion_microphone_accumulated_text
        .read()
        .await
        .clone();
    if !accumulated.trim().is_empty() {
        append_microphone_message(state, payload.session_id, &accumulated, payload.timestamp).await;
    }

    *state.companion_microphone_accumulated_text.write().await = String::new();
    *state.companion_microphone_last_finalized_text.write().await = String::new();
    *state
        .companion_microphone_current_utterance_start
        .write()
        .await = Some(utterance_start);
    *state.companion_microphone_partial_text.write().await = payload.text.trim().to_string();
    if !payload.text.trim().is_empty()
        && state
            .companion_live_microphone_started_at_ms
            .load(Ordering::Relaxed)
            == 0
    {
        state
            .companion_live_microphone_started_at_ms
            .store(now.max(0) as u64, Ordering::Relaxed);
    }
}

async fn append_microphone_message(
    state: &AppState,
    session_id: u64,
    utterance_text: &str,
    created_at_ms: i64,
) {
    let text = utterance_text.trim();
    if text.is_empty() {
        return;
    }
    if is_mic_text_duplicate_of_system(state, text, now_ms()).await {
        return;
    }

    let generation = state
        .companion_conversation_generation
        .load(Ordering::Relaxed);
    let seq = next_seq(state);
    state
        .companion_timeline
        .write()
        .await
        .push(CompanionMessage {
            id: format!("mic:{}:{}", session_id, seq),
            seq,
            kind: "mic".to_string(),
            role: "outgoing".to_string(),
            status: "final".to_string(),
            text: text.to_string(),
            created_at_ms,
            session_id: Some(session_id),
            request_id: None,
            generation: Some(generation),
            insert_after_id: None,
            stt_index: None,
            deleted: false,
            attachments: None,
        });
    prune_timeline(state).await;
}

pub async fn on_microphone_final(state: &AppState, payload: &FinalTranscriptionPayload) {
    if !state
        .microphone_transcription_enabled
        .load(Ordering::Relaxed)
    {
        clear_microphone_live_buffers(state).await;
        return;
    }

    let status = state.transcription_service.get_status().await;
    if !matches!(
        status,
        RecordingStatus::Starting | RecordingStatus::Recording | RecordingStatus::Processing
    ) {
        return;
    }

    if !is_mic_dominant_now(state, now_ms()) {
        clear_microphone_live_buffers(state).await;
        return;
    }

    let accumulated = state
        .companion_microphone_accumulated_text
        .read()
        .await
        .clone();
    let partial = state.companion_microphone_partial_text.read().await.clone();
    let utterance_text = [accumulated, payload.text.clone(), partial]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    if !utterance_text.is_empty() {
        append_microphone_message(
            state,
            payload.session_id,
            &utterance_text,
            payload.timestamp,
        )
        .await;
    }
    clear_microphone_live_buffers(state).await;
}

pub async fn build_context_text(state: &AppState, include_full_history: bool) -> String {
    let context_floor_seq = state.companion_context_floor_seq.load(Ordering::Relaxed);
    let live_system = visible_system_partial_text(state).await;
    let live_mic = visible_microphone_partial_text(state).await;

    let mut parts: Vec<String> = Vec::new();
    for message in state.companion_timeline.read().await.iter() {
        if message.deleted {
            continue;
        }
        if message.kind == "haiku" && message.status != "final" {
            continue;
        }
        if !include_full_history && message.seq <= context_floor_seq {
            continue;
        }
        let line = format_context_line(message.kind.as_str(), &message.text);
        if !line.is_empty() {
            parts.push(line);
        }
    }

    if let Some(text) = live_system {
        parts.push(format!("ОС: {}", text));
    }
    if let Some(text) = live_mic {
        parts.push(format!("МИКРОФОН: {}", text));
    }

    let mut text = parts.join("\n").trim().to_string();
    if text.len() > 12_000 {
        text = text[text.len() - 12_000..].to_string();
    }
    text
}

fn format_context_line(kind: &str, text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    match kind {
        "stt" => format!("ОС: {}", trimmed),
        "mic" => format!("МИКРОФОН: {}", trimmed),
        "prompt" => format!("ЗАПРОС: {}", trimmed),
        "haiku" => format!("ПОМОЩНИК: {}", trimmed),
        _ => trimmed.to_string(),
    }
}

pub async fn resolve_insert_after_id(state: &AppState) -> Option<String> {
    if visible_system_partial_text(state).await.is_some() {
        return Some(LIVE_STT_MESSAGE_ID.to_string());
    }

    let mut last_base_id: Option<String> = None;
    for message in state.companion_timeline.read().await.iter() {
        if message.deleted || message.kind == "haiku" {
            continue;
        }
        last_base_id = Some(message.id.clone());
    }
    last_base_id
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Transcription;
    use crate::presentation::AppState;

    fn test_transcription(text: &str, timestamp: i64) -> Transcription {
        Transcription {
            text: text.to_string(),
            is_final: true,
            confidence: None,
            language: None,
            timestamp,
            start: 0.0,
            duration: 0.0,
        }
    }

    #[tokio::test]
    async fn system_final_reanchors_live_haiku_insert_after_id() {
        let state = AppState::default();

        begin_haiku_message(
            &state,
            CompanionHaikuStart {
                request_id: "haiku:req-1".to_string(),
                insert_after_id: Some(LIVE_STT_MESSAGE_ID.to_string()),
                created_at_ms: 100,
            },
        )
        .await;

        append_system_final(&state, 7, &test_transcription("question", 101)).await;

        let timeline = state.companion_timeline.read().await;
        let stt = timeline
            .iter()
            .find(|message| message.kind == "stt")
            .expect("stt message");
        let haiku = timeline
            .iter()
            .find(|message| message.id == "haiku:req-1")
            .expect("haiku message");

        assert_eq!(haiku.insert_after_id.as_deref(), Some(stt.id.as_str()));
    }

    #[tokio::test]
    async fn focus_copy_system_final_is_incoming_stt_without_session() {
        let state = AppState::default();

        let message_id = append_focus_copy_system_final(
            &state,
            "void main() {\n  print('hi');\n}".to_string(),
            123,
            Some("focus-copy:test".to_string()),
        )
        .await
        .expect("focus copy message id");

        let timeline = state.companion_timeline.read().await;
        let message = timeline
            .iter()
            .find(|message| message.id == message_id)
            .expect("focus copy message");

        assert_eq!(message.kind, "stt");
        assert_eq!(message.role, "incoming");
        assert_eq!(message.status, "final");
        assert_eq!(message.session_id, None);
        assert_eq!(message.text, "void main() {\n  print('hi');\n}");
    }

    #[tokio::test]
    async fn build_context_text_respects_context_floor_and_live_entries() {
        let state = AppState::default();

        append_system_final(&state, 1, &test_transcription("старый вопрос", 100)).await;
        append_system_final(&state, 1, &test_transcription("новый вопрос", 200)).await;
        append_prompt_message(
            &state,
            CompanionPromptDraft {
                id: "prompt:1".to_string(),
                text: "уточни".to_string(),
                created_at_ms: 250,
                attachments: Vec::new(),
            },
        )
        .await;
        begin_haiku_message(
            &state,
            CompanionHaikuStart {
                request_id: "haiku:req-2".to_string(),
                insert_after_id: Some("prompt:1".to_string()),
                created_at_ms: 260,
            },
        )
        .await;
        append_haiku_delta(&state, "haiku:req-2", "ответ").await;
        finalize_haiku_message(&state, "haiku:req-2").await;

        state
            .companion_context_floor_seq
            .store(1, Ordering::Relaxed);
        *state.partial_transcription.write().await = Some("live follow-up".to_string());
        state
            .companion_live_system_started_at_ms
            .store(999, Ordering::Relaxed);

        let context = build_context_text(&state, false).await;

        assert!(!context.contains("старый вопрос"));
        assert!(context.contains("ОС: новый вопрос"));
        assert!(context.contains("ЗАПРОС: уточни"));
        assert!(context.contains("ПОМОЩНИК: ответ"));
        assert!(context.contains("ОС: live follow-up"));
    }

    #[tokio::test]
    async fn settling_active_generation_prevents_late_ai_deltas_after_clear() {
        let state = AppState::default();

        begin_haiku_message(
            &state,
            CompanionHaikuStart {
                request_id: "haiku:req-3".to_string(),
                insert_after_id: None,
                created_at_ms: 300,
            },
        )
        .await;
        append_haiku_delta(&state, "haiku:req-3", "partial answer").await;

        let settled = settle_active_haiku_generation(&state).await;
        assert!(settled);

        state
            .companion_conversation_generation
            .fetch_add(1, Ordering::Relaxed);

        append_haiku_delta(&state, "haiku:req-3", " late delta").await;
        finalize_haiku_message(&state, "haiku:req-3").await;

        let timeline = state.companion_timeline.read().await;
        let haiku = timeline
            .iter()
            .find(|message| message.id == "haiku:req-3")
            .expect("haiku message");

        assert_eq!(haiku.status, "final");
        assert_eq!(haiku.text, "partial answer");
        assert!(!haiku.deleted);
        assert!(!state
            .companion_request_generations
            .read()
            .await
            .contains_key("haiku:req-3"));
    }
}

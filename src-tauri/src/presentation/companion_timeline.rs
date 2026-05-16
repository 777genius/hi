use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::RecordingStatus;
use crate::presentation::companion::{
    CompanionAttachment, CompanionLlmCandidate, CompanionMessage, LIVE_STT_MESSAGE_ID,
};
use crate::presentation::events::{FinalTranscriptionPayload, PartialTranscriptionPayload};
use crate::presentation::interview_memory_bridge::{
    MemoryContextEvidenceInput, MemoryRequestEvidenceInput,
};
use crate::presentation::AppState;

const CROSS_STREAM_DEDUP_WINDOW_MS: i64 = 8_000;
const CROSS_STREAM_DEDUP_RECENT_LIMIT: usize = 6;
const MIC_DOMINANCE_HOLD_MS: u64 = 1_200;
const MIC_SYSTEM_LOOKBACK_MS: i64 = 20_000;
const MAX_CONTEXT_CHARS: usize = 48_000;
const MAX_CONTEXT_ANCHOR_CHARS: usize = 4_000;
const RECENT_CONTEXT_CHARS: usize = 32_000;
const MAX_PRUNED_IMPORTANT_OLD_MESSAGES: usize = 40;

#[derive(Debug, Clone)]
struct ContextPart {
    id: String,
    kind: String,
    line: String,
}

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
    pub candidates: Vec<CompanionLlmCandidate>,
    pub active_candidate_id: Option<String>,
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
    let max_items = max_items(state).await.max(1);
    let mut timeline = state.companion_timeline.write().await;
    let len = timeline.len();
    if len <= max_items {
        return;
    }

    let important_old_limit = MAX_PRUNED_IMPORTANT_OLD_MESSAGES.min(max_items / 5).max(1);
    let recent_reserve = max_items.saturating_sub(important_old_limit).max(1);
    let old_candidate_end = len.saturating_sub(recent_reserve);
    let protected_old_indexes =
        select_pruned_important_old_indexes(&timeline[..old_candidate_end], important_old_limit);
    let tail_keep_count = max_items.saturating_sub(protected_old_indexes.len());
    let recent_start = len.saturating_sub(tail_keep_count);

    let kept = timeline
        .iter()
        .enumerate()
        .filter(|(idx, _)| *idx >= recent_start || protected_old_indexes.contains(idx))
        .map(|(_, message)| message.clone())
        .collect::<Vec<_>>();
    *timeline = kept;
}

pub async fn clear_system_live_buffers(state: &AppState) {
    *state.partial_transcription.write().await = None;
    *state.companion_system_accumulated_text.write().await = String::new();
    *state.companion_system_current_utterance_start.write().await = None;
    *state.companion_system_last_finalized_text.write().await = String::new();
    state
        .companion_live_system_started_at_ms
        .store(0, Ordering::Relaxed);
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

pub async fn finalize_or_clear_system_live_on_stop(
    state: &AppState,
    session_id: u64,
) -> Option<crate::domain::Transcription> {
    let text = state.companion_system_accumulated_text.read().await.clone();
    let text = text.trim().to_string();

    if session_id == 0 || text.is_empty() {
        clear_system_live_buffers(state).await;
        return None;
    }

    let started_at = state
        .companion_live_system_started_at_ms
        .load(Ordering::Relaxed);
    let timestamp = if started_at > 0 {
        started_at as i64
    } else {
        now_ms()
    };

    let mut transcription = crate::domain::Transcription::final_result(text);
    transcription.timestamp = timestamp;
    append_system_final(state, session_id, &transcription).await;
    clear_system_live_buffers(state).await;
    Some(transcription)
}

pub async fn finalize_or_clear_microphone_live_on_stop(
    state: &AppState,
    session_id: u64,
) -> Option<String> {
    let text = state
        .companion_microphone_accumulated_text
        .read()
        .await
        .clone();
    let text = text.trim().to_string();

    if session_id == 0 || text.is_empty() {
        clear_microphone_live_buffers(state).await;
        return None;
    }

    let started_at = state
        .companion_live_microphone_started_at_ms
        .load(Ordering::Relaxed);
    let timestamp = if started_at > 0 {
        started_at as i64
    } else {
        now_ms()
    };

    append_microphone_message(state, session_id, &text, timestamp).await;
    clear_microphone_live_buffers(state).await;
    Some(text)
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
    merge_transcript_text(&accumulated, &partial)
        .trim()
        .to_string()
}

fn normalize_spaces(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_merge_word(word: &str) -> String {
    word.to_lowercase()
        .chars()
        .filter(|ch| ch.is_alphanumeric() || *ch == '+' || *ch == '#')
        .collect::<String>()
}

fn tokenize_for_merge(value: &str) -> (Vec<String>, Vec<String>) {
    let mut raw = Vec::new();
    let mut normalized = Vec::new();
    for word in normalize_spaces(value).split_whitespace() {
        let norm = normalize_merge_word(word);
        if norm.is_empty() {
            continue;
        }
        raw.push(word.to_string());
        normalized.push(norm);
    }
    (raw, normalized)
}

fn normalized_merge_text(value: &str) -> String {
    tokenize_for_merge(value).1.join(" ")
}

fn merge_overlap_words(a_norm: &[String], b_norm: &[String]) -> usize {
    let max = a_norm.len().min(b_norm.len());
    for count in (1..=max).rev() {
        let mut matches = true;
        for offset in 0..count {
            if a_norm[a_norm.len() - count + offset] != b_norm[offset] {
                matches = false;
                break;
            }
        }
        if matches {
            return count;
        }
    }
    0
}

fn merge_transcript_text(base: &str, next: &str) -> String {
    let a = normalize_spaces(base);
    let b = normalize_spaces(next);
    if a.is_empty() {
        return b;
    }
    if b.is_empty() {
        return a;
    }
    if a == b {
        return a;
    }

    let normalized_a = normalized_merge_text(&a);
    let normalized_b = normalized_merge_text(&b);
    if !normalized_a.is_empty() && !normalized_b.is_empty() {
        if normalized_a == normalized_b {
            return if a.len() >= b.len() { a } else { b };
        }

        let a_words = normalized_a.split_whitespace().count();
        let b_words = normalized_b.split_whitespace().count();
        let can_use_containment = (a_words >= 3 && b_words >= 3)
            || (normalized_a.len() >= 18 && normalized_b.len() >= 18);
        if can_use_containment {
            if normalized_b.contains(&normalized_a) && normalized_b.len() >= normalized_a.len() {
                return b;
            }
            if normalized_a.contains(&normalized_b) && normalized_a.len() >= normalized_b.len() {
                return a;
            }
        }
    }

    let (_, a_norm) = tokenize_for_merge(&a);
    let (b_raw, b_norm) = tokenize_for_merge(&b);
    let overlap = merge_overlap_words(&a_norm, &b_norm);
    let accept_overlap =
        overlap >= 2 || (overlap == 1 && b_norm.first().map_or(false, |w| w.len() >= 6));
    if accept_overlap {
        let suffix = b_raw[overlap..].join(" ");
        if suffix.is_empty() {
            return a;
        }
        return normalize_spaces(&format!("{} {}", a, suffix));
    }

    normalize_spaces(&format!("{} {}", a, b))
}

fn append_transcript_text(base: &str, next: &str) -> String {
    let a = normalize_spaces(base);
    let b = normalize_spaces(next);
    if a.is_empty() {
        return b;
    }
    if b.is_empty() {
        return a;
    }

    normalize_spaces(&format!("{} {}", a, b))
}

fn finalized_range_key(start: f64, duration: f64) -> String {
    if !start.is_finite() || !duration.is_finite() || duration <= 0.0 {
        return String::new();
    }
    format!("{:.3}|{:.3}", start, duration)
}

async fn live_system_text(state: &AppState) -> String {
    let accumulated = state.companion_system_accumulated_text.read().await.clone();
    let partial = state
        .partial_transcription
        .read()
        .await
        .clone()
        .unwrap_or_default();
    merge_transcript_text(&accumulated, &partial)
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

    let sys_live = live_system_text(state).await;
    !sys_live.trim().is_empty() && is_near_duplicate_text(candidate, &sys_live)
}

pub async fn visible_system_partial_text(state: &AppState) -> Option<String> {
    let text = live_system_text(state).await;
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    if is_system_text_duplicate_of_mic(state, &trimmed, now_ms()).await {
        return None;
    }
    Some(trimmed)
}

pub async fn has_system_live_text(state: &AppState) -> bool {
    !live_system_text(state).await.trim().is_empty()
}

pub async fn on_system_partial(state: &AppState, payload: &PartialTranscriptionPayload) {
    let new_text = payload.text.trim().to_string();
    let now = now_ms();

    if payload.is_segment_final {
        if new_text.is_empty() {
            return;
        }
        let segment_key = finalized_range_key(payload.start, payload.duration);
        if !segment_key.is_empty()
            && *state.companion_system_last_finalized_text.read().await == segment_key
        {
            return;
        }

        let mut accumulated = state.companion_system_accumulated_text.write().await;
        *accumulated = append_transcript_text(accumulated.trim(), &new_text);
        drop(accumulated);

        *state.companion_system_last_finalized_text.write().await = segment_key;
        *state.partial_transcription.write().await = None;
        if state
            .companion_live_system_started_at_ms
            .load(Ordering::Relaxed)
            == 0
        {
            state
                .companion_live_system_started_at_ms
                .store(now.max(0) as u64, Ordering::Relaxed);
        }
        return;
    }

    let utterance_start = payload.start;
    let current_start = *state.companion_system_current_utterance_start.read().await;

    if current_start.is_none() || current_start == Some(utterance_start) {
        *state.companion_system_current_utterance_start.write().await = Some(utterance_start);
        *state.partial_transcription.write().await = if new_text.is_empty() {
            None
        } else {
            Some(new_text.clone())
        };
        if !new_text.is_empty()
            && state
                .companion_live_system_started_at_ms
                .load(Ordering::Relaxed)
                == 0
        {
            state
                .companion_live_system_started_at_ms
                .store(now.max(0) as u64, Ordering::Relaxed);
        }
        return;
    }

    let previous_partial = state
        .partial_transcription
        .read()
        .await
        .clone()
        .unwrap_or_default();
    if !previous_partial.trim().is_empty() {
        let mut accumulated = state.companion_system_accumulated_text.write().await;
        *accumulated = merge_transcript_text(accumulated.trim(), &previous_partial);
    }

    *state.companion_system_current_utterance_start.write().await = Some(utterance_start);
    *state.partial_transcription.write().await = if new_text.is_empty() {
        None
    } else {
        Some(new_text.clone())
    };
    if !new_text.is_empty()
        && state
            .companion_live_system_started_at_ms
            .load(Ordering::Relaxed)
            == 0
    {
        state
            .companion_live_system_started_at_ms
            .store(now.max(0) as u64, Ordering::Relaxed);
    }
}

pub async fn finalize_system_transcription(
    state: &AppState,
    session_id: u64,
    transcription: &crate::domain::Transcription,
) -> Option<crate::domain::Transcription> {
    let accumulated = state.companion_system_accumulated_text.read().await.clone();
    let partial = state
        .partial_transcription
        .read()
        .await
        .clone()
        .unwrap_or_default();
    let tail = if transcription.text.trim().is_empty() {
        partial
    } else {
        transcription.text.clone()
    };
    let final_key = finalized_range_key(transcription.start, transcription.duration);
    let last_segment_key = state
        .companion_system_last_finalized_text
        .read()
        .await
        .clone();
    let is_duplicate_final_range = !transcription.text.trim().is_empty()
        && !final_key.is_empty()
        && final_key == last_segment_key
        && !accumulated.trim().is_empty();
    let utterance_text = if is_duplicate_final_range {
        accumulated
    } else if transcription.text.trim().is_empty() {
        merge_transcript_text(&accumulated, &tail)
    } else {
        append_transcript_text(&accumulated, &tail)
    }
    .trim()
    .to_string();

    clear_system_live_buffers(state).await;

    if utterance_text.is_empty() {
        return None;
    }

    let mut canonical = transcription.clone();
    canonical.text = utterance_text;
    append_system_final(state, session_id, &canonical).await;
    Some(canonical)
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
        candidates: None,
        active_candidate_id: None,
    });

    for item in timeline.iter_mut() {
        if item.kind == "haiku" && item.insert_after_id.as_deref() == Some(LIVE_STT_MESSAGE_ID) {
            item.insert_after_id = Some(message_id.clone());
        }
    }
    drop(timeline);

    crate::presentation::interview_memory_bridge::spawn_ingest_timeline_event(
        state,
        crate::presentation::interview_memory_bridge::MemoryTimelineEvent {
            source: crate::presentation::interview_memory_bridge::MemoryTimelineSource::SystemAudio,
            event_id: message_id,
            text: transcription.text.clone(),
            created_at_ms: transcription.timestamp,
            seq: Some(seq),
            attached_to_prompt: false,
            final_answer: false,
        },
    )
    .await;

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
    let memory_text = text.trim().to_string();

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
        candidates: None,
        active_candidate_id: None,
    });

    for item in timeline.iter_mut() {
        if item.kind == "haiku" && item.insert_after_id.as_deref() == Some(LIVE_STT_MESSAGE_ID) {
            item.insert_after_id = Some(message_id.clone());
        }
    }
    drop(timeline);

    crate::presentation::interview_memory_bridge::spawn_ingest_timeline_event(
        state,
        crate::presentation::interview_memory_bridge::MemoryTimelineEvent {
            source: crate::presentation::interview_memory_bridge::MemoryTimelineSource::FocusCopy,
            event_id: message_id.clone(),
            text: memory_text,
            created_at_ms,
            seq: Some(seq),
            attached_to_prompt: true,
            final_answer: false,
        },
    )
    .await;

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
    let prompt_id = prompt.id.clone();
    let prompt_text = prompt.text.clone();
    let prompt_created_at_ms = prompt.created_at_ms;
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
            candidates: None,
            active_candidate_id: None,
        });
    crate::presentation::interview_memory_bridge::spawn_ingest_timeline_event(
        state,
        crate::presentation::interview_memory_bridge::MemoryTimelineEvent {
            source:
                crate::presentation::interview_memory_bridge::MemoryTimelineSource::ManualPrompt,
            event_id: prompt_id,
            text: prompt_text,
            created_at_ms: prompt_created_at_ms,
            seq: Some(seq),
            attached_to_prompt: true,
            final_answer: false,
        },
    )
    .await;
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
            candidates: (!request.candidates.is_empty()).then_some(request.candidates),
            active_candidate_id: request.active_candidate_id,
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
            if let Some(candidates) = message.candidates.as_mut() {
                for candidate in candidates.iter_mut() {
                    if candidate.status == "streaming" {
                        candidate.status = "final".to_string();
                    }
                }
            }
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
    append_haiku_candidate_delta(state, request_id, None, delta).await;
}

pub async fn append_haiku_candidate_delta(
    state: &AppState,
    request_id: &str,
    candidate_id: Option<&str>,
    delta: &str,
) {
    if request_id.trim().is_empty() || delta.is_empty() {
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

    let mut timeline = state.companion_timeline.write().await;
    if let Some(message) = timeline.iter_mut().find(|item| item.id == request_id) {
        if message.generation != Some(current_generation) {
            return;
        }
        if let Some(candidate_id) = candidate_id.filter(|value| !value.trim().is_empty()) {
            let active_candidate_id = message
                .active_candidate_id
                .as_deref()
                .or_else(|| {
                    message
                        .candidates
                        .as_ref()
                        .and_then(|candidates| candidates.first())
                        .map(|candidate| candidate.id.as_str())
                })
                .map(str::to_string);

            if let Some(candidate) = message
                .candidates
                .as_mut()
                .and_then(|candidates| candidates.iter_mut().find(|item| item.id == candidate_id))
            {
                if candidate.status != "streaming" {
                    return;
                }
                candidate.status = "streaming".to_string();
                candidate.text.push_str(delta);
                message.status = "streaming".to_string();
                if active_candidate_id.as_deref() == Some(candidate_id) {
                    message.text = candidate.text.clone();
                }
            }
        } else {
            message.status = "streaming".to_string();
            message.text.push_str(delta);
        }
    }
}

pub async fn finalize_haiku_message(state: &AppState, request_id: &str) {
    finalize_haiku_candidate(state, request_id, None).await;
}

pub async fn finalize_haiku_candidate(
    state: &AppState,
    request_id: &str,
    candidate_id: Option<&str>,
) {
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

    let mut should_remove_generation = true;
    let mut final_answer_to_ingest: Option<(String, String, i64, u64)> = None;
    if let Some(message) = state
        .companion_timeline
        .write()
        .await
        .iter_mut()
        .find(|item| item.id == request_id)
    {
        if let Some(candidate_id) = candidate_id.filter(|value| !value.trim().is_empty()) {
            let active_candidate_id = message
                .active_candidate_id
                .as_deref()
                .or_else(|| {
                    message
                        .candidates
                        .as_ref()
                        .and_then(|candidates| candidates.first())
                        .map(|candidate| candidate.id.as_str())
                })
                .map(str::to_string);

            if let Some(candidate) = message
                .candidates
                .as_mut()
                .and_then(|candidates| candidates.iter_mut().find(|item| item.id == candidate_id))
            {
                candidate.status = "final".to_string();
                if active_candidate_id.as_deref() == Some(candidate_id) {
                    message.text = candidate.text.clone();
                }
            }

            should_remove_generation = update_haiku_group_status(message);
            if message.status == "final" && !message.text.trim().is_empty() {
                final_answer_to_ingest = Some((
                    message.id.clone(),
                    message.text.clone(),
                    message.created_at_ms,
                    message.seq,
                ));
            }
        } else {
            message.status = "final".to_string();
            if !message.text.trim().is_empty() {
                final_answer_to_ingest = Some((
                    message.id.clone(),
                    message.text.clone(),
                    message.created_at_ms,
                    message.seq,
                ));
            }
        }
    }

    if let Some((event_id, text, created_at_ms, seq)) = final_answer_to_ingest {
        crate::presentation::interview_memory_bridge::spawn_ingest_timeline_event(
            state,
            crate::presentation::interview_memory_bridge::MemoryTimelineEvent {
                source:
                    crate::presentation::interview_memory_bridge::MemoryTimelineSource::AiResponse,
                event_id,
                text,
                created_at_ms,
                seq: Some(seq),
                attached_to_prompt: false,
                final_answer: true,
            },
        )
        .await;
    }

    if should_remove_generation {
        state
            .companion_request_generations
            .write()
            .await
            .remove(request_id);
    }
}

pub async fn fail_haiku_message(state: &AppState, request_id: &str, error: &str) {
    fail_haiku_candidate(state, request_id, None, error).await;
}

pub async fn fail_haiku_candidate(
    state: &AppState,
    request_id: &str,
    candidate_id: Option<&str>,
    error: &str,
) {
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

    let mut should_remove_generation = true;
    if let Some(message) = state
        .companion_timeline
        .write()
        .await
        .iter_mut()
        .find(|item| item.id == request_id)
    {
        if let Some(candidate_id) = candidate_id.filter(|value| !value.trim().is_empty()) {
            let active_candidate_id = message
                .active_candidate_id
                .as_deref()
                .or_else(|| {
                    message
                        .candidates
                        .as_ref()
                        .and_then(|candidates| candidates.first())
                        .map(|candidate| candidate.id.as_str())
                })
                .map(str::to_string);
            let error_text = format!("Ошибка: {}", error.trim());

            if let Some(candidate) = message
                .candidates
                .as_mut()
                .and_then(|candidates| candidates.iter_mut().find(|item| item.id == candidate_id))
            {
                candidate.status = "error".to_string();
                candidate.error = Some(error.trim().to_string());
                if candidate.text.trim().is_empty() {
                    candidate.text = error_text.clone();
                }
                if active_candidate_id.as_deref() == Some(candidate_id) {
                    message.text = candidate.text.clone();
                }
            }

            should_remove_generation = update_haiku_group_status(message);
        } else {
            message.status = "error".to_string();
            if message.text.trim().is_empty() {
                message.text = format!("Ошибка: {}", error.trim());
            }
        }
    }

    if should_remove_generation {
        state
            .companion_request_generations
            .write()
            .await
            .remove(request_id);
    }
}

fn update_haiku_group_status(message: &mut CompanionMessage) -> bool {
    let Some(candidates) = message.candidates.as_ref() else {
        return true;
    };

    if candidates
        .iter()
        .any(|candidate| candidate.status == "streaming")
    {
        message.status = "streaming".to_string();
        return false;
    }

    if candidates
        .iter()
        .any(|candidate| candidate.status == "final")
    {
        message.status = "final".to_string();
    } else {
        message.status = "error".to_string();
    }

    true
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
        let segment_key = finalized_range_key(payload.start, payload.duration);
        if !segment_key.is_empty()
            && *state.companion_microphone_last_finalized_text.read().await == segment_key
        {
            return;
        }
        if is_mic_text_duplicate_of_system(state, &new_text, now).await {
            clear_microphone_live_buffers(state).await;
            return;
        }

        let mut accumulated = state.companion_microphone_accumulated_text.write().await;
        *accumulated = append_transcript_text(accumulated.trim(), &new_text);
        drop(accumulated);

        *state.companion_microphone_last_finalized_text.write().await = segment_key;
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

    let previous_partial = state.companion_microphone_partial_text.read().await.clone();
    if !previous_partial.trim().is_empty() {
        let mut accumulated = state.companion_microphone_accumulated_text.write().await;
        *accumulated = merge_transcript_text(accumulated.trim(), &previous_partial);
    }

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
            candidates: None,
            active_candidate_id: None,
        });
    crate::presentation::interview_memory_bridge::spawn_ingest_timeline_event(
        state,
        crate::presentation::interview_memory_bridge::MemoryTimelineEvent {
            source: crate::presentation::interview_memory_bridge::MemoryTimelineSource::Microphone,
            event_id: format!("mic:{}:{}", session_id, seq),
            text: text.to_string(),
            created_at_ms,
            seq: Some(seq),
            attached_to_prompt: false,
            final_answer: false,
        },
    )
    .await;
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
    let tail = if payload.text.trim().is_empty() {
        partial
    } else {
        payload.text.clone()
    };
    let final_key = finalized_range_key(payload.start, payload.duration);
    let last_segment_key = state
        .companion_microphone_last_finalized_text
        .read()
        .await
        .clone();
    let is_duplicate_final_range = !payload.text.trim().is_empty()
        && !final_key.is_empty()
        && final_key == last_segment_key
        && !accumulated.trim().is_empty();
    let utterance_text = if is_duplicate_final_range {
        accumulated
    } else if payload.text.trim().is_empty() {
        merge_transcript_text(&accumulated, &tail)
    } else {
        append_transcript_text(&accumulated, &tail)
    }
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
    let parts = collect_context_parts(state, include_full_history).await;
    context_text_from_selected_parts(&select_context_parts(&parts))
}

pub async fn build_memory_context_evidence(
    state: &AppState,
    include_full_history: bool,
) -> MemoryContextEvidenceInput {
    let parts = collect_context_parts(state, include_full_history).await;
    memory_context_evidence_from_parts(&select_context_parts(&parts))
}

pub async fn build_context_text_and_memory_evidence(
    state: &AppState,
    include_full_history: bool,
) -> (String, MemoryContextEvidenceInput) {
    let parts = collect_context_parts(state, include_full_history).await;
    let selected = select_context_parts(&parts);
    (
        context_text_from_selected_parts(&selected),
        memory_context_evidence_from_parts(&selected),
    )
}

async fn collect_context_parts(state: &AppState, include_full_history: bool) -> Vec<ContextPart> {
    let context_floor_seq = state.companion_context_floor_seq.load(Ordering::Relaxed);
    let live_system = visible_system_partial_text(state).await;
    let live_mic = visible_microphone_partial_text(state).await;

    let mut parts: Vec<ContextPart> = Vec::new();
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
            parts.push(ContextPart {
                id: message.id.clone(),
                kind: message.kind.clone(),
                line,
            });
        }
    }

    if let Some(text) = live_system {
        parts.push(ContextPart {
            id: LIVE_STT_MESSAGE_ID.to_string(),
            kind: "stt".to_string(),
            line: format!("ОС: {}", text),
        });
    }
    if let Some(text) = live_mic {
        parts.push(ContextPart {
            id: "mic:live".to_string(),
            kind: "mic".to_string(),
            line: format!("МИКРОФОН: {}", text),
        });
    }

    parts
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

fn trim_context_text(text: &str) -> String {
    trim_context_text_to(text, MAX_CONTEXT_CHARS)
}

fn trim_context_text_to(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let tail = trimmed
        .chars()
        .rev()
        .take(max_chars)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();

    if let Some(first_line_break) = tail.find('\n') {
        if first_line_break < tail.len().saturating_sub(1) {
            return tail[first_line_break + 1..].trim().to_string();
        }
    }

    tail.trim().to_string()
}

fn trim_context_line_head_to(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    trimmed
        .chars()
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

fn context_len(parts: &[ContextPart]) -> usize {
    parts
        .iter()
        .enumerate()
        .map(|(idx, part)| part.line.chars().count() + usize::from(idx > 0))
        .sum()
}

fn can_append(parts: &[ContextPart], line: &str, max_chars: usize) -> bool {
    context_len(parts) + line.chars().count() + usize::from(!parts.is_empty()) <= max_chars
}

fn indexed_context_len(parts: &[(usize, ContextPart)]) -> usize {
    parts
        .iter()
        .enumerate()
        .map(|(idx, (_, part))| part.line.chars().count() + usize::from(idx > 0))
        .sum()
}

fn can_append_indexed(parts: &[(usize, ContextPart)], line: &str, max_chars: usize) -> bool {
    indexed_context_len(parts) + line.chars().count() + usize::from(!parts.is_empty()) <= max_chars
}

fn add_anchor_candidate(
    anchors: &mut Vec<(usize, ContextPart)>,
    selected_indexes: &mut Vec<usize>,
    index: usize,
    part: &ContextPart,
    anchor_budget: usize,
) {
    if selected_indexes.contains(&index) {
        return;
    }

    let candidate_line = trim_context_anchor_line(&part.line);
    if candidate_line.is_empty() {
        return;
    }

    if can_append_indexed(anchors, &candidate_line, anchor_budget) {
        anchors.push((index, part.clone()));
        if let Some((_, inserted)) = anchors.last_mut() {
            inserted.line = candidate_line;
        }
        selected_indexes.push(index);
        return;
    }

    let used = indexed_context_len(anchors);
    let separator = usize::from(!anchors.is_empty());
    let Some(remaining) = anchor_budget.checked_sub(used + separator) else {
        return;
    };
    if remaining < 400 {
        return;
    }

    let line = trim_context_line_head_to(&candidate_line, remaining);
    if line.is_empty() {
        return;
    }

    anchors.push((
        index,
        ContextPart {
            id: part.id.clone(),
            kind: part.kind.clone(),
            line,
        },
    ));
    selected_indexes.push(index);
}

fn trim_context_anchor_line(line: &str) -> String {
    trim_context_line_head_to(line, MAX_CONTEXT_ANCHOR_CHARS)
}

fn is_important_older_context_part(part: &ContextPart) -> bool {
    if part.kind == "prompt" {
        return true;
    }
    if part.kind == "haiku" {
        return false;
    }

    let line = part.line.as_str();
    let lower = line.to_lowercase();
    let markers = [
        "```",
        "=>",
        "function ",
        "class ",
        "interface ",
        "struct ",
        "impl ",
        "const ",
        "let ",
        "var ",
        "def ",
        "func ",
        "select ",
        " from ",
        " where ",
        " join ",
        "useeffect",
        "error",
        "exception",
        "stack",
        "trace",
        "requirement",
        "constraint",
        "input",
        "output",
        "complexity",
        "project",
        "fact",
        "must ",
        "should ",
        "queue",
        "algorithm",
        "remember",
        "important",
        "deadlock",
        "race",
        "sql",
        "react",
        "python",
        "typescript",
        "javascript",
        "rust",
        "код",
        "факт",
        "маркер",
        "требован",
        "услов",
        "огранич",
        "пример",
        "вход",
        "выход",
        "сложност",
        "проект",
        "запомни",
        "важно",
        "должен",
        "нужно",
        "нельзя",
        "использовать",
        "очеред",
        "стек",
        "данн",
        "алгоритм",
        "почему",
        "как ",
        "что ",
        "задач",
        "ошиб",
        "индекс",
    ];

    line.chars().count() > 800
        || line.contains('?')
        || line.contains('{')
        || line.contains(';')
        || markers.iter().any(|marker| lower.contains(marker))
}

fn is_important_pruned_old_message(message: &CompanionMessage) -> bool {
    if message.deleted {
        return false;
    }
    if message.kind == "haiku" {
        return false;
    }

    let line = format_context_line(message.kind.as_str(), &message.text);
    is_important_older_context_part(&ContextPart {
        id: message.id.clone(),
        kind: message.kind.clone(),
        line,
    })
}

fn select_pruned_important_old_indexes(messages: &[CompanionMessage], limit: usize) -> Vec<usize> {
    if limit == 0 {
        return Vec::new();
    }

    let candidates = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| is_important_pruned_old_message(message))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Vec::new();
    }

    let mut selected = Vec::new();
    let oldest = candidates[0];
    selected.push(oldest);

    for index in candidates.iter().rev() {
        if selected.len() >= limit {
            break;
        }
        if selected.contains(index) {
            continue;
        }
        selected.push(*index);
    }

    selected.sort_unstable();
    selected
}

fn select_context_parts(raw_parts: &[ContextPart]) -> Vec<ContextPart> {
    let parts = raw_parts
        .iter()
        .filter_map(|part| {
            let line = part.line.trim();
            if line.is_empty() {
                None
            } else {
                Some(ContextPart {
                    id: part.id.clone(),
                    kind: part.kind.clone(),
                    line: line.to_string(),
                })
            }
        })
        .collect::<Vec<_>>();

    if parts.is_empty() {
        return Vec::new();
    }

    if context_len(&parts) <= MAX_CONTEXT_CHARS {
        return parts;
    }

    let recent_limit = RECENT_CONTEXT_CHARS.min(MAX_CONTEXT_CHARS);
    let mut recent: Vec<ContextPart> = Vec::new();
    let mut recent_start = parts.len();

    for idx in (0..parts.len()).rev() {
        let part = &parts[idx];
        if recent.is_empty() && part.line.chars().count() > recent_limit {
            recent.insert(
                0,
                ContextPart {
                    id: part.id.clone(),
                    kind: part.kind.clone(),
                    line: trim_context_text_to(&part.line, recent_limit),
                },
            );
            recent_start = idx;
            break;
        }
        if !can_append(&recent, &part.line, recent_limit) {
            break;
        }
        recent.insert(0, part.clone());
        recent_start = idx;
    }

    let anchor_budget = MAX_CONTEXT_CHARS
        .saturating_sub(context_len(&recent))
        .saturating_sub(usize::from(!recent.is_empty()));
    let anchor_candidates = parts[..recent_start]
        .iter()
        .enumerate()
        .filter(|(_, part)| is_important_older_context_part(part))
        .collect::<Vec<_>>();
    let mut anchors: Vec<(usize, ContextPart)> = Vec::new();
    let mut selected_anchor_indexes: Vec<usize> = Vec::new();

    if let Some((index, part)) = anchor_candidates.first() {
        add_anchor_candidate(
            &mut anchors,
            &mut selected_anchor_indexes,
            *index,
            part,
            anchor_budget,
        );
    }

    for (index, part) in anchor_candidates.iter().rev() {
        add_anchor_candidate(
            &mut anchors,
            &mut selected_anchor_indexes,
            *index,
            part,
            anchor_budget,
        );
    }

    anchors.sort_by_key(|(index, _)| *index);
    let mut selected = anchors
        .into_iter()
        .map(|(_, part)| part)
        .collect::<Vec<_>>();
    selected.extend(recent);

    if selected.is_empty() {
        let line = trim_context_text(
            &parts
                .iter()
                .map(|part| part.line.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        );
        if line.is_empty() {
            return Vec::new();
        }
        return vec![ContextPart {
            id: "context:trimmed".to_string(),
            kind: "context".to_string(),
            line,
        }];
    }

    selected
}

fn trim_context_parts(raw_parts: &[ContextPart]) -> String {
    let selected = select_context_parts(raw_parts);
    context_text_from_selected_parts(&selected)
}

fn context_text_from_selected_parts(selected: &[ContextPart]) -> String {
    if selected.is_empty() {
        return String::new();
    }

    trim_context_text(
        &selected
            .iter()
            .map(|part| part.line.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn memory_context_evidence_from_parts(parts: &[ContextPart]) -> MemoryContextEvidenceInput {
    let mut evidence = MemoryContextEvidenceInput::default();

    for part in parts {
        let text = context_part_evidence_text(part);
        if text.is_empty() {
            continue;
        }

        let item = MemoryRequestEvidenceInput {
            id: Some(part.id.clone()),
            label: Some(memory_context_label(part).to_string()),
            text: text.clone(),
        };

        if part.id.starts_with("focus-copy:")
            || crate::presentation::interview_memory_bridge::text_looks_like_current_code(&text)
        {
            evidence.current_code.push(MemoryRequestEvidenceInput {
                label: Some("current_code".to_string()),
                ..item
            });
        } else {
            evidence.recent_timeline.push(item);
        }
    }

    evidence
}

fn memory_context_label(part: &ContextPart) -> &'static str {
    match part.kind.as_str() {
        "stt" => "system_audio",
        "mic" => "microphone",
        "prompt" => "manual_prompt",
        "haiku" => "assistant",
        _ => "recent_timeline",
    }
}

fn context_part_evidence_text(part: &ContextPart) -> String {
    let trimmed = part.line.trim();
    for prefix in ["ОС:", "МИКРОФОН:", "ЗАПРОС:", "ПОМОЩНИК:"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return rest.trim().to_string();
        }
    }
    trimmed.to_string()
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

    fn test_candidate(id: &str, label: &str) -> CompanionLlmCandidate {
        CompanionLlmCandidate {
            id: id.to_string(),
            label: label.to_string(),
            provider: id.to_string(),
            model: format!("{id}-model"),
            status: "streaming".to_string(),
            text: String::new(),
            error: None,
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
                candidates: Vec::new(),
                active_candidate_id: None,
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
    async fn system_final_appends_finalized_chunks_before_append() {
        let state = AppState::default();

        on_system_partial(
            &state,
            &PartialTranscriptionPayload {
                session_id: 1,
                source: "system".to_string(),
                text: "my number is two two".to_string(),
                timestamp: 100,
                is_segment_final: true,
                start: 0.0,
                duration: 1.0,
            },
        )
        .await;

        let canonical =
            finalize_system_transcription(&state, 1, &test_transcription("two two three", 200))
                .await
                .expect("canonical transcription");

        assert_eq!(canonical.text, "my number is two two two two three");

        let timeline = state.companion_timeline.read().await;
        let stt = timeline
            .iter()
            .find(|message| message.kind == "stt")
            .expect("stt message");

        assert_eq!(stt.text, "my number is two two two two three");
        assert!(visible_system_partial_text(&state).await.is_none());
    }

    #[tokio::test]
    async fn system_final_does_not_duplicate_same_finalized_range() {
        let state = AppState::default();

        on_system_partial(
            &state,
            &PartialTranscriptionPayload {
                session_id: 1,
                source: "system".to_string(),
                text: "hello world".to_string(),
                timestamp: 100,
                is_segment_final: true,
                start: 0.0,
                duration: 1.5,
            },
        )
        .await;

        let final_transcription = test_transcription("hello world", 200).with_timing(0.0, 1.5);
        let canonical = finalize_system_transcription(&state, 1, &final_transcription)
            .await
            .expect("canonical transcription");

        assert_eq!(canonical.text, "hello world");
    }

    #[tokio::test]
    async fn system_live_text_does_not_duplicate_overlapping_interim_after_segment_final() {
        let state = AppState::default();

        on_system_partial(
            &state,
            &PartialTranscriptionPayload {
                session_id: 1,
                source: "system".to_string(),
                text: "Ты слышишь, что я говорю?".to_string(),
                timestamp: 100,
                is_segment_final: true,
                start: 0.0,
                duration: 2.0,
            },
        )
        .await;

        on_system_partial(
            &state,
            &PartialTranscriptionPayload {
                session_id: 1,
                source: "system".to_string(),
                text: "Ты слышишь, что".to_string(),
                timestamp: 120,
                is_segment_final: false,
                start: 2.0,
                duration: 0.7,
            },
        )
        .await;

        assert_eq!(
            visible_system_partial_text(&state).await.as_deref(),
            Some("Ты слышишь, что я говорю?")
        );
    }

    #[tokio::test]
    async fn stop_promotes_only_finalized_system_chunks_when_finalize_returns_nothing() {
        let state = AppState::default();

        *state.companion_system_accumulated_text.write().await = "stable segment".to_string();
        *state.partial_transcription.write().await = Some("unstable interim".to_string());
        state
            .companion_live_system_started_at_ms
            .store(1234, Ordering::Relaxed);

        let canonical = finalize_or_clear_system_live_on_stop(&state, 7)
            .await
            .expect("finalized live system text");

        assert_eq!(canonical.text, "stable segment");
        assert_eq!(canonical.timestamp, 1234);
        assert!(visible_system_partial_text(&state).await.is_none());

        let timeline = state.companion_timeline.read().await;
        let stt = timeline
            .iter()
            .find(|message| message.kind == "stt")
            .expect("stt message");
        assert_eq!(stt.text, "stable segment");
    }

    #[tokio::test]
    async fn stop_drops_unfinalized_system_interim_when_finalize_returns_nothing() {
        let state = AppState::default();

        *state.partial_transcription.write().await = Some("unstable interim".to_string());

        let canonical = finalize_or_clear_system_live_on_stop(&state, 7).await;

        assert!(canonical.is_none());
        assert!(visible_system_partial_text(&state).await.is_none());
        assert!(state.companion_timeline.read().await.is_empty());
    }

    #[tokio::test]
    async fn system_partial_keeps_repeated_short_segment_finals_when_segment_changes() {
        let state = AppState::default();

        for start in [0.0, 1.0] {
            on_system_partial(
                &state,
                &PartialTranscriptionPayload {
                    session_id: 1,
                    source: "system".to_string(),
                    text: "да".to_string(),
                    timestamp: 100,
                    is_segment_final: true,
                    start,
                    duration: 0.4,
                },
            )
            .await;
        }

        let canonical = finalize_system_transcription(&state, 1, &test_transcription("", 200))
            .await
            .expect("canonical transcription");

        assert_eq!(canonical.text, "да да");
    }

    #[tokio::test]
    async fn microphone_live_merges_overlapping_partial_after_segment_final() {
        let state = AppState::default();
        *state.companion_microphone_accumulated_text.write().await =
            "Ты слышишь, что я говорю?".to_string();
        *state.companion_microphone_partial_text.write().await = "Ты слышишь, что".to_string();

        assert_eq!(
            visible_microphone_partial_text(&state).await.as_deref(),
            Some("Ты слышишь, что я говорю?")
        );
    }

    #[tokio::test]
    async fn stop_promotes_only_finalized_microphone_chunks_when_finalize_returns_nothing() {
        let state = AppState::default();
        state
            .microphone_transcription_enabled
            .store(true, Ordering::Relaxed);

        *state.companion_microphone_accumulated_text.write().await =
            "stable microphone".to_string();
        *state.companion_microphone_partial_text.write().await = "unstable mic".to_string();

        let flushed = finalize_or_clear_microphone_live_on_stop(&state, 7)
            .await
            .expect("finalized live microphone text");

        assert_eq!(flushed, "stable microphone");
        assert!(visible_microphone_partial_text(&state).await.is_none());

        let timeline = state.companion_timeline.read().await;
        let mic = timeline
            .iter()
            .find(|message| message.kind == "mic")
            .expect("mic message");
        assert_eq!(mic.text, "stable microphone");
    }

    #[test]
    fn finalized_chunk_append_preserves_repeated_boundary_words() {
        assert_eq!(
            append_transcript_text("my number is two two", "two two three"),
            "my number is two two two two three"
        );
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
                candidates: Vec::new(),
                active_candidate_id: None,
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
    async fn build_context_text_trims_large_unicode_context_on_line_boundary() {
        let state = AppState::default();

        for idx in 0..500 {
            append_system_final(
                &state,
                1,
                &test_transcription(&format!("сообщение {:03} {}", idx, "ж".repeat(32)), idx),
            )
            .await;
        }

        let context = build_context_text(&state, false).await;

        assert!(context.chars().count() <= MAX_CONTEXT_CHARS);
        assert!(context.starts_with("ОС: сообщение"));
        assert!(context.contains("ОС: сообщение 499"));
        assert!(!context.contains("ОС: сообщение 000"));
    }

    #[tokio::test]
    async fn build_context_text_keeps_early_code_marker_in_long_interview_context() {
        let state = AppState::default();

        append_focus_copy_system_final(
            &state,
            format!(
                "CODE-JS-ORDER-MAP-001\nfunction totals(orders) {{}}\n{}",
                "x".repeat(2_000)
            ),
            100,
            Some("focus-copy:early-code".to_string()),
        )
        .await
        .expect("early focus-copy message");

        for idx in 0..320 {
            append_system_final(
                &state,
                1,
                &test_transcription(
                    &format!("FOLLOW-UP-{idx:03} {}", "ж".repeat(180)),
                    200 + idx,
                ),
            )
            .await;
        }

        let context = build_context_text(&state, false).await;

        assert!(context.chars().count() <= MAX_CONTEXT_CHARS);
        assert!(context.contains("CODE-JS-ORDER-MAP-001"));
        assert!(context.contains("FOLLOW-UP-319"));
        assert!(!context.contains("FOLLOW-UP-000"));
    }

    #[tokio::test]
    async fn prune_timeline_keeps_old_code_anchors_before_recent_tail() {
        let state = AppState::default();

        for idx in 0..24 {
            append_focus_copy_system_final(
                &state,
                format!(
                    "CTX-PRUNE-OLD-CODE-{idx:02}\nfunction pruneAnchor{idx}() {{ return {idx}; }}\nsentinel: quartz-index-latch-{idx}\n{}",
                    "x".repeat(1_000)
                ),
                100 + idx,
                Some(format!("focus-copy:prune-code-{idx}")),
            )
            .await
            .expect("old code message");
        }

        for idx in 0..280 {
            append_system_final(
                &state,
                1,
                &test_transcription(
                    &format!("noise interview filler {idx:03} {}", "ж".repeat(180)),
                    1_000 + idx,
                ),
            )
            .await;
        }
        append_system_final(
            &state,
            1,
            &test_transcription("CTX-PRUNE-RECENT-279 violet-tail-signal", 9_999),
        )
        .await;

        let timeline_text = state
            .companion_timeline
            .read()
            .await
            .iter()
            .map(|message| message.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(timeline_text.contains("CTX-PRUNE-OLD-CODE-00"));
        assert!(timeline_text.contains("CTX-PRUNE-OLD-CODE-23"));
        assert!(timeline_text.contains("CTX-PRUNE-RECENT-279"));
        assert!(!timeline_text.contains("noise interview filler 000"));

        let context = build_context_text(&state, false).await;
        assert!(context.chars().count() <= MAX_CONTEXT_CHARS);
        assert!(context.contains("CTX-PRUNE-OLD-CODE-00"));
        assert!(context.contains("CTX-PRUNE-OLD-CODE-23"));
        assert!(context.contains("CTX-PRUNE-RECENT-279"));
    }

    #[tokio::test]
    async fn build_memory_context_evidence_sends_structured_companion_sections() {
        let state = AppState::default();

        append_focus_copy_system_final(
            &state,
            "function solveQueue(items) { return items.length; }".to_string(),
            100,
            Some("focus-copy:code".to_string()),
        )
        .await
        .expect("focus-copy message");
        append_system_final(
            &state,
            1,
            &test_transcription("Как работает очередь событий?", 200),
        )
        .await;
        append_microphone_message(&state, 2, "Я бы ответил через FIFO", 220).await;
        append_prompt_message(
            &state,
            CompanionPromptDraft {
                id: "prompt:memory-check".to_string(),
                text: "Сформулируй коротко".to_string(),
                created_at_ms: 230,
                attachments: Vec::new(),
            },
        )
        .await;

        let (context, evidence) = build_context_text_and_memory_evidence(&state, false).await;

        assert!(context.contains("function solveQueue"));
        assert!(evidence.selected_messages.is_empty());
        assert!(evidence.current_code.iter().any(|item| {
            item.id.as_deref() == Some("focus-copy:code")
                && item.label.as_deref() == Some("current_code")
                && item.text.contains("function solveQueue")
                && !item.text.starts_with("ОС:")
        }));
        assert!(evidence.recent_timeline.iter().any(|item| {
            item.label.as_deref() == Some("system_audio")
                && item.text == "Как работает очередь событий?"
        }));
        assert!(evidence.recent_timeline.iter().any(|item| {
            item.label.as_deref() == Some("microphone") && item.text == "Я бы ответил через FIFO"
        }));
        assert!(evidence.recent_timeline.iter().any(|item| {
            item.label.as_deref() == Some("manual_prompt") && item.text == "Сформулируй коротко"
        }));
    }

    #[tokio::test]
    async fn build_memory_context_evidence_keeps_plain_class_discussion_out_of_code() {
        let state = AppState::default();

        append_system_final(
            &state,
            1,
            &test_transcription(
                "Объясни разницу между class component и function component без примеров кода",
                200,
            ),
        )
        .await;

        let evidence = build_memory_context_evidence(&state, false).await;

        assert!(evidence.current_code.is_empty());
        assert!(evidence.recent_timeline.iter().any(|item| {
            item.label.as_deref() == Some("system_audio")
                && item.text.contains("class component и function component")
        }));
    }

    #[tokio::test]
    async fn build_memory_context_evidence_uses_same_long_context_retention() {
        let state = AppState::default();

        append_focus_copy_system_final(
            &state,
            format!(
                "CTX-EVIDENCE-CODE-001\nconst answer = new Map();\n{}",
                "x".repeat(2_000)
            ),
            100,
            Some("focus-copy:evidence-code".to_string()),
        )
        .await
        .expect("focus-copy message");

        for idx in 0..320 {
            append_system_final(
                &state,
                1,
                &test_transcription(
                    &format!("EVIDENCE-FOLLOW-UP-{idx:03} {}", "ж".repeat(180)),
                    200 + idx,
                ),
            )
            .await;
        }

        let (context, evidence) = build_context_text_and_memory_evidence(&state, false).await;
        let evidence_text = evidence
            .current_code
            .iter()
            .chain(evidence.recent_timeline.iter())
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        assert!(context.chars().count() <= MAX_CONTEXT_CHARS);
        assert!(context.contains("CTX-EVIDENCE-CODE-001"));
        assert!(context.contains("EVIDENCE-FOLLOW-UP-319"));
        assert!(!context.contains("EVIDENCE-FOLLOW-UP-000"));
        assert!(evidence.current_code.iter().any(|item| {
            item.id.as_deref() == Some("focus-copy:evidence-code")
                && item.text.contains("CTX-EVIDENCE-CODE-001")
        }));
        assert!(evidence_text.contains("EVIDENCE-FOLLOW-UP-319"));
        assert!(!evidence_text.contains("EVIDENCE-FOLLOW-UP-000"));
    }

    #[test]
    fn trim_context_parts_keeps_first_and_fresh_old_code_anchors() {
        let mut parts = Vec::new();
        for idx in 0..24 {
            parts.push(ContextPart {
                id: format!("stt:old:{idx}"),
                kind: "stt".to_string(),
                line: format!(
                    "ОС: CODE-OLD-{idx:02} function sample{idx}() {{ return {idx}; }} {}",
                    "x".repeat(1_200)
                ),
            });
        }
        parts.push(ContextPart {
            id: "haiku:old-noise".to_string(),
            kind: "haiku".to_string(),
            line: format!("ПОМОЩНИК: ASSISTANT-OLD-NOISE-001 {}", "y".repeat(12_000)),
        });
        for idx in 0..180 {
            parts.push(ContextPart {
                id: format!("stt:recent:{idx}"),
                kind: "stt".to_string(),
                line: format!("ОС: RECENT-HOUR-{idx:03} {}", "z".repeat(220)),
            });
        }

        let context = trim_context_parts(&parts);

        assert!(context.chars().count() <= MAX_CONTEXT_CHARS);
        assert!(context.contains("CODE-OLD-00"));
        assert!(context.contains("CODE-OLD-23"));
        assert!(context.contains("RECENT-HOUR-179"));
        assert!(!context.contains("ASSISTANT-OLD-NOISE-001"));
    }

    #[test]
    fn trim_context_parts_keeps_compact_voice_facts_when_long_filler_competes() {
        let parts = vec![
            ContextPart {
                id: "stt:code-alpha".to_string(),
                kind: "stt".to_string(),
                line: format!(
                    "ОС: CODE_CTX_E2E_ALPHA function debounceSearch() {{ return true; }} {}",
                    "x".repeat(900)
                ),
            },
            ContextPart {
                id: "stt:fact-one".to_string(),
                kind: "stt".to_string(),
                line: "ОС: Контрольный голосовой факт номер один. Проект называется Северный мост."
                    .to_string(),
            },
            ContextPart {
                id: "stt:fact-two".to_string(),
                kind: "stt".to_string(),
                line: "ОС: Контрольный голосовой факт номер два. Для очереди событий нужно использовать очередь, а не стек."
                    .to_string(),
            },
            ContextPart {
                id: "stt:fact-three".to_string(),
                kind: "stt".to_string(),
                line: "ОС: Контрольный голосовой факт номер три. Сложность решения должна быть линейная."
                    .to_string(),
            },
            ContextPart {
                id: "stt:filler".to_string(),
                kind: "stt".to_string(),
                line: format!(
                    "ОС: длинный filler без контрольных фактов {}",
                    "y".repeat(65_000)
                ),
            },
            ContextPart {
                id: "stt:late".to_string(),
                kind: "stt".to_string(),
                line: "ОС: Поздний маркер LATE_CTX_E2E_OMEGA.".to_string(),
            },
        ];

        let context = trim_context_parts(&parts);

        assert!(context.chars().count() <= MAX_CONTEXT_CHARS);
        assert!(context.contains("CODE_CTX_E2E_ALPHA"));
        assert!(context.contains("Северный мост"));
        assert!(context.contains("очереди событий"));
        assert!(context.contains("линейная"));
        assert!(context.contains("LATE_CTX_E2E_OMEGA"));
    }

    #[tokio::test]
    async fn build_context_text_full_history_ignores_context_floor() {
        let state = AppState::default();

        append_system_final(&state, 1, &test_transcription("old question", 100)).await;
        append_system_final(&state, 1, &test_transcription("new question", 200)).await;
        state
            .companion_context_floor_seq
            .store(2, Ordering::Relaxed);

        let recent_context = build_context_text(&state, false).await;
        let full_context = build_context_text(&state, true).await;

        assert!(!recent_context.contains("old question"));
        assert!(full_context.contains("ОС: old question"));
        assert!(full_context.contains("ОС: new question"));
    }

    #[tokio::test]
    async fn build_context_text_skips_deleted_and_unfinished_assistant_messages() {
        let state = AppState::default();

        append_system_final(&state, 1, &test_transcription("question", 100)).await;
        begin_haiku_message(
            &state,
            CompanionHaikuStart {
                request_id: "haiku:streaming".to_string(),
                insert_after_id: None,
                created_at_ms: 120,
                candidates: Vec::new(),
                active_candidate_id: None,
            },
        )
        .await;
        append_haiku_delta(&state, "haiku:streaming", "draft answer").await;
        begin_haiku_message(
            &state,
            CompanionHaikuStart {
                request_id: "haiku:error".to_string(),
                insert_after_id: None,
                created_at_ms: 130,
                candidates: Vec::new(),
                active_candidate_id: None,
            },
        )
        .await;
        append_haiku_delta(&state, "haiku:error", "failed answer").await;
        fail_haiku_message(&state, "haiku:error", "boom").await;

        {
            let mut timeline = state.companion_timeline.write().await;
            let question = timeline
                .iter_mut()
                .find(|message| message.kind == "stt")
                .expect("stt message");
            question.deleted = true;
        }

        let context = build_context_text(&state, false).await;

        assert!(!context.contains("question"));
        assert!(!context.contains("draft answer"));
        assert!(!context.contains("failed answer"));
    }

    #[tokio::test]
    async fn finalized_haiku_ignores_late_deltas_in_same_generation() {
        let state = AppState::default();

        begin_haiku_message(
            &state,
            CompanionHaikuStart {
                request_id: "haiku:req-final".to_string(),
                insert_after_id: None,
                created_at_ms: 300,
                candidates: Vec::new(),
                active_candidate_id: None,
            },
        )
        .await;
        append_haiku_delta(&state, "haiku:req-final", "ordered answer").await;
        finalize_haiku_message(&state, "haiku:req-final").await;
        append_haiku_delta(&state, "haiku:req-final", " late delta").await;

        let timeline = state.companion_timeline.read().await;
        let haiku = timeline
            .iter()
            .find(|message| message.id == "haiku:req-final")
            .expect("haiku message");

        assert_eq!(haiku.status, "final");
        assert_eq!(haiku.text, "ordered answer");
        assert!(!state
            .companion_request_generations
            .read()
            .await
            .contains_key("haiku:req-final"));
    }

    #[tokio::test]
    async fn grouped_haiku_tracks_candidates_and_ignores_late_candidate_deltas() {
        let state = AppState::default();

        begin_haiku_message(
            &state,
            CompanionHaikuStart {
                request_id: "haiku:req-group".to_string(),
                insert_after_id: None,
                created_at_ms: 300,
                candidates: vec![
                    test_candidate("anthropic", "Anthropic"),
                    test_candidate("openai_responses", "OpenAI"),
                ],
                active_candidate_id: Some("anthropic".to_string()),
            },
        )
        .await;

        append_haiku_candidate_delta(&state, "haiku:req-group", Some("anthropic"), "primary").await;
        append_haiku_candidate_delta(
            &state,
            "haiku:req-group",
            Some("openai_responses"),
            "secondary",
        )
        .await;
        finalize_haiku_candidate(&state, "haiku:req-group", Some("openai_responses")).await;
        append_haiku_candidate_delta(&state, "haiku:req-group", Some("openai_responses"), " late")
            .await;

        {
            let timeline = state.companion_timeline.read().await;
            let haiku = timeline
                .iter()
                .find(|message| message.id == "haiku:req-group")
                .expect("haiku message");
            let candidates = haiku.candidates.as_ref().expect("candidate list");
            let openai = candidates
                .iter()
                .find(|candidate| candidate.id == "openai_responses")
                .expect("openai candidate");

            assert_eq!(haiku.status, "streaming");
            assert_eq!(haiku.text, "primary");
            assert_eq!(openai.status, "final");
            assert_eq!(openai.text, "secondary");
            assert!(state
                .companion_request_generations
                .read()
                .await
                .contains_key("haiku:req-group"));
        }

        fail_haiku_candidate(&state, "haiku:req-group", Some("anthropic"), "boom").await;
        append_haiku_candidate_delta(&state, "haiku:req-group", Some("anthropic"), " late").await;

        let timeline = state.companion_timeline.read().await;
        let haiku = timeline
            .iter()
            .find(|message| message.id == "haiku:req-group")
            .expect("haiku message");
        let candidates = haiku.candidates.as_ref().expect("candidate list");
        let anthropic = candidates
            .iter()
            .find(|candidate| candidate.id == "anthropic")
            .expect("anthropic candidate");
        let openai = candidates
            .iter()
            .find(|candidate| candidate.id == "openai_responses")
            .expect("openai candidate");

        assert_eq!(haiku.status, "final");
        assert_eq!(haiku.text, "primary");
        assert_eq!(anthropic.status, "error");
        assert_eq!(anthropic.text, "primary");
        assert_eq!(openai.text, "secondary");
        assert!(!state
            .companion_request_generations
            .read()
            .await
            .contains_key("haiku:req-group"));
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
                candidates: Vec::new(),
                active_candidate_id: None,
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

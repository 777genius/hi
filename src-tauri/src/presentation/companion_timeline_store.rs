use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::presentation::companion::CompanionMessage;
use crate::presentation::AppState;

const VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
static SAVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTimeline {
    version: u32,
    memory_session_id: String,
    history_floor_seq: u64,
    context_floor_seq: u64,
    conversation_generation: u64,
    messages: Vec<CompanionMessage>,
}

fn path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("HACKINTERVIEW_COMPANION_TIMELINE_PATH") {
        return Ok(PathBuf::from(path));
    }
    let base = dirs::config_dir().ok_or("Config directory unavailable")?;
    Ok(base.join("HackInterview").join("companion_timeline.json"))
}

pub async fn restore(state: &AppState) -> Result<(), String> {
    let path = path()?;
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() > MAX_FILE_BYTES {
        return Err("Saved timeline is too large".to_string());
    }
    let bytes = tokio::fs::read(path).await.map_err(|error| error.to_string())?;
    let mut stored: StoredTimeline =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if stored.version != VERSION
        || stored.memory_session_id != state.companion_memory_session_id.read().await.to_string()
    {
        return Ok(());
    }
    for message in &mut stored.messages {
        if message.status == "streaming" {
            message.status = "error".to_string();
            for candidate in message.candidates.iter_mut().flatten() {
                if candidate.status == "streaming" {
                    candidate.status = "error".to_string();
                }
            }
        }
    }
    let next_seq = stored.messages.iter().map(|message| message.seq).max().unwrap_or(0)
        .max(stored.history_floor_seq)
        .max(stored.context_floor_seq);
    let next_stt_index = stored.messages.iter().filter_map(|message| message.stt_index).max().unwrap_or(0);
    *state.companion_timeline.write().await = stored.messages;
    state.companion_next_seq.store(next_seq, Ordering::Relaxed);
    state.companion_next_stt_index.store(next_stt_index, Ordering::Relaxed);
    state.companion_history_floor_seq.store(stored.history_floor_seq, Ordering::Relaxed);
    state.companion_context_floor_seq.store(stored.context_floor_seq, Ordering::Relaxed);
    state.companion_conversation_generation.store(stored.conversation_generation.saturating_add(1), Ordering::Relaxed);
    Ok(())
}

pub fn schedule_save(state: &AppState) {
    let generation = state.companion_timeline_save_generation.fetch_add(1, Ordering::Relaxed) + 1;
    let save_generation = state.companion_timeline_save_generation.clone();
    let timeline = state.companion_timeline.clone();
    let memory_session_id = state.companion_memory_session_id.clone();
    let history_floor_seq = state.companion_history_floor_seq.clone();
    let context_floor_seq = state.companion_context_floor_seq.clone();
    let conversation_generation = state.companion_conversation_generation.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(350)).await;
        let _save_guard = SAVE_LOCK.lock().await;
        if save_generation.load(Ordering::Relaxed) != generation {
            return;
        }
        let stored = StoredTimeline {
            version: VERSION,
            memory_session_id: memory_session_id.read().await.to_string(),
            history_floor_seq: history_floor_seq.load(Ordering::Relaxed),
            context_floor_seq: context_floor_seq.load(Ordering::Relaxed),
            conversation_generation: conversation_generation.load(Ordering::Relaxed),
            messages: timeline.read().await.iter()
                .filter(|message| message.seq > history_floor_seq.load(Ordering::Relaxed))
                .cloned().collect(),
        };
        if let Err(error) = save(&stored).await {
            log::warn!("Failed to save companion timeline: {}", error);
        }
    });
}

pub async fn save_now(state: &AppState) -> Result<(), String> {
    state.companion_timeline_save_generation.fetch_add(1, Ordering::Relaxed);
    let _save_guard = SAVE_LOCK.lock().await;
    let stored = StoredTimeline {
        version: VERSION,
        memory_session_id: state.companion_memory_session_id.read().await.to_string(),
        history_floor_seq: state.companion_history_floor_seq.load(Ordering::Relaxed),
        context_floor_seq: state.companion_context_floor_seq.load(Ordering::Relaxed),
        conversation_generation: state.companion_conversation_generation.load(Ordering::Relaxed),
        messages: state.companion_timeline.read().await.iter()
            .filter(|message| message.seq > state.companion_history_floor_seq.load(Ordering::Relaxed))
            .cloned().collect(),
    };
    save(&stored).await
}

async fn save(stored: &StoredTimeline) -> Result<(), String> {
    let path = path()?;
    let bytes = serialize_bounded(stored, MAX_FILE_BYTES as usize)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    tokio::fs::write(&temporary, bytes).await.map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
            .await.map_err(|error| error.to_string())?;
    }
    tokio::fs::rename(temporary, path).await.map_err(|error| error.to_string())
}

fn serialize_bounded(stored: &StoredTimeline, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(stored).map_err(|error| error.to_string())?;
    if bytes.len() <= limit {
        return Ok(bytes);
    }

    let mut compact = stored.clone();
    let image_message_indexes = compact.messages.iter().enumerate()
        .filter(|(_, message)| message.attachments.as_ref().is_some_and(|items| !items.is_empty()))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let older_count = image_message_indexes.len().saturating_sub(2);
    for index in image_message_indexes.into_iter().take(older_count) {
        compact.messages[index].attachments = None;
        bytes = serde_json::to_vec(&compact).map_err(|error| error.to_string())?;
        if bytes.len() <= limit {
            return Ok(bytes);
        }
    }

    while bytes.len() > limit && compact.messages.len() > 1 {
        compact.messages.remove(0);
        bytes = serde_json::to_vec(&compact).map_err(|error| error.to_string())?;
    }
    if bytes.len() > limit {
        return Err("Latest companion message exceeds storage limit".to_string());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_storage_keeps_latest_image_and_text() {
        let image = "data:image/png;base64,".to_string() + &"A".repeat(1_000);
        let mut messages = Vec::new();
        for index in 0..4 {
            messages.push(CompanionMessage {
                id: format!("message-{index}"),
                seq: index + 1,
                text: format!("remember-{index}"),
                attachments: Some(vec![crate::presentation::companion::CompanionAttachment {
                    id: format!("image-{index}"),
                    kind: "image".into(),
                    mime: "image/png".into(),
                    data_url: image.clone(),
                }]),
                ..Default::default()
            });
        }
        let stored = StoredTimeline {
            version: VERSION,
            memory_session_id: "test".into(),
            history_floor_seq: 0,
            context_floor_seq: 0,
            conversation_generation: 0,
            messages,
        };
        let bytes = serialize_bounded(&stored, 3_400).unwrap();
        let restored: StoredTimeline = serde_json::from_slice(&bytes).unwrap();
        assert!(restored.messages.iter().any(|message| message.text == "remember-0"));
        assert!(restored.messages.last().unwrap().attachments.is_some());
        assert!(bytes.len() <= 3_400);
    }
}

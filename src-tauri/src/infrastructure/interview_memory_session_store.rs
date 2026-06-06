use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;
const DEFAULT_PROFILE_ID: &str = "default";
const DEFAULT_PROFILE_LABEL: &str = "Default interview memory";
const MEMORY_SESSIONS_PATH_ENV: &str = "HACKINTERVIEW_MEMORY_SESSIONS_PATH";
const MEMORY_PROFILE_EXTERNAL_REF_ENV: &str = "INTERVIEW_MEMORY_PROFILE_EXTERNAL_REF";
const MEMORY_PROFILE_REF_ENV: &str = "INTERVIEW_MEMORY_PROFILE_REF";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveInterviewMemorySession {
    pub profile_id: String,
    pub session_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredMemorySessions {
    schema_version: u32,
    active_profile_id: String,
    #[serde(default)]
    sessions: BTreeMap<String, StoredMemorySession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredMemorySession {
    session_id: String,
    label: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}

pub struct InterviewMemorySessionStore;

impl InterviewMemorySessionStore {
    pub async fn load_or_create_active_session() -> Result<ActiveInterviewMemorySession> {
        let path = Self::sessions_path()?;
        let now = now_ms();
        let mut store = Self::read_store_or_default(&path).await;
        let active_profile_id = configured_profile_id()
            .unwrap_or_else(|| normalize_profile_id(&store.active_profile_id));
        let mut changed = store.schema_version != SCHEMA_VERSION
            || store.active_profile_id != active_profile_id
            || active_profile_id != DEFAULT_PROFILE_ID;

        store.schema_version = SCHEMA_VERSION;
        store.active_profile_id = active_profile_id.clone();

        let session_id = store
            .sessions
            .get(&active_profile_id)
            .and_then(|session| Uuid::parse_str(session.session_id.trim()).ok());

        let session_id = match session_id {
            Some(session_id) => session_id,
            None => {
                let session_id = Uuid::new_v4();
                store.sessions.insert(
                    active_profile_id.clone(),
                    StoredMemorySession {
                        session_id: session_id.to_string(),
                        label: DEFAULT_PROFILE_LABEL.to_string(),
                        created_at_ms: now,
                        updated_at_ms: now,
                    },
                );
                changed = true;
                session_id
            }
        };

        if let Some(session) = store.sessions.get_mut(&active_profile_id) {
            if session.label.trim().is_empty() {
                session.label = DEFAULT_PROFILE_LABEL.to_string();
                changed = true;
            }
            session.updated_at_ms = now;
        }

        if changed {
            Self::save_store(&path, &store).await?;
        }

        Ok(ActiveInterviewMemorySession {
            profile_id: active_profile_id,
            session_id,
        })
    }

    async fn read_store_or_default(path: &PathBuf) -> StoredMemorySessions {
        if !path.exists() {
            return default_store();
        }

        let json = match tokio::fs::read_to_string(path).await {
            Ok(json) => json,
            Err(error) => {
                log::warn!("Failed to read interview memory sessions: {}", error);
                return default_store();
            }
        };

        match serde_json::from_str::<StoredMemorySessions>(&json) {
            Ok(store) => store,
            Err(error) => {
                log::warn!("Failed to parse interview memory sessions: {}", error);
                default_store()
            }
        }
    }

    async fn save_store(path: &PathBuf, store: &StoredMemorySessions) -> Result<()> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let json = serde_json::to_string_pretty(store)?;
        let mut tmp = path.clone();
        tmp.set_extension("tmp");
        tokio::fs::write(&tmp, json).await?;
        let _ = tokio::fs::remove_file(path).await;
        tokio::fs::rename(&tmp, path)
            .await
            .with_context(|| format!("Failed to save interview memory sessions to {:?}", path))?;
        Ok(())
    }

    fn sessions_path() -> Result<PathBuf> {
        if let Some(path) = std::env::var_os(MEMORY_SESSIONS_PATH_ENV) {
            return Ok(PathBuf::from(path));
        }

        let config_dir =
            dirs::config_dir().ok_or_else(|| anyhow::anyhow!("Failed to get config directory"))?;
        Ok(config_dir
            .join("HackInterview")
            .join("interview_memory_sessions.json"))
    }
}

fn default_store() -> StoredMemorySessions {
    StoredMemorySessions {
        schema_version: SCHEMA_VERSION,
        active_profile_id: DEFAULT_PROFILE_ID.to_string(),
        sessions: BTreeMap::new(),
    }
}

fn normalize_profile_id(value: &str) -> String {
    let normalized = value.trim();
    if normalized.is_empty() {
        DEFAULT_PROFILE_ID.to_string()
    } else {
        normalized.to_string()
    }
}

fn configured_profile_id() -> Option<String> {
    std::env::var(MEMORY_PROFILE_EXTERNAL_REF_ENV)
        .or_else(|_| std::env::var(MEMORY_PROFILE_REF_ENV))
        .ok()
        .map(|value| normalize_profile_id(&value))
        .filter(|value| value != DEFAULT_PROFILE_ID || profile_env_explicitly_set())
}

fn profile_env_explicitly_set() -> bool {
    std::env::var_os(MEMORY_PROFILE_EXTERNAL_REF_ENV).is_some()
        || std::env::var_os(MEMORY_PROFILE_REF_ENV).is_some()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn load_or_create_reuses_same_active_session() {
        let path = std::env::temp_dir().join(format!(
            "hackinterview-memory-sessions-{}.json",
            Uuid::new_v4()
        ));
        std::env::set_var(MEMORY_SESSIONS_PATH_ENV, &path);
        std::env::remove_var(MEMORY_PROFILE_EXTERNAL_REF_ENV);
        std::env::remove_var(MEMORY_PROFILE_REF_ENV);

        let first = InterviewMemorySessionStore::load_or_create_active_session()
            .await
            .unwrap();
        let second = InterviewMemorySessionStore::load_or_create_active_session()
            .await
            .unwrap();

        assert_eq!(first.profile_id, DEFAULT_PROFILE_ID);
        assert_eq!(first.session_id, second.session_id);
        assert!(path.exists());

        let _ = tokio::fs::remove_file(&path).await;
        std::env::remove_var(MEMORY_SESSIONS_PATH_ENV);
    }

    #[tokio::test]
    #[serial]
    async fn corrupt_store_recovers_with_new_default_session() {
        let path = std::env::temp_dir().join(format!(
            "hackinterview-memory-sessions-{}.json",
            Uuid::new_v4()
        ));
        tokio::fs::write(&path, "{not-json").await.unwrap();
        std::env::set_var(MEMORY_SESSIONS_PATH_ENV, &path);
        std::env::remove_var(MEMORY_PROFILE_EXTERNAL_REF_ENV);
        std::env::remove_var(MEMORY_PROFILE_REF_ENV);

        let active = InterviewMemorySessionStore::load_or_create_active_session()
            .await
            .unwrap();

        assert_eq!(active.profile_id, DEFAULT_PROFILE_ID);
        assert_ne!(active.session_id, Uuid::nil());

        let _ = tokio::fs::remove_file(&path).await;
        std::env::remove_var(MEMORY_SESSIONS_PATH_ENV);
    }

    #[tokio::test]
    #[serial]
    async fn configured_external_profile_gets_its_own_active_session() {
        let path = std::env::temp_dir().join(format!(
            "hackinterview-memory-sessions-{}.json",
            Uuid::new_v4()
        ));
        std::env::set_var(MEMORY_SESSIONS_PATH_ENV, &path);
        std::env::set_var(MEMORY_PROFILE_EXTERNAL_REF_ENV, "fuib-ai-fullstack-2026");
        std::env::remove_var(MEMORY_PROFILE_REF_ENV);

        let active = InterviewMemorySessionStore::load_or_create_active_session()
            .await
            .unwrap();

        assert_eq!(active.profile_id, "fuib-ai-fullstack-2026");
        assert_ne!(active.session_id, Uuid::nil());

        let stored = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(stored.contains("\"activeProfileId\": \"fuib-ai-fullstack-2026\""));

        let _ = tokio::fs::remove_file(&path).await;
        std::env::remove_var(MEMORY_SESSIONS_PATH_ENV);
        std::env::remove_var(MEMORY_PROFILE_EXTERNAL_REF_ENV);
    }
}

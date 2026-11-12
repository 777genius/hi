use std::path::PathBuf;

use super::atomic_file::write_atomic;

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Персистентное хранилище auth состояния (device_id + session).
///
/// Цели:
/// - единый source of truth в Rust (надёжно даже когда WebView "спит")
/// - общий device_id для всех окон (важно для refresh token привязки на сервере)
/// - хранение refresh/access токенов и сроков жизни для фонового refresh
pub struct AuthStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub email_verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSession {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub access_expires_at_ms: i64,
    pub refresh_expires_at_ms: Option<i64>,
    pub user: Option<AuthUser>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStoreData {
    pub device_id: String,
    pub session: Option<AuthSession>,
}

impl AuthStoreData {
    pub fn is_authenticated(&self) -> bool {
        self.session.is_some()
    }
}

impl AuthStore {
    fn config_dir() -> Result<PathBuf> {
        let config_dir =
            dirs::config_dir().ok_or_else(|| anyhow::anyhow!("Failed to get config directory"))?;
        let app_config_dir = config_dir.join("HackInterview");

        // Важно: create_dir_all идемпотентен и надёжнее, чем exists() (race).
        std::fs::create_dir_all(&app_config_dir)?;
        Ok(app_config_dir)
    }

    fn store_path() -> Result<PathBuf> {
        Ok(Self::config_dir()?.join("auth_store.json"))
    }

    fn new_device_id() -> String {
        format!("desktop-{}", uuid::Uuid::new_v4())
    }

    /// Загружает хранилище с диска или создаёт новое (с device_id).
    pub async fn load_or_create() -> Result<AuthStoreData> {
        let path = Self::store_path()?;
        if !path.exists() {
            let data = AuthStoreData {
                device_id: Self::new_device_id(),
                session: None,
            };
            Self::save(&data).await?;
            return Ok(data);
        }

        let json = tokio::fs::read_to_string(&path).await?;
        let mut data: AuthStoreData = serde_json::from_str(&json)?;

        // Защита: device_id обязателен
        if data.device_id.trim().is_empty() {
            data.device_id = Self::new_device_id();
            Self::save(&data).await?;
        }

        Ok(data)
    }

    pub async fn save(data: &AuthStoreData) -> Result<()> {
        let path = Self::store_path()?;
        let json = serde_json::to_string_pretty(data)?;
        write_atomic(&path, &json).await?;
        Ok(())
    }

    pub async fn clear_session_keep_device_id() -> Result<AuthStoreData> {
        let mut data = Self::load_or_create().await?;
        data.session = None;
        Self::save(&data).await?;
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("hackinterview-auth-store-{}", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn atomic_write_replaces_existing_auth_data() {
        let root = test_root();
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("auth_store.json");
        tokio::fs::write(&path, "old auth").await.unwrap();

        write_atomic(&path, "new auth").await.unwrap();

        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "new auth");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1, "no temporary files remain");
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn failed_replacement_preserves_original_and_cleans_temp_file() {
        let root = test_root();
        let target = root.join("auth_store.json");
        tokio::fs::create_dir_all(&target).await.unwrap();

        // A directory cannot be replaced by a JSON file. Verify that the
        // failure leaves the original target intact and does not fall back to
        // a destructive direct write.
        assert!(write_atomic(&target, "new auth").await.is_err());
        assert!(target.is_dir());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}

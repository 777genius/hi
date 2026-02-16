use std::path::{Path, PathBuf};

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
        let config_dir = dirs::config_dir()
            .ok_or_else(|| anyhow::anyhow!("Failed to get config directory"))?;
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

    async fn write_file_atomic(path: &Path, contents: &str) -> Result<()> {
        // Важно: tmp-файл должен быть уникальным, иначе параллельные save() будут конфликтовать.
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Invalid auth store path (no parent)"))?;
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow::anyhow!("Invalid auth store path (bad filename)"))?;
        let tmp = parent.join(format!("{}.tmp.{}", file_name, uuid::Uuid::new_v4()));

        tokio::fs::write(&tmp, contents).await?;
        let _ = tokio::fs::remove_file(path).await;

        match tokio::fs::rename(&tmp, path).await {
            Ok(_) => Ok(()),
            Err(e) => {
                log::warn!(
                    "Atomic rename failed for {:?}: {}. Falling back to direct write.",
                    path,
                    e
                );
                tokio::fs::write(path, contents).await?;
                let _ = tokio::fs::remove_file(&tmp).await;
                Ok(())
            }
        }
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
        Self::write_file_atomic(&path, &json).await?;
        Ok(())
    }

    pub async fn clear_session_keep_device_id() -> Result<AuthStoreData> {
        let mut data = Self::load_or_create().await?;
        data.session = None;
        Self::save(&data).await?;
        Ok(data)
    }
}


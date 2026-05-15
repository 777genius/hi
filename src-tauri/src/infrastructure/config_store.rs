use anyhow::Result;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::{AppConfig, SttConfig, UiPreferences};

/// Маркер "приложение только что обновилось".
///
/// Нужен как safety-net для Windows: после перезапуска приложение по умолчанию стартует скрытым
/// (без taskbar), и пользователь может подумать, что оно не запустилось.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PostUpdateMarker {
    pub version: String,
    pub created_at_ms: i64,
}

/// Персистентное хранилище конфигурации STT
pub struct ConfigStore;

impl ConfigStore {
    async fn write_file_atomic(path: &Path, contents: &str) -> Result<()> {
        // Пишем во временный файл и только потом атомарно подменяем.
        // На Windows rename может падать, если цель уже существует, поэтому делаем best-effort remove.
        let mut tmp = path.to_path_buf();
        tmp.set_extension("tmp");

        tokio::fs::write(&tmp, contents).await?;

        // Best-effort: если файл уже был — убираем, иначе rename может упасть на Windows.
        let _ = tokio::fs::remove_file(path).await;

        match tokio::fs::rename(&tmp, path).await {
            Ok(_) => Ok(()),
            Err(e) => {
                // Фоллбек на прямую запись (на случай нестандартных FS ограничений).
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

    /// Получить директорию конфигурации приложения
    fn config_dir() -> Result<PathBuf> {
        let config_dir =
            dirs::config_dir().ok_or_else(|| anyhow::anyhow!("Failed to get config directory"))?;

        let app_config_dir = config_dir.join("HackInterview");

        // Важно: create_dir_all идемпотентен и надёжнее, чем exists() (race).
        std::fs::create_dir_all(&app_config_dir)?;

        Ok(app_config_dir)
    }

    /// Получить путь к файлу конфигурации STT
    fn config_path() -> Result<PathBuf> {
        Ok(Self::config_dir()?.join("stt_config.json"))
    }

    /// Получить путь к файлу конфигурации приложения
    fn app_config_path() -> Result<PathBuf> {
        Ok(Self::config_dir()?.join("app_config.json"))
    }

    /// Сохранить конфигурацию STT
    pub async fn save_config(config: &SttConfig) -> Result<()> {
        let path = Self::config_path()?;

        let json = serde_json::to_string_pretty(config)?;
        tokio::fs::write(path, json).await?;

        log::debug!("STT config saved to disk");
        Ok(())
    }

    /// Загрузить конфигурацию STT
    pub async fn load_config() -> Result<SttConfig> {
        let path = Self::config_path()?;

        if !path.exists() {
            log::info!("No saved config found, using defaults");
            return Ok(SttConfig::default());
        }

        let json = tokio::fs::read_to_string(path).await?;
        let config: SttConfig = serde_json::from_str(&json)?;

        log::debug!("STT config loaded from disk");
        Ok(config)
    }

    /// Удалить сохраненную конфигурацию
    pub async fn delete_config() -> Result<()> {
        let path = Self::config_path()?;

        if path.exists() {
            tokio::fs::remove_file(path).await?;
            log::info!("STT config deleted");
        }

        Ok(())
    }

    /// Сохранить конфигурацию приложения
    pub async fn save_app_config(config: &AppConfig) -> Result<()> {
        let path = Self::app_config_path()?;

        let json = serde_json::to_string_pretty(config)?;
        tokio::fs::write(path, json).await?;

        log::info!("App config saved to disk");
        Ok(())
    }

    /// Сохранить bridge-файл для локальных интеграций, которым нужен companion token.
    pub async fn save_companion_bridge_token(token: &str) -> Result<()> {
        let paths = Self::companion_bridge_token_paths()?;
        let updated_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let json = serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "companionAccessToken": token,
            "updatedAtMs": updated_at_ms,
        }))?;

        for path in paths {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            Self::write_file_atomic(&path, &json).await?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;

                let permissions = std::fs::Permissions::from_mode(0o600);
                if let Err(error) = tokio::fs::set_permissions(&path, permissions).await {
                    log::warn!(
                        "Failed to tighten companion bridge file permissions: {}",
                        error
                    );
                }
            }
        }

        log::debug!("Companion bridge token saved to disk");
        Ok(())
    }

    /// Загрузить companion token из bridge-файла.
    pub async fn load_companion_bridge_token() -> Result<Option<String>> {
        for path in Self::companion_bridge_token_paths()? {
            if !path.exists() {
                continue;
            }

            let json = tokio::fs::read_to_string(path).await?;
            let value: serde_json::Value = serde_json::from_str(&json)?;
            if let Some(token) = value
                .get("companionAccessToken")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
            {
                return Ok(Some(token));
            }
        }

        Ok(None)
    }

    fn companion_bridge_token_paths() -> Result<Vec<PathBuf>> {
        let config_dir =
            dirs::config_dir().ok_or_else(|| anyhow::anyhow!("Failed to get config directory"))?;
        Ok(vec![
            config_dir.join("ClipboardTools").join("bridge.json"),
            Self::config_dir()?.join("companion_bridge.json"),
        ])
    }

    /// Загрузить конфигурацию приложения
    pub async fn load_app_config() -> Result<AppConfig> {
        let path = Self::app_config_path()?;

        if !path.exists() {
            log::info!("No saved app config found, using defaults");
            return Ok(AppConfig::default());
        }

        let json = tokio::fs::read_to_string(path).await?;
        let mut config: AppConfig = serde_json::from_str(&json)?;

        // Автодействия принудительно выключены в этом форке.
        config.auto_copy_to_clipboard = false;
        config.auto_paste_text = false;

        if config.max_history_items <= AppConfig::LEGACY_MAX_HISTORY_ITEMS {
            let previous_max_history_items = config.max_history_items;
            config.max_history_items = AppConfig::DEFAULT_MAX_HISTORY_ITEMS;
            log::info!(
                "Migrated max_history_items from {} to {}",
                previous_max_history_items,
                config.max_history_items
            );
        }

        log::info!("App config loaded from disk");
        Ok(config)
    }

    /// Получить путь к файлу UI-настроек
    fn ui_preferences_path() -> Result<PathBuf> {
        Ok(Self::config_dir()?.join("ui_preferences.json"))
    }

    /// Получить путь к маркеру пост-апдейта
    fn post_update_marker_path() -> Result<PathBuf> {
        Ok(Self::config_dir()?.join("post_update.json"))
    }

    /// Сохранить маркер пост-апдейта (перед перезапуском приложения).
    pub async fn save_post_update_marker(version: &str) -> Result<()> {
        let path = Self::post_update_marker_path()?;
        let marker = PostUpdateMarker {
            version: version.to_string(),
            created_at_ms: chrono::Utc::now().timestamp_millis(),
        };
        let json = serde_json::to_string_pretty(&marker)?;
        Self::write_file_atomic(&path, &json).await?;
        Ok(())
    }

    /// Прочитать и удалить маркер пост-апдейта (one-shot).
    pub async fn take_post_update_marker() -> Result<Option<PostUpdateMarker>> {
        let path = Self::post_update_marker_path()?;
        if !path.exists() {
            return Ok(None);
        }

        // Best-effort: если файл битый или не читается — всё равно удаляем,
        // чтобы не зацикливаться на каждом старте.
        let marker = match tokio::fs::read_to_string(&path).await {
            Ok(json) => serde_json::from_str::<PostUpdateMarker>(&json).ok(),
            Err(e) => {
                log::warn!("Failed to read post-update marker: {}", e);
                // Файл существует → считаем что апдейт был, даже если payload не удалось прочитать.
                Some(PostUpdateMarker {
                    version: "unknown".to_string(),
                    created_at_ms: 0,
                })
            }
        };

        let _ = tokio::fs::remove_file(&path).await;
        Ok(marker)
    }

    /// Сохранить UI-настройки (тема, локаль)
    pub async fn save_ui_preferences(prefs: &UiPreferences) -> Result<()> {
        let path = Self::ui_preferences_path()?;
        let json = serde_json::to_string_pretty(prefs)?;
        tokio::fs::write(path, json).await?;
        log::info!("UI preferences saved to disk");
        Ok(())
    }

    /// Загрузить UI-настройки
    pub async fn load_ui_preferences() -> Result<UiPreferences> {
        let path = Self::ui_preferences_path()?;
        if !path.exists() {
            log::info!("No saved UI preferences found, using defaults");
            return Ok(UiPreferences::default());
        }
        let json = tokio::fs::read_to_string(path).await?;
        let prefs: UiPreferences = serde_json::from_str(&json)?;
        log::info!("UI preferences loaded from disk");
        Ok(prefs)
    }

    /// Удалить сохраненную конфигурацию приложения
    pub async fn delete_app_config() -> Result<()> {
        let path = Self::app_config_path()?;

        if path.exists() {
            tokio::fs::remove_file(path).await?;
            log::info!("App config deleted");
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SttProviderType;
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn test_save_and_load_stt_config() {
        let _ = ConfigStore::delete_config().await;

        let mut config = SttConfig::default();
        config.provider = SttProviderType::Backend;
        config.language = "ru".to_string();

        ConfigStore::save_config(&config).await.unwrap();
        let loaded = ConfigStore::load_config().await.unwrap();

        assert_eq!(loaded.provider, config.provider);
        assert_eq!(loaded.language, config.language);

        ConfigStore::delete_config().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_load_nonexistent_config_returns_default() {
        let _ = ConfigStore::delete_config().await;

        let loaded = ConfigStore::load_config().await.unwrap();
        assert_eq!(loaded.provider, SttConfig::default().provider);
    }

    #[tokio::test]
    #[serial]
    async fn test_save_and_load_app_config() {
        let _ = ConfigStore::delete_app_config().await;

        let mut config = AppConfig::default();
        config.auto_copy_to_clipboard = true;
        config.auto_paste_text = true;
        config.vad_silence_timeout_ms = 2500;
        config.companion_access_token = Some("stable-token".to_string());

        ConfigStore::save_app_config(&config).await.unwrap();
        let loaded = ConfigStore::load_app_config().await.unwrap();

        // Автодействия принудительно выключены при загрузке.
        assert_eq!(loaded.auto_copy_to_clipboard, false);
        assert_eq!(loaded.auto_paste_text, false);
        assert_eq!(loaded.vad_silence_timeout_ms, config.vad_silence_timeout_ms);
        assert_eq!(
            loaded.companion_access_token.as_deref(),
            Some("stable-token")
        );

        ConfigStore::delete_app_config().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_load_app_config_migrates_legacy_history_limit() {
        let _ = ConfigStore::delete_app_config().await;

        let mut config = AppConfig::default();
        config.max_history_items = AppConfig::LEGACY_MAX_HISTORY_ITEMS;

        ConfigStore::save_app_config(&config).await.unwrap();
        let loaded = ConfigStore::load_app_config().await.unwrap();

        assert_eq!(
            loaded.max_history_items,
            AppConfig::DEFAULT_MAX_HISTORY_ITEMS
        );

        ConfigStore::delete_app_config().await.unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn test_delete_config_is_safe() {
        // Удаление несуществующего конфига должно быть безопасным
        let result = ConfigStore::delete_config().await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    #[serial]
    async fn test_config_paths() {
        let stt_path = ConfigStore::config_path().unwrap();
        let app_path = ConfigStore::app_config_path().unwrap();

        assert!(stt_path.to_str().unwrap().contains("stt_config.json"));
        assert!(app_path.to_str().unwrap().contains("app_config.json"));
    }

    #[tokio::test]
    #[serial]
    async fn post_update_marker_is_one_shot() {
        // Убедимся, что маркер можно поставить и снять.
        ConfigStore::save_post_update_marker("9.9.9").await.unwrap();
        let marker = ConfigStore::take_post_update_marker().await.unwrap();
        assert!(marker.is_some());
        assert_eq!(marker.unwrap().version, "9.9.9");

        // Второй раз маркера уже быть не должно.
        let marker2 = ConfigStore::take_post_update_marker().await.unwrap();
        assert!(marker2.is_none());
    }
}

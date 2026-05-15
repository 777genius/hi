use std::{
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex},
    time::Duration,
};

#[cfg(target_os = "windows")]
use super::config_store::ConfigStore;
use reqwest::StatusCode;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_updater::UpdaterExt;

const UPDATE_MANIFEST_ENDPOINT: &str =
    "https://github.com/777genius/hack_interview_ai/releases/latest/download/latest.json";
const ENABLE_DEV_UPDATER_ENV: &str = "HACKINTERVIEW_ENABLE_DEV_UPDATER";

/// Защита от двойного старта установки.
///
/// В Tauri окна — это отдельные webview'ы, и пользователь теоретически может нажать "Обновить"
/// в двух местах почти одновременно. Обновление — это ресурсная операция, поэтому делаем простой
/// глобальный lock на процесс.
static INSTALL_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Информация о доступном обновлении, которую отдаём во frontend.
#[derive(Clone, serde::Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub body: String,
}

#[derive(Clone, serde::Serialize)]
struct UpdateDownloadProgressPayload {
    version: String,
    downloaded: u64,
    total: Option<u64>,
    progress: Option<u8>,
}

#[derive(Clone, serde::Serialize)]
struct UpdateInstallStagePayload {
    version: String,
}

#[derive(Debug, PartialEq, Eq)]
enum UpdateEndpointState {
    Ready,
    NoUpdate,
    Unavailable(String),
}

fn dev_updater_enabled() -> bool {
    std::env::var(ENABLE_DEV_UPDATER_ENV).as_deref() == Ok("1")
}

fn should_skip_update_check_in_debug() -> bool {
    cfg!(debug_assertions) && !dev_updater_enabled()
}

fn has_update_manifest_shape(value: &serde_json::Value) -> bool {
    let has_version = value.get("version").and_then(|v| v.as_str()).is_some();
    let has_static_manifest = value.get("platforms").and_then(|v| v.as_object()).is_some();
    let has_dynamic_manifest = value.get("url").and_then(|v| v.as_str()).is_some()
        && value.get("signature").and_then(|v| v.as_str()).is_some();

    has_version && (has_static_manifest || has_dynamic_manifest)
}

async fn check_update_endpoint_state() -> Result<UpdateEndpointState, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("Failed to build update endpoint client: {}", e))?;

    let response = client
        .get(UPDATE_MANIFEST_ENDPOINT)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to reach update endpoint: {}", e))?;

    let status = response.status();

    if status == StatusCode::NO_CONTENT {
        return Ok(UpdateEndpointState::NoUpdate);
    }

    if status == StatusCode::NOT_FOUND {
        return Ok(UpdateEndpointState::Unavailable(
            "latest.json was not found in the latest GitHub release".to_string(),
        ));
    }

    if !status.is_success() {
        return Ok(UpdateEndpointState::Unavailable(format!(
            "update endpoint returned {}",
            status
        )));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read update endpoint response: {}", e))?;

    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Update endpoint returned invalid JSON: {}", e))?;

    if has_update_manifest_shape(&value) {
        Ok(UpdateEndpointState::Ready)
    } else {
        Ok(UpdateEndpointState::Unavailable(
            "latest.json is not a valid Tauri updater manifest".to_string(),
        ))
    }
}

/// Запускает фоновую проверку обновлений: сразу при старте, далее каждые 6 часов
pub fn start_background_update_check<R: Runtime>(app: AppHandle<R>) {
    if should_skip_update_check_in_debug() {
        log::debug!(
            "Skipping background update checker in debug build. Set {}=1 to test updater locally",
            ENABLE_DEV_UPDATER_ENV
        );
        return;
    }

    tauri::async_runtime::spawn(async move {
        // Небольшая задержка чтобы приложение успело инициализироваться
        tokio::time::sleep(Duration::from_secs(5)).await;

        loop {
            log::info!("Checking for app updates (background check)");

            match check_for_update(app.clone()).await {
                Ok(Some(update)) => {
                    log::info!("Update available: {}", update.version);
                    // Уведомляем frontend о доступном обновлении
                    if let Err(e) = app.emit("update:available", update) {
                        log::error!("Failed to emit update event: {}", e);
                    }
                }
                Ok(None) => {
                    log::debug!("No updates available");
                }
                Err(e) => {
                    log::error!("Failed to check for updates: {}", e);
                }
            }

            // Ждем 6 часов до следующей проверки
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

/// Проверяет наличие обновлений (без установки)
/// Возвращает версию если доступна, None если обновлений нет
pub async fn check_for_update<R: Runtime>(app: AppHandle<R>) -> Result<Option<UpdateInfo>, String> {
    if should_skip_update_check_in_debug() {
        log::debug!(
            "Skipping update check in debug build. Set {}=1 to test updater locally",
            ENABLE_DEV_UPDATER_ENV
        );
        return Ok(None);
    }

    match check_update_endpoint_state().await? {
        UpdateEndpointState::Ready => {}
        UpdateEndpointState::NoUpdate => {
            log::info!("App is up to date");
            return Ok(None);
        }
        UpdateEndpointState::Unavailable(reason) => {
            log::warn!("Skipping update check: {}", reason);
            return Ok(None);
        }
    }

    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("Failed to build updater: {}", e))?;

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!(
                "Update found: {} (current: {})",
                update.version,
                update.current_version
            );
            Ok(Some(UpdateInfo {
                version: update.version.clone(),
                body: update.body.clone().unwrap_or_default(),
            }))
        }
        Ok(None) => {
            log::info!("App is up to date");
            Ok(None)
        }
        Err(e) => {
            log::error!("Update check failed: {}", e);
            Err(format!("Update check failed: {}", e))
        }
    }
}

/// Проверяет и устанавливает обновление.
///
/// Важно: подтверждение делаем во frontend (наш UpdateDialog), поэтому тут
/// не показываем системный диалог — иначе получится двойное подтверждение.
pub async fn check_and_install_update<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    if should_skip_update_check_in_debug() {
        return Err(format!(
            "Updater is disabled in debug builds. Set {}=1 to test updater locally",
            ENABLE_DEV_UPDATER_ENV
        ));
    }

    match check_update_endpoint_state().await? {
        UpdateEndpointState::Ready => {}
        UpdateEndpointState::NoUpdate => return Ok("No updates available".to_string()),
        UpdateEndpointState::Unavailable(reason) => {
            return Err(format!("Update feed is unavailable: {}", reason));
        }
    }

    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("Failed to build updater: {}", e))?;

    if INSTALL_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Update installation is already in progress".to_string());
    }

    let result = match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let current_version = update.current_version.clone();
            let body = update.body.clone().unwrap_or_default();

            log::info!("Update found: {} -> {}", current_version, version);
            log::info!("Release notes: {}", body);

            // Скачиваем и устанавливаем
            log::info!("Downloading and installing update...");

            let _ = app.emit(
                "update:download-started",
                UpdateInstallStagePayload {
                    version: version.clone(),
                },
            );

            let app_handle_progress = app.clone();
            let version_progress = version.clone();
            let app_handle_installing = app.clone();
            let version_installing = version.clone();
            let downloaded_total = Arc::new(Mutex::new(0u64));
            let downloaded_total_progress = Arc::clone(&downloaded_total);

            update
                .download_and_install(
                    move |chunk_length, content_length| {
                        let chunk_length = chunk_length as u64;

                        // В зависимости от платформы/реализации `chunk_length` может быть:
                        // - либо "сколько скачано всего"
                        // - либо "размер последнего чанка"
                        // Поэтому используем простую эвристику, чтобы корректно считать прогресс.
                        let mut downloaded_total = downloaded_total_progress
                            .lock()
                            .expect("update downloaded_total mutex poisoned");

                        let previous = *downloaded_total;
                        let downloaded = if let Some(total) = content_length {
                            if chunk_length <= total && chunk_length >= previous {
                                chunk_length
                            } else {
                                previous.saturating_add(chunk_length)
                            }
                        } else {
                            previous.saturating_add(chunk_length)
                        };

                        *downloaded_total = downloaded;

                        let progress = content_length.and_then(|total| {
                            if total == 0 {
                                return Some(0);
                            }
                            let pct = ((*downloaded_total as f64 / total as f64) * 100.0)
                                .clamp(0.0, 100.0) as u8;
                            Some(pct)
                        });

                        let _ = app_handle_progress.emit(
                            "update:download-progress",
                            UpdateDownloadProgressPayload {
                                version: version_progress.clone(),
                                downloaded: *downloaded_total,
                                total: content_length,
                                progress,
                            },
                        );
                    },
                    move || {
                        log::info!("Download completed, installing...");
                        let _ = app_handle_installing.emit(
                            "update:installing",
                            UpdateInstallStagePayload {
                                version: version_installing.clone(),
                            },
                        );
                    },
                )
                .await
                .map_err(|e| format!("Failed to download/install update: {}", e))?;

            log::info!("Update installed successfully, restarting...");

            // На Windows приложение стартует скрытым (без taskbar), поэтому после апдейта
            // пользователь может подумать, что "ничего не запустилось".
            // Ставим one-shot marker, чтобы на следующем запуске один раз показать окно.
            #[cfg(target_os = "windows")]
            if let Err(e) = ConfigStore::save_post_update_marker(&version).await {
                log::warn!("Failed to save post-update marker: {}", e);
            }

            // Перезапускаем приложение
            app.restart();
        }
        Ok(None) => {
            log::info!("App is already up to date");
            Ok("No updates available".to_string())
        }
        Err(e) => {
            log::error!("Update check failed: {}", e);
            Err(format!("Failed to check for updates: {}", e))
        }
    };

    // В случае успеха приложение перезапустится (и код дальше не продолжится).
    // Если же мы дошли до сюда — значит либо обновления нет, либо была ошибка, и lock надо снять.
    INSTALL_IN_PROGRESS.store(false, Ordering::SeqCst);

    result
}

#[cfg(test)]
mod tests {
    use super::has_update_manifest_shape;
    use serde_json::json;

    #[test]
    fn accepts_static_manifest_shape() {
        let manifest = json!({
            "version": "1.2.3",
            "platforms": {
                "darwin-aarch64": {
                    "signature": "sig",
                    "url": "https://example.com/app.tar.gz"
                }
            }
        });

        assert!(has_update_manifest_shape(&manifest));
    }

    #[test]
    fn accepts_dynamic_manifest_shape() {
        let manifest = json!({
            "version": "1.2.3",
            "url": "https://example.com/app.tar.gz",
            "signature": "sig"
        });

        assert!(has_update_manifest_shape(&manifest));
    }

    #[test]
    fn rejects_github_not_found_body_shape() {
        let body = json!("Not Found");

        assert!(!has_update_manifest_shape(&body));
    }
}

use tauri::{AppHandle, Emitter, Manager};

use crate::infrastructure::signal::{run_signal_receive_loop, SignalConfig, SignalIncomingMessage};
use crate::presentation::events::{SignalMessagePayload, EVENT_SIGNAL_MESSAGE};
use crate::presentation::AppState;

pub fn start_signal_receiver(app_handle: AppHandle) {
    let Some(config) = SignalConfig::from_env() else {
        log::info!("Signal integration disabled: SIGNAL_ACCOUNT_NUMBER is not configured");
        return;
    };

    log::info!(
        "Signal integration enabled for account {} via {}",
        mask_signal_account(&config.account_number),
        config.api_base_url
    );

    tauri::async_runtime::spawn(async move {
        run_signal_receive_loop(config, move |message| {
            let app_handle = app_handle.clone();
            async move {
                if let Err(err) = ingest_signal_message(&app_handle, message).await {
                    log::warn!("Failed to ingest Signal message: {}", err);
                }
            }
        })
        .await;
    });
}

async fn ingest_signal_message(
    app_handle: &AppHandle,
    message: SignalIncomingMessage,
) -> Result<(), String> {
    let state = app_handle
        .try_state::<AppState>()
        .ok_or_else(|| "AppState is not available".to_string())?;

    let Some(message_id) =
        crate::presentation::companion_timeline::append_signal_message(state.inner(), &message)
            .await
    else {
        return Ok(());
    };

    let payload = SignalMessagePayload {
        id: message_id,
        platform: "signal".to_string(),
        sender: message.sender,
        conversation_id: message.conversation_id,
        text: message.text,
        timestamp: message.timestamp_ms,
    };

    let _ = app_handle.emit(EVENT_SIGNAL_MESSAGE, payload);
    let _ = crate::presentation::companion::publish_snapshot(app_handle).await;
    Ok(())
}

fn mask_signal_account(account: &str) -> String {
    let trimmed = account.trim();
    let visible_tail = trimmed.chars().rev().take(4).collect::<Vec<_>>();
    if visible_tail.is_empty() {
        return "[empty]".to_string();
    }
    let tail = visible_tail.into_iter().rev().collect::<String>();
    format!("***{}", tail)
}

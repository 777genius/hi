#[cfg(target_os = "macos")]
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
pub struct FocusCopyHelperSupervisor {
    stop: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    join: Mutex<Option<JoinHandle<()>>>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusCopyResultEvent {
    #[serde(rename = "type")]
    event_type: String,
    ok: bool,
    text: Option<String>,
    method: Option<String>,
    character_count: usize,
    app_name: Option<String>,
    bundle_id: Option<String>,
    url: Option<String>,
    error: Option<String>,
    elapsed_ms: u64,
}

#[cfg(target_os = "macos")]
impl Drop for FocusCopyHelperSupervisor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);

        if let Ok(mut child_guard) = self.child.lock() {
            if let Some(child) = child_guard.as_mut() {
                log::info!("Stopping focus copy helper child pid={}", child.id());
                let _ = child.kill();
            }
        }

        if let Ok(mut join_guard) = self.join.lock() {
            if let Some(join) = join_guard.take() {
                let _ = join.join();
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn focus_copy_helper_executable() -> PathBuf {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let helper_root = repo_root.join("tools").join("macos-focus-copy-helper");
    let app_executable = helper_root
        .join("dist")
        .join("Telegram.app")
        .join("Contents")
        .join("MacOS")
        .join("Telegram");

    // Accessibility is granted to the app bundle. Starting the bare Swift
    // build makes macOS treat it as a different, untrusted process.
    app_executable
}

#[cfg(target_os = "macos")]
pub fn start_focus_copy_helper_supervisor(
    app_handle: AppHandle,
) -> Option<FocusCopyHelperSupervisor> {
    let executable = focus_copy_helper_executable();
    if !executable.exists() {
        log::warn!(
            "Focus copy helper is not built, skipping auto-start: {}",
            executable.display()
        );
        return None;
    }

    let stop = Arc::new(AtomicBool::new(false));
    let child = Arc::new(Mutex::new(None));
    let thread_stop = Arc::clone(&stop);
    let thread_child = Arc::clone(&child);
    let thread_executable = executable.clone();
    let thread_app_handle = app_handle.clone();

    let join = match thread::Builder::new()
        .name("focus-copy-helper-supervisor".to_string())
        .spawn(move || {
            log::info!(
                "Focus copy helper supervisor started: {}",
                thread_executable.display()
            );

            while !thread_stop.load(Ordering::SeqCst) {
                match Command::new(&thread_executable)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    Ok(mut child_process) => {
                        let pid = child_process.id();
                        log::info!("Focus copy helper started pid={}", pid);

                        if let Some(stdout) = child_process.stdout.take() {
                            spawn_stdout_reader(
                                stdout,
                                thread_app_handle.clone(),
                                Arc::clone(&thread_stop),
                                pid,
                            );
                        } else {
                            log::warn!("Focus copy helper stdout is not available pid={}", pid);
                        }

                        if let Ok(mut guard) = thread_child.lock() {
                            *guard = Some(child_process);
                        } else {
                            log::error!("Focus copy helper child mutex is poisoned");
                            return;
                        }

                        wait_for_child_exit(&thread_child, &thread_stop, pid);
                    }
                    Err(error) => {
                        log::error!(
                            "Failed to start focus copy helper '{}': {}",
                            thread_executable.display(),
                            error
                        );
                    }
                }

                for _ in 0..4 {
                    if thread_stop.load(Ordering::SeqCst) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(250));
                }
            }

            log::info!("Focus copy helper supervisor stopped");
        }) {
        Ok(join) => join,
        Err(error) => {
            log::error!(
                "Failed to create focus copy helper supervisor thread: {}",
                error
            );
            return None;
        }
    };

    Some(FocusCopyHelperSupervisor {
        stop,
        child,
        join: Mutex::new(Some(join)),
    })
}

#[cfg(target_os = "macos")]
fn wait_for_child_exit(child_slot: &Arc<Mutex<Option<Child>>>, stop: &Arc<AtomicBool>, pid: u32) {
    loop {
        if stop.load(Ordering::SeqCst) {
            if let Ok(mut guard) = child_slot.lock() {
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                }
                if let Some(mut child) = guard.take() {
                    let _ = child.wait();
                }
            }
            return;
        }

        let exit_result = {
            let mut guard = match child_slot.lock() {
                Ok(guard) => guard,
                Err(_) => {
                    log::error!("Focus copy helper child mutex is poisoned");
                    return;
                }
            };

            let Some(child) = guard.as_mut() else {
                return;
            };

            match child.try_wait() {
                Ok(Some(status)) => {
                    guard.take();
                    Some(Ok(status))
                }
                Ok(None) => None,
                Err(error) => {
                    guard.take();
                    Some(Err(error))
                }
            }
        };

        match exit_result {
            Some(Ok(status)) => {
                log::warn!(
                    "Focus copy helper pid={} exited with status={:?}; restarting",
                    pid,
                    status.code()
                );
                return;
            }
            Some(Err(error)) => {
                log::error!(
                    "Failed to poll focus copy helper pid={}: {}; restarting",
                    pid,
                    error
                );
                return;
            }
            None => thread::sleep(Duration::from_millis(250)),
        }
    }
}

#[cfg(target_os = "macos")]
fn spawn_stdout_reader(
    stdout: ChildStdout,
    app_handle: AppHandle,
    stop: Arc<AtomicBool>,
    pid: u32,
) {
    let spawn_result = thread::Builder::new()
        .name(format!("focus-copy-helper-stdout-{pid}"))
        .spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if stop.load(Ordering::SeqCst) {
                    break;
                }

                match line {
                    Ok(line) => handle_helper_stdout_line(&app_handle, &line),
                    Err(error) => {
                        log::debug!(
                            "Focus copy helper stdout read failed pid={}: {}",
                            pid,
                            error
                        );
                        break;
                    }
                }
            }
        });

    if let Err(error) = spawn_result {
        log::warn!(
            "Failed to start focus copy helper stdout reader pid={}: {}",
            pid,
            error
        );
    }
}

#[cfg(target_os = "macos")]
fn handle_helper_stdout_line(app_handle: &AppHandle, line: &str) {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') || !trimmed.contains("\"type\":\"focusCopyResult\"") {
        log::debug!("Focus copy helper: {}", trimmed);
        return;
    }

    let event = match serde_json::from_str::<FocusCopyResultEvent>(trimmed) {
        Ok(event) => event,
        Err(error) => {
            log::warn!("Failed to parse focus copy helper event: {}", error);
            return;
        }
    };

    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        ingest_focus_copy_result(app_handle, event).await;
    });
}

#[cfg(target_os = "macos")]
async fn ingest_focus_copy_result(app_handle: AppHandle, event: FocusCopyResultEvent) {
    if event.event_type != "focusCopyResult" {
        return;
    }

    if !event.ok {
        log::warn!(
            "Focus copy failed method={:?}, app={:?}, bundle={:?}, error={:?}, elapsedMs={}",
            event.method,
            event.app_name,
            event.bundle_id,
            event.error,
            event.elapsed_ms
        );
        return;
    }

    let Some(text) = event.text else {
        log::warn!("Focus copy helper reported success without text");
        return;
    };
    if text.trim().is_empty() {
        log::debug!("Focus copy helper returned empty text, skipping chat ingest");
        return;
    }

    let Some(state) = app_handle.try_state::<crate::presentation::AppState>() else {
        log::warn!("Focus copy ingest skipped because AppState is not available");
        return;
    };

    let created_at_ms = now_ms();
    let message_id = crate::presentation::companion_timeline::append_focus_copy_system_final(
        state.inner(),
        text,
        created_at_ms,
        Some(format!("focus-copy:{}", uuid::Uuid::new_v4())),
    )
    .await;

    if message_id.is_none() {
        return;
    }

    match crate::presentation::companion::publish_snapshot(&app_handle).await {
        Ok(_) => {
            log::info!(
                "Focus copy ingested into chat id={:?}, method={:?}, chars={}, app={:?}, bundle={:?}, url={:?}, elapsedMs={}",
                message_id,
                event.method,
                event.character_count,
                event.app_name,
                event.bundle_id,
                event.url,
                event.elapsed_ms
            );
        }
        Err(error) => {
            log::warn!(
                "Focus copy ingested but companion snapshot publish failed: {}",
                error
            );
        }
    }
}

#[cfg(target_os = "macos")]
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

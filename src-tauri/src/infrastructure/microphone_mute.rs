use anyhow::{Context, Result};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Default)]
struct MuteStatusCache {
    value: Option<MicrophoneMuteStatus>,
    checked_at: Option<Instant>,
    refreshing: bool,
    generation: u64,
}

impl MuteStatusCache {
    fn store_fresh(&mut self, value: MicrophoneMuteStatus) {
        self.generation = self.generation.wrapping_add(1);
        self.value = Some(value);
        self.checked_at = Some(Instant::now());
    }
}

fn status_cache() -> &'static Arc<Mutex<MuteStatusCache>> {
    static CACHE: OnceLock<Arc<Mutex<MuteStatusCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Arc::new(Mutex::new(MuteStatusCache::default())))
}

// Snapshot publication must never wait for CoreAudio or an AppleScript child.
// A stuck probe keeps its single-flight slot until it really finishes, rather
// than spawning an unbounded number of timed-out blocking tasks.
fn cached_status_with_probe(
    cache: &Arc<Mutex<MuteStatusCache>>,
    probe: impl FnOnce() -> Result<MicrophoneMuteStatus> + Send + 'static,
) -> Option<MicrophoneMuteStatus> {
    let mut entry = cache.lock().unwrap_or_else(|e| e.into_inner());
    let value = entry.value.clone();
    if entry.refreshing
        || entry
            .checked_at
            .is_some_and(|at| at.elapsed() < Duration::from_secs(1))
    {
        return value;
    }
    entry.refreshing = true;
    let generation = entry.generation;
    drop(entry);
    let cache = Arc::clone(cache);
    tauri::async_runtime::spawn_blocking(move || {
        let result = probe();
        let mut entry = cache.lock().unwrap_or_else(|e| e.into_inner());
        entry.refreshing = false;
        // An explicit mute/read completed while this older probe was running.
        if entry.generation != generation {
            return;
        }
        entry.checked_at = Some(Instant::now());
        if let Ok(status) = result {
            entry.value = Some(status);
        }
    });
    value
}

pub fn cached_microphone_mute_status() -> Option<MicrophoneMuteStatus> {
    cached_status_with_probe(status_cache(), read_microphone_mute_status)
}

/// Explicit user actions retain a fresh OS read and immediately seed snapshots.
pub fn get_microphone_mute_status() -> Result<MicrophoneMuteStatus> {
    let status = read_microphone_mute_status()?;
    status_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .store_fresh(status.clone());
    Ok(status)
}

pub fn set_microphone_muted(
    muted: bool,
    restore_input_volume: Option<u32>,
) -> Result<SetMicrophoneMuteOutcome> {
    let result = set_microphone_muted_native(muted, restore_input_volume)?;
    status_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .store_fresh(result.status.clone());
    Ok(result)
}

#[derive(Debug, Clone)]
pub struct MicrophoneMuteStatus {
    pub muted: bool,
    pub supported: bool,
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct SetMicrophoneMuteOutcome {
    pub status: MicrophoneMuteStatus,
    pub restore_input_volume: Option<u32>,
    pub applied_methods: Vec<String>,
}

#[allow(dead_code)]
const DEFAULT_RESTORE_INPUT_VOLUME: u32 = 75;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::c_void;
    use std::process::Command;

    type AudioObjectID = u32;
    type AudioObjectPropertySelector = u32;
    type AudioObjectPropertyScope = u32;
    type AudioObjectPropertyElement = u32;
    type OSStatus = i32;
    type Boolean = u8;

    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    struct AudioObjectPropertyAddress {
        m_selector: AudioObjectPropertySelector,
        m_scope: AudioObjectPropertyScope,
        m_element: AudioObjectPropertyElement,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectHasProperty(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
        ) -> Boolean;
        fn AudioObjectIsPropertySettable(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            out_is_settable: *mut Boolean,
        ) -> OSStatus;
        fn AudioObjectGetPropertyData(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            io_data_size: *mut u32,
            out_data: *mut c_void,
        ) -> OSStatus;
        fn AudioObjectSetPropertyData(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            in_data_size: u32,
            in_data: *const c_void,
        ) -> OSStatus;
    }

    const fn fourcc(bytes: [u8; 4]) -> u32 {
        u32::from_be_bytes(bytes)
    }

    const AUDIO_OBJECT_SYSTEM_OBJECT: AudioObjectID = 1;
    const AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: AudioObjectPropertyScope = fourcc(*b"glob");
    const AUDIO_OBJECT_PROPERTY_SCOPE_INPUT: AudioObjectPropertyScope = fourcc(*b"inpt");
    const AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: AudioObjectPropertyElement = 0;
    const AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE: AudioObjectPropertySelector =
        fourcc(*b"dIn ");
    const AUDIO_DEVICE_PROPERTY_VOLUME_SCALAR: AudioObjectPropertySelector = fourcc(*b"volm");
    const AUDIO_DEVICE_PROPERTY_MUTE: AudioObjectPropertySelector = fourcc(*b"mute");

    const INPUT_ELEMENTS_TO_TRY: [AudioObjectPropertyElement; 9] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

    fn property_address(
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        element: AudioObjectPropertyElement,
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            m_selector: selector,
            m_scope: scope,
            m_element: element,
        }
    }

    fn default_input_device_id() -> Result<AudioObjectID> {
        let address = property_address(
            AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE,
            AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        );
        let mut data_size = std::mem::size_of::<AudioObjectID>() as u32;
        let mut device_id: AudioObjectID = 0;

        let status = unsafe {
            AudioObjectGetPropertyData(
                AUDIO_OBJECT_SYSTEM_OBJECT,
                &address,
                0,
                std::ptr::null(),
                &mut data_size,
                (&mut device_id as *mut AudioObjectID).cast::<c_void>(),
            )
        };

        if status != 0 || device_id == 0 {
            anyhow::bail!(
                "Failed to get default input device: {}",
                format_osstatus(status)
            );
        }

        Ok(device_id)
    }

    fn has_property(device_id: AudioObjectID, address: &AudioObjectPropertyAddress) -> bool {
        unsafe { AudioObjectHasProperty(device_id, address) != 0 }
    }

    fn is_property_settable(
        device_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
    ) -> bool {
        let mut settable: Boolean = 0;
        let status = unsafe { AudioObjectIsPropertySettable(device_id, address, &mut settable) };
        status == 0 && settable != 0
    }

    fn get_u32_property(
        device_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
    ) -> Result<u32> {
        let mut value: u32 = 0;
        let mut data_size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                device_id,
                address,
                0,
                std::ptr::null(),
                &mut data_size,
                (&mut value as *mut u32).cast::<c_void>(),
            )
        };
        if status != 0 {
            anyhow::bail!("CoreAudio get u32 failed: {}", format_osstatus(status));
        }
        Ok(value)
    }

    fn set_u32_property(
        device_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
        value: u32,
    ) -> Result<()> {
        let status = unsafe {
            AudioObjectSetPropertyData(
                device_id,
                address,
                0,
                std::ptr::null(),
                std::mem::size_of::<u32>() as u32,
                (&value as *const u32).cast::<c_void>(),
            )
        };
        if status != 0 {
            anyhow::bail!("CoreAudio set u32 failed: {}", format_osstatus(status));
        }
        Ok(())
    }

    fn get_f32_property(
        device_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
    ) -> Result<f32> {
        let mut value: f32 = 0.0;
        let mut data_size = std::mem::size_of::<f32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                device_id,
                address,
                0,
                std::ptr::null(),
                &mut data_size,
                (&mut value as *mut f32).cast::<c_void>(),
            )
        };
        if status != 0 {
            anyhow::bail!("CoreAudio get f32 failed: {}", format_osstatus(status));
        }
        Ok(value)
    }

    fn set_f32_property(
        device_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
        value: f32,
    ) -> Result<()> {
        let status = unsafe {
            AudioObjectSetPropertyData(
                device_id,
                address,
                0,
                std::ptr::null(),
                std::mem::size_of::<f32>() as u32,
                (&value as *const f32).cast::<c_void>(),
            )
        };
        if status != 0 {
            anyhow::bail!("CoreAudio set f32 failed: {}", format_osstatus(status));
        }
        Ok(())
    }

    fn read_coreaudio_mute_state(device_id: AudioObjectID) -> Option<bool> {
        let mut found_any = false;
        let mut any_muted = false;

        for element in INPUT_ELEMENTS_TO_TRY {
            let address = property_address(
                AUDIO_DEVICE_PROPERTY_MUTE,
                AUDIO_OBJECT_PROPERTY_SCOPE_INPUT,
                element,
            );
            if !has_property(device_id, &address) {
                continue;
            }
            if let Ok(value) = get_u32_property(device_id, &address) {
                found_any = true;
                if value != 0 {
                    any_muted = true;
                }
            }
        }

        found_any.then_some(any_muted)
    }

    fn set_coreaudio_mute_state(device_id: AudioObjectID, muted: bool) -> usize {
        let mut applied = 0usize;
        let value = if muted { 1 } else { 0 };

        for element in INPUT_ELEMENTS_TO_TRY {
            let address = property_address(
                AUDIO_DEVICE_PROPERTY_MUTE,
                AUDIO_OBJECT_PROPERTY_SCOPE_INPUT,
                element,
            );
            if !has_property(device_id, &address) || !is_property_settable(device_id, &address) {
                continue;
            }

            if let Err(err) = set_u32_property(device_id, &address, value) {
                log::debug!(
                    "Failed to set CoreAudio mute on element {}: {}",
                    element,
                    err
                );
                continue;
            }
            applied += 1;
        }

        applied
    }

    fn read_coreaudio_volume_state(device_id: AudioObjectID) -> Option<(bool, f32)> {
        let mut values = Vec::new();

        for element in INPUT_ELEMENTS_TO_TRY {
            let address = property_address(
                AUDIO_DEVICE_PROPERTY_VOLUME_SCALAR,
                AUDIO_OBJECT_PROPERTY_SCOPE_INPUT,
                element,
            );
            if !has_property(device_id, &address) {
                continue;
            }
            if let Ok(value) = get_f32_property(device_id, &address) {
                values.push(value.clamp(0.0, 1.0));
            }
        }

        if values.is_empty() {
            return None;
        }

        let max_value = values.iter().copied().fold(0.0_f32, f32::max);
        Some((max_value <= 0.0001, max_value))
    }

    fn set_coreaudio_volume_scalar(device_id: AudioObjectID, scalar: f32) -> usize {
        let scalar = scalar.clamp(0.0, 1.0);
        let mut applied = 0usize;

        for element in INPUT_ELEMENTS_TO_TRY {
            let address = property_address(
                AUDIO_DEVICE_PROPERTY_VOLUME_SCALAR,
                AUDIO_OBJECT_PROPERTY_SCOPE_INPUT,
                element,
            );
            if !has_property(device_id, &address) || !is_property_settable(device_id, &address) {
                continue;
            }

            if let Err(err) = set_f32_property(device_id, &address, scalar) {
                log::debug!(
                    "Failed to set CoreAudio input volume on element {}: {}",
                    element,
                    err
                );
                continue;
            }
            applied += 1;
        }

        applied
    }

    fn get_osascript_input_volume() -> Result<u32> {
        let output = Command::new("osascript")
            .args(["-e", "input volume of (get volume settings)"])
            .output()
            .context("Failed to run osascript for input volume")?;

        if !output.status.success() {
            anyhow::bail!(
                "osascript get input volume failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }

        let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let value = raw
            .parse::<u32>()
            .context("Failed to parse osascript input volume")?;

        Ok(value.min(100))
    }

    fn set_osascript_input_volume(value: u32) -> Result<()> {
        let clamped = value.min(100).to_string();
        let status = Command::new("osascript")
            .args(["-e", &format!("set volume input volume {}", clamped)])
            .status()
            .context("Failed to run osascript to set input volume")?;

        if !status.success() {
            anyhow::bail!("osascript set input volume failed");
        }

        Ok(())
    }

    fn detect_status() -> Result<MicrophoneMuteStatus> {
        let device_id = default_input_device_id()?;
        let core_mute = read_coreaudio_mute_state(device_id);
        let core_volume = read_coreaudio_volume_state(device_id);
        // CoreAudio already defines the effective mute state below. Avoid an
        // AppleScript process when it cannot change that result.
        let apple_input_volume = if core_mute.is_none() && core_volume.is_none() {
            get_osascript_input_volume().ok()
        } else {
            None
        };

        let muted = if let Some(core_muted) = core_mute {
            core_muted || core_volume.map(|(muted, _)| muted).unwrap_or(false)
        } else if let Some((volume_muted, _)) = core_volume {
            volume_muted
        } else {
            apple_input_volume == Some(0)
        };

        let mut sources = Vec::new();
        if core_mute.is_some() {
            sources.push("coreaudio-mute");
        }
        if core_volume.is_some() {
            sources.push("coreaudio-volume");
        }
        if apple_input_volume.is_some() {
            sources.push("osascript");
        }

        let source = if sources.is_empty() {
            "unsupported".to_string()
        } else if sources.len() == 1 {
            sources[0].to_string()
        } else {
            "combined".to_string()
        };

        Ok(MicrophoneMuteStatus {
            muted,
            supported: !sources.is_empty(),
            source,
        })
    }

    pub(super) fn get_microphone_mute_status() -> Result<MicrophoneMuteStatus> {
        detect_status()
    }

    pub(super) fn set_microphone_muted(
        muted: bool,
        restore_input_volume: Option<u32>,
    ) -> Result<SetMicrophoneMuteOutcome> {
        let device_id = default_input_device_id()?;
        let current_apple_input_volume = get_osascript_input_volume().ok();
        let current_core_volume = read_coreaudio_volume_state(device_id).map(|(_, v)| v);

        let mut applied_methods = Vec::new();

        if muted {
            let applied_mute = set_coreaudio_mute_state(device_id, true);
            if applied_mute > 0 {
                applied_methods.push("coreaudio-mute".to_string());
            }

            let applied_volume = set_coreaudio_volume_scalar(device_id, 0.0);
            if applied_volume > 0 {
                applied_methods.push("coreaudio-volume".to_string());
            }

            if let Err(err) = set_osascript_input_volume(0) {
                log::debug!("Failed to mute input volume via osascript: {}", err);
            } else {
                applied_methods.push("osascript".to_string());
            }

            let next_restore = current_apple_input_volume
                .filter(|value| *value > 0)
                .or_else(|| {
                    current_core_volume
                        .filter(|value| *value > 0.0001)
                        .map(|value| ((value * 100.0).round() as u32).clamp(1, 100))
                })
                .or(restore_input_volume)
                .or(Some(DEFAULT_RESTORE_INPUT_VOLUME));

            let status = detect_status().unwrap_or(MicrophoneMuteStatus {
                muted: true,
                supported: !applied_methods.is_empty(),
                source: if applied_methods.is_empty() {
                    "unsupported".to_string()
                } else if applied_methods.len() == 1 {
                    applied_methods[0].clone()
                } else {
                    "combined".to_string()
                },
            });

            return Ok(SetMicrophoneMuteOutcome {
                status,
                restore_input_volume: next_restore,
                applied_methods,
            });
        }

        let restore_value = restore_input_volume
            .filter(|value| *value > 0)
            .or(current_apple_input_volume.filter(|value| *value > 0))
            .unwrap_or(DEFAULT_RESTORE_INPUT_VOLUME)
            .min(100);

        let applied_unmute = set_coreaudio_mute_state(device_id, false);
        if applied_unmute > 0 {
            applied_methods.push("coreaudio-mute".to_string());
        }

        let applied_volume = set_coreaudio_volume_scalar(device_id, restore_value as f32 / 100.0);
        if applied_volume > 0 {
            applied_methods.push("coreaudio-volume".to_string());
        }

        if let Err(err) = set_osascript_input_volume(restore_value) {
            log::debug!("Failed to restore input volume via osascript: {}", err);
        } else {
            applied_methods.push("osascript".to_string());
        }

        let status = detect_status().unwrap_or(MicrophoneMuteStatus {
            muted: false,
            supported: !applied_methods.is_empty(),
            source: if applied_methods.is_empty() {
                "unsupported".to_string()
            } else if applied_methods.len() == 1 {
                applied_methods[0].clone()
            } else {
                "combined".to_string()
            },
        });

        Ok(SetMicrophoneMuteOutcome {
            status,
            restore_input_volume: Some(restore_value),
            applied_methods,
        })
    }

    fn format_osstatus(status: OSStatus) -> String {
        if status == 0 {
            return "0".to_string();
        }

        let bytes = status.to_be_bytes();
        if bytes.iter().all(|b| b.is_ascii_graphic() || *b == b' ') {
            format!("{} ('{}')", status, String::from_utf8_lossy(&bytes))
        } else {
            status.to_string()
        }
    }
}

#[cfg(target_os = "macos")]
fn read_microphone_mute_status() -> Result<MicrophoneMuteStatus> {
    macos::get_microphone_mute_status()
}

#[cfg(target_os = "macos")]
fn set_microphone_muted_native(
    muted: bool,
    restore_input_volume: Option<u32>,
) -> Result<SetMicrophoneMuteOutcome> {
    macos::set_microphone_muted(muted, restore_input_volume)
}

#[cfg(not(target_os = "macos"))]
fn read_microphone_mute_status() -> Result<MicrophoneMuteStatus> {
    Ok(MicrophoneMuteStatus {
        muted: false,
        supported: false,
        source: "unsupported".to_string(),
    })
}

#[cfg(not(target_os = "macos"))]
fn set_microphone_muted_native(
    muted: bool,
    restore_input_volume: Option<u32>,
) -> Result<SetMicrophoneMuteOutcome> {
    Ok(SetMicrophoneMuteOutcome {
        status: MicrophoneMuteStatus {
            muted,
            supported: false,
            source: "unsupported".to_string(),
        },
        restore_input_volume,
        applied_methods: Vec::new(),
    })
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use std::sync::mpsc;

    fn status(muted: bool) -> MicrophoneMuteStatus {
        MicrophoneMuteStatus {
            muted,
            supported: true,
            source: "test".into(),
        }
    }

    fn wait_for_refresh(cache: &Arc<Mutex<MuteStatusCache>>) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while cache.lock().unwrap().refreshing {
            assert!(Instant::now() < deadline, "background probe did not finish");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn slow_probe_keeps_cached_mute_and_does_not_block_or_duplicate_refresh() {
        let cache = Arc::new(Mutex::new(MuteStatusCache {
            value: Some(status(true)),
            ..Default::default()
        }));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (values_tx, values_rx) = mpsc::channel();
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reader_probes = Arc::clone(&probes);
        let reader_cache = Arc::clone(&cache);
        let reader = std::thread::spawn(move || {
            let first_probes = Arc::clone(&reader_probes);
            let first = cached_status_with_probe(&reader_cache, move || {
                first_probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(status(false))
            });
            let second = cached_status_with_probe(&reader_cache, move || {
                reader_probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(status(false))
            });
            values_tx.send((first, second)).unwrap();
        });
        let entered = entered_rx.recv_timeout(Duration::from_secs(2));
        let values = values_rx.recv_timeout(Duration::from_millis(250));
        // Release even on assertion failure so a blocking task cannot outlive
        // this test and prevent shutdown.
        let _ = release_tx.send(());
        reader.join().unwrap();
        entered.unwrap();
        let (first, second) = values.expect("snapshots waited for the OS probe");
        assert!(first.unwrap().muted);
        assert!(second.unwrap().muted);
        wait_for_refresh(&cache);
        assert_eq!(probes.load(std::sync::atomic::Ordering::SeqCst), 1);
        let fresh_probes = Arc::clone(&probes);
        let refreshed = cached_status_with_probe(&cache, move || {
            fresh_probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(status(false))
        });
        assert!(!refreshed.unwrap().muted);
        assert!(
            !cache.lock().unwrap().refreshing,
            "fresh cache scheduled another OS probe"
        );
    }

    #[test]
    fn explicit_mute_wins_over_an_older_background_probe() {
        let cache = Arc::new(Mutex::new(MuteStatusCache::default()));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        assert!(cached_status_with_probe(&cache, move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(status(false))
        })
        .is_none());
        let entered = entered_rx.recv_timeout(Duration::from_secs(2));
        cache.lock().unwrap().store_fresh(status(true));
        let _ = release_tx.send(());
        entered.unwrap();
        wait_for_refresh(&cache);
        assert!(
            cached_status_with_probe(&cache, || panic!("fresh value re-probed"))
                .unwrap()
                .muted
        );
    }
}

use async_trait::async_trait;
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::domain::{AudioCapture, AudioChunk, AudioChunkCallback, AudioConfig, AudioError, AudioResult};

/// Linux system output (speaker) capture using PipeWire.
///
/// Notes:
/// - Requires a PipeWire session (most modern Linux distros).
/// - We request 16kHz mono S16LE so downstream (VAD/STT) gets the expected format.
pub struct LinuxOutputAudioCapture {
    audio_config: AudioConfig,
    is_capturing: bool,
    stop_tx: Arc<Mutex<Option<pipewire::channel::Sender<StopMessage>>>>,
    thread_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
}

#[derive(Debug)]
struct StopMessage;

impl LinuxOutputAudioCapture {
    pub fn new() -> AudioResult<Self> {
        Ok(Self {
            audio_config: AudioConfig::default(),
            is_capturing: false,
            stop_tx: Arc::new(Mutex::new(None)),
            thread_handle: Arc::new(Mutex::new(None)),
        })
    }
}

#[async_trait]
impl AudioCapture for LinuxOutputAudioCapture {
    async fn initialize(&mut self, config: AudioConfig) -> AudioResult<()> {
        self.audio_config = config;
        log::info!("LinuxOutputAudioCapture initialized with config: {:?}", config);
        Ok(())
    }

    async fn start_capture(&mut self, on_chunk: AudioChunkCallback) -> AudioResult<()> {
        if self.is_capturing {
            return Err(AudioError::Capture("Already capturing audio".to_string()));
        }

        let (pw_sender, pw_receiver) = pipewire::channel::channel::<StopMessage>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

        let thread_on_chunk = on_chunk.clone();

        let handle = std::thread::Builder::new()
            .name("pipewire-output-capture".to_string())
            .spawn(move || {
                pipewire_thread(thread_on_chunk, pw_receiver, ready_tx);
            })
            .map_err(|e| AudioError::Internal(format!("Failed to spawn pipewire thread: {}", e)))?;

        // Wait for initialization handshake.
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {
                // Store stop sender + thread handle
                if let Ok(mut tx_guard) = self.stop_tx.lock() {
                    *tx_guard = Some(pw_sender);
                }
                if let Ok(mut handle_guard) = self.thread_handle.lock() {
                    *handle_guard = Some(handle);
                }
                self.is_capturing = true;
                log::info!("Linux PipeWire output capture started successfully");
                Ok(())
            }
            Ok(Err(err)) => {
                let _ = handle.join();
                Err(AudioError::Capture(err))
            }
            Err(_) => {
                // Timeout waiting for PipeWire init: stop the thread and fail.
                let _ = pw_sender.send(StopMessage);
                let _ = handle.join();
                Err(AudioError::Capture(
                    "Timed out initializing PipeWire capture".to_string(),
                ))
            }
        }
    }

    async fn stop_capture(&mut self) -> AudioResult<()> {
        if !self.is_capturing {
            return Ok(());
        }

        // Signal stop.
        let tx = self
            .stop_tx
            .lock()
            .ok()
            .and_then(|mut g| g.take());
        if let Some(tx) = tx {
            let _ = tx.send(StopMessage);
        }

        // Join thread.
        let handle = self
            .thread_handle
            .lock()
            .ok()
            .and_then(|mut g| g.take());
        if let Some(handle) = handle {
            let _ = handle.join();
        }

        self.is_capturing = false;
        log::info!("Linux PipeWire output capture stopped");
        Ok(())
    }

    fn is_capturing(&self) -> bool {
        self.is_capturing
    }

    fn config(&self) -> AudioConfig {
        self.audio_config
    }
}

fn pipewire_thread(
    on_chunk: AudioChunkCallback,
    pw_receiver: pipewire::channel::Receiver<StopMessage>,
    ready_tx: std::sync::mpsc::Sender<Result<(), String>>,
) {
    use pipewire::properties::properties;
    use pipewire::stream::{StreamFlags, StreamRc};
    use pipewire::{context::ContextRc, main_loop::MainLoopRc};

    use pipewire::spa::param::audio::{AudioFormat, AudioInfoRaw};
    use pipewire::spa::param::ParamType;
    use pipewire::spa::pod::serialize::PodSerializer;
    use pipewire::spa::pod::{Object, Pod, Value};
    use pipewire::spa::utils::SpaTypes;

    pipewire::init();

    let mainloop = match MainLoopRc::new(None) {
        Ok(ml) => ml,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("MainLoop: {}", e)));
            return;
        }
    };

    let context = match ContextRc::new(&mainloop, None) {
        Ok(ctx) => ctx,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("Context: {}", e)));
            return;
        }
    };

    let core = match context.connect_rc(None) {
        Ok(core) => core,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("Core connect: {}", e)));
            return;
        }
    };

    // Stop receiver: quit the loop on stop message.
    let _stop_receiver = pw_receiver.attach(mainloop.loop_(), {
        let mainloop = mainloop.clone();
        move |_| mainloop.quit()
    });

    // Configure stream properties: capture sink output.
    let props = properties! {
        *pipewire::keys::MEDIA_TYPE => "Audio",
        *pipewire::keys::MEDIA_CATEGORY => "Capture",
        *pipewire::keys::MEDIA_ROLE => "Communication",
        *pipewire::keys::STREAM_CAPTURE_SINK => "true",
        *pipewire::keys::APP_NAME => "HackInterview",
    };

    let stream = match StreamRc::new(core, "system-output-capture", props) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("Stream: {}", e)));
            return;
        }
    };

    // Request 16kHz mono S16LE.
    let mut info = AudioInfoRaw::new();
    info.set_format(AudioFormat::S16LE);
    info.set_rate(16000);
    info.set_channels(1);

    let object = Object {
        type_: SpaTypes::ObjectParamFormat.as_raw() as u32,
        id: ParamType::EnumFormat.as_raw() as u32,
        properties: Vec::from(info),
    };

    let value = Value::Object(object);
    let (cursor, _len) = match PodSerializer::serialize(Cursor::new(Vec::new()), &value) {
        Ok(r) => r,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("Pod serialize: {}", e)));
            return;
        }
    };
    let bytes = cursor.into_inner();
    let pod = match Pod::from_bytes(&bytes) {
        Some(p) => p,
        None => {
            let _ = ready_tx.send(Err("Pod from bytes failed".to_string()));
            return;
        }
    };
    let mut params = [pod];

    // Listener: dequeue buffers and emit chunks.
    let _listener = match stream
        .add_local_listener_with_user_data(on_chunk)
        .process(|stream, on_chunk| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };

            for data in buffer.datas_mut() {
                let chunk = data.chunk();
                let size = chunk.size() as usize;
                if size == 0 {
                    continue;
                }
                let offset = chunk.offset() as usize;

                let Some(bytes) = data.data() else {
                    continue;
                };
                if offset >= bytes.len() {
                    continue;
                }
                let end = offset.saturating_add(size).min(bytes.len());
                let payload = &bytes[offset..end];

                if payload.len() < 2 {
                    continue;
                }

                // Interpret as little-endian i16 PCM.
                let samples: Vec<i16> = payload
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]))
                    .collect();

                if !samples.is_empty() {
                    on_chunk(AudioChunk::new(samples, 16000, 1));
                }
            }
        })
        .register()
    {
        Ok(l) => l,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("Listener register: {}", e)));
            return;
        }
    };

    if let Err(e) = stream.connect(
        pipewire::spa::utils::Direction::Input,
        None,
        StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS | StreamFlags::RT_PROCESS,
        &mut params,
    ) {
        let _ = ready_tx.send(Err(format!("Stream connect: {}", e)));
        return;
    }

    // Handshake back to start_capture.
    let _ = ready_tx.send(Ok(()));

    // Run until stop signal.
    mainloop.run();
}


use std::collections::VecDeque;
use std::future::Future;
use std::process::Stdio;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_SIGNAL_API_BASE_URL: &str = "http://localhost:8081";
const DEFAULT_RECONNECT_MIN_SECONDS: u64 = 1;
const DEFAULT_RECONNECT_MAX_SECONDS: u64 = 30;
const DEFAULT_MESSAGE_REQUEST_ACCEPT_TIMEOUT_SECONDS: u64 = 12;
const DEFAULT_MESSAGE_REQUEST_ACCEPT_RETRY_ATTEMPTS: usize = 5;
const DEFAULT_MESSAGE_REQUEST_ACCEPT_RETRY_DELAY_SECONDS: u64 = 3;
const RECENT_SIGNAL_EVENT_IDS_LIMIT: usize = 512;

#[derive(Debug, Clone)]
pub struct SignalConfig {
    pub api_base_url: String,
    pub account_number: String,
    pub reconnect_min_seconds: u64,
    pub reconnect_max_seconds: u64,
    pub message_request_auto_accept: bool,
    pub message_request_accept_timeout_seconds: u64,
    pub message_request_accept_retry_attempts: usize,
    pub message_request_accept_retry_delay_seconds: u64,
    pub message_request_json_rpc_addr: Option<String>,
    pub message_request_docker_container: Option<String>,
    pub message_request_docker_binary: String,
}

impl SignalConfig {
    pub fn from_env() -> Option<Self> {
        if env_flag_is_false("SIGNAL_ENABLED") {
            return None;
        }

        let account_number = std::env::var("SIGNAL_ACCOUNT_NUMBER")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;
        let api_base_url = std::env::var("SIGNAL_API_BASE_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_SIGNAL_API_BASE_URL.to_string());
        let reconnect_min_seconds = read_env_u64(
            "SIGNAL_RECEIVE_RECONNECT_MIN_SECONDS",
            DEFAULT_RECONNECT_MIN_SECONDS,
        )
        .max(1);
        let reconnect_max_seconds = read_env_u64(
            "SIGNAL_RECEIVE_RECONNECT_MAX_SECONDS",
            DEFAULT_RECONNECT_MAX_SECONDS,
        )
        .max(reconnect_min_seconds);
        let message_request_accept_timeout_seconds = read_env_u64(
            "SIGNAL_MESSAGE_REQUEST_ACCEPT_TIMEOUT_SECONDS",
            DEFAULT_MESSAGE_REQUEST_ACCEPT_TIMEOUT_SECONDS,
        )
        .max(1);
        let message_request_accept_retry_attempts = read_env_usize(
            "SIGNAL_MESSAGE_REQUEST_ACCEPT_RETRY_ATTEMPTS",
            DEFAULT_MESSAGE_REQUEST_ACCEPT_RETRY_ATTEMPTS,
        )
        .max(1);
        let message_request_accept_retry_delay_seconds = read_env_u64(
            "SIGNAL_MESSAGE_REQUEST_ACCEPT_RETRY_DELAY_SECONDS",
            DEFAULT_MESSAGE_REQUEST_ACCEPT_RETRY_DELAY_SECONDS,
        );
        let message_request_json_rpc_addr =
            read_optional_env("SIGNAL_MESSAGE_REQUEST_JSON_RPC_ADDR");
        let message_request_docker_container =
            read_optional_env("SIGNAL_MESSAGE_REQUEST_DOCKER_CONTAINER");
        let message_request_docker_binary =
            read_optional_env("SIGNAL_MESSAGE_REQUEST_DOCKER_BINARY")
                .unwrap_or_else(|| "docker".to_string());

        Some(Self {
            api_base_url,
            account_number,
            reconnect_min_seconds,
            reconnect_max_seconds,
            message_request_auto_accept: env_flag_is_true("SIGNAL_MESSAGE_REQUEST_AUTO_ACCEPT"),
            message_request_accept_timeout_seconds,
            message_request_accept_retry_attempts,
            message_request_accept_retry_delay_seconds,
            message_request_json_rpc_addr,
            message_request_docker_container,
            message_request_docker_binary,
        })
    }

    pub fn receive_ws_url(&self) -> String {
        let base = self.api_base_url.trim().trim_end_matches('/');
        let ws_base = if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{}", rest)
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{}", rest)
        } else {
            base.to_string()
        };
        let account = self.account_number.trim();
        format!(
            "{}/v1/receive/{}?ignore_attachments=true&ignore_stories=true&send_read_receipts=false",
            ws_base, account
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalIncomingMessage {
    pub id: String,
    pub sender: String,
    pub conversation_id: Option<String>,
    pub timestamp_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignalMessageRequest {
    pub id: String,
    pub recipient: String,
    pub sender: String,
    pub timestamp_ms: i64,
    pub reason: String,
}

pub async fn run_signal_receive_loop<F, Fut>(config: SignalConfig, mut on_message: F)
where
    F: FnMut(SignalIncomingMessage) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send,
{
    let mut reconnect_seconds = config.reconnect_min_seconds;
    let mut recent_ids: VecDeque<String> = VecDeque::new();
    let mut recent_message_request_ids: VecDeque<String> = VecDeque::new();

    loop {
        let url = config.receive_ws_url();
        log::info!(
            "Connecting Signal receive WebSocket: {}",
            sanitize_signal_url(&url)
        );
        match connect_async(url.as_str()).await {
            Ok((mut ws, _)) => {
                log::info!("Signal receive WebSocket connected");
                reconnect_seconds = config.reconnect_min_seconds;

                while let Some(next) = ws.next().await {
                    match next {
                        Ok(Message::Text(text)) => {
                            handle_signal_ws_text(
                                &config,
                                &text,
                                &mut recent_ids,
                                &mut recent_message_request_ids,
                                &mut on_message,
                            )
                            .await;
                        }
                        Ok(Message::Binary(bytes)) => {
                            if let Ok(text) = String::from_utf8(bytes) {
                                handle_signal_ws_text(
                                    &config,
                                    &text,
                                    &mut recent_ids,
                                    &mut recent_message_request_ids,
                                    &mut on_message,
                                )
                                .await;
                            }
                        }
                        Ok(Message::Close(frame)) => {
                            log::warn!("Signal receive WebSocket closed: {:?}", frame);
                            break;
                        }
                        Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
                        Err(err) => {
                            log::warn!("Signal receive WebSocket error: {}", err);
                            break;
                        }
                    }
                }
            }
            Err(err) => {
                log::warn!("Signal receive WebSocket connect failed: {}", err);
            }
        }

        let delay = reconnect_seconds.min(config.reconnect_max_seconds);
        tokio::time::sleep(Duration::from_secs(delay)).await;
        reconnect_seconds = (reconnect_seconds.saturating_mul(2)).min(config.reconnect_max_seconds);
    }
}

async fn handle_signal_ws_text<F, Fut>(
    config: &SignalConfig,
    text: &str,
    recent_ids: &mut VecDeque<String>,
    recent_message_request_ids: &mut VecDeque<String>,
    on_message: &mut F,
) where
    F: FnMut(SignalIncomingMessage) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send,
{
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        log::debug!("Ignoring non-JSON Signal WebSocket frame");
        return;
    };

    if let Some(message_request) = parse_signal_message_request(&value) {
        handle_signal_message_request(config, message_request, recent_message_request_ids);
        return;
    }

    let Some(message) = parse_signal_incoming_message(&value) else {
        return;
    };

    if recent_ids.iter().any(|id| id == &message.id) {
        return;
    }
    recent_ids.push_back(message.id.clone());
    while recent_ids.len() > RECENT_SIGNAL_EVENT_IDS_LIMIT {
        recent_ids.pop_front();
    }

    on_message(message).await;
}

fn handle_signal_message_request(
    config: &SignalConfig,
    request: SignalMessageRequest,
    recent_message_request_ids: &mut VecDeque<String>,
) {
    if recent_message_request_ids
        .iter()
        .any(|id| id == &request.id)
    {
        return;
    }
    recent_message_request_ids.push_back(request.id.clone());
    while recent_message_request_ids.len() > RECENT_SIGNAL_EVENT_IDS_LIMIT {
        recent_message_request_ids.pop_front();
    }

    if !config.message_request_auto_accept {
        log::warn!(
            "Signal message request from {} requires approval; receive loop remains connected",
            mask_signal_value(&request.sender)
        );
        return;
    }

    let attempts = config.message_request_accept_retry_attempts;
    let timeout = Duration::from_secs(config.message_request_accept_timeout_seconds);
    let retry_delay = Duration::from_secs(config.message_request_accept_retry_delay_seconds);
    let Some(accepter) = SignalMessageRequestAccepter::from_config(config) else {
        log::warn!(
            "Signal message request from {} cannot be auto-accepted: no JSON-RPC transport configured",
            mask_signal_value(&request.sender)
        );
        return;
    };

    tauri::async_runtime::spawn(async move {
        accept_signal_message_request_with_retries(
            accepter,
            request,
            attempts,
            timeout,
            retry_delay,
        )
        .await;
    });
}

async fn accept_signal_message_request_with_retries(
    accepter: SignalMessageRequestAccepter,
    request: SignalMessageRequest,
    attempts: usize,
    timeout: Duration,
    retry_delay: Duration,
) {
    let attempts = attempts.max(1);
    for attempt in 1..=attempts {
        match tokio::time::timeout(timeout, accepter.accept(&request)).await {
            Ok(Ok(())) => {
                log::info!(
                    "Accepted Signal message request from {} on attempt {}/{}",
                    mask_signal_value(&request.sender),
                    attempt,
                    attempts
                );
                return;
            }
            Ok(Err(err)) => {
                log::warn!(
                    "Failed to accept Signal message request from {} on attempt {}/{}: {}",
                    mask_signal_value(&request.sender),
                    attempt,
                    attempts,
                    err
                );
            }
            Err(_) => {
                log::warn!(
                    "Timed out accepting Signal message request from {} on attempt {}/{}",
                    mask_signal_value(&request.sender),
                    attempt,
                    attempts
                );
            }
        }

        if attempt < attempts && !retry_delay.is_zero() {
            tokio::time::sleep(retry_delay).await;
        }
    }

    log::warn!(
        "Signal message request from {} was not auto-accepted after {} attempts; manual approval can still unblock later messages",
        mask_signal_value(&request.sender),
        attempts
    );
}

pub fn parse_signal_incoming_message(value: &Value) -> Option<SignalIncomingMessage> {
    let envelope = value.get("envelope").unwrap_or(value);
    parse_signal_data_message(value, envelope)
        .or_else(|| parse_signal_note_to_self(value, envelope))
}

pub fn parse_signal_message_request(value: &Value) -> Option<SignalMessageRequest> {
    let envelope = value.get("envelope").unwrap_or(value);
    let exception = value.get("exception")?;
    let reason = exception_reason(exception)?;
    if !looks_like_message_request_or_prekey_error(&reason) {
        return None;
    }

    let recipient = first_string(envelope, &["sourceNumber", "source", "sourceUuid"])?;
    let sender = first_string(
        envelope,
        &["sourceName", "sourceNumber", "source", "sourceUuid"],
    )
    .unwrap_or_else(|| recipient.clone());
    let timestamp_ms =
        first_i64(envelope, &["timestamp", "serverTimestamp"]).unwrap_or_else(now_ms);
    let id = fallback_signal_message_id(&recipient, timestamp_ms, &reason);

    Some(SignalMessageRequest {
        id: format!("signal-message-request:{}", sanitize_id_part(&id)),
        recipient,
        sender,
        timestamp_ms,
        reason,
    })
}

fn parse_signal_data_message(_value: &Value, envelope: &Value) -> Option<SignalIncomingMessage> {
    let data_message = envelope.get("dataMessage")?;
    let text = data_message.get("message")?.as_str()?.trim().to_string();
    if text.is_empty() {
        return None;
    }

    let sender = first_string(envelope, &["source", "sourceNumber", "sourceUuid"])
        .unwrap_or_else(|| "signal:unknown".to_string());
    let timestamp_ms = first_i64(data_message, &["timestamp"])
        .or_else(|| first_i64(envelope, &["timestamp", "serverTimestamp"]))
        .unwrap_or_else(now_ms);
    let conversation_id = signal_conversation_id(data_message).or_else(|| Some(sender.clone()));
    let id = first_string(envelope, &["serverGuid", "guid"])
        .or_else(|| first_string(data_message, &["serverGuid", "guid"]))
        .unwrap_or_else(|| fallback_signal_message_id(&sender, timestamp_ms, &text));

    Some(SignalIncomingMessage {
        id: format!("signal:{}", sanitize_id_part(&id)),
        sender,
        conversation_id,
        timestamp_ms,
        text,
    })
}

fn parse_signal_note_to_self(value: &Value, envelope: &Value) -> Option<SignalIncomingMessage> {
    let sent_message = envelope.get("syncMessage")?.get("sentMessage")?;
    if !is_note_to_self_sync_message(value, envelope, sent_message) {
        return None;
    }

    let text = sent_message.get("message")?.as_str()?.trim().to_string();
    if text.is_empty() {
        return None;
    }

    let sender = first_string(
        envelope,
        &["sourceName", "source", "sourceNumber", "sourceUuid"],
    )
    .unwrap_or_else(|| "signal:note-to-self".to_string());
    let timestamp_ms = first_i64(sent_message, &["timestamp"])
        .or_else(|| first_i64(envelope, &["timestamp", "serverTimestamp"]))
        .unwrap_or_else(now_ms);
    let conversation_id = first_string(
        sent_message,
        &["destination", "destinationNumber", "destinationUuid"],
    )
    .or_else(|| first_string(value, &["account"]))
    .or_else(|| Some(sender.clone()));
    let id = first_string(envelope, &["serverGuid", "guid"])
        .or_else(|| first_string(sent_message, &["serverGuid", "guid"]))
        .unwrap_or_else(|| fallback_signal_message_id(&sender, timestamp_ms, &text));

    Some(SignalIncomingMessage {
        id: format!("signal:{}", sanitize_id_part(&id)),
        sender,
        conversation_id,
        timestamp_ms,
        text,
    })
}

fn is_note_to_self_sync_message(value: &Value, envelope: &Value, sent_message: &Value) -> bool {
    let Some(account) = first_string(value, &["account"]) else {
        return false;
    };
    let source = first_string(envelope, &["source", "sourceNumber"]);
    let destination = first_string(sent_message, &["destination", "destinationNumber"]);

    source.as_deref() == Some(account.as_str()) && destination.as_deref() == Some(account.as_str())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SignalMessageRequestAcceptTransport {
    Tcp {
        addr: String,
    },
    DockerExec {
        docker_binary: String,
        container: String,
        addr: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SignalMessageRequestAccepter {
    account_number: String,
    transport: SignalMessageRequestAcceptTransport,
}

impl SignalMessageRequestAccepter {
    fn from_config(config: &SignalConfig) -> Option<Self> {
        let transport = if let Some(addr) = config.message_request_json_rpc_addr.clone() {
            Some(SignalMessageRequestAcceptTransport::Tcp { addr })
        } else {
            config
                .message_request_docker_container
                .clone()
                .map(
                    |container| SignalMessageRequestAcceptTransport::DockerExec {
                        docker_binary: config.message_request_docker_binary.clone(),
                        container,
                        addr: "127.0.0.1:6001".to_string(),
                    },
                )
        }?;

        Some(Self {
            account_number: config.account_number.clone(),
            transport,
        })
    }

    async fn accept(&self, request: &SignalMessageRequest) -> Result<(), String> {
        let request_body = json!({
            "jsonrpc": "2.0",
            "method": "sendMessageRequestResponse",
            "id": uuid::Uuid::new_v4().to_string(),
            "params": {
                "account": self.account_number,
                "recipient": request.recipient,
                "type": "accept"
            }
        });
        let request_text = request_body.to_string();
        let response = match &self.transport {
            SignalMessageRequestAcceptTransport::Tcp { addr } => {
                send_json_rpc_over_tcp(addr, &request_text).await?
            }
            SignalMessageRequestAcceptTransport::DockerExec {
                docker_binary,
                container,
                addr,
            } => {
                send_json_rpc_via_docker_exec(docker_binary, container, addr, &request_text).await?
            }
        };
        validate_json_rpc_response(&response)
    }
}

async fn send_json_rpc_over_tcp(addr: &str, request_text: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(addr)
        .await
        .map_err(|err| format!("connect {addr}: {err}"))?;
    stream
        .write_all(request_text.as_bytes())
        .await
        .map_err(|err| format!("write JSON-RPC request: {err}"))?;
    stream
        .write_all(b"\n")
        .await
        .map_err(|err| format!("finish JSON-RPC request: {err}"))?;

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .await
        .map_err(|err| format!("read JSON-RPC response: {err}"))?;
    Ok(response)
}

async fn send_json_rpc_via_docker_exec(
    docker_binary: &str,
    container: &str,
    addr: &str,
    request_text: &str,
) -> Result<String, String> {
    let script = r#"
import json
import socket
import sys

addr = sys.argv[1]
request_text = sys.argv[2]
host, port = addr.rsplit(":", 1)

sock = socket.create_connection((host, int(port)), timeout=8)
sock.sendall((request_text + "\n").encode())
sock.settimeout(8)

chunks = []
while True:
    chunk = sock.recv(65536)
    if not chunk:
        break
    chunks.append(chunk)
    if b"\n" in chunk:
        break

sock.close()
sys.stdout.write(b"".join(chunks).decode(errors="replace"))
"#;

    let output = Command::new(docker_binary)
        .arg("exec")
        .arg(container)
        .arg("python3")
        .arg("-c")
        .arg(script)
        .arg(addr)
        .arg(request_text)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|err| format!("run docker exec: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "docker exec exited with {}: {}{}",
            output.status,
            stderr.trim(),
            if stdout.trim().is_empty() {
                String::new()
            } else {
                format!("; stdout: {}", stdout.trim())
            }
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn validate_json_rpc_response(response: &str) -> Result<(), String> {
    let trimmed = response.trim();
    if trimmed.is_empty() {
        return Err("empty JSON-RPC response".to_string());
    }

    let value: Value = serde_json::from_str(trimmed)
        .map_err(|err| format!("invalid JSON-RPC response: {err}; response={trimmed}"))?;
    if let Some(error) = value.get("error") {
        return Err(format!("JSON-RPC error: {error}"));
    }
    if value.get("result").is_none() {
        return Err(format!("JSON-RPC response has no result: {value}"));
    }
    Ok(())
}

fn exception_reason(exception: &Value) -> Option<String> {
    let type_text = first_string(exception, &["type"]);
    let message_text = first_string(exception, &["message"]);
    match (type_text, message_text) {
        (Some(kind), Some(message)) => Some(format!("{kind}: {message}")),
        (Some(kind), None) => Some(kind),
        (None, Some(message)) => Some(message),
        (None, None) => None,
    }
}

fn looks_like_message_request_or_prekey_error(reason: &str) -> bool {
    let normalized = reason.to_ascii_lowercase();
    normalized.contains("protocolinvalidmessageexception")
        || normalized.contains("invalidmessageexception")
        || normalized.contains("prekey")
        || normalized.contains("message request")
        || normalized.contains("decryption failed")
}

fn signal_conversation_id(data_message: &Value) -> Option<String> {
    data_message
        .get("groupInfo")
        .and_then(|group| first_string(group, &["groupId", "id"]))
        .or_else(|| {
            data_message
                .get("groupV2")
                .and_then(|group| first_string(group, &["masterKey", "id"]))
        })
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|candidate| {
            if let Some(text) = candidate.as_str() {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
            if candidate.is_number() || candidate.is_boolean() {
                return Some(candidate.to_string());
            }
            None
        })
}

fn first_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|candidate| {
            candidate
                .as_i64()
                .or_else(|| {
                    candidate
                        .as_u64()
                        .and_then(|value| i64::try_from(value).ok())
                })
                .or_else(|| {
                    candidate
                        .as_str()
                        .and_then(|value| value.trim().parse::<i64>().ok())
                })
        })
}

fn fallback_signal_message_id(sender: &str, timestamp_ms: i64, text: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    sender.hash(&mut hasher);
    timestamp_ms.hash(&mut hasher);
    text.hash(&mut hasher);
    format!("{}:{}:{:016x}", sender, timestamp_ms, hasher.finish())
}

fn sanitize_id_part(value: &str) -> String {
    let mut out = String::with_capacity(value.len().min(96));
    for ch in value.chars().take(96) {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "unknown".to_string()
    } else {
        out
    }
}

fn sanitize_signal_url(url: &str) -> String {
    url.split("/v1/receive/")
        .next()
        .map(|base| format!("{}/v1/receive/[account]", base))
        .unwrap_or_else(|| "[signal-url]".to_string())
}

fn read_env_u64(key: &str, fallback: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
}

fn read_env_usize(key: &str, fallback: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(fallback)
}

fn read_optional_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_flag_is_true(key: &str) -> bool {
    std::env::var(key)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn env_flag_is_false(key: &str) -> bool {
    std::env::var(key)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no"
            )
        })
        .unwrap_or(false)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn mask_signal_value(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() <= 8 {
        return "***".to_string();
    }
    let tail = trimmed.chars().rev().take(4).collect::<Vec<_>>();
    format!("***{}", tail.into_iter().rev().collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn receive_ws_url_converts_http_to_ws_and_keeps_number_literal() {
        let config = SignalConfig {
            api_base_url: "http://localhost:8081/".to_string(),
            account_number: "+380001112233".to_string(),
            reconnect_min_seconds: 1,
            reconnect_max_seconds: 30,
            message_request_auto_accept: false,
            message_request_accept_timeout_seconds: 12,
            message_request_accept_retry_attempts: 5,
            message_request_accept_retry_delay_seconds: 3,
            message_request_json_rpc_addr: None,
            message_request_docker_container: None,
            message_request_docker_binary: "docker".to_string(),
        };

        assert_eq!(
            config.receive_ws_url(),
            "ws://localhost:8081/v1/receive/+380001112233?ignore_attachments=true&ignore_stories=true&send_read_receipts=false"
        );
    }

    #[test]
    fn parses_data_message_text() {
        let parsed = parse_signal_incoming_message(&json!({
            "envelope": {
                "source": "+111",
                "serverGuid": "abc-123",
                "timestamp": 1710000000123i64,
                "dataMessage": {
                    "message": "  hello from signal  "
                }
            }
        }))
        .expect("message");

        assert_eq!(parsed.id, "signal:abc-123");
        assert_eq!(parsed.sender, "+111");
        assert_eq!(parsed.conversation_id.as_deref(), Some("+111"));
        assert_eq!(parsed.timestamp_ms, 1710000000123);
        assert_eq!(parsed.text, "hello from signal");
    }

    #[test]
    fn ignores_typing_and_empty_messages() {
        assert!(parse_signal_incoming_message(&json!({
            "envelope": {
                "source": "+111",
                "typingMessage": { "action": "STARTED" }
            }
        }))
        .is_none());

        assert!(parse_signal_incoming_message(&json!({
            "envelope": {
                "source": "+111",
                "dataMessage": { "message": "   " }
            }
        }))
        .is_none());
    }

    #[test]
    fn parses_note_to_self_sync_message() {
        let parsed = parse_signal_incoming_message(&json!({
            "account": "+111",
            "envelope": {
                "source": "+111",
                "sourceNumber": "+111",
                "sourceName": "Me",
                "timestamp": 1710000000123i64,
                "syncMessage": {
                    "sentMessage": {
                        "destination": "+111",
                        "destinationNumber": "+111",
                        "timestamp": 1710000000456i64,
                        "message": "  note from signal  "
                    }
                }
            }
        }))
        .expect("message");

        assert_eq!(parsed.sender, "Me");
        assert_eq!(parsed.conversation_id.as_deref(), Some("+111"));
        assert_eq!(parsed.timestamp_ms, 1710000000456);
        assert_eq!(parsed.text, "note from signal");
    }

    #[test]
    fn ignores_non_self_sync_sent_messages() {
        assert!(parse_signal_incoming_message(&json!({
            "account": "+111",
            "envelope": {
                "source": "+111",
                "sourceNumber": "+111",
                "syncMessage": {
                    "sentMessage": {
                        "destination": "+222",
                        "destinationNumber": "+222",
                        "timestamp": 1710000000456i64,
                        "message": "outgoing to someone else"
                    }
                }
            }
        }))
        .is_none());
    }

    #[test]
    fn parses_message_request_prekey_exception_with_number() {
        let parsed = parse_signal_message_request(&json!({
            "exception": {
                "type": "ProtocolInvalidMessageException",
                "message": "org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed"
            },
            "envelope": {
                "source": "+222",
                "sourceNumber": "+222",
                "sourceUuid": "uuid-222",
                "sourceName": "Candidate",
                "timestamp": 1710000000123i64
            },
            "account": "+111"
        }))
        .expect("message request");

        assert_eq!(parsed.recipient, "+222");
        assert_eq!(parsed.sender, "Candidate");
        assert_eq!(parsed.timestamp_ms, 1710000000123);
        assert!(parsed.reason.contains("ProtocolInvalidMessageException"));
    }

    #[test]
    fn parses_message_request_prekey_exception_with_uuid_fallback() {
        let parsed = parse_signal_message_request(&json!({
            "exception": {
                "message": "invalid PreKey message: decryption failed"
            },
            "envelope": {
                "source": "aff3c5da-8c55-4a88-aa6a-cea3d8428d14",
                "sourceNumber": null,
                "sourceUuid": "aff3c5da-8c55-4a88-aa6a-cea3d8428d14",
                "timestamp": 1710000000123i64
            }
        }))
        .expect("message request");

        assert_eq!(parsed.recipient, "aff3c5da-8c55-4a88-aa6a-cea3d8428d14");
        assert_eq!(parsed.sender, "aff3c5da-8c55-4a88-aa6a-cea3d8428d14");
    }

    #[test]
    fn ignores_unrelated_signal_exception() {
        assert!(parse_signal_message_request(&json!({
            "exception": {
                "type": "RateLimitException",
                "message": "retry later"
            },
            "envelope": {
                "source": "+222",
                "timestamp": 1710000000123i64
            }
        }))
        .is_none());
    }

    #[test]
    fn builds_docker_accept_transport_from_config() {
        let config = SignalConfig {
            api_base_url: "http://localhost:8081".to_string(),
            account_number: "+111".to_string(),
            reconnect_min_seconds: 1,
            reconnect_max_seconds: 30,
            message_request_auto_accept: true,
            message_request_accept_timeout_seconds: 12,
            message_request_accept_retry_attempts: 5,
            message_request_accept_retry_delay_seconds: 3,
            message_request_json_rpc_addr: None,
            message_request_docker_container: Some("signal-api".to_string()),
            message_request_docker_binary: "/usr/local/bin/docker".to_string(),
        };

        let accepter = SignalMessageRequestAccepter::from_config(&config).expect("accepter");
        assert_eq!(accepter.account_number, "+111");
        assert_eq!(
            accepter.transport,
            SignalMessageRequestAcceptTransport::DockerExec {
                docker_binary: "/usr/local/bin/docker".to_string(),
                container: "signal-api".to_string(),
                addr: "127.0.0.1:6001".to_string()
            }
        );
    }

    #[test]
    fn validates_json_rpc_accept_response() {
        assert!(validate_json_rpc_response(r#"{"jsonrpc":"2.0","result":{},"id":"1"}"#).is_ok());
        assert!(validate_json_rpc_response(
            r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"boom"},"id":"1"}"#
        )
        .is_err());
        assert!(validate_json_rpc_response("").is_err());
    }

    #[tokio::test]
    async fn message_request_exception_does_not_block_following_message() {
        let config = SignalConfig {
            api_base_url: "http://localhost:8081".to_string(),
            account_number: "+111".to_string(),
            reconnect_min_seconds: 1,
            reconnect_max_seconds: 30,
            message_request_auto_accept: false,
            message_request_accept_timeout_seconds: 12,
            message_request_accept_retry_attempts: 5,
            message_request_accept_retry_delay_seconds: 3,
            message_request_json_rpc_addr: None,
            message_request_docker_container: None,
            message_request_docker_binary: "docker".to_string(),
        };
        let mut recent_ids = VecDeque::new();
        let mut recent_message_request_ids = VecDeque::new();
        let messages = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let mut on_message = {
            let messages = messages.clone();
            move |message: SignalIncomingMessage| {
                let messages = messages.clone();
                async move {
                    messages.lock().unwrap().push(message.text);
                }
            }
        };

        handle_signal_ws_text(
            &config,
            &json!({
                "exception": {
                    "type": "ProtocolInvalidMessageException",
                    "message": "invalid PreKey message: decryption failed"
                },
                "envelope": {
                    "source": "+222",
                    "sourceNumber": "+222",
                    "timestamp": 1710000000123i64
                }
            })
            .to_string(),
            &mut recent_ids,
            &mut recent_message_request_ids,
            &mut on_message,
        )
        .await;

        handle_signal_ws_text(
            &config,
            &json!({
                "envelope": {
                    "source": "+222",
                    "timestamp": 1710000000999i64,
                    "dataMessage": {
                        "message": "after manual approval"
                    }
                }
            })
            .to_string(),
            &mut recent_ids,
            &mut recent_message_request_ids,
            &mut on_message,
        )
        .await;

        assert_eq!(
            messages.lock().unwrap().as_slice(),
            ["after manual approval"]
        );
    }

    #[tokio::test]
    #[ignore]
    async fn live_accept_message_request_via_configured_transport() {
        let config = SignalConfig::from_env().expect("SIGNAL_ACCOUNT_NUMBER");
        let recipient = std::env::var("SIGNAL_LIVE_MESSAGE_REQUEST_RECIPIENT")
            .expect("SIGNAL_LIVE_MESSAGE_REQUEST_RECIPIENT");
        let accepter = SignalMessageRequestAccepter::from_config(&config).expect(
            "SIGNAL_MESSAGE_REQUEST_JSON_RPC_ADDR or SIGNAL_MESSAGE_REQUEST_DOCKER_CONTAINER",
        );
        let request = SignalMessageRequest {
            id: "live-message-request-canary".to_string(),
            recipient,
            sender: "live-message-request-canary".to_string(),
            timestamp_ms: now_ms(),
            reason: "live canary".to_string(),
        };

        accepter
            .accept(&request)
            .await
            .expect("accept message request");
    }
}

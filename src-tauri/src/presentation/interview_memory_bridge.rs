use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::presentation::AppState;

const DEFAULT_API_BASE_URL: &str = "https://api.voicetext.site";
const DEFAULT_CONTEXT_BUDGET_CHARS: usize = 48_000;
const DEFAULT_MAX_MEMORY_CANDIDATES: u64 = 2_000;
const DEFAULT_MAX_MEMORY_RESULTS: usize = 32;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct MemoryMetadataRequest {
    source_event_id: Option<String>,
    route: Option<String>,
    attached_to_prompt: bool,
    pinned: bool,
    explicit_interview_context: bool,
    final_answer: bool,
    request_scoped: bool,
}

impl Default for MemoryMetadataRequest {
    fn default() -> Self {
        Self {
            source_event_id: None,
            route: Some("desktop_companion".to_string()),
            attached_to_prompt: false,
            pinned: false,
            explicit_interview_context: false,
            final_answer: false,
            request_scoped: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct IngestMemoryRequest {
    session_id: String,
    event_id: Option<String>,
    source: String,
    seq_start: Option<i64>,
    seq_end: Option<i64>,
    occurred_at: Option<String>,
    text: String,
    language: Option<String>,
    kind_hint: Option<String>,
    metadata: MemoryMetadataRequest,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct RequestEvidenceDto {
    id: String,
    label: String,
    text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct AssembleContextRequest {
    session_id: String,
    context_snapshot_id: Option<String>,
    current_request: RequestEvidenceDto,
    selected_messages: Vec<RequestEvidenceDto>,
    current_code: Vec<RequestEvidenceDto>,
    recent_timeline: Vec<RequestEvidenceDto>,
    budget_max_chars: Option<usize>,
    max_memory_candidates: Option<u64>,
    max_memory_results: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct ApiSuccess<T> {
    data: T,
}

#[derive(Debug, Deserialize)]
struct AssembleContextResponse {
    text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryTimelineSource {
    SystemAudio,
    Microphone,
    ManualPrompt,
    AiResponse,
    FocusCopy,
}

#[derive(Debug, Clone)]
pub struct MemoryTimelineEvent {
    pub source: MemoryTimelineSource,
    pub event_id: String,
    pub text: String,
    pub created_at_ms: i64,
    pub seq: Option<u64>,
    pub attached_to_prompt: bool,
    pub final_answer: bool,
}

pub fn is_enabled() -> bool {
    env_flag("INTERVIEW_MEMORY_ENABLED")
        || env_flag("HACKINTERVIEW_INTERVIEW_MEMORY_ENABLED")
        || env_flag("INTERVIEW_MEMORY_ACTIVE_CONTEXT")
}

pub async fn reset_session(state: &AppState) {
    let previous_session_id = {
        let mut session_id = state.companion_memory_session_id.write().await;
        let previous_session_id = *session_id;
        *session_id = Uuid::new_v4();
        previous_session_id
    };

    if !is_enabled() {
        return;
    }

    let Some(auth_token) = auth_token(state).await else {
        return;
    };

    tauri::async_runtime::spawn(async move {
        if let Err(err) = delete_session(previous_session_id, &auth_token).await {
            log::warn!("Interview memory session delete skipped: {}", err);
        }
    });
}

pub async fn spawn_ingest_timeline_event(state: &AppState, event: MemoryTimelineEvent) {
    if !is_enabled() {
        return;
    }

    let Some(auth_token) = auth_token(state).await else {
        return;
    };
    let text = event.text.trim().to_string();
    if text.is_empty() {
        return;
    }
    let session_id = memory_session_id(state).await;
    let request = build_ingest_request(session_id, MemoryTimelineEvent { text, ..event });

    tauri::async_runtime::spawn(async move {
        if let Err(err) = post_json::<_, serde_json::Value>(
            "/api/v1/interview-memory/ingest",
            &auth_token,
            &request,
        )
        .await
        {
            log::warn!("Interview memory ingest skipped: {}", err);
        }
    });
}

pub async fn assemble_stream_context_or_fallback(state: &AppState, local_context: &str) -> String {
    if !is_enabled() {
        return local_context.to_string();
    }

    match assemble_stream_context(state, local_context).await {
        Ok(Some(text)) => text,
        Ok(None) => local_context.to_string(),
        Err(err) => {
            log::warn!("Interview memory active context fallback: {}", err);
            local_context.to_string()
        }
    }
}

pub async fn assemble_chat_context_or_fallback(
    state: &AppState,
    local_context: &str,
    question: &str,
) -> Option<String> {
    if !is_enabled() {
        return None;
    }

    match assemble_chat_context(state, local_context, question).await {
        Ok(text) => text,
        Err(err) => {
            log::warn!("Interview memory chat context fallback: {}", err);
            None
        }
    }
}

async fn assemble_stream_context(
    state: &AppState,
    local_context: &str,
) -> Result<Option<String>, String> {
    let trimmed = local_context.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let Some(auth_token) = auth_token(state).await else {
        return Ok(None);
    };

    let session_id = memory_session_id(state).await;
    let request = build_stream_context_request(session_id, trimmed.to_string());
    let response = post_json::<_, AssembleContextResponse>(
        "/api/v1/interview-memory/context",
        &auth_token,
        &request,
    )
    .await?;

    let text = response.text.trim().to_string();
    Ok((!text.is_empty()).then_some(text))
}

async fn assemble_chat_context(
    state: &AppState,
    local_context: &str,
    question: &str,
) -> Result<Option<String>, String> {
    let context = local_context.trim();
    let question = question.trim();
    if context.is_empty() && question.is_empty() {
        return Ok(None);
    }
    let Some(auth_token) = auth_token(state).await else {
        return Ok(None);
    };

    let session_id = memory_session_id(state).await;
    let request = build_chat_context_request(session_id, context.to_string(), question.to_string());
    let response = post_json::<_, AssembleContextResponse>(
        "/api/v1/interview-memory/context",
        &auth_token,
        &request,
    )
    .await?;

    let text = response.text.trim().to_string();
    Ok((!text.is_empty()).then_some(text))
}

async fn post_json<TRequest, TResponse>(
    path: &str,
    auth_token: &str,
    body: &TRequest,
) -> Result<TResponse, String>
where
    TRequest: Serialize + ?Sized,
    TResponse: for<'de> Deserialize<'de>,
{
    let url = format!("{}{}", api_base_url().trim_end_matches('/'), path);
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(auth_token)
        .json(body)
        .timeout(std::time::Duration::from_secs(4))
        .send()
        .await
        .map_err(|err| format!("request failed: {err}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("status={status} body={body}"));
    }

    response
        .json::<ApiSuccess<TResponse>>()
        .await
        .map(|envelope| envelope.data)
        .map_err(|err| format!("invalid response: {err}"))
}

async fn delete_session(session_id: Uuid, auth_token: &str) -> Result<(), String> {
    let url = format!(
        "{}/api/v1/interview-memory/sessions/{}",
        api_base_url().trim_end_matches('/'),
        session_id
    );
    let response = reqwest::Client::new()
        .delete(url)
        .bearer_auth(auth_token)
        .timeout(std::time::Duration::from_secs(4))
        .send()
        .await
        .map_err(|err| format!("request failed: {err}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("status={status} body={body}"));
    }

    Ok(())
}

async fn auth_token(state: &AppState) -> Option<String> {
    state
        .auth_store
        .read()
        .await
        .session
        .as_ref()
        .map(|session| session.access_token.trim().to_string())
        .filter(|token| !token.is_empty())
        .or_else(|| std::env::var("INTERVIEW_MEMORY_AUTH_TOKEN").ok())
}

async fn memory_session_id(state: &AppState) -> Uuid {
    *state.companion_memory_session_id.read().await
}

fn build_ingest_request(session_id: Uuid, event: MemoryTimelineEvent) -> IngestMemoryRequest {
    let source = source_to_backend(event.source).to_string();
    let metadata = MemoryMetadataRequest {
        source_event_id: Some(event.event_id.clone()),
        attached_to_prompt: event.attached_to_prompt,
        explicit_interview_context: matches!(
            event.source,
            MemoryTimelineSource::SystemAudio
                | MemoryTimelineSource::Microphone
                | MemoryTimelineSource::ManualPrompt
                | MemoryTimelineSource::FocusCopy
        ),
        final_answer: event.final_answer,
        ..MemoryMetadataRequest::default()
    };

    IngestMemoryRequest {
        session_id: session_id.to_string(),
        event_id: Some(event.event_id),
        source,
        seq_start: event.seq.map(|seq| seq as i64),
        seq_end: event.seq.map(|seq| seq as i64),
        occurred_at: timestamp_ms_to_rfc3339(event.created_at_ms),
        text: event.text,
        language: None,
        kind_hint: None,
        metadata,
    }
}

fn build_stream_context_request(session_id: Uuid, local_context: String) -> AssembleContextRequest {
    AssembleContextRequest {
        session_id: session_id.to_string(),
        context_snapshot_id: Some(format!("desktop-stream-{}", Uuid::new_v4())),
        current_request: RequestEvidenceDto {
            id: "current-context".to_string(),
            label: "current_request".to_string(),
            text: local_context,
        },
        selected_messages: Vec::new(),
        current_code: Vec::new(),
        recent_timeline: Vec::new(),
        budget_max_chars: Some(DEFAULT_CONTEXT_BUDGET_CHARS),
        max_memory_candidates: Some(DEFAULT_MAX_MEMORY_CANDIDATES),
        max_memory_results: Some(DEFAULT_MAX_MEMORY_RESULTS),
    }
}

fn build_chat_context_request(
    session_id: Uuid,
    local_context: String,
    question: String,
) -> AssembleContextRequest {
    AssembleContextRequest {
        session_id: session_id.to_string(),
        context_snapshot_id: Some(format!("desktop-chat-{}", Uuid::new_v4())),
        current_request: RequestEvidenceDto {
            id: "current-question".to_string(),
            label: "request".to_string(),
            text: if question.trim().is_empty() {
                "Ответь по текущему контексту.".to_string()
            } else {
                question
            },
        },
        selected_messages: Vec::new(),
        current_code: Vec::new(),
        recent_timeline: (!local_context.trim().is_empty())
            .then(|| RequestEvidenceDto {
                id: "local-context".to_string(),
                label: "recent_timeline".to_string(),
                text: local_context,
            })
            .into_iter()
            .collect(),
        budget_max_chars: Some(DEFAULT_CONTEXT_BUDGET_CHARS),
        max_memory_candidates: Some(DEFAULT_MAX_MEMORY_CANDIDATES),
        max_memory_results: Some(DEFAULT_MAX_MEMORY_RESULTS),
    }
}

fn source_to_backend(source: MemoryTimelineSource) -> &'static str {
    match source {
        MemoryTimelineSource::SystemAudio => "system_audio",
        MemoryTimelineSource::Microphone => "microphone",
        MemoryTimelineSource::ManualPrompt => "manual_prompt",
        MemoryTimelineSource::AiResponse => "ai_response",
        MemoryTimelineSource::FocusCopy => "focus_copy",
    }
}

fn timestamp_ms_to_rfc3339(timestamp_ms: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp_ms)
        .map(|timestamp| timestamp.to_rfc3339())
}

fn api_base_url() -> String {
    std::env::var("VOICE_TO_TEXT_API_URL")
        .or_else(|_| std::env::var("VITE_API_URL"))
        .unwrap_or_else(|_| DEFAULT_API_BASE_URL.to_string())
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_request_marks_microphone_as_explicit_session_context() {
        let session_id = Uuid::new_v4();
        let request = build_ingest_request(
            session_id,
            MemoryTimelineEvent {
                source: MemoryTimelineSource::Microphone,
                event_id: "mic:1".to_string(),
                text: "my answer".to_string(),
                created_at_ms: 1_700_000_000_000,
                seq: Some(42),
                attached_to_prompt: false,
                final_answer: false,
            },
        );

        assert_eq!(request.session_id, session_id.to_string());
        assert_eq!(request.source, "microphone");
        assert_eq!(request.seq_start, Some(42));
        assert!(request.metadata.explicit_interview_context);
        assert!(!request.metadata.final_answer);
        assert!(request.occurred_at.is_some());
    }

    #[test]
    fn ingest_request_marks_ai_response_as_final_answer_only() {
        let request = build_ingest_request(
            Uuid::new_v4(),
            MemoryTimelineEvent {
                source: MemoryTimelineSource::AiResponse,
                event_id: "haiku:1".to_string(),
                text: "assistant answer".to_string(),
                created_at_ms: 1_700_000_000_000,
                seq: Some(7),
                attached_to_prompt: false,
                final_answer: true,
            },
        );

        assert_eq!(request.source, "ai_response");
        assert!(request.metadata.final_answer);
        assert!(!request.metadata.explicit_interview_context);
    }

    #[test]
    fn chat_context_request_keeps_question_separate_from_recent_timeline() {
        let request = build_chat_context_request(
            Uuid::new_v4(),
            "ОС: previous question".to_string(),
            "current question".to_string(),
        );

        assert_eq!(request.current_request.text, "current question");
        assert_eq!(request.recent_timeline.len(), 1);
        assert_eq!(request.recent_timeline[0].text, "ОС: previous question");
        assert_eq!(request.budget_max_chars, Some(DEFAULT_CONTEXT_BUDGET_CHARS));
    }
}

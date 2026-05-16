use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::presentation::AppState;

const DEFAULT_API_BASE_URL: &str = "https://api.voicetext.site";
const DEFAULT_CONTEXT_BUDGET_CHARS: usize = 48_000;
const DEFAULT_MINIMAL_FALLBACK_CONTEXT_CHARS: usize = 12_000;
const DEFAULT_MAX_MEMORY_CANDIDATES: u64 = 2_000;
const DEFAULT_MAX_MEMORY_RESULTS: usize = 32;
const MAX_INGEST_EVENT_TEXT_CHARS: usize = 25_000;

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

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryContextEvidenceInput {
    #[serde(default)]
    pub selected_messages: Vec<MemoryRequestEvidenceInput>,
    #[serde(default)]
    pub current_code: Vec<MemoryRequestEvidenceInput>,
    #[serde(default)]
    pub recent_timeline: Vec<MemoryRequestEvidenceInput>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRequestEvidenceInput {
    pub id: Option<String>,
    pub label: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct StructuredContextEvidence {
    selected_messages: Vec<RequestEvidenceDto>,
    current_code: Vec<RequestEvidenceDto>,
    recent_timeline: Vec<RequestEvidenceDto>,
}

impl StructuredContextEvidence {
    fn has_any(&self) -> bool {
        !self.selected_messages.is_empty()
            || !self.current_code.is_empty()
            || !self.recent_timeline.is_empty()
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterviewMemoryMode {
    Disabled,
    ShadowIngest,
    ShadowRetrieve,
    AssistiveContext,
    ActiveContext,
    LocalOnly,
}

impl InterviewMemoryMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::ShadowIngest => "shadow_ingest",
            Self::ShadowRetrieve => "shadow_retrieve",
            Self::AssistiveContext => "assistive_context",
            Self::ActiveContext => "active_context",
            Self::LocalOnly => "local_only",
        }
    }

    pub fn backend_ingest_enabled(self) -> bool {
        matches!(
            self,
            Self::ShadowIngest
                | Self::ShadowRetrieve
                | Self::AssistiveContext
                | Self::ActiveContext
        )
    }

    pub fn backend_prompt_context_enabled(self) -> bool {
        matches!(self, Self::AssistiveContext | Self::ActiveContext)
    }

    pub fn minimal_local_prompt_context_enabled(self) -> bool {
        matches!(
            self,
            Self::Disabled | Self::AssistiveContext | Self::ActiveContext | Self::LocalOnly
        )
    }
}

fn apply_app_config_mode_override(
    mode: InterviewMemoryMode,
    interview_memory_enabled: bool,
) -> InterviewMemoryMode {
    if interview_memory_enabled {
        mode
    } else {
        InterviewMemoryMode::Disabled
    }
}

pub async fn resolved_mode_for_state(state: &AppState) -> InterviewMemoryMode {
    let interview_memory_enabled = state.config.read().await.interview_memory_enabled;
    apply_app_config_mode_override(resolved_mode(), interview_memory_enabled)
}

pub fn resolved_mode() -> InterviewMemoryMode {
    resolve_mode_from_env(|name| std::env::var(name).ok())
}

pub async fn reset_session(state: &AppState) {
    let previous_session_id = {
        let mut session_id = state.companion_memory_session_id.write().await;
        let previous_session_id = *session_id;
        *session_id = Uuid::new_v4();
        previous_session_id
    };

    if !resolved_mode_for_state(state)
        .await
        .backend_ingest_enabled()
    {
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
    if !resolved_mode_for_state(state)
        .await
        .backend_ingest_enabled()
    {
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
    let requests = build_ingest_requests(session_id, MemoryTimelineEvent { text, ..event });

    tauri::async_runtime::spawn(async move {
        for request in requests {
            if let Err(err) = post_json::<_, serde_json::Value>(
                "/api/v1/interview-memory/ingest",
                &auth_token,
                &request,
            )
            .await
            {
                log::warn!(
                    "Interview memory ingest skipped for event {:?}: {}",
                    request.event_id,
                    err
                );
            }
        }
    });
}

pub async fn assemble_stream_context_or_fallback(
    state: &AppState,
    local_context: &str,
    memory_context_evidence: Option<&MemoryContextEvidenceInput>,
) -> String {
    let mode = resolved_mode_for_state(state).await;
    if !mode.backend_prompt_context_enabled() {
        return if mode.minimal_local_prompt_context_enabled() {
            minimal_current_session_fallback_context(local_context)
        } else {
            local_context.to_string()
        };
    }

    let fallback_context = minimal_current_session_fallback_context(local_context);
    match assemble_stream_context(state, local_context, memory_context_evidence).await {
        Ok(Some(text)) => text,
        Ok(None) => fallback_context,
        Err(err) => {
            log::warn!("Interview memory active context fallback: {}", err);
            fallback_context
        }
    }
}

pub async fn assemble_chat_context_or_fallback(
    state: &AppState,
    local_context: &str,
    question: &str,
    memory_context_evidence: Option<&MemoryContextEvidenceInput>,
) -> Option<String> {
    if !resolved_mode_for_state(state)
        .await
        .backend_prompt_context_enabled()
    {
        return None;
    }

    match assemble_chat_context(state, local_context, question, memory_context_evidence).await {
        Ok(text) => text,
        Err(err) => {
            log::warn!("Interview memory chat context fallback: {}", err);
            None
        }
    }
}

pub fn minimal_current_session_fallback_context(local_context: &str) -> String {
    trim_text_tail_to_line(local_context, DEFAULT_MINIMAL_FALLBACK_CONTEXT_CHARS)
}

async fn assemble_stream_context(
    state: &AppState,
    local_context: &str,
    memory_context_evidence: Option<&MemoryContextEvidenceInput>,
) -> Result<Option<String>, String> {
    let fallback_context = minimal_current_session_fallback_context(local_context);
    let trimmed = fallback_context.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let Some(auth_token) = auth_token(state).await else {
        return Ok(None);
    };

    let session_id = memory_session_id(state).await;
    let request =
        build_stream_context_request(session_id, trimmed.to_string(), memory_context_evidence);
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
    memory_context_evidence: Option<&MemoryContextEvidenceInput>,
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
    let request = build_chat_context_request(
        session_id,
        minimal_current_session_fallback_context(context),
        question.to_string(),
        memory_context_evidence,
    );
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
    if let Some(token) = std::env::var("INTERVIEW_MEMORY_AUTH_TOKEN")
        .ok()
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
    {
        return Some(token);
    }

    state
        .auth_store
        .read()
        .await
        .session
        .as_ref()
        .map(|session| session.access_token.trim().to_string())
        .filter(|token| !token.is_empty())
}

async fn memory_session_id(state: &AppState) -> Uuid {
    *state.companion_memory_session_id.read().await
}

pub async fn memory_session_id_string(state: &AppState) -> String {
    memory_session_id(state).await.to_string()
}

fn build_ingest_requests(session_id: Uuid, event: MemoryTimelineEvent) -> Vec<IngestMemoryRequest> {
    let text_parts = split_text_for_ingest(&event.text, MAX_INGEST_EVENT_TEXT_CHARS);
    if text_parts.len() <= 1 {
        return vec![build_ingest_request(session_id, event)];
    }

    let total_parts = text_parts.len();
    let original_event_id = event.event_id.clone();
    text_parts
        .into_iter()
        .enumerate()
        .map(|(index, text)| {
            let mut part_event = event.clone();
            part_event.event_id = format!(
                "{original_event_id}:part:{:03}-of-{:03}",
                index + 1,
                total_parts
            );
            part_event.text = text;
            build_ingest_request(session_id, part_event)
        })
        .collect()
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

fn build_stream_context_request(
    session_id: Uuid,
    local_context: String,
    memory_context_evidence: Option<&MemoryContextEvidenceInput>,
) -> AssembleContextRequest {
    let evidence = build_structured_context_evidence(&local_context, memory_context_evidence);
    let current_request = derive_stream_current_request(&local_context, &evidence);
    AssembleContextRequest {
        session_id: session_id.to_string(),
        context_snapshot_id: Some(format!("desktop-stream-{}", Uuid::new_v4())),
        current_request: RequestEvidenceDto {
            id: "current-context".to_string(),
            label: "current_request".to_string(),
            text: current_request,
        },
        selected_messages: evidence.selected_messages,
        current_code: evidence.current_code,
        recent_timeline: evidence.recent_timeline,
        budget_max_chars: Some(DEFAULT_CONTEXT_BUDGET_CHARS),
        max_memory_candidates: Some(DEFAULT_MAX_MEMORY_CANDIDATES),
        max_memory_results: Some(DEFAULT_MAX_MEMORY_RESULTS),
    }
}

fn build_chat_context_request(
    session_id: Uuid,
    local_context: String,
    question: String,
    memory_context_evidence: Option<&MemoryContextEvidenceInput>,
) -> AssembleContextRequest {
    let evidence = build_structured_context_evidence(&local_context, memory_context_evidence);
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
        selected_messages: evidence.selected_messages,
        current_code: evidence.current_code,
        recent_timeline: evidence.recent_timeline,
        budget_max_chars: Some(DEFAULT_CONTEXT_BUDGET_CHARS),
        max_memory_candidates: Some(DEFAULT_MAX_MEMORY_CANDIDATES),
        max_memory_results: Some(DEFAULT_MAX_MEMORY_RESULTS),
    }
}

fn build_structured_context_evidence(
    local_context: &str,
    memory_context_evidence: Option<&MemoryContextEvidenceInput>,
) -> StructuredContextEvidence {
    if let Some(input) = memory_context_evidence {
        let evidence = structured_context_from_input(input);
        if evidence.has_any() {
            return evidence;
        }
    }

    parse_local_context_evidence(local_context)
}

fn structured_context_from_input(input: &MemoryContextEvidenceInput) -> StructuredContextEvidence {
    StructuredContextEvidence {
        selected_messages: evidence_from_input(&input.selected_messages, "selected_message"),
        current_code: evidence_from_input(&input.current_code, "current_code"),
        recent_timeline: evidence_from_input(&input.recent_timeline, "recent_timeline"),
    }
}

fn evidence_from_input(
    items: &[MemoryRequestEvidenceInput],
    default_label: &str,
) -> Vec<RequestEvidenceDto> {
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let text = item.text.trim();
            if text.is_empty() {
                return None;
            }

            let label = item
                .label
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(default_label);
            let id = item
                .id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("{}:{}", default_label, index + 1));

            Some(RequestEvidenceDto {
                id,
                label: label.to_string(),
                text: text.to_string(),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParsedContextKind {
    SystemAudio,
    Microphone,
    ManualPrompt,
    Assistant,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedContextBlock {
    kind: ParsedContextKind,
    text: String,
}

fn parse_local_context_evidence(local_context: &str) -> StructuredContextEvidence {
    let mut evidence = StructuredContextEvidence::default();

    for (index, block) in split_context_blocks(local_context).into_iter().enumerate() {
        let text = block.text.trim();
        if text.is_empty() {
            continue;
        }

        if text_looks_like_current_code(text) {
            evidence.current_code.push(RequestEvidenceDto {
                id: format!("local-code:{}", index + 1),
                label: "current_code".to_string(),
                text: text.to_string(),
            });
            continue;
        }

        let label = match block.kind {
            ParsedContextKind::SystemAudio => "system_audio",
            ParsedContextKind::Microphone => "microphone",
            ParsedContextKind::ManualPrompt => "manual_prompt",
            ParsedContextKind::Assistant => "assistant",
            ParsedContextKind::Unknown => "recent_timeline",
        };

        evidence.recent_timeline.push(RequestEvidenceDto {
            id: format!("local-context:{}", index + 1),
            label: label.to_string(),
            text: text.to_string(),
        });
    }

    evidence
}

fn split_context_blocks(local_context: &str) -> Vec<ParsedContextBlock> {
    let mut blocks = Vec::new();
    let mut current_kind = ParsedContextKind::Unknown;
    let mut current_text = String::new();

    for line in local_context.lines() {
        if let Some((kind, text)) = parse_context_prefix(line) {
            push_context_block(&mut blocks, current_kind, &mut current_text);
            current_kind = kind;
            current_text.push_str(text);
            continue;
        }

        if !current_text.is_empty() {
            current_text.push('\n');
        }
        current_text.push_str(line);
    }

    push_context_block(&mut blocks, current_kind, &mut current_text);
    blocks
}

fn parse_context_prefix(line: &str) -> Option<(ParsedContextKind, &str)> {
    let trimmed = line.trim_start();
    for (prefix, kind) in [
        ("ОС:", ParsedContextKind::SystemAudio),
        ("МИКРОФОН:", ParsedContextKind::Microphone),
        ("ЗАПРОС:", ParsedContextKind::ManualPrompt),
        ("ПОМОЩНИК:", ParsedContextKind::Assistant),
    ] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return Some((kind, rest.trim_start()));
        }
    }
    None
}

fn push_context_block(
    blocks: &mut Vec<ParsedContextBlock>,
    kind: ParsedContextKind,
    text: &mut String,
) {
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        blocks.push(ParsedContextBlock {
            kind,
            text: trimmed.to_string(),
        });
    }
    text.clear();
}

pub(crate) fn text_looks_like_current_code(text: &str) -> bool {
    if text.contains("```") {
        return true;
    }

    let lower = text.to_ascii_lowercase();
    if lower.contains("select ") && lower.contains(" from ") {
        return true;
    }

    let has_code_punctuation = text.contains('{')
        || text.contains(';')
        || text.contains("=>")
        || text.contains('=')
        || text.contains("()")
        || text.contains("):")
        || text.contains(") {");
    if !has_code_punctuation {
        return false;
    }

    [
        "function ",
        "class ",
        "interface ",
        "struct ",
        "impl ",
        "const ",
        "let ",
        "var ",
        "def ",
        "func ",
        "export ",
        "import ",
        "type ",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn derive_stream_current_request(
    local_context: &str,
    evidence: &StructuredContextEvidence,
) -> String {
    if let Some(item) =
        evidence.recent_timeline.iter().rev().find(|item| {
            !matches!(item.label.as_str(), "assistant") && !item.text.trim().is_empty()
        })
    {
        return trim_text_tail_to_line(&item.text, 4_000);
    }

    if evidence.has_any() {
        return "Ответь по текущему интервью-контексту.".to_string();
    }

    minimal_current_session_fallback_context(local_context)
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
    std::env::var("INTERVIEW_MEMORY_API_URL")
        .or_else(|_| std::env::var("VOICE_TO_TEXT_API_URL"))
        .or_else(|_| std::env::var("VITE_API_URL"))
        .unwrap_or_else(|_| DEFAULT_API_BASE_URL.to_string())
}

fn split_text_for_ingest(text: &str, max_chars: usize) -> Vec<String> {
    if max_chars == 0 {
        return Vec::new();
    }

    if text.chars().count() <= max_chars {
        return vec![text.to_string()];
    }

    let mut parts = Vec::new();
    let mut current = String::new();
    let mut current_chars = 0usize;

    for line in text.split_inclusive('\n') {
        let line_chars = line.chars().count();
        if line_chars > max_chars {
            push_non_empty(&mut parts, &mut current, &mut current_chars);
            push_hard_wrapped(&mut parts, line, max_chars);
            continue;
        }

        if current_chars > 0 && current_chars + line_chars > max_chars {
            push_non_empty(&mut parts, &mut current, &mut current_chars);
        }

        current.push_str(line);
        current_chars += line_chars;
    }

    push_non_empty(&mut parts, &mut current, &mut current_chars);
    parts
}

fn trim_text_tail_to_line(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let tail = trimmed
        .chars()
        .rev()
        .take(max_chars)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();

    if let Some(first_line_break) = tail.find('\n') {
        if first_line_break < tail.len().saturating_sub(1) {
            return tail[first_line_break + 1..].trim().to_string();
        }
    }

    tail.trim().to_string()
}

fn push_non_empty(parts: &mut Vec<String>, current: &mut String, current_chars: &mut usize) {
    if !current.is_empty() {
        parts.push(std::mem::take(current));
        *current_chars = 0;
    }
}

fn push_hard_wrapped(parts: &mut Vec<String>, text: &str, max_chars: usize) {
    let mut current = String::new();
    let mut current_chars = 0usize;

    for ch in text.chars() {
        if current_chars >= max_chars {
            parts.push(std::mem::take(&mut current));
            current_chars = 0;
        }
        current.push(ch);
        current_chars += 1;
    }

    if !current.is_empty() {
        parts.push(current);
    }
}

fn env_value_is_true(value: Option<String>) -> bool {
    matches!(
        value.map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn env_value_is_false(value: Option<String>) -> bool {
    matches!(
        value.map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "0" | "false" | "no" | "off")
    )
}

fn resolve_mode_from_env(get_env: impl Fn(&str) -> Option<String>) -> InterviewMemoryMode {
    if env_value_is_true(get_env("INTERVIEW_MEMORY_FORCE_DISABLED")) {
        return InterviewMemoryMode::Disabled;
    }
    if env_value_is_true(get_env("INTERVIEW_MEMORY_FORCE_LOCAL_ONLY")) {
        return InterviewMemoryMode::LocalOnly;
    }

    if let Some(mode) = get_env("INTERVIEW_MEMORY_MODE")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
    {
        return match mode.as_str() {
            "disabled" | "off" | "false" | "0" => InterviewMemoryMode::Disabled,
            "shadow_ingest" | "shadow-ingest" | "shadowingest" => InterviewMemoryMode::ShadowIngest,
            "shadow_retrieve" | "shadow-retrieve" | "shadowretrieve" => {
                InterviewMemoryMode::ShadowRetrieve
            }
            "assistive_context" | "assistive-context" | "assistivecontext" => {
                InterviewMemoryMode::AssistiveContext
            }
            "active_context" | "active-context" | "activecontext" | "active" => {
                InterviewMemoryMode::ActiveContext
            }
            "local_only" | "local-only" | "localonly" => InterviewMemoryMode::LocalOnly,
            _ => InterviewMemoryMode::Disabled,
        };
    }

    if env_value_is_true(get_env("INTERVIEW_MEMORY_ACTIVE_CONTEXT"))
        || env_value_is_true(get_env("INTERVIEW_MEMORY_ENABLED"))
        || env_value_is_true(get_env("HACKINTERVIEW_INTERVIEW_MEMORY_ENABLED"))
    {
        return InterviewMemoryMode::ActiveContext;
    }

    if env_value_is_false(get_env("INTERVIEW_MEMORY_ENABLED"))
        || env_value_is_false(get_env("HACKINTERVIEW_INTERVIEW_MEMORY_ENABLED"))
        || env_value_is_false(get_env("INTERVIEW_MEMORY_ACTIVE_CONTEXT"))
    {
        return InterviewMemoryMode::Disabled;
    }

    InterviewMemoryMode::ActiveContext
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve_mode(entries: &[(&str, &str)]) -> InterviewMemoryMode {
        resolve_mode_from_env(|name| {
            entries
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_string())
        })
    }

    #[test]
    fn ingest_requests_split_large_events_before_backend_limit() {
        let session_id = Uuid::new_v4();
        let text = format!(
            "{}\n{}",
            "строка с кодом и контекстом\n".repeat(1_000),
            "tail marker"
        );

        let requests = build_ingest_requests(
            session_id,
            MemoryTimelineEvent {
                source: MemoryTimelineSource::FocusCopy,
                event_id: "focus-copy:large".to_string(),
                text: text.clone(),
                created_at_ms: 1_700_000_000_000,
                seq: Some(99),
                attached_to_prompt: false,
                final_answer: false,
            },
        );

        assert!(requests.len() > 1);
        assert!(requests
            .iter()
            .all(|request| request.text.chars().count() <= MAX_INGEST_EVENT_TEXT_CHARS));
        assert_eq!(
            requests
                .iter()
                .map(|request| request.text.as_str())
                .collect::<String>(),
            text
        );
        assert_eq!(
            requests[0].event_id.as_deref(),
            Some("focus-copy:large:part:001-of-002")
        );
        assert_eq!(
            requests[1].event_id.as_deref(),
            Some("focus-copy:large:part:002-of-002")
        );
    }

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
            None,
        );

        assert_eq!(request.current_request.text, "current question");
        assert_eq!(request.recent_timeline.len(), 1);
        assert_eq!(request.recent_timeline[0].text, "previous question");
        assert_eq!(request.recent_timeline[0].label, "system_audio");
        assert_eq!(request.budget_max_chars, Some(DEFAULT_CONTEXT_BUDGET_CHARS));
    }

    #[test]
    fn minimal_fallback_keeps_recent_tail_without_old_anchor_packer() {
        let local_context = format!(
            "ОС: OLD_CODE_ANCHOR function stale() {{ return 1; }}\n{}\nОС: RECENT_CURRENT_QUESTION",
            "фоновый длинный текст\n".repeat(1_000)
        );

        let fallback = minimal_current_session_fallback_context(&local_context);

        assert!(fallback.chars().count() <= DEFAULT_MINIMAL_FALLBACK_CONTEXT_CHARS);
        assert!(!fallback.contains("OLD_CODE_ANCHOR"));
        assert!(fallback.contains("RECENT_CURRENT_QUESTION"));
    }

    #[test]
    fn chat_context_request_uses_minimal_recent_timeline() {
        let old_context = format!(
            "ОС: OLD_MEMORY_SHOULD_COME_FROM_BACKEND\n{}\nОС: CURRENT_TAIL_FACT",
            "длинный filler\n".repeat(1_200)
        );

        let request = build_chat_context_request(
            Uuid::new_v4(),
            minimal_current_session_fallback_context(&old_context),
            "current question".to_string(),
            None,
        );

        assert_eq!(request.current_request.text, "current question");
        let recent_text = request
            .recent_timeline
            .iter()
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(recent_text.chars().count() <= DEFAULT_MINIMAL_FALLBACK_CONTEXT_CHARS);
        assert!(!recent_text.contains("OLD_MEMORY_SHOULD_COME_FROM_BACKEND"));
        assert!(recent_text.contains("CURRENT_TAIL_FACT"));
    }

    #[test]
    fn chat_context_request_splits_code_and_recent_timeline_sections() {
        let local_context = [
            "ОС: CODE_CTX function processQueue() { return queue.shift(); }",
            "ОС: почему нужна очередь а не стек?",
            "МИКРОФОН: отвечаю про FIFO",
        ]
        .join("\n");

        let request = build_chat_context_request(
            Uuid::new_v4(),
            local_context,
            "сформулируй ответ".to_string(),
            None,
        );

        assert_eq!(request.current_request.text, "сформулируй ответ");
        assert_eq!(request.current_code.len(), 1);
        assert!(request.current_code[0].text.contains("processQueue"));
        assert_eq!(request.recent_timeline.len(), 2);
        assert!(request.recent_timeline[0]
            .text
            .contains("почему нужна очередь"));
        assert_eq!(request.recent_timeline[1].label, "microphone");
    }

    #[test]
    fn context_parser_does_not_treat_plain_class_discussion_as_code() {
        let request = build_chat_context_request(
            Uuid::new_v4(),
            "ОС: объясни разницу class component и function component".to_string(),
            "ответь".to_string(),
            None,
        );

        assert!(request.current_code.is_empty());
        assert_eq!(request.recent_timeline.len(), 1);
        assert!(request.recent_timeline[0].text.contains("class component"));
    }

    #[test]
    fn stream_context_request_derives_current_request_from_latest_speech() {
        let local_context = [
            "ОС: ```ts",
            "function debounceSearch() {}",
            "```",
            "ОС: как объяснить отмену прошлого таймера?",
        ]
        .join("\n");

        let request = build_stream_context_request(Uuid::new_v4(), local_context, None);

        assert_eq!(
            request.current_request.text,
            "как объяснить отмену прошлого таймера?"
        );
        assert_eq!(request.current_code.len(), 1);
        assert!(request.current_code[0].text.contains("debounceSearch"));
        assert_eq!(request.recent_timeline.len(), 1);
    }

    #[test]
    fn explicit_memory_context_evidence_preserves_selected_messages() {
        let input = MemoryContextEvidenceInput {
            selected_messages: vec![MemoryRequestEvidenceInput {
                id: Some("stt:selected".to_string()),
                label: Some("selected_message".to_string()),
                text: "selected transcript requirement".to_string(),
            }],
            current_code: vec![MemoryRequestEvidenceInput {
                id: Some("focus-copy:code".to_string()),
                label: Some("current_code".to_string()),
                text: "function solve() {}".to_string(),
            }],
            recent_timeline: Vec::new(),
        };

        let request = build_chat_context_request(
            Uuid::new_v4(),
            "ОС: ignored fallback".to_string(),
            "answer selected".to_string(),
            Some(&input),
        );

        assert_eq!(request.selected_messages.len(), 1);
        assert_eq!(request.selected_messages[0].id, "stt:selected");
        assert_eq!(request.current_code.len(), 1);
        assert_eq!(request.current_code[0].id, "focus-copy:code");
        assert!(request.recent_timeline.is_empty());
    }

    #[test]
    fn memory_mode_defaults_to_active_context() {
        assert_eq!(resolve_mode(&[]), InterviewMemoryMode::ActiveContext);
    }

    #[test]
    fn memory_mode_supports_legacy_active_context_flags() {
        assert_eq!(
            resolve_mode(&[("INTERVIEW_MEMORY_ENABLED", "1")]),
            InterviewMemoryMode::ActiveContext
        );
        assert_eq!(
            resolve_mode(&[("INTERVIEW_MEMORY_ACTIVE_CONTEXT", "true")]),
            InterviewMemoryMode::ActiveContext
        );
    }

    #[test]
    fn memory_mode_force_disabled_wins_over_active_context() {
        assert_eq!(
            resolve_mode(&[
                ("INTERVIEW_MEMORY_FORCE_DISABLED", "true"),
                ("INTERVIEW_MEMORY_MODE", "active_context"),
                ("INTERVIEW_MEMORY_ENABLED", "1"),
            ]),
            InterviewMemoryMode::Disabled
        );
    }

    #[test]
    fn memory_mode_disabled_uses_minimal_local_context_only() {
        let mode = resolve_mode(&[("INTERVIEW_MEMORY_MODE", "disabled")]);

        assert_eq!(mode, InterviewMemoryMode::Disabled);
        assert!(!mode.backend_ingest_enabled());
        assert!(!mode.backend_prompt_context_enabled());
        assert!(mode.minimal_local_prompt_context_enabled());
    }

    #[test]
    fn app_config_can_disable_default_active_context() {
        assert_eq!(
            apply_app_config_mode_override(InterviewMemoryMode::ActiveContext, false),
            InterviewMemoryMode::Disabled
        );
        assert_eq!(
            apply_app_config_mode_override(InterviewMemoryMode::ActiveContext, true),
            InterviewMemoryMode::ActiveContext
        );
    }

    #[test]
    fn memory_mode_legacy_false_disables_default_active_context() {
        assert_eq!(
            resolve_mode(&[("INTERVIEW_MEMORY_ENABLED", "false")]),
            InterviewMemoryMode::Disabled
        );
        assert_eq!(
            resolve_mode(&[("INTERVIEW_MEMORY_ACTIVE_CONTEXT", "0")]),
            InterviewMemoryMode::Disabled
        );
    }

    #[test]
    fn memory_mode_resolves_shadow_without_prompt_impact() {
        let mode = resolve_mode(&[("INTERVIEW_MEMORY_MODE", "shadow_retrieve")]);

        assert_eq!(mode, InterviewMemoryMode::ShadowRetrieve);
        assert!(mode.backend_ingest_enabled());
        assert!(!mode.backend_prompt_context_enabled());
        assert!(!mode.minimal_local_prompt_context_enabled());
    }

    #[test]
    fn memory_mode_resolves_active_with_prompt_impact() {
        let mode = resolve_mode(&[("INTERVIEW_MEMORY_MODE", "active_context")]);

        assert_eq!(mode, InterviewMemoryMode::ActiveContext);
        assert!(mode.backend_ingest_enabled());
        assert!(mode.backend_prompt_context_enabled());
        assert!(mode.minimal_local_prompt_context_enabled());
    }

    #[test]
    fn memory_mode_local_only_avoids_backend_calls_but_uses_minimal_local_context() {
        let mode = resolve_mode(&[("INTERVIEW_MEMORY_FORCE_LOCAL_ONLY", "true")]);

        assert_eq!(mode, InterviewMemoryMode::LocalOnly);
        assert!(!mode.backend_ingest_enabled());
        assert!(!mode.backend_prompt_context_enabled());
        assert!(mode.minimal_local_prompt_context_enabled());
    }

    #[test]
    fn invalid_memory_mode_resolves_to_disabled() {
        assert_eq!(
            resolve_mode(&[("INTERVIEW_MEMORY_MODE", "definitely-not-a-mode")]),
            InterviewMemoryMode::Disabled
        );
    }

    #[test]
    fn memory_api_url_is_dedicated_override() {
        std::env::set_var("INTERVIEW_MEMORY_API_URL", "http://127.0.0.1:8080");
        std::env::set_var("VOICE_TO_TEXT_API_URL", "https://wrong.example");
        std::env::set_var("VITE_API_URL", "https://also-wrong.example");

        assert_eq!(api_base_url(), "http://127.0.0.1:8080");

        std::env::remove_var("INTERVIEW_MEMORY_API_URL");
        std::env::remove_var("VOICE_TO_TEXT_API_URL");
        std::env::remove_var("VITE_API_URL");
    }
}

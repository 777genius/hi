use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::collections::{BTreeSet, HashMap};
use std::time::Duration;
use tokio::sync::OnceCell;
use uuid::Uuid;

const DEFAULT_DB_URL: &str =
    "postgres://hackinterview:hackinterview@127.0.0.1:54329/hackinterview_memory";
const DEFAULT_EMBEDDING_MODEL: &str = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSIONS: usize = 1536;
const OPENAI_EMBEDDINGS_URL: &str = "https://api.openai.com/v1/embeddings";
const MAX_CONTEXT_CHARS: usize = 14_000;
const MAX_MEMORY_CHUNK_CHARS: usize = 900;
const MAX_PENDING_EMBEDDINGS_PER_TICK: i64 = 24;

static STORE: OnceCell<LocalInterviewMemoryStore> = OnceCell::const_new();

#[derive(Debug, Clone)]
pub struct LocalMemoryEvent {
    pub session_id: Uuid,
    pub event_id: Option<String>,
    pub source: String,
    pub kind_hint: Option<String>,
    pub text: String,
    pub occurred_at_ms: i64,
    pub seq_start: Option<i64>,
    pub seq_end: Option<i64>,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct LocalContextRequest {
    pub session_id: Uuid,
    pub current_request: String,
    pub selected_messages: Vec<LocalEvidence>,
    pub current_code: Vec<LocalEvidence>,
    pub recent_timeline: Vec<LocalEvidence>,
    pub max_results: usize,
}

#[derive(Debug, Clone)]
pub struct LocalEvidence {
    pub label: String,
    pub text: String,
}

#[derive(Clone)]
pub struct LocalInterviewMemoryStore {
    pool: PgPool,
    client: reqwest::Client,
    embeddings_enabled: bool,
    embedding_model: String,
    embedding_dimensions: usize,
    openai_api_key: Option<String>,
}

pub fn local_memory_enabled() -> bool {
    #[cfg(test)]
    if std::env::var("INTERVIEW_MEMORY_LOCAL_DB_ENABLED").is_err() {
        return false;
    }

    env_bool("INTERVIEW_MEMORY_LOCAL_DB_ENABLED", true)
}

pub async fn store() -> Option<LocalInterviewMemoryStore> {
    if !local_memory_enabled() {
        return None;
    }

    match STORE
        .get_or_try_init(LocalInterviewMemoryStore::connect_from_env)
        .await
    {
        Ok(store) => Some(store.clone()),
        Err(error) => {
            log::warn!("Local interview memory unavailable, will retry: {}", error);
            None
        }
    }
}

impl LocalInterviewMemoryStore {
    async fn connect_from_env() -> Result<Self> {
        let db_url =
            std::env::var("INTERVIEW_MEMORY_DB_URL").unwrap_or_else(|_| DEFAULT_DB_URL.to_string());
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(Duration::from_secs(2))
            .connect(&db_url)
            .await
            .with_context(|| "failed to connect local interview memory Postgres")?;

        ensure_schema(&pool).await?;

        Ok(Self {
            pool,
            client: reqwest::Client::new(),
            embeddings_enabled: env_bool("INTERVIEW_MEMORY_EMBEDDINGS_ENABLED", true),
            embedding_model: std::env::var("INTERVIEW_MEMORY_EMBEDDING_MODEL")
                .unwrap_or_else(|_| DEFAULT_EMBEDDING_MODEL.to_string()),
            embedding_dimensions: std::env::var("INTERVIEW_MEMORY_EMBEDDING_DIMENSIONS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(DEFAULT_EMBEDDING_DIMENSIONS),
            openai_api_key: std::env::var("OPENAI_API_KEY")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        })
    }

    pub async fn ingest(&self, event: LocalMemoryEvent) -> Result<()> {
        let text = event.text.trim();
        if text.is_empty() {
            return Ok(());
        }
        if should_skip_synthetic_e2e_memory(text) {
            log::debug!("Skipping synthetic E2E memory event from {}", event.source);
            return Ok(());
        }

        let source_hash = source_hash(&event.session_id, event.event_id.as_deref(), text);
        let chunk_id = Uuid::new_v4();
        let embedding_status = if self.can_embed() {
            "pending"
        } else {
            "skipped"
        };
        let occurred_at =
            DateTime::<Utc>::from_timestamp_millis(event.occurred_at_ms).unwrap_or_else(Utc::now);
        let normalized_text = normalize_text(text);
        let kind = event
            .kind_hint
            .unwrap_or_else(|| infer_kind(&event.source, text));

        sqlx::query(
            r#"
            INSERT INTO interview_memory_chunks (
                id, session_id, source_hash, event_id, source, kind, text, normalized_text,
                seq_start, seq_end, occurred_at, metadata, embedding_status
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            ON CONFLICT (session_id, source_hash) DO NOTHING
            "#,
        )
        .bind(chunk_id)
        .bind(event.session_id)
        .bind(source_hash)
        .bind(event.event_id)
        .bind(event.source)
        .bind(kind)
        .bind(text)
        .bind(normalized_text)
        .bind(event.seq_start)
        .bind(event.seq_end)
        .bind(occurred_at)
        .bind(event.metadata)
        .bind(embedding_status)
        .execute(&self.pool)
        .await?;

        if self.can_embed() {
            let cloned = self.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = cloned
                    .process_pending_embeddings(MAX_PENDING_EMBEDDINGS_PER_TICK)
                    .await
                {
                    log::debug!("Local interview memory embedding tick failed: {}", error);
                }
            });
        }

        Ok(())
    }

    pub async fn assemble_context(&self, request: LocalContextRequest) -> Result<String> {
        let query_text = build_retrieval_query_text(&request);

        let mut ranked = self
            .keyword_search(request.session_id, &query_text, 300)
            .await?;
        if self.can_embed() {
            if let Ok(vector) = self.embed_one(&query_text).await {
                if let Ok(vector_matches) =
                    self.vector_search(request.session_id, &vector, 80).await
                {
                    merge_vector_matches(&mut ranked, vector_matches);
                }
            }
        }

        for chunk in &mut ranked {
            chunk.score = adjusted_rank_score(&query_text, chunk);
        }
        ranked.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| b.occurred_at_ms.cmp(&a.occurred_at_ms))
        });
        ranked.truncate(request.max_results.max(1));

        Ok(pack_context(request, ranked))
    }

    async fn keyword_search(
        &self,
        session_id: Uuid,
        query_text: &str,
        limit: i64,
    ) -> Result<Vec<RankedChunk>> {
        let rows = sqlx::query(
            r#"
            SELECT id, source, kind, text, normalized_text, seq_start, seq_end,
                   (extract(epoch from occurred_at) * 1000)::bigint AS occurred_at_ms
            FROM interview_memory_chunks
            WHERE session_id = $1
              AND source <> 'ai_response'
              AND kind <> 'voice_question'
            ORDER BY occurred_at DESC
            LIMIT $2
            "#,
        )
        .bind(session_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let query_terms = significant_words(query_text);
        let mut chunks = Vec::new();
        for row in rows {
            let normalized: String = row.try_get("normalized_text")?;
            let terms = significant_words(&normalized);
            let overlap = terms.intersection(&query_terms).count();
            let kind: String = row.try_get("kind")?;
            let score = kind_score(&kind) + overlap as f32 * 8.0;
            if score < 8.0 {
                continue;
            }
            chunks.push(RankedChunk {
                id: row.try_get("id")?,
                source: row.try_get("source")?,
                kind,
                text: row.try_get("text")?,
                score,
                reason: format!("keyword:{overlap}"),
                seq_start: row.try_get("seq_start")?,
                seq_end: row.try_get("seq_end")?,
                occurred_at_ms: row.try_get("occurred_at_ms")?,
            });
        }
        Ok(chunks)
    }

    async fn vector_search(
        &self,
        session_id: Uuid,
        vector: &[f32],
        limit: i64,
    ) -> Result<Vec<RankedChunk>> {
        let vector_literal = vector_literal(vector);
        let rows = sqlx::query(
            r#"
            SELECT c.id, c.source, c.kind, c.text, c.seq_start, c.seq_end,
                   (extract(epoch from c.occurred_at) * 1000)::bigint AS occurred_at_ms,
                   1 - (e.embedding <=> $2::vector) AS similarity
            FROM interview_memory_embeddings e
            JOIN interview_memory_chunks c ON c.id = e.chunk_id
            WHERE e.session_id = $1
              AND e.model = $3
              AND c.source <> 'ai_response'
              AND c.kind <> 'voice_question'
            ORDER BY e.embedding <=> $2::vector
            LIMIT $4
            "#,
        )
        .bind(session_id)
        .bind(vector_literal)
        .bind(&self.embedding_model)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let similarity = row.try_get::<f64, _>("similarity")? as f32;
                Ok(RankedChunk {
                    id: row.try_get("id")?,
                    source: row.try_get("source")?,
                    kind: row.try_get("kind")?,
                    text: row.try_get("text")?,
                    score: 35.0 + similarity.max(0.0) * 70.0,
                    reason: format!("vector:{similarity:.3}"),
                    seq_start: row.try_get("seq_start")?,
                    seq_end: row.try_get("seq_end")?,
                    occurred_at_ms: row.try_get("occurred_at_ms")?,
                })
            })
            .collect()
    }

    async fn process_pending_embeddings(&self, limit: i64) -> Result<()> {
        if !self.can_embed() {
            return Ok(());
        }

        let rows = sqlx::query(
            r#"
            SELECT id, session_id, text
            FROM interview_memory_chunks
            WHERE embedding_status IN ('pending', 'failed')
            ORDER BY updated_at ASC
            LIMIT $1
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        for row in rows {
            let chunk_id: Uuid = row.try_get("id")?;
            let session_id: Uuid = row.try_get("session_id")?;
            let text: String = row.try_get("text")?;
            match self.embed_one(&text).await {
                Ok(vector) => {
                    let vector_literal = vector_literal(&vector);
                    sqlx::query(
                        r#"
                        INSERT INTO interview_memory_embeddings (
                            chunk_id, session_id, model, dimensions, embedding
                        )
                        SELECT $1,$2,$3,$4,$5::vector
                        WHERE EXISTS (
                            SELECT 1 FROM interview_memory_chunks WHERE id = $1
                        )
                        ON CONFLICT (chunk_id) DO UPDATE SET
                            model = EXCLUDED.model,
                            dimensions = EXCLUDED.dimensions,
                            embedding = EXCLUDED.embedding,
                            updated_at = now()
                        "#,
                    )
                    .bind(chunk_id)
                    .bind(session_id)
                    .bind(&self.embedding_model)
                    .bind(self.embedding_dimensions as i32)
                    .bind(vector_literal)
                    .execute(&self.pool)
                    .await?;

                    sqlx::query(
                        "UPDATE interview_memory_chunks SET embedding_status = 'ready', updated_at = now() WHERE id = $1",
                    )
                    .bind(chunk_id)
                    .execute(&self.pool)
                    .await?;
                }
                Err(error) => {
                    sqlx::query(
                        "UPDATE interview_memory_chunks SET embedding_status = 'failed', embedding_error = $2, updated_at = now() WHERE id = $1",
                    )
                    .bind(chunk_id)
                    .bind(sanitize_error(&error.to_string()))
                    .execute(&self.pool)
                    .await?;
                }
            }
        }

        Ok(())
    }

    async fn embed_one(&self, text: &str) -> Result<Vec<f32>> {
        let api_key = self
            .openai_api_key
            .as_ref()
            .context("OPENAI_API_KEY missing for local memory embeddings")?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(vec![0.0; self.embedding_dimensions]);
        }

        let response = self
            .client
            .post(OPENAI_EMBEDDINGS_URL)
            .bearer_auth(api_key)
            .json(&OpenAiEmbeddingRequest {
                model: &self.embedding_model,
                input: trimmed,
                dimensions: self.embedding_dimensions,
            })
            .timeout(Duration::from_secs(12))
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!(
                "OpenAI embeddings status={status} body={}",
                sanitize_error(&body)
            );
        }

        let payload = response.json::<OpenAiEmbeddingResponse>().await?;
        let vector = payload
            .data
            .into_iter()
            .next()
            .map(|item| item.embedding)
            .context("OpenAI embeddings response has no data")?;
        if vector.len() != self.embedding_dimensions {
            anyhow::bail!(
                "embedding dimensions mismatch: expected {}, got {}",
                self.embedding_dimensions,
                vector.len()
            );
        }
        Ok(vector)
    }

    fn can_embed(&self) -> bool {
        self.embeddings_enabled && self.openai_api_key.is_some()
    }
}

async fn ensure_schema(pool: &PgPool) -> Result<()> {
    sqlx::query("CREATE EXTENSION IF NOT EXISTS vector")
        .execute(pool)
        .await
        .context("failed to enable pgvector extension")?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS interview_memory_chunks (
            id uuid PRIMARY KEY,
            session_id uuid NOT NULL,
            source_hash text NOT NULL,
            event_id text,
            source text NOT NULL,
            kind text NOT NULL,
            text text NOT NULL,
            normalized_text text NOT NULL,
            seq_start bigint,
            seq_end bigint,
            occurred_at timestamptz NOT NULL,
            metadata jsonb NOT NULL DEFAULT '{}',
            embedding_status text NOT NULL DEFAULT 'skipped',
            embedding_error text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(session_id, source_hash)
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS interview_memory_embeddings (
            chunk_id uuid PRIMARY KEY REFERENCES interview_memory_chunks(id) ON DELETE CASCADE,
            session_id uuid NOT NULL,
            model text NOT NULL,
            dimensions integer NOT NULL,
            embedding vector(1536) NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        )
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_interview_memory_chunks_session_time ON interview_memory_chunks(session_id, occurred_at DESC)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_interview_memory_embeddings_session ON interview_memory_embeddings(session_id, model)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_interview_memory_embeddings_hnsw ON interview_memory_embeddings USING hnsw (embedding vector_cosine_ops)",
    )
    .execute(pool)
    .await?;

    Ok(())
}

fn pack_context(request: LocalContextRequest, chunks: Vec<RankedChunk>) -> String {
    let mut output = String::new();
    push_section(&mut output, "current_request", &request.current_request);
    push_evidence_section(&mut output, "selected_messages", &request.selected_messages);
    push_evidence_section(&mut output, "current_code", &request.current_code);

    if !chunks.is_empty() {
        output.push_str("\n[retrieved_memory]\n");
        for chunk in chunks {
            let seq = match (chunk.seq_start, chunk.seq_end) {
                (Some(start), Some(end)) if start != end => format!(" seq={start}-{end}"),
                (Some(seq), _) => format!(" seq={seq}"),
                _ => String::new(),
            };
            let text = trim_text_head_to_char_boundary(&chunk.text, MAX_MEMORY_CHUNK_CHARS);
            output.push_str(&format!(
                "[memory id={} source={} kind={} score={:.2} reason={}{}]\n{}\n",
                chunk.id, chunk.source, chunk.kind, chunk.score, chunk.reason, seq, text
            ));
            if output.chars().count() >= MAX_CONTEXT_CHARS {
                break;
            }
        }
    }

    push_evidence_section(&mut output, "recent_timeline", &request.recent_timeline);

    trim_text_head_to_char_boundary(&output, MAX_CONTEXT_CHARS)
}

fn push_section(output: &mut String, label: &str, text: &str) {
    let text = text.trim();
    if !text.is_empty() {
        output.push_str(&format!("[{label}]\n{text}\n"));
    }
}

fn push_evidence_section(output: &mut String, label: &str, items: &[LocalEvidence]) {
    if items.is_empty() {
        return;
    }
    output.push_str(&format!("\n[{label}]\n"));
    for item in items {
        let text = item.text.trim();
        if !text.is_empty() {
            output.push_str(&format!("[{}]\n{}\n", item.label, text));
        }
    }
}

fn merge_vector_matches(chunks: &mut Vec<RankedChunk>, vector_matches: Vec<RankedChunk>) {
    let mut positions = HashMap::new();
    for (index, chunk) in chunks.iter().enumerate() {
        positions.insert(chunk.id, index);
    }

    for vector_chunk in vector_matches {
        if let Some(index) = positions.get(&vector_chunk.id).copied() {
            chunks[index].score = chunks[index].score.max(vector_chunk.score);
            chunks[index].reason = format!("{},{}", chunks[index].reason, vector_chunk.reason);
        } else {
            positions.insert(vector_chunk.id, chunks.len());
            chunks.push(vector_chunk);
        }
    }
}

fn adjusted_rank_score(query_text: &str, chunk: &RankedChunk) -> f32 {
    let query = query_text.to_lowercase();
    let text = chunk.text.to_lowercase();
    let mut score = chunk.score;

    for phrase in [
        "agent teams ai",
        "build_runner",
        "messenger_user_bot",
        "os ai computer use",
        "voice-to-text",
        "voicetextai",
        "qaspa",
    ] {
        if query.contains(phrase) && text.contains(phrase) {
            score += 45.0;
            score = score.max(180.0);
        }
    }

    if !query.contains("storymind") && text.contains("storymind") {
        score -= 42.0;
    }
    if query.contains("agent teams ai") && text.contains("electron") && text.contains("react") {
        score += 26.0;
    }
    if query.contains("agent teams ai")
        && text.contains("claude")
        && text.contains("codex")
        && text.contains("opencode")
    {
        score += 18.0;
    }
    if query.contains("agent teams ai")
        && query.contains("stack")
        && text.contains("other languages:")
    {
        score -= 28.0;
    }
    if query.contains("agent teams ai") && chunk.text.chars().count() > 2_500 {
        score -= 16.0;
    }
    if (query.contains("desktop automation") || query.contains("computer control"))
        && text.contains("os ai computer use")
    {
        score += 72.0;
        score = score.max(190.0);
    }
    if (query.contains("desktop automation") || query.contains("computer control"))
        && text.contains("agent teams ai")
        && !text.contains("os ai computer use")
    {
        score -= 38.0;
    }
    if (query.contains("voice-to-text") || query.contains("voicetextai"))
        && text.contains("tauri")
        && text.contains("rust")
        && text.contains("vue")
    {
        score += 46.0;
        score = score.max(185.0);
    }

    score
}

fn build_retrieval_query_text(request: &LocalContextRequest) -> String {
    let mut query_text = request.current_request.clone();
    if !request.current_request.trim().is_empty() {
        for _ in 0..3 {
            query_text.push('\n');
            query_text.push_str(&request.current_request);
        }
    }
    for item in request
        .selected_messages
        .iter()
        .chain(request.current_code.iter())
    {
        query_text.push('\n');
        query_text.push_str(&item.text);
    }
    let recent_start = request.recent_timeline.len().saturating_sub(2);
    for item in request.recent_timeline.iter().skip(recent_start) {
        query_text.push('\n');
        query_text.push_str(&item.text);
    }
    query_text
}

#[derive(Debug, Clone)]
struct RankedChunk {
    id: Uuid,
    source: String,
    kind: String,
    text: String,
    score: f32,
    reason: String,
    seq_start: Option<i64>,
    seq_end: Option<i64>,
    occurred_at_ms: i64,
}

#[derive(Debug, Serialize)]
struct OpenAiEmbeddingRequest<'a> {
    model: &'a str,
    input: &'a str,
    dimensions: usize,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingResponse {
    data: Vec<OpenAiEmbeddingItem>,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingItem {
    embedding: Vec<f32>,
}

fn infer_kind(source: &str, text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    if source == "ai_response" {
        "ai_response".to_string()
    } else if lower.contains("remember") || lower.contains("запомни") {
        "requirement".to_string()
    } else if text.ends_with('?') || lower.contains("как ") || lower.contains("what ") {
        "voice_question".to_string()
    } else {
        "raw_transcript_chunk".to_string()
    }
}

fn kind_score(kind: &str) -> f32 {
    match kind {
        "requirement" | "current_code" | "selected_message" | "manual_prompt" => 28.0,
        "voice_question" | "signal" => 20.0,
        "raw_transcript_chunk" => 10.0,
        _ => 6.0,
    }
}

fn source_hash(session_id: &Uuid, event_id: Option<&str>, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(session_id.as_bytes());
    hasher.update(event_id.unwrap_or_default().as_bytes());
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

fn normalize_text(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn should_skip_synthetic_e2e_memory(text: &str) -> bool {
    if env_bool("INTERVIEW_MEMORY_ALLOW_SYNTHETIC_E2E", false) {
        return false;
    }

    let lower = text.to_lowercase();
    lower.contains("e2e")
        || lower.contains("code_ctx_")
        || lower.contains("selected_ctx_")
        || lower.contains("unselected_ctx_")
        || lower.contains("signal-e2e")
        || (lower.contains("северный мост") && lower.contains("debouncesearch"))
}

fn significant_words(text: &str) -> BTreeSet<String> {
    normalize_text(text)
        .split(|ch: char| !ch.is_alphanumeric() && !matches!(ch, '_' | '-' | '/' | '.'))
        .filter(|word| word.chars().count() >= 3)
        .filter(|word| !STOP_WORDS.contains(word))
        .map(ToString::to_string)
        .collect()
}

fn vector_literal(vector: &[f32]) -> String {
    let values = vector
        .iter()
        .map(|value| {
            if value.is_finite() {
                value.to_string()
            } else {
                "0".to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("[{values}]")
}

fn trim_text_tail_to_char_boundary(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut indices = text
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    indices.push(text.len());
    let start = indices[text.chars().count().saturating_sub(max_chars)];
    text[start..].trim_start().to_string()
}

fn trim_text_head_to_char_boundary(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let end = text
        .char_indices()
        .map(|(index, _)| index)
        .nth(max_chars)
        .unwrap_or(text.len());
    text[..end].trim_end().to_string()
}

fn sanitize_error(error: &str) -> String {
    error
        .replace('\n', " ")
        .replace('\r', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

fn env_bool(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(default)
}

const STOP_WORDS: &[&str] = &[
    "and",
    "are",
    "but",
    "for",
    "how",
    "the",
    "this",
    "that",
    "was",
    "were",
    "with",
    "you",
    "your",
    "про",
    "как",
    "что",
    "это",
    "для",
    "или",
    "они",
    "она",
    "его",
    "мне",
    "тебя",
    "тебе",
    "если",
    "надо",
    "нужно",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn ranked_chunk(id: Uuid, score: f32, reason: &str, text: &str) -> RankedChunk {
        RankedChunk {
            id,
            source: "manual_prompt".to_string(),
            kind: "requirement".to_string(),
            text: text.to_string(),
            score,
            reason: reason.to_string(),
            seq_start: Some(7),
            seq_end: Some(9),
            occurred_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn source_hash_is_stable_for_same_event() {
        let session_id = Uuid::parse_str("053a417b-7607-4116-9241-2792914fae2c").unwrap();

        assert_eq!(
            source_hash(&session_id, Some("e1"), "Dart build_runner"),
            source_hash(&session_id, Some("e1"), "Dart build_runner")
        );
    }

    #[test]
    fn vector_literal_uses_pgvector_format() {
        assert_eq!(vector_literal(&[0.1, -0.2]), "[0.1,-0.2]");
    }

    #[test]
    fn vector_literal_sanitizes_non_finite_values() {
        assert_eq!(
            vector_literal(&[f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 1.0]),
            "[0,0,0,1]"
        );
    }

    #[test]
    fn significant_words_preserve_technical_identifiers() {
        let words = significant_words(
            "How did build_runner speed up Qaspa scan_secret and Rust/Axum services?",
        );

        assert!(words.contains("build_runner"));
        assert!(words.contains("qaspa"));
        assert!(words.contains("scan_secret"));
        assert!(words.contains("rust/axum"));
        assert!(!words.contains("how"));
    }

    #[test]
    fn infer_kind_detects_memory_requirements_questions_and_ai() {
        assert_eq!(
            infer_kind(
                "manual_prompt",
                "Remember that I sped up build_runner by 2x"
            ),
            "requirement"
        );
        assert_eq!(
            infer_kind("manual_prompt", "запомни опыт с Qaspa"),
            "requirement"
        );
        assert_eq!(
            infer_kind("system_audio", "What did I build with Solana?"),
            "voice_question"
        );
        assert_eq!(infer_kind("ai_response", "Sure"), "ai_response");
    }

    #[test]
    fn synthetic_e2e_memory_is_skipped_by_default() {
        std::env::remove_var("INTERVIEW_MEMORY_ALLOW_SYNTHETIC_E2E");

        assert!(should_skip_synthetic_e2e_memory(
            "Проект Северный мост. function debounceSearch() {}"
        ));
        assert!(should_skip_synthetic_e2e_memory(
            "CODE_CTX_E2E_ALPHA selected context marker"
        ));
        assert!(!should_skip_synthetic_e2e_memory(
            "Ilya sped up Dart build_runner code generation by 2x"
        ));
    }

    #[test]
    fn synthetic_e2e_memory_can_be_allowed_for_dedicated_tests() {
        std::env::set_var("INTERVIEW_MEMORY_ALLOW_SYNTHETIC_E2E", "1");
        assert!(!should_skip_synthetic_e2e_memory(
            "Проект Северный мост. function debounceSearch() {}"
        ));
        std::env::remove_var("INTERVIEW_MEMORY_ALLOW_SYNTHETIC_E2E");
    }

    #[test]
    fn merge_vector_matches_dedupes_and_keeps_best_score() {
        let id = Uuid::new_v4();
        let other_id = Uuid::new_v4();
        let mut chunks = vec![ranked_chunk(id, 12.0, "keyword:1", "Dart fact")];

        merge_vector_matches(
            &mut chunks,
            vec![
                ranked_chunk(id, 91.0, "vector:0.800", "Dart fact"),
                ranked_chunk(other_id, 70.0, "vector:0.600", "Qaspa fact"),
            ],
        );

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].score, 91.0);
        assert_eq!(chunks[0].reason, "keyword:1,vector:0.800");
        assert_eq!(chunks[1].id, other_id);
    }

    #[test]
    fn adjusted_rank_score_keeps_vacancy_prep_from_beating_project_facts() {
        let query = "Describe Agent Teams AI and mention its stack plus the agents it coordinates.";
        let storymind = ranked_chunk(
            Uuid::new_v4(),
            92.0,
            "vector:0.814",
            "Storymind prep: tie Agent Teams AI to Rust, TypeScript/NestJS and Python product workflows.",
        );
        let project_fact = ranked_chunk(
            Uuid::new_v4(),
            82.0,
            "vector:0.742",
            "Agent Teams AI is a TypeScript Electron React desktop app coordinating Claude, Codex and OpenCode.",
        );

        assert!(adjusted_rank_score(query, &project_fact) > adjusted_rank_score(query, &storymind));
    }

    #[test]
    fn adjusted_rank_score_keeps_storymind_context_when_storymind_is_requested() {
        let query = "How should I position Agent Teams AI for Storymind?";
        let storymind = ranked_chunk(
            Uuid::new_v4(),
            92.0,
            "vector:0.814",
            "Storymind prep: tie Agent Teams AI to Rust, TypeScript/NestJS and Python product workflows.",
        );

        assert!(adjusted_rank_score(query, &storymind) > 100.0);
    }

    #[test]
    fn adjusted_rank_score_prefers_agent_teams_actual_stack_over_language_dump() {
        let query = "Describe Agent Teams AI actual app stack plus the agents it coordinates.";
        let language_dump = ranked_chunk(
            Uuid::new_v4(),
            95.0,
            "vector:0.850",
            &format!(
                "{} {}",
                "Agent Teams AI repo stats. Primary language TypeScript. Other languages: JavaScript, CSS, HTML, Vue, SCSS, Dockerfile, Shell.",
                "x".repeat(3_000)
            ),
        );
        let actual_stack = ranked_chunk(
            Uuid::new_v4(),
            70.0,
            "keyword:3",
            "Agent Teams AI is an Electron React TypeScript desktop app coordinating Claude, Codex and OpenCode.",
        );

        assert!(
            adjusted_rank_score(query, &actual_stack) > adjusted_rank_score(query, &language_dump)
        );
    }

    #[test]
    fn adjusted_rank_score_strongly_boosts_exact_project_memory() {
        let query = "Explain Qaspa and mention concrete privacy or quantum-resistant features.";
        let qaspa = ranked_chunk(
            Uuid::new_v4(),
            60.0,
            "keyword:4",
            "Qaspa is Ilya's Rust fork of Kaspa focused on privacy and quantum resistance.",
        );
        let generic_crypto = ranked_chunk(
            Uuid::new_v4(),
            140.0,
            "vector:0.814",
            "Ilya implemented a quantum-resistant private-address PoW blockchain prototype.",
        );

        assert!(adjusted_rank_score(query, &qaspa) > adjusted_rank_score(query, &generic_crypto));
    }

    #[test]
    fn retrieval_query_prioritizes_current_request_and_recent_tail() {
        let request = LocalContextRequest {
            session_id: Uuid::new_v4(),
            current_request: "current autonomous workflow question".to_string(),
            selected_messages: Vec::new(),
            current_code: Vec::new(),
            recent_timeline: (0..12)
                .map(|index| LocalEvidence {
                    label: "signal".to_string(),
                    text: format!("old topic {index}"),
                })
                .collect(),
            max_results: 4,
        };

        let query = build_retrieval_query_text(&request);

        assert_eq!(
            query
                .matches("current autonomous workflow question")
                .count(),
            4
        );
        assert!(!query.contains("old topic 0"));
        assert!(!query.contains("old topic 3"));
        assert!(!query.contains("old topic 4"));
        assert!(query.contains("old topic 10"));
        assert!(query.contains("old topic 11"));
    }

    #[test]
    fn pack_context_includes_evidence_memory_and_sequence_range() {
        let memory_id = Uuid::new_v4();
        let context = pack_context(
            LocalContextRequest {
                session_id: Uuid::new_v4(),
                current_request: "Explain Qaspa".to_string(),
                selected_messages: vec![LocalEvidence {
                    label: "selected_message".to_string(),
                    text: "Interviewer asked about privacy chains".to_string(),
                }],
                current_code: Vec::new(),
                recent_timeline: Vec::new(),
                max_results: 4,
            },
            vec![ranked_chunk(
                memory_id,
                88.0,
                "vector:0.750",
                "Qaspa has stealth addresses and MLDSA.",
            )],
        );

        assert!(context.contains("[current_request]"));
        assert!(context.contains("[selected_messages]"));
        assert!(context.contains("[retrieved_memory]"));
        assert!(context.contains("seq=7-9"));
        assert!(context.contains("Qaspa has stealth addresses"));
    }

    #[test]
    fn pack_context_places_retrieved_memory_before_recent_timeline() {
        let context = pack_context(
            LocalContextRequest {
                session_id: Uuid::new_v4(),
                current_request: "Explain Qaspa".to_string(),
                selected_messages: Vec::new(),
                current_code: Vec::new(),
                recent_timeline: vec![LocalEvidence {
                    label: "system".to_string(),
                    text: "Long filler about unrelated roadmap planning.".to_string(),
                }],
                max_results: 4,
            },
            vec![ranked_chunk(
                Uuid::new_v4(),
                88.0,
                "vector:0.750",
                "Qaspa has stealth addresses and MLDSA.",
            )],
        );

        assert!(
            context.find("[retrieved_memory]").unwrap()
                < context.find("[recent_timeline]").unwrap()
        );
    }

    #[test]
    fn pack_context_preserves_current_request_when_memory_chunk_is_huge() {
        let context = pack_context(
            LocalContextRequest {
                session_id: Uuid::new_v4(),
                current_request: "How should I explain Qaspa?".to_string(),
                selected_messages: Vec::new(),
                current_code: Vec::new(),
                recent_timeline: Vec::new(),
                max_results: 1,
            },
            vec![ranked_chunk(
                Uuid::new_v4(),
                99.0,
                "vector:0.900",
                &"x".repeat(MAX_CONTEXT_CHARS * 2),
            )],
        );

        assert!(context.starts_with("[current_request]"));
        assert!(context.contains("How should I explain Qaspa?"));
        assert!(context.chars().count() <= MAX_CONTEXT_CHARS);
    }

    #[test]
    fn pack_context_truncates_individual_memory_chunks() {
        let context = pack_context(
            LocalContextRequest {
                session_id: Uuid::new_v4(),
                current_request: "Dart question".to_string(),
                selected_messages: Vec::new(),
                current_code: Vec::new(),
                recent_timeline: Vec::new(),
                max_results: 1,
            },
            vec![ranked_chunk(
                Uuid::new_v4(),
                99.0,
                "vector:0.900",
                &"a".repeat(MAX_MEMORY_CHUNK_CHARS + 500),
            )],
        );

        assert!(!context.contains(&"a".repeat(MAX_MEMORY_CHUNK_CHARS + 100)));
        assert!(context.contains(&"a".repeat(MAX_MEMORY_CHUNK_CHARS)));
    }

    #[test]
    fn trim_text_tail_keeps_utf8_boundary() {
        let trimmed = trim_text_tail_to_char_boundary("привет qaspa", 7);

        assert_eq!(trimmed, "т qaspa");
    }

    #[tokio::test]
    async fn local_pgvector_smoke_ingests_and_retrieves_without_embeddings() {
        if std::env::var("INTERVIEW_MEMORY_PGVECTOR_E2E")
            .ok()
            .as_deref()
            != Some("1")
        {
            return;
        }

        std::env::set_var("INTERVIEW_MEMORY_EMBEDDINGS_ENABLED", "false");
        let store = LocalInterviewMemoryStore::connect_from_env().await.unwrap();
        let session_id = Uuid::new_v4();

        store
            .ingest(LocalMemoryEvent {
                session_id,
                event_id: Some("smoke-stale-answer-like-question".to_string()),
                source: "manual_prompt".to_string(),
                kind_hint: Some("voice_question".to_string()),
                text: "I start by understanding the root cause, not just the symptoms. Then I split the problem into smaller parts.".to_string(),
                occurred_at_ms: Utc::now().timestamp_millis(),
                seq_start: Some(0),
                seq_end: Some(0),
                metadata: serde_json::json!({"test": true}),
            })
            .await
            .unwrap();

        store
            .ingest(LocalMemoryEvent {
                session_id,
                event_id: Some("smoke-dart-build-runner".to_string()),
                source: "manual_prompt".to_string(),
                kind_hint: Some("requirement".to_string()),
                text: "Ilya accelerated Dart build_runner code generation in Google open source by 2x.".to_string(),
                occurred_at_ms: Utc::now().timestamp_millis(),
                seq_start: Some(1),
                seq_end: Some(1),
                metadata: serde_json::json!({"test": true}),
            })
            .await
            .unwrap();

        let context = store
            .assemble_context(LocalContextRequest {
                session_id,
                current_request: "What Dart build_runner achievement should I mention?".to_string(),
                selected_messages: Vec::new(),
                current_code: Vec::new(),
                recent_timeline: Vec::new(),
                max_results: 4,
            })
            .await
            .unwrap();

        assert!(context.contains("build_runner"));
        assert!(context.contains("2x"));
        assert!(!context.contains("root cause"));
        assert!(!context.contains("symptoms"));

        sqlx::query("DELETE FROM interview_memory_chunks WHERE session_id = $1")
            .bind(session_id)
            .execute(&store.pool)
            .await
            .unwrap();
    }
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_MEMORY_PLATFORM_API_URL = 'http://127.0.0.1:7788';

export function normalizeApiVariant(value) {
  const normalized = String(value || 'legacy').trim().toLowerCase();
  if (['platform', 'v1', 'memory_platform', 'memory-platform'].includes(normalized)) return 'platform';
  if (['legacy', 'compat', 'compatibility'].includes(normalized)) return 'legacy';
  throw new Error(`Unknown memory api variant: ${value}`);
}

export const DEFAULT_MEMORY_API_URL =
  process.env.INTERVIEW_MEMORY_E2E_API_URL ||
  process.env.INTERVIEW_MEMORY_API_URL ||
  (normalizeApiVariant(process.env.INTERVIEW_MEMORY_API_VARIANT || 'legacy') === 'platform'
    ? DEFAULT_MEMORY_PLATFORM_API_URL
    : '') ||
  process.env.VITE_API_URL ||
  'https://api.voicetext.site';

export const DEFAULT_AUTH_STORE_PATH =
  process.env.HACKINTERVIEW_AUTH_STORE_PATH ||
  join(homedir(), 'Library/Application Support/HackInterview/auth_store.json');

const COMPANION_BRIDGE_CANDIDATES = [
  join(homedir(), 'Library/Application Support/ClipboardTools/bridge.json'),
  join(homedir(), 'Library/Application Support/HackInterview/companion_bridge.json'),
];

export function normalizeBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.protocol}//${url.host}`;
}

export async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export function tokenFromJson(json) {
  return String(
    json?.session?.access_token ||
      json?.access_token ||
      json?.token ||
      json?.data?.access_token ||
      json?.data?.session?.access_token ||
      '',
  ).trim();
}

export async function readAuthToken(options) {
  if (String(options.authToken || '').trim()) return String(options.authToken).trim();

  if (String(options.authTokenFile || '').trim()) {
    const raw = (await readFile(options.authTokenFile, 'utf8')).trim();
    if (!raw) return '';
    try {
      return tokenFromJson(JSON.parse(raw));
    } catch {
      return raw;
    }
  }

  return tokenFromJson(await readJsonIfExists(options.authStorePath || DEFAULT_AUTH_STORE_PATH));
}

export async function apiFetch(options, path, init = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${options.apiUrl}${path}`, init);
  const latencyMs = Math.round(performance.now() - startedAt);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  return {
    ok: response.ok && payload?.success !== false,
    status: response.status,
    latencyMs,
    payload,
  };
}

export async function authenticatedFetch(options, token, path, body, method = 'POST', extraHeaders = {}) {
  return apiFetch(options, path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-memory-canary-id': options.runId || 'document-memory',
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function stableDocumentId(text, label = 'document') {
  const hash = createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
  const safeLabel = String(label || 'document')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё_-]+/giu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${safeLabel || 'document'}-${hash}`;
}

function findSplitEnd(text, start, maxChars) {
  const hardEnd = Math.min(text.length, start + maxChars);
  if (hardEnd >= text.length) return text.length;

  const minSoftEnd = Math.min(hardEnd, start + Math.floor(maxChars * 0.55));
  const slice = text.slice(start, hardEnd);
  for (const separator of ['\n\n', '\n', '. ', '; ', ', ', ' ']) {
    const index = slice.lastIndexOf(separator);
    if (index >= 0 && start + index + separator.length >= minSoftEnd) {
      return start + index + separator.length;
    }
  }
  return hardEnd;
}

export function splitTextForMemory(text, options = {}) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return [];

  const maxChars = Math.max(1_000, Math.floor(options.maxCharsPerEvent || 12_000));
  const overlapChars = Math.max(0, Math.min(Math.floor(options.overlapChars || 0), Math.floor(maxChars / 4)));
  const chunks = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const chunkStart = cursor;
    const end = findSplitEnd(normalized, cursor, maxChars);
    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) {
      chunks.push({
        index: chunks.length + 1,
        start: chunkStart,
        end,
        text: chunk,
      });
    }
    if (end >= normalized.length) break;
    const nextCursor = Math.max(cursor + 1, end - overlapChars);
    cursor = Math.min(nextCursor, normalized.length);
  }

  return chunks;
}

export function buildMemoryEvent(sessionId, chunk, options = {}) {
  const eventIdPrefix = String(options.eventIdPrefix || `document:${options.documentId || randomUUID()}`);
  const eventId = `${eventIdPrefix}:chunk:${String(chunk.index).padStart(4, '0')}`;
  return {
    session_id: sessionId,
    event_id: eventId,
    source: options.source || 'manual_prompt',
    seq_start: chunk.index,
    seq_end: chunk.index,
    occurred_at: new Date().toISOString(),
    text: chunk.text,
    language: options.language || null,
    kind_hint: options.kindHint || 'requirement',
    metadata: {
      source_event_id: eventId,
      route: 'document_memory_import',
      attached_to_prompt: false,
      pinned: options.pinned !== false,
      explicit_interview_context: true,
      final_answer: false,
      request_scoped: false,
    },
  };
}

function sourceToSpeaker(source) {
  if (source === 'ai_response') return 'assistant';
  if (source === 'system_audio' || source === 'signal') return 'interviewer';
  if (source === 'microphone' || source === 'manual_prompt') return 'user';
  return 'unknown';
}

function sourceToTrustLevel(source) {
  if (source === 'ai_response') return 'low';
  if (source === 'focus_copy' || source === 'manual_prompt') return 'high';
  return 'medium';
}

function memoryScope(options, sessionId) {
  return {
    space_slug: options.spaceSlug || 'hackinterview',
    profile_external_ref: options.profileExternalRef || 'default',
    thread_external_ref: sessionId,
  };
}

function platformDocumentRequest(options, sessionId, chunk, eventOptions, label) {
  const event = buildMemoryEvent(sessionId, chunk, eventOptions);
  return {
    path: '/v1/documents',
    body: {
      ...memoryScope(options, sessionId),
      title: `${label} part ${String(chunk.index).padStart(4, '0')}`,
      text: chunk.text,
      source_type: 'document',
      source_external_id: event.event_id,
      classification: 'internal',
    },
    idempotencyKey: event.event_id,
  };
}

function platformEpisodeRequest(options, sessionId, chunk, eventOptions) {
  const event = buildMemoryEvent(sessionId, chunk, eventOptions);
  const sourceExternalId = event.event_id || event.metadata?.source_event_id || sessionId;
  return {
    path: '/v1/episodes',
    body: {
      ...memoryScope(options, sessionId),
      source_type: event.source,
      source_external_id: sourceExternalId,
      text: event.text,
      occurred_at: event.occurred_at,
      speaker: sourceToSpeaker(event.source),
      trust_level: sourceToTrustLevel(event.source),
      kind_hint: event.kind_hint,
      language: event.language,
      metadata: event.metadata,
      idempotency_key: sourceExternalId,
    },
    idempotencyKey: sourceExternalId,
  };
}

function ingestRequestForChunk(options, sessionId, chunk, eventOptions, label) {
  if (normalizeApiVariant(options.apiVariant || 'legacy') === 'platform') {
    return options.platformImportMode === 'episodes'
      ? platformEpisodeRequest(options, sessionId, chunk, eventOptions)
      : platformDocumentRequest(options, sessionId, chunk, eventOptions, label);
  }
  return {
    path: '/api/v1/interview-memory/ingest',
    body: buildMemoryEvent(sessionId, chunk, eventOptions),
    idempotencyKey: null,
  };
}

export async function importDocumentText(options, token, input) {
  const text = String(input.text || '');
  const label = input.label || 'document';
  const documentId = input.documentId || stableDocumentId(text, label);
  const sessionId = input.sessionId || randomUUID();
  const chunks = splitTextForMemory(text, options);
  if (chunks.length === 0) throw new Error('Document is empty after trimming.');

  const eventOptions = {
    documentId,
    eventIdPrefix: input.eventIdPrefix || `document:${documentId}`,
    source: options.source,
    language: options.language,
    kindHint: options.kindHint,
    pinned: options.pinned,
  };

  const results = [];
  for (const chunk of chunks) {
    const ingest = ingestRequestForChunk(options, sessionId, chunk, eventOptions, label);
    const response = await authenticatedFetch(
      options,
      token,
      ingest.path,
      ingest.body,
      'POST',
      ingest.idempotencyKey ? { 'Idempotency-Key': ingest.idempotencyKey } : {},
    );
    const storedChunks = Number(
      response.payload?.data?.stored_chunks ??
        response.payload?.data?.chunks ??
        0,
    );
    const duplicateChunks = Number(response.payload?.data?.duplicate_chunks || 0);
    results.push({
      index: chunk.index,
      chars: chunk.text.length,
      status: response.status,
      ok: response.ok,
      latencyMs: response.latencyMs,
      storedChunks,
      duplicateChunks,
      durability: response.payload?.data?.durability || response.payload?.data?.indexing_status,
    });
    if (!response.ok) {
      throw new Error(`Document ingest failed at chunk ${chunk.index}: ${response.status} ${JSON.stringify(response.payload)}`);
    }
  }

  return {
    sessionId,
    documentId,
    label,
    inputChars: text.length,
    chunkCount: chunks.length,
    storedChunks: results.reduce((sum, item) => sum + item.storedChunks, 0),
    duplicateChunks: results.reduce((sum, item) => sum + item.duplicateChunks, 0),
    results,
  };
}

export async function fetchMemoryContext(options, token, sessionId, check) {
  if (normalizeApiVariant(options.apiVariant || 'legacy') === 'platform') {
    return authenticatedFetch(options, token, '/v1/context', {
      ...memoryScope(options, sessionId),
      query: check.query,
      token_budget: Math.max(64, Math.min(16_000, Math.floor((check.budgetMaxChars || options.contextBudgetChars || 18_000) / 4))),
      max_facts: 20,
      max_chunks: check.maxMemoryResults || options.maxMemoryResults,
    });
  }
  return authenticatedFetch(options, token, '/api/v1/interview-memory/context', {
    session_id: sessionId,
    context_snapshot_id: check.contextSnapshotId || `document-memory-${options.runId || randomUUID()}-${check.label}`,
    current_request: {
      id: check.id || `document-memory-request-${check.label}`,
      label: check.requestLabel || 'document_memory_check',
      text: check.query,
    },
    selected_messages: check.selectedMessages || [],
    current_code: check.currentCode || [],
    recent_timeline: check.recentTimeline || [],
    budget_max_chars: check.budgetMaxChars || options.contextBudgetChars,
    max_memory_candidates: check.maxMemoryCandidates || options.maxMemoryCandidates,
    max_memory_results: check.maxMemoryResults || options.maxMemoryResults,
  });
}

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

export function evaluateRequiredTerms(contextText, checks) {
  const normalized = normalizeText(contextText);
  return checks.map((check) => {
    const terms = Array.isArray(check.requiredTerms) ? check.requiredTerms : [];
    const missingTerms = terms.filter((term) => !normalized.includes(normalizeText(term)));
    return {
      label: check.label,
      ok: missingTerms.length === 0,
      requiredTermCount: terms.length,
      missingTermCount: missingTerms.length,
      missingTerms,
    };
  });
}

export async function deleteMemorySession(options, token, sessionId) {
  if (normalizeApiVariant(options.apiVariant || 'legacy') === 'platform') {
    return authenticatedFetch(options, token, '/v1/thread-memory', memoryScope(options, sessionId), 'DELETE');
  }
  return authenticatedFetch(options, token, `/api/v1/interview-memory/sessions/${sessionId}`, undefined, 'DELETE');
}

export function memoryContextText(options, payload) {
  return normalizeApiVariant(options.apiVariant || 'legacy') === 'platform'
    ? payload?.data?.rendered_text || ''
    : payload?.data?.text || '';
}

export function extractTokenFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;
    const match = url.pathname.match(/\/c\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

export async function readCompanionBridgeToken() {
  for (const path of COMPANION_BRIDGE_CANDIDATES) {
    const value = await readJsonIfExists(path);
    const token = String(value?.companionAccessToken || '').trim();
    if (token) return { token, path };
  }
  return { token: '', path: '' };
}

export async function resolveCompanionState(options) {
  const baseUrl = normalizeBaseUrl(options.companionBaseUrl || process.env.COMPANION_URL || 'http://127.0.0.1:43821');
  let token = String(options.companionToken || '').trim();
  if (!token) token = extractTokenFromUrl(process.env.COMPANION_URL || options.companionBaseUrl || '');
  let bridgePath = '';
  if (!token) {
    const bridge = await readCompanionBridgeToken();
    token = bridge.token;
    bridgePath = bridge.path;
  }
  if (!token) throw new Error('Companion token not found. Pass --companion-token, COMPANION_TOKEN, COMPANION_URL or use the bridge file.');

  const response = await fetch(`${baseUrl}/api/state?token=${encodeURIComponent(token)}`);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Companion state failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return {
    baseUrl,
    token,
    bridgePath,
    payload,
    memorySessionId: String(payload?.data?.memory?.sessionId || payload?.memory?.sessionId || '').trim(),
  };
}

export async function loadDocumentFile(filePath) {
  return {
    label: basename(filePath),
    text: await readFile(filePath, 'utf8'),
  };
}

export async function writeJsonArtifact(dir, artifact) {
  await mkdir(dir, { recursive: true });
  const artifactPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifactPath;
}

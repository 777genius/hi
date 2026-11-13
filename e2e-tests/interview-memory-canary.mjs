#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const DEFAULT_API_URL =
  process.env.INTERVIEW_MEMORY_E2E_API_URL ||
  process.env.INTERVIEW_MEMORY_API_URL ||
  process.env.VITE_API_URL ||
  'https://api.voicetext.site';

const REQUIRED_CHECKS = [
  { label: 'early code marker', terms: ['IM_CANARY_CODE'] },
  { label: 'project phrase', terms: ['Северный мост'] },
  { label: 'queue not stack', terms: ['очередь', 'стек'] },
  { label: 'linear complexity', terms: ['линейная'] },
  { label: 'late marker', terms: ['IM_CANARY_LATE'] },
];

const getDataNumber = (payload, key) => {
  const value = payload?.data?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : 0;
};

function parseArgs(argv) {
  const options = {
    apiUrl: DEFAULT_API_URL,
    authToken: process.env.INTERVIEW_MEMORY_AUTH_TOKEN || '',
    authTokenFile: process.env.INTERVIEW_MEMORY_AUTH_TOKEN_FILE || '',
    authStorePath:
      process.env.HACKINTERVIEW_AUTH_STORE_PATH ||
      join(homedir(), 'Library/Application Support/HackInterview/auth_store.json'),
    apiVariant: process.env.INTERVIEW_MEMORY_API_VARIANT || 'legacy',
    spaceSlug: process.env.INTERVIEW_MEMORY_SPACE_SLUG || 'hackinterview',
    profileExternalRef:
      process.env.INTERVIEW_MEMORY_PROFILE_EXTERNAL_REF ||
      process.env.INTERVIEW_MEMORY_PROFILE_REF ||
      'default',
    artifactsDir: '.e2e-artifacts/interview-memory-canary',
    keepSession: false,
    contextBudgetChars: Number(process.env.INTERVIEW_MEMORY_CANARY_BUDGET_CHARS || 18_000),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;

    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };

    if (arg === '--api-url') options.apiUrl = next();
    else if (arg === '--auth-token') options.authToken = next();
    else if (arg === '--auth-token-file') options.authTokenFile = next();
    else if (arg === '--auth-store-path') options.authStorePath = next();
    else if (arg === '--api-variant') options.apiVariant = next();
    else if (arg === '--space-slug') options.spaceSlug = next();
    else if (arg === '--profile-ref') options.profileExternalRef = next();
    else if (arg === '--artifacts-dir') options.artifactsDir = next();
    else if (arg === '--keep-session') options.keepSession = true;
    else if (arg === '--budget-chars') options.contextBudgetChars = Number(next());
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.apiUrl = normalizeBaseUrl(options.apiUrl);
  options.apiVariant = normalizeApiVariant(options.apiVariant);
  options.contextBudgetChars = Math.max(1_000, Math.floor(options.contextBudgetChars || 18_000));
  return options;
}

function printHelp() {
  console.log(`Interview memory backend canary

Usage:
  pnpm e2e:memory-canary -- --api-url https://api.voicetext.site

What it checks:
  - calls legacy /api/v1/interview-memory/* or Memo Stack /v1/*;
  - creates an isolated synthetic memory session;
  - ingests deterministic code, voice question, constraint, filler, prompt and final AI-answer events;
  - verifies /context retrieves required early and late evidence under budget;
  - checks duplicate final-event ingest is idempotent;
  - deletes the synthetic session unless --keep-session is passed;
  - writes a production-safe redacted artifact.

Useful flags:
  --api-url <url>             Backend URL, default VITE_API_URL/INTERVIEW_MEMORY_API_URL/https://api.voicetext.site.
  --api-variant <name>        legacy or platform, default INTERVIEW_MEMORY_API_VARIANT/legacy.
  --space-slug <slug>         Memo Stack space slug, default hackinterview.
  --profile-ref <ref>         Memo Stack profile external ref, default default.
  --auth-token <token>        Raw bearer token.
  --auth-token-file <path>    Raw token or auth_store.json.
  --auth-store-path <path>    Native Tauri auth store, default ~/Library/Application Support/HackInterview/auth_store.json.
  --artifacts-dir <path>      Output artifact directory.
  --budget-chars <n>          Context budget for /context.
  --keep-session              Do not delete the synthetic session after the check.
`);
}

function normalizeBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.protocol}//${url.host}`;
}

function normalizeApiVariant(value) {
  const normalized = String(value || 'legacy').trim().toLowerCase();
  if (
    ['platform', 'v1', 'memo_stack', 'memo-stack', 'memory_platform', 'memory-platform'].includes(
      normalized,
    )
  )
    return 'platform';
  if (['legacy', 'compat', 'compatibility'].includes(normalized)) return 'legacy';
  throw new Error(`Unknown memory api variant: ${value}`);
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function tokenFromJson(json) {
  return String(
    json?.session?.access_token ||
      json?.access_token ||
      json?.token ||
      json?.data?.access_token ||
      json?.data?.session?.access_token ||
      '',
  ).trim();
}

async function readAuthToken(options) {
  if (options.authToken.trim()) return options.authToken.trim();
  if (options.authTokenFile.trim()) {
    const raw = (await readFile(options.authTokenFile, 'utf8')).trim();
    if (!raw) return '';
    try {
      return tokenFromJson(JSON.parse(raw));
    } catch {
      return raw;
    }
  }

  const authStore = await readJsonIfExists(options.authStorePath);
  return tokenFromJson(authStore);
}

async function apiFetch(options, path, init = {}) {
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

async function authenticatedFetch(options, token, path, body, method = 'POST') {
  return apiFetch(options, path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-memory-canary-id': options.runId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function nowIso() {
  return new Date().toISOString();
}

function memoryEvent(sessionId, event) {
  return {
    session_id: sessionId,
    event_id: event.eventId,
    source: event.source,
    seq_start: event.seq,
    seq_end: event.seq,
    occurred_at: nowIso(),
    text: event.text,
    language: event.language || 'ru',
    kind_hint: event.kindHint,
    metadata: {
      source_event_id: event.eventId,
      attached_to_prompt: Boolean(event.attachedToPrompt),
      pinned: Boolean(event.pinned),
      explicit_interview_context: Boolean(event.explicitInterviewContext),
      final_answer: Boolean(event.finalAnswer),
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
    space_slug: options.spaceSlug,
    profile_external_ref: options.profileExternalRef,
    thread_external_ref: sessionId,
  };
}

function ingestRequest(options, sessionId, event) {
  const legacy = memoryEvent(sessionId, event);
  if (options.apiVariant === 'legacy') return legacy;
  const sourceExternalId = legacy.event_id || legacy.metadata?.source_event_id || sessionId;
  return {
    ...memoryScope(options, sessionId),
    source_type: legacy.source,
    source_external_id: sourceExternalId,
    text: legacy.text,
    occurred_at: legacy.occurred_at,
    speaker: sourceToSpeaker(legacy.source),
    trust_level: sourceToTrustLevel(legacy.source),
    kind_hint: legacy.kind_hint,
    language: legacy.language,
    metadata: legacy.metadata,
    idempotency_key: sourceExternalId,
  };
}

function contextRequest(options, sessionId) {
  const text = [
    'Найди контекст интервью по проекту Северный мост.',
    'Нужны debounceSearch, очередь FIFO не стек, линейная сложность и поздний маркер.',
  ].join(' ');
  if (options.apiVariant === 'legacy') {
    return {
      session_id: sessionId,
      context_snapshot_id: `canary-${options.runId}`,
      current_request: {
        id: `${options.runId}:request`,
        label: 'canary_request',
        text,
      },
      budget_max_chars: options.contextBudgetChars,
      max_memory_candidates: 200,
      max_memory_results: 32,
    };
  }
  return {
    ...memoryScope(options, sessionId),
    query: text,
    token_budget: Math.max(64, Math.min(16_000, Math.floor(options.contextBudgetChars / 4))),
    max_facts: 20,
    max_chunks: 32,
  };
}

function contextText(options, payload) {
  return options.apiVariant === 'platform'
    ? payload?.data?.rendered_text || ''
    : payload?.data?.text || '';
}

function ingestPath(options) {
  return options.apiVariant === 'platform' ? '/v1/episodes' : '/api/v1/interview-memory/ingest';
}

function contextPath(options) {
  return options.apiVariant === 'platform' ? '/v1/context' : '/api/v1/interview-memory/context';
}

function buildEvents(runId) {
  const shortRunId = runId.replaceAll('-', '').slice(0, 12);
  return [
    {
      label: 'early_code',
      eventId: `${runId}:early-code`,
      source: 'focus_copy',
      seq: 1,
      kindHint: 'current_code',
      attachedToPrompt: true,
      explicitInterviewContext: true,
      text: [
        `IM_CANARY_CODE_${shortRunId}`,
        'Проект Северный мост: проверь debounceSearch и объясни отмену прошлого таймера.',
        '```ts',
        'function debounceSearch(fn, delayMs) {',
        '  let timer;',
        '  return (query) => {',
        '    clearTimeout(timer);',
        '    timer = setTimeout(() => fn(query), delayMs);',
        '  };',
        '}',
        '```',
      ].join('\n'),
    },
    {
      label: 'voice_question',
      eventId: `${runId}:voice-question`,
      source: 'system_audio',
      seq: 2,
      kindHint: 'voice_question',
      text: 'Голосовой вопрос интервью: почему debounceSearch должен сохранять последний аргумент и отменять старый таймер?',
    },
    {
      label: 'constraint',
      eventId: `${runId}:constraint`,
      source: 'system_audio',
      seq: 3,
      kindHint: 'constraint',
      text: 'Критичное уточнение: для очереди событий нужна очередь FIFO, не стек LIFO.',
    },
    {
      label: 'filler',
      eventId: `${runId}:filler`,
      source: 'system_audio',
      seq: 4,
      kindHint: 'raw_transcript_chunk',
      text: 'Длинная середина интервью без контрольных маркеров. '.repeat(120),
    },
    {
      label: 'manual_prompt',
      eventId: `${runId}:manual-prompt`,
      source: 'manual_prompt',
      seq: 5,
      kindHint: 'user_prompt',
      text: 'Сформируй ответ кандидата: учти Северный мост, debounceSearch, очередь вместо стека и линейная сложность.',
    },
    {
      label: 'late_marker',
      eventId: `${runId}:late-marker`,
      source: 'focus_copy',
      seq: 6,
      kindHint: 'selected_message',
      attachedToPrompt: true,
      explicitInterviewContext: true,
      text: `IM_CANARY_LATE_${shortRunId}: позднее уточнение - решение должно быть линейная сложность O(n).`,
    },
    {
      label: 'ai_distractor',
      eventId: `${runId}:ai-final`,
      source: 'ai_response',
      seq: 7,
      kindHint: 'ai_response',
      finalAnswer: true,
      text: 'Черновой ответ AI с низким приоритетом: можно было бы использовать стек, но это distractor.',
    },
  ];
}

function checkContext(contextText) {
  const normalized = String(contextText || '').toLowerCase();
  return REQUIRED_CHECKS.map((check) => ({
    label: check.label,
    ok: check.terms.every((term) => normalized.includes(term.toLowerCase())),
    termCount: check.terms.length,
  }));
}

function assertNoRawLeak(artifact) {
  const serialized = JSON.stringify(artifact).toLowerCase();
  const forbidden = [
    'im_canary_code',
    'im_canary_late',
    'debouncesearch',
    'северный мост',
    'очередь fifo',
    'черновой ответ ai',
  ];
  const leaked = forbidden.filter((fragment) => serialized.includes(fragment));
  if (leaked.length > 0) {
    throw new Error(`Production-safe canary artifact leaked raw fragments: ${leaked.join(', ')}`);
  }
}

async function writeArtifact(options, artifact) {
  assertNoRawLeak(artifact);
  await mkdir(options.artifactsDir, { recursive: true });
  const artifactPath = join(
    options.artifactsDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifactPath;
}

function responseSummary(response) {
  return {
    status: response.status,
    ok: response.ok,
    latencyMs: response.latencyMs,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.runId = randomUUID();
  const token = await readAuthToken(options);
  if (!token) {
    throw new Error('Auth token is required. Pass --auth-token, --auth-token-file or a valid auth_store.json.');
  }

  const sessionId = randomUUID();
  const events = buildEvents(options.runId);
  const startedAt = new Date().toISOString();
  const health = await apiFetch(options, '/health');
  if (!health.ok) throw new Error(`Health check failed: ${health.status}`);

  const ingestResults = [];
  let contextResult = null;
  let duplicateResult = null;
  let statusBeforeDelete = null;
  let deleteResult = null;
  let statusAfterDelete = null;

  try {
    for (const event of events) {
      const response = await authenticatedFetch(
        options,
        token,
        ingestPath(options),
        ingestRequest(options, sessionId, event),
      );
      ingestResults.push({
        label: event.label,
        ...responseSummary(response),
        durability: response.payload?.data?.durability,
        storedChunks: response.payload?.data?.stored_chunks ?? 0,
        duplicateChunks: response.payload?.data?.duplicate_chunks ?? 0,
      });
      if (!response.ok) {
        throw new Error(`Ingest failed for ${event.label}: ${response.status} ${JSON.stringify(response.payload)}`);
      }
    }

    const duplicateEvent = events.find((event) => event.label === 'constraint');
    duplicateResult = await authenticatedFetch(
      options,
      token,
      ingestPath(options),
      ingestRequest(options, sessionId, duplicateEvent),
    );
    if (!duplicateResult.ok) {
      throw new Error(`Duplicate ingest failed: ${duplicateResult.status} ${JSON.stringify(duplicateResult.payload)}`);
    }
    const duplicateStoredChunks = getDataNumber(duplicateResult.payload, 'stored_chunks');
    const duplicateChunks = getDataNumber(duplicateResult.payload, 'duplicate_chunks');
    if (duplicateStoredChunks !== 0 || duplicateChunks < 1) {
      throw new Error(
        `Duplicate ingest was not idempotent: stored=${duplicateStoredChunks}, duplicate=${duplicateChunks}`,
      );
    }

    contextResult = await authenticatedFetch(
      options,
      token,
      contextPath(options),
      contextRequest(options, sessionId),
    );
    if (!contextResult.ok) {
      throw new Error(`Context failed: ${contextResult.status} ${JSON.stringify(contextResult.payload)}`);
    }

    const checks = checkContext(contextText(options, contextResult.payload));
    const allChecksOk = checks.every((check) => check.ok);
    if (!allChecksOk) {
      throw new Error(`Context checks failed: ${checks.map((check) => `${check.label}=${check.ok}`).join(', ')}`);
    }

    statusBeforeDelete =
      options.apiVariant === 'platform'
        ? await authenticatedFetch(
            options,
            token,
            '/v1/thread-memory/status',
            memoryScope(options, sessionId),
          )
        : await authenticatedFetch(
            options,
            token,
            `/api/v1/interview-memory/sessions/${sessionId}/status`,
            undefined,
            'GET',
          );
    if (!statusBeforeDelete.ok) {
      throw new Error(`Status before delete failed: ${statusBeforeDelete.status}`);
    }
    const chunksBeforeDelete = getDataNumber(statusBeforeDelete.payload, 'chunks');
    if (chunksBeforeDelete <= 0) {
      throw new Error(`Status before delete reported no chunks: ${chunksBeforeDelete}`);
    }

    if (!options.keepSession) {
      deleteResult =
        options.apiVariant === 'platform'
          ? await authenticatedFetch(
              options,
              token,
              '/v1/thread-memory',
              memoryScope(options, sessionId),
              'DELETE',
            )
          : await authenticatedFetch(
              options,
              token,
              `/api/v1/interview-memory/sessions/${sessionId}`,
              undefined,
              'DELETE',
            );
      if (!deleteResult.ok) {
        throw new Error(`Delete failed: ${deleteResult.status}`);
      }

      statusAfterDelete =
        options.apiVariant === 'platform'
          ? await authenticatedFetch(
              options,
              token,
              '/v1/thread-memory/status',
              memoryScope(options, sessionId),
            )
          : await authenticatedFetch(
              options,
              token,
              `/api/v1/interview-memory/sessions/${sessionId}/status`,
              undefined,
              'GET',
            );
      if (!statusAfterDelete.ok) {
        throw new Error(`Status after delete failed: ${statusAfterDelete.status}`);
      }
      const countsAfterDelete = ['chunks', 'facts', 'jobs', 'pending_jobs'].map((key) => [
        key,
        getDataNumber(statusAfterDelete.payload, key),
      ]);
      const staleCounts = countsAfterDelete.filter(([, value]) => value !== 0);
      if (staleCounts.length > 0) {
        throw new Error(
          `Delete cleanup left data: ${staleCounts.map(([key, value]) => `${key}=${value}`).join(', ')}`,
        );
      }
    }

    const artifact = {
      artifactVersion: 1,
      productionSafe: true,
      createdAt: new Date().toISOString(),
      startedAt,
      apiHost: new URL(options.apiUrl).host,
      apiVariant: options.apiVariant,
      runId: options.runId,
      sessionId,
      keptSession: options.keepSession,
      health: responseSummary(health),
      ingest: {
        eventCount: ingestResults.length,
        storedChunks: ingestResults.reduce((sum, item) => sum + item.storedChunks, 0),
        duplicateChunks: ingestResults.reduce((sum, item) => sum + item.duplicateChunks, 0),
        results: ingestResults,
      },
      duplicateIngest: {
        ...responseSummary(duplicateResult),
        storedChunks: duplicateResult.payload?.data?.stored_chunks ?? 0,
        duplicateChunks: duplicateResult.payload?.data?.duplicate_chunks ?? 0,
      },
      context: {
        ...responseSummary(contextResult),
        checks,
        itemCount: contextResult.payload?.data?.items?.length ?? null,
        budgetUsed: contextResult.payload?.data?.artifact?.budget_used ?? null,
        budgetTotal: contextResult.payload?.data?.artifact?.budget_total ?? null,
        criticalBudgetPressure:
          contextResult.payload?.data?.artifact?.critical_budget_pressure ?? null,
        sectionCount: contextResult.payload?.data?.artifact?.sections?.length ?? null,
        includedChunks: contextResult.payload?.data?.artifact?.included_chunks?.length ?? null,
        droppedChunks: contextResult.payload?.data?.artifact?.dropped_chunks?.length ?? null,
      },
      statusBeforeDelete: statusBeforeDelete
        ? {
            ...responseSummary(statusBeforeDelete),
            chunks: statusBeforeDelete.payload?.data?.chunks,
            facts: statusBeforeDelete.payload?.data?.facts,
            jobs: statusBeforeDelete.payload?.data?.jobs,
            pendingJobs: statusBeforeDelete.payload?.data?.pending_jobs,
          }
        : null,
      delete: deleteResult
        ? {
            ...responseSummary(deleteResult),
            deletedChunks: deleteResult.payload?.data?.deleted_chunks,
            deletedFacts: deleteResult.payload?.data?.deleted_facts,
            deletedJobs: deleteResult.payload?.data?.deleted_jobs,
          }
        : null,
      statusAfterDelete: statusAfterDelete
        ? {
            ...responseSummary(statusAfterDelete),
            chunks: statusAfterDelete.payload?.data?.chunks,
            facts: statusAfterDelete.payload?.data?.facts,
            jobs: statusAfterDelete.payload?.data?.jobs,
            pendingJobs: statusAfterDelete.payload?.data?.pending_jobs,
          }
        : null,
    };

    const artifactPath = await writeArtifact(options, artifact);
    console.log(
      JSON.stringify(
        {
          ok: true,
          apiHost: artifact.apiHost,
          sessionId,
          artifactPath,
          contextLatencyMs: artifact.context.latencyMs,
          storedChunks: artifact.ingest.storedChunks,
          duplicateChunks: artifact.duplicateIngest.duplicateChunks,
          deletedChunks: artifact.delete?.deletedChunks ?? null,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (!options.keepSession) {
      const cleanup =
        options.apiVariant === 'platform'
          ? authenticatedFetch(
              options,
              token,
              '/v1/thread-memory',
              memoryScope(options, sessionId),
              'DELETE',
            )
          : authenticatedFetch(
              options,
              token,
              `/api/v1/interview-memory/sessions/${sessionId}`,
              undefined,
              'DELETE',
            );
      await cleanup.catch(() => {});
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`[memory-canary] ${error.stack || error.message || error}`);
  process.exit(1);
});

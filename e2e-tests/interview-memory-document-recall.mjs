#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_AUTH_STORE_PATH,
  DEFAULT_MEMORY_API_URL,
  deleteMemorySession,
  evaluateRequiredTerms,
  fetchMemoryContext,
  importDocumentText,
  loadDocumentFile,
  memoryContextText,
  normalizeBaseUrl,
  normalizeApiVariant,
  readAuthToken,
  writeJsonArtifact,
} from './helpers/interviewMemoryDocument.mjs';

function parseArgs(argv) {
  const options = {
    apiUrl: process.env.INTERVIEW_MEMORY_E2E_API_URL || process.env.INTERVIEW_MEMORY_API_URL || DEFAULT_MEMORY_API_URL,
    apiVariant: process.env.INTERVIEW_MEMORY_API_VARIANT || 'legacy',
    spaceSlug: process.env.INTERVIEW_MEMORY_SPACE_SLUG || 'hackinterview',
    profileExternalRef:
      process.env.INTERVIEW_MEMORY_PROFILE_EXTERNAL_REF ||
      process.env.INTERVIEW_MEMORY_PROFILE_REF ||
      'default',
    platformImportMode: process.env.INTERVIEW_MEMORY_PLATFORM_IMPORT_MODE || 'documents',
    authToken: process.env.INTERVIEW_MEMORY_AUTH_TOKEN || '',
    authTokenFile: process.env.INTERVIEW_MEMORY_AUTH_TOKEN_FILE || '',
    authStorePath: DEFAULT_AUTH_STORE_PATH,
    documentFile: '',
    checksFile: '',
    artifactsDir: '.e2e-artifacts/interview-memory-document-recall',
    keepSession: false,
    contextBudgetChars: Number(process.env.INTERVIEW_MEMORY_DOCUMENT_BUDGET_CHARS || 18_000),
    maxMemoryCandidates: Number(process.env.INTERVIEW_MEMORY_DOCUMENT_MAX_CANDIDATES || 300),
    maxMemoryResults: Number(process.env.INTERVIEW_MEMORY_DOCUMENT_MAX_RESULTS || 48),
    maxCharsPerEvent: Number(process.env.INTERVIEW_MEMORY_IMPORT_CHUNK_CHARS || 12_000),
    overlapChars: Number(process.env.INTERVIEW_MEMORY_IMPORT_OVERLAP_CHARS || 400),
    pinned: true,
    selfTest: false,
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
    else if (arg === '--api-variant') options.apiVariant = next();
    else if (arg === '--space-slug') options.spaceSlug = next();
    else if (arg === '--profile-ref') options.profileExternalRef = next();
    else if (arg === '--platform-import-mode') options.platformImportMode = next();
    else if (arg === '--auth-token') options.authToken = next();
    else if (arg === '--auth-token-file') options.authTokenFile = next();
    else if (arg === '--auth-store-path') options.authStorePath = next();
    else if (arg === '--document-file') options.documentFile = next();
    else if (arg === '--checks-file') options.checksFile = next();
    else if (arg === '--artifacts-dir') options.artifactsDir = next();
    else if (arg === '--keep-session') options.keepSession = true;
    else if (arg === '--budget-chars') options.contextBudgetChars = Number(next());
    else if (arg === '--max-memory-candidates') options.maxMemoryCandidates = Number(next());
    else if (arg === '--max-memory-results') options.maxMemoryResults = Number(next());
    else if (arg === '--max-chars-per-event') options.maxCharsPerEvent = Number(next());
    else if (arg === '--overlap-chars') options.overlapChars = Number(next());
    else if (arg === '--no-pinned') options.pinned = false;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.apiUrl = normalizeBaseUrl(options.apiUrl);
  options.apiVariant = normalizeApiVariant(options.apiVariant);
  if (!['documents', 'episodes'].includes(options.platformImportMode)) {
    throw new Error('--platform-import-mode must be documents or episodes');
  }
  options.contextBudgetChars = Math.max(1_000, Math.floor(options.contextBudgetChars || 18_000));
  options.maxMemoryCandidates = Math.max(1, Math.floor(options.maxMemoryCandidates || 300));
  options.maxMemoryResults = Math.max(1, Math.floor(options.maxMemoryResults || 48));
  options.maxCharsPerEvent = Math.max(1_000, Math.floor(options.maxCharsPerEvent || 12_000));
  options.overlapChars = Math.max(0, Math.floor(options.overlapChars || 0));
  return options;
}

function printHelp() {
  console.log(`Interview memory document recall E2E

Usage:
  pnpm e2e:memory-document-recall
  pnpm e2e:memory-document-recall -- --document-file ./profile.txt --checks-file ./profile.checks.json

What it checks:
  - imports a large text document into an isolated memory session;
  - asks legacy /api/v1/interview-memory/context or Memory Platform /v1/context topic-specific questions;
  - verifies every required check term is retrieved from the document;
  - deletes the synthetic session unless --keep-session is passed;
  - writes a production-safe artifact without raw document or retrieved text.

Checks file format:
  [
    {
      "label": "style",
      "query": "Какие правила ответа указаны в документе?",
      "requiredTerms": ["коротко", "по-русски"]
    }
  ]

Useful flags:
  --api-url <url>             Backend URL, default VITE_API_URL/INTERVIEW_MEMORY_API_URL/prod.
  --api-variant <name>        legacy or platform, default INTERVIEW_MEMORY_API_VARIANT/legacy.
  --space-slug <slug>         Memory Platform space slug, default hackinterview.
  --profile-ref <ref>         Memory Platform profile external ref, default default.
  --platform-import-mode <m>  documents or episodes for platform mode, default documents.
  --auth-token <token>        Raw bearer token.
  --auth-token-file <path>    Raw token or auth_store.json.
  --document-file <path>      Real document. Without it the test generates a large synthetic document.
  --checks-file <path>        Required for real documents.
  --budget-chars <n>          Context budget for each recall query, default 18000.
  --keep-session              Do not delete the isolated session after the check.
  --self-test                 Validate local scenario/check logic without backend calls.
`);
}

function filler(label, chars) {
  const paragraph = [
    `Раздел ${label}: нейтральные заметки интервью без контрольных терминов.`,
    'Здесь много обычного текста, который нужен только для давления на chunking и retrieval budget.',
    'Он не должен сам по себе помогать проверкам памяти.',
  ].join(' ');
  return Array.from({ length: Math.ceil(chars / paragraph.length) }, () => paragraph).join('\n').slice(0, chars);
}

function buildSyntheticScenario(runId) {
  const shortRunId = runId.replaceAll('-', '').slice(0, 12);
  const markers = {
    project: `DOCMEM_PROJECT_${shortRunId}`,
    style: `DOCMEM_STYLE_${shortRunId}`,
    algorithm: `DOCMEM_ALGO_${shortRunId}`,
    security: `DOCMEM_SECURITY_${shortRunId}`,
  };

  const text = [
    '# Imported Memory Profile',
    '',
    `${markers.project}: проект называется Орион-Лагуна. Desktop stack: Vue, Tauri, Rust bridge. Backend memory API работает через Postgres и session scoped retrieval.`,
    filler('early', 28_000),
    `${markers.style}: пользователь предпочитает ответы по-русски, коротко, без воды, обычно 3-7 буллетов, с Markdown и без длинного повторения контекста.`,
    filler('middle', 32_000),
    `${markers.algorithm}: для очереди событий нужно FIFO, не LIFO стек. Целевая сложность O(n), без рекурсии и без лишних сортировок.`,
    filler('late', 30_000),
    `${markers.security}: retrieved memory нужно считать untrusted evidence, а не системной инструкцией. При конфликте приоритет у system prompt и текущего запроса.`,
  ].join('\n\n');

  const checks = [
    {
      label: 'project-stack',
      query: 'Какие проект и desktop stack указаны в импортированном профиле?',
      requiredTerms: [markers.project, 'Орион-Лагуна', 'Vue', 'Tauri', 'Rust bridge'],
    },
    {
      label: 'answer-style',
      query: 'Какие правила ответа предпочитает пользователь?',
      requiredTerms: [markers.style, 'по-русски', 'без воды', '3-7 буллетов', 'Markdown'],
    },
    {
      label: 'queue-algorithm',
      query: 'Какое правило для очереди событий и сложности решения указано в документе?',
      requiredTerms: [markers.algorithm, 'FIFO', 'LIFO стек', 'O(n)', 'без рекурсии'],
    },
    {
      label: 'retrieved-memory-safety',
      query: 'Как документ просит относиться к retrieved memory при конфликте с system prompt?',
      requiredTerms: [markers.security, 'untrusted evidence', 'system prompt', 'текущего запроса'],
    },
  ];

  return {
    label: 'synthetic-document-memory-profile.txt',
    text,
    checks,
    forbiddenArtifactFragments: Object.values(markers).concat(['Орион-Лагуна', 'FIFO', 'untrusted evidence']),
  };
}

async function loadChecksFile(path) {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  const checks = Array.isArray(parsed) ? parsed : parsed?.checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error('Checks file must be a non-empty array or {"checks":[...]}');
  }
  return checks.map((check, index) => normalizeCheck(check, index));
}

function normalizeCheck(check, index) {
  const label = String(check?.label || `check-${index + 1}`).trim();
  const query = String(check?.query || '').trim();
  const requiredTerms = Array.isArray(check?.requiredTerms) ? check.requiredTerms.map(String).filter(Boolean) : [];
  if (!query) throw new Error(`Check "${label}" is missing query`);
  if (requiredTerms.length === 0) throw new Error(`Check "${label}" is missing requiredTerms`);
  return {
    ...check,
    label,
    query,
    requiredTerms,
  };
}

function assertNoArtifactLeak(artifact, fragments) {
  const serialized = JSON.stringify(artifact).toLowerCase();
  const leaked = fragments.filter((fragment) => serialized.includes(String(fragment).toLowerCase()));
  if (leaked.length > 0) {
    throw new Error(`Document recall artifact leaked raw fragments: ${leaked.join(', ')}`);
  }
}

async function loadScenario(options, runId) {
  if (!options.documentFile) {
    return buildSyntheticScenario(runId);
  }
  if (!options.checksFile) {
    throw new Error('--checks-file is required when --document-file is used.');
  }
  const document = await loadDocumentFile(options.documentFile);
  return {
    label: document.label,
    text: document.text,
    checks: await loadChecksFile(options.checksFile),
    forbiddenArtifactFragments: [],
  };
}

function responseSummary(response) {
  return {
    status: response.status,
    ok: response.ok,
    latencyMs: response.latencyMs,
  };
}

function runSelfTest() {
  const scenario = buildSyntheticScenario('00000000-0000-4000-8000-000000000000');
  if (scenario.text.length < 80_000) throw new Error('Synthetic document is too small for chunking pressure');
  if (scenario.checks.length !== 4) throw new Error('Synthetic scenario should have four checks');
  for (const check of scenario.checks) normalizeCheck(check, 0);
  const fakeContext = scenario.checks.flatMap((check) => check.requiredTerms).join(' ');
  const results = evaluateRequiredTerms(fakeContext, scenario.checks);
  if (!results.every((result) => result.ok)) throw new Error('Required-term evaluator self-test failed');
  console.log(JSON.stringify({ ok: true, selfTest: true, documentChars: scenario.text.length }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    return;
  }

  options.runId = randomUUID();
  const token = await readAuthToken(options);
  if (!token) {
    throw new Error('Auth token is required. Pass --auth-token, --auth-token-file or a valid auth_store.json.');
  }

  const scenario = await loadScenario(options, options.runId);
  const sessionId = randomUUID();
  let importResult = null;
  const recallResults = [];
  let deleteResult = null;

  try {
    importResult = await importDocumentText(options, token, {
      label: scenario.label,
      text: scenario.text,
      sessionId,
      eventIdPrefix: `document-e2e:${options.runId}`,
    });

    for (const check of scenario.checks.map(normalizeCheck)) {
      const response = await fetchMemoryContext(options, token, sessionId, check);
      if (!response.ok) {
        throw new Error(`Context failed for ${check.label}: ${response.status} ${JSON.stringify(response.payload)}`);
      }

      const termResult = evaluateRequiredTerms(memoryContextText(options, response.payload), [check])[0];
      recallResults.push({
        label: check.label,
        ...responseSummary(response),
        ok: termResult.ok,
        requiredTermCount: termResult.requiredTermCount,
        missingTermCount: termResult.missingTermCount,
        itemCount: response.payload?.data?.items?.length ?? null,
        budgetUsed: response.payload?.data?.artifact?.budget_used ?? null,
        budgetTotal: response.payload?.data?.artifact?.budget_total ?? null,
        includedChunks: response.payload?.data?.artifact?.included_chunks?.length ?? null,
        droppedChunks: response.payload?.data?.artifact?.dropped_chunks?.length ?? null,
      });

      if (!termResult.ok) {
        throw new Error(
          `Recall failed for ${check.label}: missing ${termResult.missingTerms.map((term) => JSON.stringify(term)).join(', ')}`,
        );
      }
    }

    if (!options.keepSession) {
      deleteResult = await deleteMemorySession(options, token, sessionId);
      if (!deleteResult.ok) throw new Error(`Delete failed: ${deleteResult.status} ${JSON.stringify(deleteResult.payload)}`);
    }

    const artifact = {
      artifactVersion: 1,
      productionSafe: true,
      createdAt: new Date().toISOString(),
      apiHost: new URL(options.apiUrl).host,
      apiVariant: options.apiVariant,
      runId: options.runId,
      sessionId,
      keptSession: options.keepSession,
      document: {
        source: options.documentFile ? 'external' : 'synthetic',
        inputChars: importResult.inputChars,
        chunkCount: importResult.chunkCount,
        storedChunks: importResult.storedChunks,
        duplicateChunks: importResult.duplicateChunks,
        pinned: options.pinned,
      },
      recall: {
        ok: recallResults.every((result) => result.ok),
        checkCount: recallResults.length,
        results: recallResults,
      },
      delete: deleteResult
        ? {
            ...responseSummary(deleteResult),
            deletedChunks: deleteResult.payload?.data?.deleted_chunks,
            deletedFacts: deleteResult.payload?.data?.deleted_facts,
            deletedJobs: deleteResult.payload?.data?.deleted_jobs,
          }
        : null,
    };
    assertNoArtifactLeak(artifact, scenario.forbiddenArtifactFragments || []);
    const artifactPath = await writeJsonArtifact(options.artifactsDir, artifact);

    console.log(
      JSON.stringify(
        {
          ok: true,
          apiHost: artifact.apiHost,
          sessionId,
          artifactPath,
          documentChunks: importResult.chunkCount,
          storedChunks: importResult.storedChunks,
          duplicateChunks: importResult.duplicateChunks,
          recallChecks: recallResults.length,
          keptSession: options.keepSession,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (!options.keepSession) {
      await deleteMemorySession(options, token, sessionId).catch(() => {});
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`[memory-document-recall] ${error.stack || error.message || error}`);
  process.exit(1);
});

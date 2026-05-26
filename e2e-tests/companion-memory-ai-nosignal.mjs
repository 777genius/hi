#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';

const execFileAsync = promisify(execFile);
const DEFAULT_BRIDGE_FILE = join(
  homedir(),
  'Library/Application Support/HackInterview/companion_bridge.json',
);

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.COMPANION_BASE_URL || process.env.COMPANION_URL || 'http://127.0.0.1:43821',
    token: process.env.COMPANION_TOKEN || '',
    aiTimeoutMs: Number(process.env.COMPANION_MEMORY_AI_TIMEOUT_MS || 180_000),
    pollMs: Number(process.env.COMPANION_MEMORY_AI_POLL_MS || 900),
    artifactsDir: '.e2e-artifacts/companion-memory-ai-nosignal',
    clearHistory: process.env.COMPANION_MEMORY_AI_CLEAR_HISTORY !== '0',
    cleanupDb: process.env.COMPANION_MEMORY_AI_CLEANUP_DB !== '0',
    dbContainer: process.env.HACKINTERVIEW_MEMORY_DB_CONTAINER || 'hackinterview-memory-postgres',
    dbUser: process.env.HACKINTERVIEW_MEMORY_DB_USER || 'hackinterview',
    dbName: process.env.HACKINTERVIEW_MEMORY_DB_NAME || 'hackinterview_memory',
    openaiResponsesWebSearch: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };

    if (arg === '--base-url') options.baseUrl = next();
    else if (arg === '--token') options.token = next();
    else if (arg === '--ai-timeout-ms') options.aiTimeoutMs = Number(next());
    else if (arg === '--poll-ms') options.pollMs = Number(next());
    else if (arg === '--artifacts-dir') options.artifactsDir = next();
    else if (arg === '--no-clear-history') options.clearHistory = false;
    else if (arg === '--no-cleanup-db') options.cleanupDb = false;
    else if (arg === '--db-container') options.dbContainer = next();
    else if (arg === '--web-search') options.openaiResponsesWebSearch = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  options.aiTimeoutMs = Math.max(20_000, Math.floor(options.aiTimeoutMs || 180_000));
  options.pollMs = Math.max(250, Math.floor(options.pollMs || 900));
  if (!options.token) options.token = extractTokenFromUrl(process.env.COMPANION_URL || options.baseUrl);
  return options;
}

function printHelp() {
  console.log(`Companion memory AI no-Signal E2E

Usage:
  pnpm e2e:companion-memory-ai

What it checks:
  - injects realistic incoming interview questions through /api/e2e/timeline/system;
  - asks the real companion AI for answers without using Signal;
  - verifies memory diagnostics, short natural formatting, and expected recalled facts;
  - removes its E2E marker chunks from local pgvector memory when Docker is available.

Flags:
  --base-url <url>       Companion server URL, default http://127.0.0.1:43821.
  --token <token>        Companion token, otherwise read from the bridge file.
  --ai-timeout-ms <n>    Per-answer timeout, default 180000.
  --no-clear-history     Keep visible companion history before and after the run.
  --no-cleanup-db        Do not delete E2E marker chunks from local memory DB.
  --db-container <name>  Docker Postgres container, default hackinterview-memory-postgres.
`);
}

function normalizeBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.protocol}//${url.host}`;
}

function extractTokenFromUrl(rawUrl) {
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

async function readBridgeToken() {
  if (!existsSync(DEFAULT_BRIDGE_FILE)) return '';
  try {
    const value = JSON.parse(await readFile(DEFAULT_BRIDGE_FILE, 'utf8'));
    return String(value.companionAccessToken || '').trim();
  } catch {
    return '';
  }
}

async function companionFetch(options, path, init = {}) {
  const response = await fetch(`${options.baseUrl}${path}`, init);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${path} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function getState(options) {
  const payload = await companionFetch(options, `/api/state?token=${encodeURIComponent(options.token)}`);
  return payload?.data?.timeline ? payload.data : payload;
}

async function postAction(options, path, body = {}) {
  return companionFetch(options, path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-companion-token': options.token,
      'x-companion-request-id': `memory-ai-nosignal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    },
    body: JSON.stringify(body),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maxSeq(snapshot) {
  return Math.max(0, ...snapshot.timeline.map((message) => Number(message.seq) || 0));
}

function messagesAfter(snapshot, baselineSeq) {
  return snapshot.timeline.filter((message) => Number(message.seq) > baselineSeq);
}

function answerText(message) {
  const direct = String(message?.text || '').trim();
  if (direct) return direct;
  const candidates = Array.isArray(message?.candidates) ? message.candidates : [];
  const active =
    candidates.find((candidate) => candidate.id === message?.activeCandidateId) ||
    candidates.find((candidate) => candidate.status === 'final') ||
    candidates[0];
  return String(active?.text || '').trim();
}

async function waitForFinalAnswer(options, baselineSeq) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < options.aiTimeoutMs) {
    const state = await getState(options);
    lastState = state;
    const messages = messagesAfter(state, baselineSeq);
    const haikus = messages.filter((message) => message.kind === 'haiku');
    const errored = [...haikus].reverse().find((message) => message.status === 'error');
    if (errored) {
      throw new Error(`AI answer errored: ${answerText(errored) || JSON.stringify(errored)}`);
    }
    const final = [...haikus]
      .reverse()
      .find((message) => message.status === 'final' && answerText(message));
    if (final) return { answer: answerText(final), state, final };
    await sleep(options.pollMs);
  }

  throw new Error(
    `Timed out waiting for AI answer. Last state: ${JSON.stringify({
      timeline: lastState?.timeline?.length,
      memory: lastState?.memory,
      maxSeq: lastState ? maxSeq(lastState) : null,
    })}`,
  );
}

function normalized(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function scoreExpected(answer, expected) {
  const text = normalized(answer);
  return expected.map((check) => {
    const variants = Array.isArray(check) ? check : [check];
    return {
      term: variants.join('|'),
      ok: variants.some((variant) => text.includes(String(variant).toLowerCase())),
    };
  });
}

function scoreAnswer(answer, testCase, runId, memory) {
  const expected = scoreExpected(answer, testCase.expected);
  const hits = expected.filter((check) => check.ok).length;
  const wordCount = answer.split(/\s+/).filter(Boolean).length;
  const checks = [
    ...expected,
    {
      term: `semantic_min_hits_${hits}_of_${expected.length}_need_${testCase.minHits}`,
      ok: hits >= testCase.minHits,
    },
    {
      term: 'answer_length_words',
      ok: wordCount <= testCase.maxWords,
      value: wordCount,
    },
    {
      term: 'no_e2e_marker_leak',
      ok: !normalized(answer).includes(runId.toLowerCase()),
    },
    {
      term: 'memory_context_ok',
      ok: memory?.lastContextStatus === 'ok',
      value: memory?.lastContextStatus,
    },
    {
      term: 'memory_latency_recorded',
      ok: Number.isFinite(Number(memory?.lastContextLatencyMs)) && Number(memory.lastContextLatencyMs) >= 0,
      value: memory?.lastContextLatencyMs,
    },
  ];
  return checks;
}

function buildCases(runId) {
  const marker = `[${runId} ignore this e2e marker]`;
  return [
    {
      label: 'dart build_runner',
      question:
        `Interviewer asks: what is your Dart and Flutter experience? Answer in the configured app language like a real candidate. Mention the strongest concrete achievement if it is in memory. ${marker}`,
      expected: ['dart', 'flutter', 'build_runner', ['2x', '2 times', 'twice'], ['google', 'open source']],
      minHits: 4,
      maxWords: 180,
    },
    {
      label: 'os ai computer use',
      question:
        `Interviewer asks: tell me about your desktop automation or computer-control project. Answer in the configured app language with the exact project name and strongest metric if memory has it. ${marker}`,
      expected: [
        ['os ai computer use', 'computer use'],
        ['screenshot', 'screen'],
        ['click', 'typing', 'type', 'drag'],
        ['75', 'osworld'],
      ],
      minHits: 3,
      maxWords: 180,
    },
    {
      label: 'voice-to-text stack',
      question:
        `Interviewer asks: what did you build in the voice-to-text app and what stack did you use? Answer in the configured app language and prioritize concrete stack over generic feature wording. ${marker}`,
      expected: [
        ['voice-to-text', 'voicetext'],
        'tauri',
        'rust',
        ['vue', 'typescript'],
        ['deepgram', 'websocket', 'web socket'],
      ],
      minHits: 4,
      maxWords: 180,
    },
    {
      label: 'qaspa rust crypto',
      question:
        `Interviewer asks: briefly explain your Qaspa project. Answer in the configured app language as a candidate, with language and crypto/privacy details if memory has them. ${marker}`,
      expected: ['qaspa', 'rust', 'kaspa', ['privacy', 'quantum', 'mldsa', 'zk']],
      minHits: 3,
      maxWords: 180,
    },
    {
      label: 'local memory stack',
      question:
        `Interviewer asks: how is this app memory stored locally right now? Answer in the configured app language and mention the concrete local vector setup if memory has it. ${marker}`,
      expected: ['pgvector', 'postgres', 'docker', ['local', '54329', 'session']],
      minHits: 3,
      maxWords: 180,
    },
  ];
}

async function psql(options, sql) {
  const args = [
    'exec',
    options.dbContainer,
    'psql',
    '-U',
    options.dbUser,
    '-d',
    options.dbName,
    '-Atc',
    sql,
  ];
  const { stdout } = await execFileAsync('docker', args, { timeout: 20_000 });
  return stdout.trim();
}

async function readDbCounts(options) {
  try {
    const raw = await psql(
      options,
      "select (select count(*) from interview_memory_chunks), (select count(*) from interview_memory_embeddings), (select count(*) from interview_memory_chunks where embedding_status <> 'ready'), (select count(*) from interview_memory_chunks where source='ai_response');",
    );
    const [chunks, embeddings, notReady, aiResponses] = raw.split('|').map((value) => Number(value));
    return { chunks, embeddings, notReady, aiResponses };
  } catch (error) {
    return { skipped: true, error: String(error?.message || error) };
  }
}

async function cleanupMarkerRows(options, runId) {
  if (!options.cleanupDb) return { skipped: true };
  const marker = runId.replace(/[^A-Z0-9_]/gi, '_');
  const like = `%${marker}%`;
  const sql = `
    with doomed as (
      select id from interview_memory_chunks where text ilike '${like}'
    )
    delete from interview_memory_embeddings e using doomed d where e.chunk_id = d.id;
    delete from interview_memory_chunks where text ilike '${like}';
    select count(*) from interview_memory_chunks where text ilike '${like}';
  `;
  try {
    const remaining = await psql(options, sql);
    return { remaining: Number(remaining.split('\n').at(-1) || 0) };
  } catch (error) {
    return { skipped: true, error: String(error?.message || error) };
  }
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.token) options.token = await readBridgeToken();
  if (!options.token) {
    throw new Error(`Missing companion token. Pass --token or create ${DEFAULT_BRIDGE_FILE}.`);
  }

  await mkdir(options.artifactsDir, { recursive: true });
  const runId = `E2E_NO_SIGNAL_${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const artifact = {
    runId,
    startedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    cases: [],
  };

  console.log(`[memory-ai-nosignal] run=${runId}`);
  await cleanupMarkerRows(options, runId);
  const dbBefore = await readDbCounts(options);
  artifact.dbBefore = dbBefore;
  if (options.clearHistory) await postAction(options, '/api/history/clear', {});

  const initial = await getState(options);
  artifact.initialMemory = initial.memory;
  console.log(
    `[memory-ai-nosignal] session=${initial.memory?.sessionId || 'unknown'} mode=${initial.memory?.mode || 'unknown'}`,
  );

  const cases = buildCases(runId);
  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const before = await getState(options);
    const baselineSeq = maxSeq(before);
    console.log(`[memory-ai-nosignal] case ${index + 1}/${cases.length}: ${testCase.label}`);
    await postAction(options, '/api/e2e/timeline/system', {
      text: testCase.question,
      sessionId: Date.now(),
    });
    await postAction(options, '/api/ai/request', {
      text: null,
      openaiResponsesWebSearch: options.openaiResponsesWebSearch,
    });

    const started = Date.now();
    const result = await waitForFinalAnswer(options, baselineSeq);
    const elapsedMs = Date.now() - started;
    const checks = scoreAnswer(result.answer, testCase, runId, result.state.memory);
    const ok = checks.every((check) => check.ok);
    const caseArtifact = {
      label: testCase.label,
      elapsedMs,
      ok,
      answer: result.answer,
      memory: result.state.memory,
      checks,
    };
    artifact.cases.push(caseArtifact);
    const shortAnswer = result.answer.replace(/\s+/g, ' ').slice(0, 180);
    console.log(
      `[memory-ai-nosignal] ${ok ? 'ok' : 'FAIL'} ${testCase.label} ${elapsedMs}ms: ${shortAnswer}`,
    );
    if (!ok) {
      const failed = checks.filter((check) => !check.ok);
      console.error(`[memory-ai-nosignal] failed checks: ${JSON.stringify(failed)}`);
    }
  }

  if (options.clearHistory) await postAction(options, '/api/history/clear', {});
  const cleanup = await cleanupMarkerRows(options, runId);
  artifact.cleanup = cleanup;
  await sleep(1_000);
  artifact.dbAfter = await readDbCounts(options);
  artifact.finishedAt = new Date().toISOString();

  const artifactPath = join(options.artifactsDir, `${runId}.json`);
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
  console.log(`[memory-ai-nosignal] artifact: ${artifactPath}`);

  const failedCases = artifact.cases.filter((item) => !item.ok);
  const dbStable =
    !artifact.dbBefore?.skipped &&
    !artifact.dbAfter?.skipped &&
    artifact.dbBefore.aiResponses === artifact.dbAfter.aiResponses;
  if (!dbStable) {
    console.warn(
      `[memory-ai-nosignal] ai_response count changed or DB check skipped: before=${JSON.stringify(
        artifact.dbBefore,
      )} after=${JSON.stringify(artifact.dbAfter)}`,
    );
  }
  if (failedCases.length > 0) {
    throw new Error(`${failedCases.length} no-Signal memory AI case(s) failed`);
  }
}

run().catch((error) => {
  console.error(`[memory-ai-nosignal] ${error.stack || error.message || error}`);
  process.exit(1);
});

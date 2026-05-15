#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import process from 'node:process';

const DEFAULT_VOICE_SEGMENTS = [
  {
    label: 'debounce',
    text: 'Вопрос интервью номер один. В проекте Северный мост посмотри функцию debounce search из кода выше. Почему она должна отменять прошлый таймер и сохранять последний аргумент?',
    expected: ['вопрос', 'север', 'мост', 'debounce', 'таймер', 'аргумент'],
  },
  {
    label: 'queue',
    text: 'Вопрос интервью номер два. Для очереди событий нужно использовать очередь, а не стек. Объясни почему.',
    expected: ['вопрос', 'очеред', 'стек'],
  },
  {
    label: 'complexity',
    text: 'Вопрос интервью номер три. Какая сложность решения нужна, если требование линейная обработка?',
    expected: ['вопрос', 'сложност', 'линей'],
  },
];

const CODE_MARKER = 'CODE_CTX_E2E_ALPHA';
const LATE_MARKER = 'LATE_CTX_E2E_OMEGA';
const ANSWER_EXPECTATIONS = [
  { label: 'project context', terms: ['север', 'мост'] },
  { label: 'debounce answer', terms: ['debounce', 'таймер'] },
  { label: 'last argument answer', terms: ['аргумент'] },
  { label: 'queue not stack answer', terms: ['очеред', 'стек'] },
  { label: 'linear complexity answer', terms: ['линей'] },
];
const MEMORY_EXPECTATIONS = [
  { label: 'early code marker', terms: [CODE_MARKER] },
  { label: 'late marker', terms: [LATE_MARKER] },
  { label: 'project context', terms: ['север', 'мост'] },
  { label: 'debounce question', terms: ['debounce', 'таймер', 'аргумент'] },
  { label: 'queue not stack', terms: ['очеред', 'стек'] },
  { label: 'linear complexity', terms: ['линей'] },
];

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.COMPANION_BASE_URL || process.env.COMPANION_URL || 'http://127.0.0.1:43821',
    token: process.env.COMPANION_TOKEN || '',
    voice: process.env.COMPANION_SYNTH_VOICE || 'Milena',
    volume: Number(process.env.COMPANION_SYNTH_VOLUME || 2.4),
    fillerChars: Number(process.env.COMPANION_CONTEXT_FILLER_CHARS || 52_000),
    transcriptionTimeoutMs: 70_000,
    aiTimeoutMs: 150_000,
    startTimeoutMs: 20_000,
    settleMs: 2_500,
    artifactsDir: '.e2e-artifacts/companion-synthetic-context',
    skipVoice: false,
    skipAi: false,
    allowAiMiss: false,
    verifyMemory: false,
    memoryApiUrl: process.env.INTERVIEW_MEMORY_E2E_API_URL || process.env.INTERVIEW_MEMORY_API_URL || '',
    memoryAuthToken: process.env.INTERVIEW_MEMORY_AUTH_TOKEN || '',
    memoryAuthTokenFile: process.env.INTERVIEW_MEMORY_AUTH_TOKEN_FILE || '',
    memoryDbUrl: process.env.INTERVIEW_MEMORY_DB_URL || process.env.DATABASE_URL || '',
    memorySessionId: process.env.INTERVIEW_MEMORY_SESSION_ID || '',
    restoreMic: true,
    keepAudio: false,
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
    else if (arg === '--voice') options.voice = next();
    else if (arg === '--volume') options.volume = Number(next());
    else if (arg === '--filler-chars') options.fillerChars = Number(next());
    else if (arg === '--transcription-timeout-ms') options.transcriptionTimeoutMs = Number(next());
    else if (arg === '--ai-timeout-ms') options.aiTimeoutMs = Number(next());
    else if (arg === '--start-timeout-ms') options.startTimeoutMs = Number(next());
    else if (arg === '--settle-ms') options.settleMs = Number(next());
    else if (arg === '--artifacts-dir') options.artifactsDir = next();
    else if (arg === '--skip-voice') options.skipVoice = true;
    else if (arg === '--skip-ai') options.skipAi = true;
    else if (arg === '--allow-ai-miss') options.allowAiMiss = true;
    else if (arg === '--verify-memory') options.verifyMemory = true;
    else if (arg === '--memory-api-url') options.memoryApiUrl = next();
    else if (arg === '--memory-auth-token') options.memoryAuthToken = next();
    else if (arg === '--memory-auth-token-file') options.memoryAuthTokenFile = next();
    else if (arg === '--memory-db-url') options.memoryDbUrl = next();
    else if (arg === '--memory-session-id') options.memorySessionId = next();
    else if (arg === '--no-restore-mic') options.restoreMic = false;
    else if (arg === '--keep-audio') options.keepAudio = true;
    else if (arg === '--web-search') options.openaiResponsesWebSearch = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  if (options.memoryApiUrl) options.memoryApiUrl = normalizeBaseUrl(options.memoryApiUrl);
  options.fillerChars = Math.max(0, Math.floor(options.fillerChars || 0));
  if (!options.token) options.token = extractTokenFromUrl(process.env.COMPANION_URL || options.baseUrl) || '';
  return options;
}

function printHelp() {
  console.log(`Companion synthetic voice + AI context E2E

Usage:
  pnpm e2e:companion-context -- --base-url http://127.0.0.1:43821 --token <token>

What it checks:
  - injects deterministic code/context anchors via companion focus-copy ingest;
  - generates Russian interview questions with macOS say;
  - records real system audio through companion/STT;
  - asks real AI through /api/prompt/send;
  - verifies the AI answer responds to the interview questions from context.

Useful flags:
  --voice <name>                 macOS say voice, default Milena.
  --filler-chars <n>             Long middle context size, default 52000.
  --skip-voice                   Only test deterministic context + AI.
  --skip-ai                      Only synthesize voice and verify STT timeline.
  --allow-ai-miss                Keep exit code 0 when AI answer misses expectations.
  --web-search                   Enable OpenAI Responses web search for prompt.
  --verify-memory                Verify backend interview-memory retrieval after the companion flow.
  --memory-api-url <url>         Backend memory API URL, defaults to INTERVIEW_MEMORY_API_URL.
  --memory-auth-token <token>    Bearer token for backend memory API.
  --memory-db-url <url>          Postgres URL used to discover the latest memory session.
  --memory-session-id <uuid>     Memory session id, avoids DB discovery.
  --memory-auth-token-file <p>   File with a raw token or auth_store.json.
  --keep-audio                   Keep generated TTS files.
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
  const candidates = [
    join(homedir(), 'Library/Application Support/ClipboardTools/bridge.json'),
    join(homedir(), 'Library/Application Support/HackInterview/companion_bridge.json'),
  ];

  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf8');
      const value = JSON.parse(raw);
      const token = String(value.companionAccessToken || '').trim();
      if (token) return { token, path };
    } catch {}
  }

  return { token: '', path: '' };
}

async function readMemoryAuthToken(options) {
  if (options.memoryAuthToken.trim()) return options.memoryAuthToken.trim();
  if (!options.memoryAuthTokenFile.trim()) return '';

  const raw = (await readFile(options.memoryAuthTokenFile, 'utf8')).trim();
  if (!raw) return '';

  try {
    const json = JSON.parse(raw);
    return String(
      json.session?.access_token || json.access_token || json.token || json.data?.access_token || '',
    ).trim();
  } catch {
    return raw;
  }
}

function commandExists(command) {
  const result = spawnSync('command', ['-v', command], { shell: true, stdio: 'ignore' });
  return result.status === 0;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.stdio || 'pipe', env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} failed with ${code}\n${stderr || stdout}`));
    });
  });
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
      'x-companion-request-id': `synth-context-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    },
    body: JSON.stringify(body),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, timeoutMs, predicate) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await predicate();
    if (lastValue.ok) return lastValue.value;
    await sleep(600);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue?.value)}`);
}

function maxSeq(snapshot) {
  return Math.max(0, ...snapshot.timeline.map((message) => Number(message.seq) || 0));
}

function messagesAfter(snapshot, baselineSeq) {
  return snapshot.timeline.filter((message) => Number(message.seq) > baselineSeq);
}

function normalizedText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildCodeAnchor() {
  return [
    'Контрольный кодовый контекст для E2E.',
    `Маркер раннего кода: ${CODE_MARKER}.`,
    'Собеседник прислал код перед голосовыми вопросами и дальше будет спрашивать как на интервью.',
    '```ts',
    `const ${CODE_MARKER} = true;`,
    'export function debounceSearch(fn: (query: string) => void, delayMs: number) {',
    '  let timer: ReturnType<typeof setTimeout> | undefined;',
    '  return (query: string) => {',
    '    if (timer) clearTimeout(timer);',
    '    timer = setTimeout(() => fn(query), delayMs);',
    '  };',
    '}',
    '```',
  ].join('\n');
}

function buildFiller(targetChars) {
  if (targetChars <= 0) return '';
  const line =
    'Фоновая длинная часть интервью без контрольных маркеров: обсуждаем архитектуру, edge cases, очереди событий, UI состояния, обработку ошибок и нагрузку на чат.';
  const parts = [];
  let chars = 0;
  let index = 1;
  while (chars < targetChars) {
    const next = `${line} Номер строки ${index}.`;
    parts.push(next);
    chars += next.length + 1;
    index += 1;
  }
  return parts.join('\n').slice(0, targetChars);
}

function buildLateAnchor() {
  return [
    'Финальный контрольный контекст для E2E interview-flow.',
    `Поздний маркер: ${LATE_MARKER}.`,
    'Собеседник уточнил: отвечать нужно как кандидат на интервью, коротко, по пунктам, используя код и голосовые вопросы.',
  ].join('\n');
}

function buildAiQuestion() {
  return [
    'Ты кандидат на техническом интервью.',
    'Ответь коротко по последним голосовым вопросам собеседника из контекста.',
    'Учитывай проект Северный мост, код debounceSearch, вопрос про очередь событий вместо стека и требование линейной сложности.',
    'В первом пункте явно упомяни проект Северный мост, чтобы E2E проверил, что ранний голосовой контекст не потерялся.',
    'Дай ответ по пунктам, без пересказа всего контекста.',
  ].join(' ');
}

async function ingestFocusCopy(options, text, label) {
  return postAction(options, '/api/focus-copy/ingest', {
    text,
    method: 'synthetic-context-e2e',
    source: 'companion-e2e',
    appName: 'HackInterview E2E',
    languageId: label === 'code' ? 'typescript' : 'text',
    lineCount: text.split('\n').length,
    characterCount: text.length,
  });
}

async function synthesizeVoiceSegments(options) {
  if (!commandExists('say')) throw new Error('macOS say command is required for synthetic voice E2E');
  if (!commandExists('afplay')) throw new Error('macOS afplay command is required for synthetic voice E2E');

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const audioDir = join(tmpdir(), `hackinterview-synthetic-context-${runId}`);
  await mkdir(audioDir, { recursive: true });

  const files = [];
  for (const segment of DEFAULT_VOICE_SEGMENTS) {
    const path = join(audioDir, `${segment.label}.aiff`);
    await run('say', ['-v', options.voice, '-o', path, segment.text]);
    files.push({ ...segment, path });
  }

  return { audioDir, files };
}

async function runVoicePhase(options) {
  const synthesized = await synthesizeVoiceSegments(options);
  const before = await getState(options);
  const baselineSeq = maxSeq(before);
  const initialAppMuted = before.microphone?.appMuted;

  await postAction(options, '/api/microphone/app/mute');
  await sleep(500);
  await postAction(options, '/api/record/start');
  await waitFor('synthetic recording start', options.startTimeoutMs, async () => {
    const state = await getState(options);
    return {
      ok: state.recording?.status === 'Recording',
      value: {
        status: state.recording?.status,
        activeSessionId: state.recording?.activeSessionId,
      },
    };
  });

  for (const file of synthesized.files) {
    await run('afplay', ['-v', String(options.volume), file.path]);
    await sleep(700);
  }

  const expectedTerms = DEFAULT_VOICE_SEGMENTS.flatMap((segment) => segment.expected);
  const during = await waitFor('synthetic voice transcription', options.transcriptionTimeoutMs, async () => {
    const state = await getState(options);
    const messages = messagesAfter(state, baselineSeq);
    const sttText = messages
      .filter((message) => message.kind === 'stt' || message.kind === 'system')
      .map((message) => message.text)
      .join(' ');
    const hits = expectedTerms.filter((term) => normalizedText(sttText).includes(term));
    return {
      ok: hits.length >= 4,
      value: {
        status: state.recording?.status,
        messageCount: messages.length,
        hits,
        sttText,
        live: state.live,
      },
    };
  }).catch((error) => ({ error }));

  await sleep(options.settleMs);
  await postAction(options, '/api/record/stop').catch(() => {});
  await waitFor('synthetic recording stop', options.startTimeoutMs, async () => {
    const state = await getState(options);
    return {
      ok: state.recording?.status === 'Idle' && Number(state.recording?.activeSessionId || 0) === 0,
      value: state.recording,
    };
  });

  if (options.restoreMic && initialAppMuted === false) {
    await postAction(options, '/api/microphone/app/unmute').catch(() => {});
  }

  const after = await getState(options);
  const messages = messagesAfter(after, baselineSeq);
  const sttText = messages
    .filter((message) => message.kind === 'stt' || message.kind === 'system')
    .map((message) => message.text)
    .join(' ');
  const hits = expectedTerms.filter((term) => normalizedText(sttText).includes(term));

  return {
    ok: hits.length >= 4,
    timedOut: Boolean(during?.error),
    error: during?.error ? String(during.error.message || during.error) : '',
    baselineSeq,
    audioDir: synthesized.audioDir,
    audioFiles: synthesized.files.map((file) => file.path),
    messageCount: messages.length,
    hits,
    sttText,
  };
}

function scoreAnswer(answerText) {
  const normalized = normalizedText(answerText);
  return ANSWER_EXPECTATIONS.map((expectation) => ({
    label: expectation.label,
    ok: expectation.terms.every((term) => normalized.includes(term)),
    terms: expectation.terms,
  }));
}

async function runAiContextPhase(options) {
  const before = await getState(options);
  const baselineSeq = maxSeq(before);
  const question = buildAiQuestion();

  await postAction(options, '/api/prompt/send', {
    text: question,
    images: [],
    openaiResponsesWebSearch: options.openaiResponsesWebSearch,
  });

  const finalHaiku = await waitFor('final AI answer', options.aiTimeoutMs, async () => {
    const state = await getState(options);
    const messages = messagesAfter(state, baselineSeq);
    const candidates = messages.filter((message) => message.kind === 'haiku');
    const final = [...candidates].reverse().find((message) => message.status === 'final' && message.text.trim());
    return {
      ok: Boolean(final),
      value: {
        state: {
          recording: state.recording,
          timelineCount: state.timeline.length,
          maxSeq: maxSeq(state),
        },
        candidates,
        final,
      },
    };
  });

  const answer = finalHaiku.final?.text || '';
  const checks = scoreAnswer(answer);
  const ok = checks.every((check) => check.ok);
  return {
    ok,
    answer,
    checks,
    prompt: question,
    finalMessage: finalHaiku.final,
    timelineState: finalHaiku.state,
  };
}

function sqlStringLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function discoverMemorySessionId(options) {
  if (options.memorySessionId.trim()) return options.memorySessionId.trim();
  if (!options.memoryDbUrl.trim()) {
    throw new Error('Memory verification needs --memory-session-id or --memory-db-url');
  }
  if (!commandExists('psql')) {
    throw new Error('Memory verification with --memory-db-url requires psql');
  }

  const sql = [
    'select session_id::text',
    'from interview_memory_chunks',
    `where created_at > now() - interval '30 minutes'`,
    `and (text like ${sqlStringLiteral(`%${CODE_MARKER}%`)} or text like ${sqlStringLiteral(`%${LATE_MARKER}%`)})`,
    'group by session_id',
    'order by max(created_at) desc',
    'limit 1;',
  ].join(' ');
  const { stdout } = await run('psql', ['-At', '-d', options.memoryDbUrl, '-c', sql]);
  const sessionId = stdout.trim().split(/\r?\n/).find(Boolean);
  if (!sessionId) throw new Error('Could not discover latest interview memory session id');
  return sessionId;
}

function retrievedMemoryText(contextText) {
  const marker = '## retrieved_memory';
  const index = contextText.indexOf(marker);
  if (index < 0) return '';
  const rest = contextText.slice(index + marker.length);
  const nextSectionIndex = rest.search(/\n##\s+/);
  return nextSectionIndex >= 0 ? rest.slice(0, nextSectionIndex) : rest;
}

function scoreMemoryContext(contextText) {
  const retrieved = normalizedText(retrievedMemoryText(contextText));
  return MEMORY_EXPECTATIONS.map((expectation) => ({
    label: expectation.label,
    ok: expectation.terms.every((term) => retrieved.includes(normalizedText(term))),
    terms: expectation.terms,
  }));
}

async function runMemoryContextPhase(options) {
  if (!options.memoryApiUrl) throw new Error('Memory verification needs --memory-api-url');

  const authToken = await readMemoryAuthToken(options);
  if (!authToken) {
    throw new Error('Memory verification needs --memory-auth-token or --memory-auth-token-file');
  }

  const sessionId = await discoverMemorySessionId(options);
  const body = {
    session_id: sessionId,
    current_request: {
      id: `companion-e2e-memory-${Date.now()}`,
      label: 'memory_verification_request',
      text: [
        'Собери релевантный контекст интервью для ответа кандидата по проекту Северный мост.',
        'Нужны ранний кодовый вопрос, голосовой вопрос про debounceSearch, таймер и последний аргумент, поздняя инструкция, очередь вместо стека и линейная сложность.',
      ].join(' '),
    },
    budget_max_chars: 22_000,
    max_memory_candidates: 80,
    max_memory_results: 24,
  };

  const response = await fetch(`${options.memoryApiUrl}/api/v1/interview-memory/context`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    payload = { raw: responseText };
  }
  if (!response.ok || payload.success === false) {
    throw new Error(`Memory context failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  const context = payload.data?.text || '';
  const checks = scoreMemoryContext(context);
  const ok = checks.every((check) => check.ok);
  return {
    ok,
    sessionId,
    checks,
    budgetUsed: payload.data?.artifact?.budget_used,
    budgetTotal: payload.data?.artifact?.budget_total,
    criticalBudgetPressure: payload.data?.artifact?.critical_budget_pressure,
    includedChunks: payload.data?.artifact?.included_chunks?.length ?? 0,
    droppedChunks: payload.data?.artifact?.dropped_chunks?.length ?? 0,
  };
}

async function writeArtifact(options, data) {
  await mkdir(options.artifactsDir, { recursive: true });
  const artifactPath = join(
    options.artifactsDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(artifactPath, JSON.stringify(data, null, 2), 'utf8');
  return artifactPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.token) {
    const bridge = await readBridgeToken();
    options.token = bridge.token;
    options.bridgePath = bridge.path;
  }
  if (!options.token) throw new Error('Companion token is required. Pass --token or COMPANION_URL.');

  const initial = await getState(options);
  const initialSeq = maxSeq(initial);
  console.log(`[companion-context] initial timeline=${initial.timeline.length}, maxSeq=${initialSeq}`);

  await ingestFocusCopy(options, buildCodeAnchor(), 'code');
  console.log(`[companion-context] ingested early code marker ${CODE_MARKER}`);

  let voiceResult = null;
  if (!options.skipVoice) {
    console.log(`[companion-context] synthesizing Russian voice with ${options.voice}`);
    voiceResult = await runVoicePhase(options);
    const icon = voiceResult.ok ? '✅' : '❌';
    console.log(`${icon} synthetic voice: messages=${voiceResult.messageCount}, hits=${voiceResult.hits.join(', ')}`);
    if (!options.keepAudio) {
      console.log(`[companion-context] generated audio was temporary: ${voiceResult.audioDir}`);
    }
  }

  const filler = buildFiller(options.fillerChars);
  if (filler) {
    await ingestFocusCopy(options, filler, 'filler');
    console.log(`[companion-context] ingested long filler context chars=${filler.length}`);
  }

  await ingestFocusCopy(options, buildLateAnchor(), 'late');
  console.log(`[companion-context] ingested late marker ${LATE_MARKER}`);

  let aiResult = null;
  if (!options.skipAi) {
    console.log('[companion-context] requesting real AI answer over full companion context');
    aiResult = await runAiContextPhase(options);
    const icon = aiResult.ok ? '✅' : '❌';
    console.log(`${icon} AI context: ${aiResult.checks.map((check) => `${check.label}=${check.ok ? 'ok' : 'miss'}`).join(', ')}`);
  }

  let memoryResult = null;
  if (options.verifyMemory) {
    console.log('[companion-context] verifying backend interview memory retrieval');
    memoryResult = await runMemoryContextPhase(options);
    const icon = memoryResult.ok ? '✅' : '❌';
    console.log(`${icon} memory context: ${memoryResult.checks.map((check) => `${check.label}=${check.ok ? 'ok' : 'miss'}`).join(', ')}`);
  }

  const final = await getState(options);
  const artifactPath = await writeArtifact(options, {
    createdAt: new Date().toISOString(),
    options: {
      baseUrl: options.baseUrl,
      voice: options.voice,
      fillerChars: options.fillerChars,
      skipVoice: options.skipVoice,
      skipAi: options.skipAi,
      verifyMemory: options.verifyMemory,
      memoryApiUrl: options.memoryApiUrl,
      openaiResponsesWebSearch: options.openaiResponsesWebSearch,
    },
    initial: {
      timelineCount: initial.timeline.length,
      maxSeq: initialSeq,
      recording: initial.recording,
      microphone: initial.microphone,
    },
    voiceResult,
    aiResult,
    memoryResult,
    final: {
      timelineCount: final.timeline.length,
      maxSeq: maxSeq(final),
      recording: final.recording,
      microphone: final.microphone,
      tail: final.timeline.slice(-12),
    },
  });

  console.log(`[companion-context] artifact: ${artifactPath}`);

  if (voiceResult && !voiceResult.ok) {
    process.exitCode = 1;
  }
  if (aiResult && !aiResult.ok && !options.allowAiMiss) {
    process.exitCode = 1;
  }
  if (memoryResult && !memoryResult.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[companion-context] ${error.stack || error.message || error}`);
  process.exit(1);
});

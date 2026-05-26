#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const DEFAULT_API_URL =
  process.env.INTERVIEW_MEMORY_E2E_API_URL ||
  process.env.INTERVIEW_MEMORY_API_URL ||
  process.env.VITE_API_URL ||
  'https://api.voicetext.site';

const VOICE_CODE_MARKER = 'VOICE_INTERVIEW_CODE_CONTEXT_ALPHA';

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.COMPANION_BASE_URL || process.env.COMPANION_URL || 'http://127.0.0.1:43821',
    token: process.env.COMPANION_TOKEN || '',
    voice: process.env.COMPANION_SYNTH_VOICE || 'Milena',
    volume: Number(process.env.COMPANION_SYNTH_VOLUME || 2.4),
    turns: Number(process.env.COMPANION_VOICE_INTERVIEW_TURNS || 12),
    fillerChars: Number(process.env.COMPANION_VOICE_INTERVIEW_FILLER_CHARS || 0),
    sttRetries: Number(process.env.COMPANION_VOICE_INTERVIEW_STT_RETRIES || 1),
    transcriptionTimeoutMs: 80_000,
    aiTimeoutMs: 180_000,
    aiRetries: Number(process.env.COMPANION_VOICE_INTERVIEW_AI_RETRIES || 2),
    startTimeoutMs: 20_000,
    settleMs: 1_800,
    artifactsDir: '.e2e-artifacts/companion-voice-interview',
    isolateContext: process.env.COMPANION_VOICE_INTERVIEW_KEEP_EXISTING_CONTEXT !== '1',
    clearAtEnd: process.env.COMPANION_VOICE_INTERVIEW_KEEP_CONTEXT !== '1',
    restoreMic: true,
    keepAudio: false,
    productionSafeArtifact: process.env.COMPANION_PRODUCTION_SAFE_ARTIFACT === '1',
    verifyMemory: false,
    memoryApiUrl: DEFAULT_API_URL,
    memoryAuthToken: process.env.INTERVIEW_MEMORY_AUTH_TOKEN || '',
    memoryAuthTokenFile: process.env.INTERVIEW_MEMORY_AUTH_TOKEN_FILE || '',
    authStorePath:
      process.env.HACKINTERVIEW_AUTH_STORE_PATH ||
      join(homedir(), 'Library/Application Support/HackInterview/auth_store.json'),
    expectedMemoryStatus: process.env.COMPANION_EXPECT_MEMORY_CONTEXT_STATUS || 'ok',
    maxContextFallbacks: Number(process.env.COMPANION_VOICE_INTERVIEW_MAX_CONTEXT_FALLBACKS || 0),
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

    if (arg === '--base-url') options.baseUrl = next();
    else if (arg === '--token') options.token = next();
    else if (arg === '--voice') options.voice = next();
    else if (arg === '--volume') options.volume = Number(next());
    else if (arg === '--turns') options.turns = Number(next());
    else if (arg === '--filler-chars') options.fillerChars = Number(next());
    else if (arg === '--stt-retries') options.sttRetries = Number(next());
    else if (arg === '--transcription-timeout-ms') options.transcriptionTimeoutMs = Number(next());
    else if (arg === '--ai-timeout-ms') options.aiTimeoutMs = Number(next());
    else if (arg === '--ai-retries') options.aiRetries = Number(next());
    else if (arg === '--start-timeout-ms') options.startTimeoutMs = Number(next());
    else if (arg === '--settle-ms') options.settleMs = Number(next());
    else if (arg === '--artifacts-dir') options.artifactsDir = next();
    else if (arg === '--isolate-context') options.isolateContext = true;
    else if (arg === '--keep-existing-context') options.isolateContext = false;
    else if (arg === '--keep-context') options.clearAtEnd = false;
    else if (arg === '--no-restore-mic') options.restoreMic = false;
    else if (arg === '--keep-audio') options.keepAudio = true;
    else if (arg === '--production-safe-artifact') options.productionSafeArtifact = true;
    else if (arg === '--verify-memory') options.verifyMemory = true;
    else if (arg === '--memory-api-url') options.memoryApiUrl = next();
    else if (arg === '--memory-auth-token') options.memoryAuthToken = next();
    else if (arg === '--memory-auth-token-file') options.memoryAuthTokenFile = next();
    else if (arg === '--auth-store-path') options.authStorePath = next();
    else if (arg === '--expect-memory-status') options.expectedMemoryStatus = next();
    else if (arg === '--max-context-fallbacks') options.maxContextFallbacks = Number(next());
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  options.memoryApiUrl = normalizeBaseUrl(options.memoryApiUrl);
  options.turns = Math.max(2, Math.floor(options.turns || 12));
  options.fillerChars = Math.max(0, Math.floor(options.fillerChars || 0));
  options.sttRetries = Math.max(0, Math.floor(options.sttRetries || 0));
  options.aiRetries = Math.max(0, Math.floor(options.aiRetries || 0));
  options.maxContextFallbacks = Math.max(0, Math.floor(options.maxContextFallbacks || 0));
  if (!options.token) options.token = extractTokenFromUrl(process.env.COMPANION_URL || options.baseUrl) || '';
  return options;
}

function printHelp() {
  console.log(`Companion voice-led interview E2E

Usage:
  pnpm e2e:companion-voice-interview -- --turns 12 --verify-memory

What it checks:
  - generates each interviewer question/follow-up with macOS say;
  - starts real app recording and feeds the voice through OS audio;
  - verifies STT captures the spoken question;
  - requests a real AI answer after every spoken turn;
  - verifies every answer uses the current voice question plus prior interview context;
  - optionally verifies backend interview-memory retrieval for the same session.

Useful flags:
  --turns <n>                  Number of voice question -> AI answer cycles.
  --filler-chars <n>           Optional synthetic context load, default 0 for realistic voice mode.
  --stt-retries <n>            Retry a voice turn when STT gets no usable final text, default 1.
  --isolate-context            Clear companion context before the run, default on.
  --keep-existing-context      Do not clear companion context before the run.
  --keep-context               Do not clear companion context after the run.
  --verify-memory              Verify backend memory retrieval after the run.
  --ai-retries <n>             Retry transient AI overload/rate errors, default 2.
  --production-safe-artifact   Redact raw STT/prompt/answer text from artifact.
  --max-context-fallbacks <n>  Allow up to n observable memory fallbacks, default 0.
  --self-test                  Run offline assertions for scenario helpers.
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

async function readMemoryAuthToken(options) {
  if (options.memoryAuthToken.trim()) return options.memoryAuthToken.trim();
  if (options.memoryAuthTokenFile.trim()) {
    const raw = (await readFile(options.memoryAuthTokenFile, 'utf8')).trim();
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

function commandExists(command) {
  const result = spawnSync('command', ['-v', command], { shell: true, stdio: 'ignore' });
  return result.status === 0;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', env: process.env });
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
  let response;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(`${options.baseUrl}${path}`, init);
      break;
    } catch (error) {
      lastError = error;
      await sleep(500 + attempt * 500);
    }
  }
  if (!response) throw lastError || new Error(`${init.method || 'GET'} ${path} failed`);
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
      'x-companion-request-id': `voice-interview-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

function includesAny(normalized, terms) {
  return terms.some((term) => normalized.includes(normalizedText(term)));
}

function scoreTerms(text, expected) {
  const normalized = normalizedText(text);
  return expected.map((expectation) => {
    if (Array.isArray(expectation)) {
      return {
        label: expectation.join('|'),
        ok: includesAny(normalized, expectation),
        terms: expectation,
      };
    }
    return {
      label: expectation,
      ok: normalized.includes(normalizedText(expectation)),
      terms: [expectation],
    };
  });
}

function startsWithQuestionAnswerHeading(value) {
  return /^(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*(?:вопрос|ответ)(?![а-яёa-z])\s*(?:\*\*)?\s*(?=[:：]|\r?\n|$|(?:о|про)(?![а-яёa-z]))/iu.test(
    String(value || '').trimStart(),
  );
}

function minTranscriptHits(checks, turn) {
  const requested = Number(turn?.minTranscriptHits);
  return Math.min(Number.isFinite(requested) && requested > 0 ? requested : 2, checks.length);
}

function assertMemorySnapshot(snapshot, label) {
  const memory = snapshot?.memory;
  if (!memory || typeof memory.mode !== 'string' || !memory.mode.trim()) {
    throw new Error(`${label} state is missing memory.mode`);
  }
  for (const key of [
    'backendIngestEnabled',
    'backendPromptContextEnabled',
    'minimalLocalPromptContextEnabled',
  ]) {
    if (typeof memory[key] !== 'boolean') {
      throw new Error(`${label} state is missing memory.${key}`);
    }
  }
  if (typeof memory.sessionId !== 'string' || !memory.sessionId.trim()) {
    throw new Error(`${label} state is missing memory.sessionId`);
  }
  if (typeof memory.lastContextStatus !== 'string' || !memory.lastContextStatus.trim()) {
    throw new Error(`${label} state is missing memory.lastContextStatus`);
  }
  if (typeof memory.lastIngestStatus !== 'string' || !memory.lastIngestStatus.trim()) {
    throw new Error(`${label} state is missing memory.lastIngestStatus`);
  }
}

function scoreMemoryDiagnostics(memory, expectedStatus = 'ok') {
  return [
    {
      label: `context status ${expectedStatus}`,
      ok: memory?.lastContextStatus === expectedStatus,
      value: memory?.lastContextStatus,
    },
    {
      label: 'context latency recorded',
      ok: Number.isFinite(Number(memory?.lastContextLatencyMs)) && Number(memory.lastContextLatencyMs) >= 0,
      value: memory?.lastContextLatencyMs,
    },
    {
      label: expectedStatus === 'fallback' ? 'ingest status observable' : 'ingest status ok',
      ok:
        expectedStatus === 'fallback'
          ? ['ok', 'failed'].includes(String(memory?.lastIngestStatus || ''))
          : memory?.lastIngestStatus === 'ok',
      value: memory?.lastIngestStatus,
    },
  ];
}

function diagnosticsPassForTurn(diagnosticChecks, options) {
  return diagnosticChecks.every((check) => {
    if (
      options.expectedMemoryStatus === 'ok' &&
      options.maxContextFallbacks > 0 &&
      check.label === 'context status ok' &&
      check.value === 'fallback'
    ) {
      return true;
    }
    return check.ok;
  });
}

function marker(runId, suffix) {
  return `VOICE_INTERVIEW_E2E_${runId}_${suffix}`;
}

function buildCodeAnchor(runId) {
  return [
    'Voice-led interview E2E code context.',
    `Контрольный маркер кода: ${marker(runId, VOICE_CODE_MARKER)}.`,
    'Собеседник будет голосом спрашивать про debounce search, очереди, SQL, React, idempotency и backpressure.',
    '```ts',
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

function buildFiller(runId, turnIndex, targetChars) {
  if (targetChars <= 0) return '';
  const lines = [
    'Интервьюер делает короткую паузу и уточняет формат ответа, ожидания по глубине и порядок демонстрации решения.',
    'Кандидат проговаривает, что сначала объяснит инвариант, затем крайние случаи, потом покажет небольшой пример.',
    'Разговор ненадолго уходит в организационные детали про звук, экран, заметки, темп интервью и переход к следующей теме.',
    `Пауза перед следующим вопросом, переход ${turnIndex}, участники сохраняют контекст предыдущего технического обсуждения.`,
  ];
  const parts = [];
  let chars = 0;
  let index = 1;
  while (chars < targetChars) {
    const next = lines[(index - 1) % lines.length];
    parts.push(next);
    chars += next.length + 1;
    index += 1;
  }
  return parts.join('\n').slice(0, targetChars).replaceAll(runId, '');
}

function baseVoiceTurns(runId) {
  return [
    {
      label: 'voice cache question',
      spoken: [
        'Давай начнём с кэша.',
        'Представь, что в проекте Северный маяк у нас LRU-кэш с TTL и ограничением по размеру.',
        'Как бы ты объяснил, когда запись надо считать устаревшей, а когда её надо вытеснять из-за переполнения?',
      ].join(' '),
      transcriptExpected: [['начн', 'давай'], ['север', 'маяк'], ['кэш', 'cache'], ['ttl', 'т т л']],
      aiPrompt: 'implicit-ai-request',
      answerExpected: [['lru', 'cache', 'кэш'], ['ttl', 'устар'], ['evict', 'вытесн', 'удал']],
    },
    {
      label: 'voice cache follow-up',
      spoken: [
        'Уточнение по этой же задаче.',
        'Допустим, два запроса почти одновременно читают один и тот же ключ, а срок жизни записи истекает прямо между чтением и обновлением.',
        'Где здесь может появиться гонка и какой инвариант ты бы защищал?',
      ].join(' '),
      transcriptExpected: ['уточнение', ['срок жизни', 'ttl'], ['гонк', 'одновременно'], ['инвариант', 'защищ']],
      aiPrompt: 'implicit-ai-request',
      answerExpected: [['ttl', 'устар'], ['race', 'гонк', 'конкур'], ['кэш', 'cache']],
    },
    {
      label: 'voice sql question',
      spoken: [
        'Теперь SQL.',
        'Есть таблица users с пользователями и таблица orders с заказами.',
        'Почему для отчёта используют left join, то есть левое соединение, чтобы не потерять пользователей без заказов?',
        'И отдельно где пригодится оконная функция row number для нумерации строк?',
      ].join(' '),
      transcriptExpected: [
        ['sql', 'эс кью эл'],
        ['left join', 'лев'],
        ['пользовател', 'users'],
        ['row number', 'окон', 'нумерац'],
      ],
      aiPrompt: 'implicit-ai-request',
      minTranscriptHits: 4,
      answerExpected: [
        ['left join', 'лев'],
        ['row_number', 'row number', 'окон', 'нумерац'],
        ['без заказ', 'null'],
      ],
    },
    {
      label: 'voice react follow-up',
      spoken: [
        'Давай теперь про React, про реакт-компонент.',
        'Представь, что в компоненте есть callback для поиска, и он иногда берёт старое значение из замыкания.',
        'Почему опасно просто убрать query из массива зависимостей ради меньшего числа рендеров?',
      ].join(' '),
      transcriptExpected: [
        ['react', 'реакт'],
        ['callback', 'колбек', 'кэлбек', 'замыкан'],
        ['query', 'квери', 'квири', 'запрос'],
        ['зависим', 'массив'],
      ],
      aiPrompt: 'implicit-ai-request',
      answerExpected: [['stale', 'устаревш'], ['dependency', 'зависим'], ['query', 'состояни']],
    },
    {
      label: 'voice idempotency question',
      spoken: [
        'Окей, теперь платежи.',
        'Клиент отправил запрос, деньги могли списаться, но ответ потерялся из-за сетевого таймаута.',
        'Как бы ты защитился от двойного списания, если клиент попробует повторить операцию?',
      ].join(' '),
      transcriptExpected: [['платеж', 'деньг'], ['таймаут', 'ответ потерял'], ['двойн'], ['повтор']],
      aiPrompt: 'implicit-ai-request',
      answerExpected: [
        ['idempotency', 'идемпот', 'идемпотент'],
        ['retry', 'повтор', 'повторн'],
        ['key', 'ключ', 'тот же', 'один результат', 'не списывать повторно'],
      ],
    },
    {
      label: 'voice backpressure follow-up',
      spoken: [
        'Ещё один практический кейс.',
        'Если задач приходит больше, чем сервис успевает обработать, как бы ты ограничивал очередь, замедлял входящий поток и понимал по метрикам, что система уже перегружена?',
        'Можно связать это с темой повторов, которую мы только что обсуждали.',
      ].join(' '),
      transcriptExpected: [['задач', 'сервис'], ['очеред'], ['метрик', 'перегруж'], ['повтор']],
      aiPrompt: 'implicit-ai-request',
      answerExpected: [['backpressure', 'давлен', 'нагруз'], ['bounded', 'огранич'], ['queue', 'очеред'], ['observability', 'метрик']],
    },
    {
      label: 'voice final recall',
      spoken: [
        'Давай в конце быстро соберём всё вместе.',
        'Мы успели обсудить кэш с TTL, SQL с left join, React с устаревшим замыканием, платежные повторы и ограничение нагрузки.',
        'Коротко пройдись по этим темам и объясни, что было главным в каждом блоке.',
      ].join(' '),
      transcriptExpected: [['в конце', 'собер'], ['кэш', 'cache'], ['sql', 'эс кью эл'], ['react', 'реакт']],
      aiPrompt: 'implicit-ai-request',
      answerExpected: [
        ['cache', 'кэш', 'ttl'],
        ['left join', 'sql'],
        ['react', 'stale', 'замыкан'],
        ['idempotency', 'идемпот', 'платеж'],
        ['backpressure', 'нагруз', 'очеред'],
      ],
      recall: true,
    },
  ];
}

function buildVoiceTurns(runId, count) {
  const coreTurns = baseVoiceTurns(runId);
  if (count <= coreTurns.length) return coreTurns.slice(0, count);

  const finalRecallTurn = coreTurns.at(-1);
  const turns = coreTurns.slice(0, -1);
  const followUps = [
    {
      label: 'voice extra cache sql',
      spoken: 'Сравни кэш с TTL и SQL с left join. Где мы боремся с устаревшими данными, а где с потерей строк в результате?',
      transcriptExpected: [['cache', 'кэш'], ['ttl', 'т т л'], ['sql', 's q l'], ['left join', 'лев']],
      answerExpected: [['ttl', 'устар'], ['left join', 'sql'], ['данн', 'строк']],
    },
    {
      label: 'voice extra react retry',
      spoken: 'Сравни старое значение в React callback и повтор платежной операции. В обоих случаях проблема похожая или принципиально разная?',
      transcriptExpected: [
        ['стар', 'устаревш'],
        ['callback', 'колбек', 'кэлбек', 'calboot', 'замыкан'],
        ['платеж', 'операц'],
        ['retry', 'повтор'],
      ],
      answerExpected: [
        ['stale', 'устаревш', 'старое значение', 'замык'],
        ['idempotency', 'идемпот', 'идемпотент'],
        ['retry', 'повтор', 'повторн'],
      ],
    },
    {
      label: 'voice extra all topics',
      spoken: 'Если бы надо было объяснить все эти темы одним коротким ответом на интервью, как бы ты разделил кэш, SQL, React, платежи и ограничение нагрузки?',
      transcriptExpected: [['cache', 'кэш'], ['sql', 's q l'], ['react', 'реакт'], ['backpressure', 'бекпреш']],
      answerExpected: [['cache', 'кэш', 'ttl'], ['sql', 'left join'], ['react', 'stale'], ['idempotency', 'идемпот'], 'backpressure'],
    },
  ];

  for (let index = turns.length + 1; index < count; index += 1) {
    const followUp = followUps[index % followUps.length];
    turns.push({
      label: `${followUp.label} ${index}`,
      spoken: followUp.spoken,
      transcriptExpected: followUp.transcriptExpected,
      aiPrompt: 'implicit-ai-request',
      answerExpected: [...followUp.answerExpected],
    });
  }

  turns.push(finalRecallTurn);
  return turns;
}

function ensureAudioTools() {
  if (!commandExists('say')) throw new Error('macOS say command is required for voice interview E2E');
  if (!commandExists('afplay')) throw new Error('macOS afplay command is required for voice interview E2E');
}

async function synthesizeTurnAudio(options, audioDir, turn, turnNumber) {
  const file = join(audioDir, `${String(turnNumber).padStart(3, '0')}-${turn.label.replace(/[^a-z0-9]+/gi, '-')}.aiff`);
  await run('say', ['-v', options.voice, '-o', file, turn.spoken]);
  return file;
}

async function recordVoiceQuestion(options, audioFile, turn, baselineSeq) {
  const before = await getState(options);
  const initialAppMuted = before.microphone?.appMuted;
  let stopped = false;

  try {
    await postAction(options, '/api/microphone/app/mute');
    await sleep(300);
    await postAction(options, '/api/record/start');
    await waitFor('voice interview recording start', options.startTimeoutMs, async () => {
      const state = await getState(options);
      return {
        ok: state.recording?.status === 'Recording',
        value: state.recording,
      };
    });

    await run('afplay', ['-v', String(options.volume), audioFile]);
    await sleep(options.settleMs);

    await postAction(options, '/api/record/stop').catch(() => {});
    stopped = true;
    await waitFor('voice interview recording stop', options.startTimeoutMs, async () => {
      const state = await getState(options);
      return {
        ok: state.recording?.status === 'Idle' && Number(state.recording?.activeSessionId || 0) === 0,
        value: state.recording,
      };
    });

    const transcriptState = await waitFor('voice interview STT', options.transcriptionTimeoutMs, async () => {
      const state = await getState(options);
      const text = messagesAfter(state, baselineSeq)
        .filter((message) => message.kind === 'stt' || message.kind === 'system')
        .map((message) => message.text)
        .join(' ');
      const checks = scoreTerms(text, turn.transcriptExpected);
      return {
        ok: checks.filter((check) => check.ok).length >= minTranscriptHits(checks, turn),
        value: {
          state,
          text,
          checks,
        },
      };
    });

    if (options.restoreMic && initialAppMuted === false) {
      await postAction(options, '/api/microphone/app/unmute').catch(() => {});
    }

    const finalState = await getState(options);
    const transcript = messagesAfter(finalState, baselineSeq)
      .filter((message) => message.kind === 'stt' || message.kind === 'system')
      .map((message) => message.text)
      .join(' ');
    const checks = scoreTerms(transcript, turn.transcriptExpected);

    return {
      ok: checks.filter((check) => check.ok).length >= minTranscriptHits(checks, turn),
      transcript,
      checks,
      state: transcriptState.state || finalState,
    };
  } finally {
    if (!stopped) await postAction(options, '/api/record/stop').catch(() => {});
    if (options.restoreMic && initialAppMuted === false) {
      await postAction(options, '/api/microphone/app/unmute').catch(() => {});
    }
  }
}

async function recordVoiceQuestionWithRetry(options, audioFile, turn, baselineSeq) {
  let lastError;
  for (let attempt = 0; attempt <= options.sttRetries; attempt += 1) {
    try {
      return await recordVoiceQuestion(options, audioFile, turn, baselineSeq);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const retryable = /Timed out waiting for voice interview STT/.test(message);
      if (!retryable || attempt >= options.sttRetries) break;
      console.warn(
        `[voice-interview] STT turn retry ${attempt + 1}/${options.sttRetries}: ${turn.label}`,
      );
      await postAction(options, '/api/record/stop').catch(() => {});
      await sleep(1_500 + attempt * 1_000);
    }
  }
  throw lastError;
}

function isTransientAiError(text) {
  return /overload|rate|429|503|temporar|timeout|timed out|try again|unavailable/i.test(String(text || ''));
}

async function requestAiAnswer(options, turn, baselineSeq, attempt = 0) {
  await postAction(options, '/api/ai/request', {
    text: null,
    openaiResponsesWebSearch: false,
  });

  const finalHaiku = await waitFor('voice interview AI final answer', options.aiTimeoutMs, async () => {
    const state = await getState(options);
    const messages = messagesAfter(state, baselineSeq);
    const candidates = messages.filter((message) => message.kind === 'haiku');
    const errored = [...candidates].reverse().find((message) => message.status === 'error');
    if (errored) {
      return {
        ok: true,
        value: {
          state: {
            recording: state.recording,
            memory: state.memory,
            timelineCount: state.timeline.length,
            maxSeq: maxSeq(state),
          },
          error: String(errored.text || errored.error || 'unknown error').slice(0, 300),
        },
      };
    }
    const final = [...candidates].reverse().find((message) => message.status === 'final' && message.text.trim());
    return {
      ok: Boolean(final),
      value: {
        state: {
          recording: state.recording,
          memory: state.memory,
          timelineCount: state.timeline.length,
          maxSeq: maxSeq(state),
        },
        final,
      },
    };
  });

  if (finalHaiku.error) {
    if (attempt < options.aiRetries && isTransientAiError(finalHaiku.error)) {
      console.warn(
        `[voice-interview] transient AI error, retry ${attempt + 1}/${options.aiRetries}: ${finalHaiku.error}`,
      );
      await sleep(1_500 + attempt * 1_000);
      const retryState = await getState(options);
      return requestAiAnswer(options, turn, maxSeq(retryState), attempt + 1);
    }
    throw new Error(
      `AI stream failed: ${JSON.stringify({
        error: finalHaiku.error,
        memory: finalHaiku.state?.memory,
      })}`,
    );
  }

  const answer = finalHaiku.final?.text || '';
  const answerChecks = [
    ...scoreTerms(answer, turn.answerExpected),
    {
      label: 'no question/answer preface',
      ok: !startsWithQuestionAnswerHeading(answer),
      terms: ['no Вопрос/Ответ preface'],
    },
  ];
  const diagnosticChecks = scoreMemoryDiagnostics(finalHaiku.state.memory, options.expectedMemoryStatus);
  return {
    ok: answerChecks.every((check) => check.ok) && diagnosticsPassForTurn(diagnosticChecks, options),
    answer,
    answerChecks,
    diagnosticChecks,
    finalMessage: finalHaiku.final,
    timelineState: finalHaiku.state,
  };
}

async function ingestFocusCopy(options, text, languageId = 'text') {
  return postAction(options, '/api/focus-copy/ingest', {
    text,
    method: 'voice-interview-e2e',
    source: 'companion-voice-interview-e2e',
    appName: 'HackInterview Voice Interview E2E',
    languageId,
    lineCount: text.split('\n').length,
    characterCount: text.length,
  });
}

function retrievedMemoryText(contextText) {
  const markerText = '## retrieved_memory';
  const index = contextText.indexOf(markerText);
  if (index < 0) return '';
  const rest = contextText.slice(index + markerText.length);
  const nextSectionIndex = rest.search(/\n##\s+/);
  return nextSectionIndex >= 0 ? rest.slice(0, nextSectionIndex) : rest;
}

async function runMemoryCheck(options, runId, sessionId) {
  const token = await readMemoryAuthToken(options);
  if (!token) throw new Error('Memory verification needs auth token or auth_store.json');
  if (!sessionId) throw new Error('Memory verification needs companion memory session id');

  const requiredTerms = [
    'Северный маяк',
    'LRU',
    'TTL',
    ['LEFT JOIN', 'LFT JOIN', 'левое соединение'],
    ['stale closure', 'стейл-клоужур', 'устаревшее замыкание', 'старые значения'],
    ['idempotency', 'идемпот'],
    ['backpressure', 'ограничение нагрузки', 'перегружена', 'очередь'],
    marker(runId, VOICE_CODE_MARKER),
  ];
  const response = await fetch(`${options.memoryApiUrl}/api/v1/interview-memory/context`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-memory-canary-id': `voice-interview-${runId}`,
    },
    body: JSON.stringify({
      session_id: sessionId,
      context_snapshot_id: `voice-interview-${runId}-${Date.now()}`,
      current_request: {
        id: `voice-interview-memory-${runId}-${Date.now()}`,
        label: 'voice_interview_memory_check',
        text: 'Финальная проверка памяти по голосовому интервью: кэш LRU TTL, SQL LEFT JOIN, React stale closure, idempotency retry, backpressure и исходный код debounce.',
      },
      budget_max_chars: 30_000,
      max_memory_candidates: 300,
      max_memory_results: 64,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(`Memory context failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  const retrieved = normalizedText(retrievedMemoryText(payload.data?.text || ''));
  const checks = requiredTerms.map((term) => {
    if (Array.isArray(term)) {
      return { term: term.join('|'), ok: includesAny(retrieved, term) };
    }
    return { term, ok: retrieved.includes(normalizedText(term)) };
  });
  return {
    ok: checks.every((check) => check.ok),
    checks,
    budgetUsed: payload.data?.budget?.used_chars,
    budgetTotal: payload.data?.budget?.max_chars,
    latencyMs: payload.data?.diagnostics?.latency_ms,
  };
}

function redactText(value) {
  const text = String(value || '');
  return text ? { redacted: true, charCount: text.length } : '';
}

function redactChecks(checks) {
  return (checks || []).map((check) => ({
    label: check.label || check.term,
    ok: check.ok,
    termCount: Array.isArray(check.terms) ? check.terms.length : 0,
    value: check.value,
  }));
}

function productionSafeTurnResult(result) {
  return {
    ...result,
    transcript: redactText(result.transcript),
    answer: redactText(result.answer),
    aiTrigger: result.aiTrigger,
    transcriptChecks: redactChecks(result.transcriptChecks),
    answerChecks: redactChecks(result.answerChecks),
    diagnosticChecks: redactChecks(result.diagnosticChecks),
  };
}

function assertProductionSafeArtifact(artifact) {
  if (!artifact.productionSafe) return;
  const serialized = JSON.stringify(artifact).toLowerCase();
  const forbidden = ['северный маяк', 'двойного списания', 'устаревших данных'];
  const leaked = forbidden.filter((item) => serialized.includes(item));
  if (leaked.length > 0) {
    throw new Error(`Production-safe artifact leaked raw E2E fragments: ${leaked.join(', ')}`);
  }
}

async function writeArtifact(options, artifact) {
  assertProductionSafeArtifact(artifact);
  await mkdir(options.artifactsDir, { recursive: true });
  const path = join(options.artifactsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(path, JSON.stringify(artifact, null, 2), 'utf8');
  return path;
}

function runSelfTest() {
  const runId = 'SELFTEST';
  const turns = buildVoiceTurns(runId, 14);
  if (turns.length !== 14) throw new Error('turn count should match');
  if (!turns.at(-1)?.recall) throw new Error('final recall should stay last');
  if (turns.some((turn) => /[Вв]опрос/u.test(turn.spoken))) {
    throw new Error('spoken interview turns must not use question prefix wording');
  }
  if (!turns.some((turn) => turn.spoken.includes('Уточнение'))) {
    throw new Error('scenario should include guided follow-up turns');
  }
  if (turns.some((turn) => turn.aiPrompt !== 'implicit-ai-request')) {
    throw new Error('voice-led scenario must use implicit AI requests instead of visible user prompts');
  }
  for (const badAnswer of [
    'Вопрос: почему нужен LEFT JOIN?\n\nОтвет: чтобы не потерять строки',
    'Вопрос о том, почему нужен LEFT JOIN.\n\n- чтобы не потерять строки',
    '**Вопрос:** почему нужен LEFT JOIN?\n\n**Ответ:** чтобы не потерять строки',
    '# Ответ\n- чтобы не потерять строки',
  ]) {
    if (!startsWithQuestionAnswerHeading(badAnswer)) {
      throw new Error(`answer heading detector missed: ${badAnswer}`);
    }
  }
  const filler = buildFiller(runId, 2, 3000);
  if (filler.length !== 3000) throw new Error('filler should honor length');
  if (filler.includes(runId)) throw new Error('filler must not include run id');
  console.log('[voice-interview] self-test ok');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    return;
  }

  ensureAudioTools();
  if (!options.token) {
    const bridge = await readBridgeToken();
    options.token = bridge.token;
    options.bridgePath = bridge.path;
  }
  if (!options.token) throw new Error('Companion token is required. Pass --token or COMPANION_URL.');

  const runId = randomUUID().slice(0, 8).toUpperCase();
  await postAction(options, '/api/record/stop').catch(() => {});
  if (options.isolateContext) {
    await postAction(options, '/api/context/clear');
    await sleep(options.settleMs);
  }

  const initial = await getState(options);
  assertMemorySnapshot(initial, 'initial companion');
  const initialSeq = maxSeq(initial);
  const turns = buildVoiceTurns(runId, options.turns);
  const fillerPerGap = turns.length > 1 ? Math.floor(options.fillerChars / (turns.length - 1)) : 0;
  const audioDir = join(tmpdir(), `hackinterview-voice-interview-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(audioDir, { recursive: true });
  await ingestFocusCopy(options, buildCodeAnchor(runId), 'typescript');

  const turnResults = [];
  console.log(
    `[voice-interview] run=${runId}, initial timeline=${initial.timeline.length}, maxSeq=${initialSeq}, turns=${turns.length}, fillerChars=${options.fillerChars}`,
  );

  for (let index = 0; index < turns.length; index += 1) {
    const turnNumber = index + 1;
    const turn = turns[index];
    if (index > 0 && fillerPerGap > 0) {
      await ingestFocusCopy(options, buildFiller(runId, turnNumber, fillerPerGap), 'text');
      console.log(`[voice-interview] turn=${turnNumber} synthetic load chars=${fillerPerGap}`);
    }

    const baselineState = await getState(options);
    const baselineSeq = maxSeq(baselineState);
    const audioFile = await synthesizeTurnAudio(options, audioDir, turn, turnNumber);
    console.log(`[voice-interview] turn=${turnNumber}/${turns.length}: ${turn.label}`);

    const voiceResult = await recordVoiceQuestionWithRetry(options, audioFile, turn, baselineSeq);
    const afterVoice = await getState(options);
    const aiResult = await requestAiAnswer(options, turn, maxSeq(afterVoice));
    const ok = voiceResult.ok && aiResult.ok;
    const result = {
      index: turnNumber,
      label: turn.label,
      ok,
      transcript: voiceResult.transcript,
      transcriptChecks: voiceResult.checks,
      aiTrigger: 'api/ai/request:text:null',
      answer: aiResult.answer,
      answerChecks: aiResult.answerChecks,
      diagnosticChecks: aiResult.diagnosticChecks,
      timelineState: aiResult.timelineState,
      audioFile: options.keepAudio ? audioFile : undefined,
    };
    turnResults.push(result);

    const icon = ok ? '✅' : '❌';
    console.log(
      `${icon} turn=${turnNumber}: ${[
        ...voiceResult.checks.map((check) => `stt:${check.label}=${check.ok ? 'ok' : 'miss'}`),
        ...aiResult.answerChecks.map((check) => `ai:${check.label}=${check.ok ? 'ok' : 'miss'}`),
        ...aiResult.diagnosticChecks.map((check) => `${check.label}=${check.ok ? 'ok' : 'miss'}`),
      ].join(', ')}`,
    );
  }

  const final = await getState(options);
  let memoryResult = null;
  if (options.verifyMemory) {
    console.log('[voice-interview] verifying backend memory retrieval');
    memoryResult = await runMemoryCheck(options, runId, final.memory?.sessionId);
    const icon = memoryResult.ok ? '✅' : '❌';
    console.log(
      `${icon} memory context: ${memoryResult.checks.map((check) => `${check.term}=${check.ok ? 'ok' : 'miss'}`).join(', ')}`,
    );
  }

  const failedTurns = turnResults.filter((result) => !result.ok);
  const contextFallbackTurns = turnResults.filter((result) =>
    result.diagnosticChecks.some((check) => check.label === 'context status ok' && !check.ok && check.value === 'fallback'),
  );
  const acceptance = {
    ok:
      failedTurns.length === 0 &&
      contextFallbackTurns.length <= options.maxContextFallbacks &&
      (!memoryResult || memoryResult.ok),
    failedTurns: failedTurns.map((turn) => turn.index),
    contextFallbackTurns: contextFallbackTurns.map((turn) => turn.index),
    maxContextFallbacks: options.maxContextFallbacks,
    memoryOk: !memoryResult || memoryResult.ok,
  };

  const artifact = {
    createdAt: new Date().toISOString(),
    productionSafe: options.productionSafeArtifact,
    options: {
      turns: options.turns,
      fillerChars: options.fillerChars,
      sttRetries: options.sttRetries,
      aiRetries: options.aiRetries,
      expectedMemoryStatus: options.expectedMemoryStatus,
      maxContextFallbacks: options.maxContextFallbacks,
      isolateContext: options.isolateContext,
      clearAtEnd: options.clearAtEnd,
    },
    runId,
    acceptance,
    initial: {
      timelineCount: initial.timeline.length,
      maxSeq: initialSeq,
      memory: initial.memory,
    },
    final: {
      timelineCount: final.timeline.length,
      maxSeq: maxSeq(final),
      memory: final.memory,
    },
    turnResults: options.productionSafeArtifact ? turnResults.map(productionSafeTurnResult) : turnResults,
    memoryResult,
    audioDir: options.keepAudio ? audioDir : undefined,
  };
  const artifactPath = await writeArtifact(options, artifact);
  console.log(`[voice-interview] artifact: ${artifactPath}`);

  if (options.clearAtEnd) {
    await postAction(options, '/api/context/clear').catch((error) => {
      console.warn(`[voice-interview] cleanup clear failed: ${error.message || error}`);
    });
    console.log('[voice-interview] cleared companion context after run');
  }

  if (!acceptance.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[voice-interview] ${error.stack || error.message || error}`);
  process.exitCode = 1;
});

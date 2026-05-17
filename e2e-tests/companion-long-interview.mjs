#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

const DEFAULT_API_URL =
  process.env.INTERVIEW_MEMORY_E2E_API_URL ||
  process.env.INTERVIEW_MEMORY_API_URL ||
  process.env.VITE_API_URL ||
  'https://api.voicetext.site';

const DEFAULT_AUTH_STORE = join(homedir(), 'Library/Application Support/HackInterview/auth_store.json');

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.COMPANION_BASE_URL || process.env.COMPANION_URL || 'http://127.0.0.1:43821',
    token: process.env.COMPANION_TOKEN || '',
    turns: Number(process.env.COMPANION_LONG_INTERVIEW_TURNS || 8),
    fillerChars: Number(process.env.COMPANION_LONG_INTERVIEW_FILLER_CHARS || 120_000),
    aiTimeoutMs: Number(process.env.COMPANION_LONG_INTERVIEW_AI_TIMEOUT_MS || 180_000),
    settleMs: Number(process.env.COMPANION_LONG_INTERVIEW_SETTLE_MS || 800),
    artifactsDir: '.e2e-artifacts/companion-long-interview',
    expectedMemoryStatus: process.env.COMPANION_EXPECT_MEMORY_CONTEXT_STATUS || 'ok',
    allowAiMiss: false,
    verifyMemory: false,
    memoryApiUrl: DEFAULT_API_URL,
    memoryAuthToken: process.env.INTERVIEW_MEMORY_AUTH_TOKEN || '',
    memoryAuthTokenFile: process.env.INTERVIEW_MEMORY_AUTH_TOKEN_FILE || '',
    authStorePath: process.env.HACKINTERVIEW_AUTH_STORE_PATH || DEFAULT_AUTH_STORE,
    memoryBudgetChars: Number(process.env.COMPANION_LONG_INTERVIEW_MEMORY_BUDGET_CHARS || 26_000),
    memoryMaxCandidates: Number(process.env.COMPANION_LONG_INTERVIEW_MEMORY_MAX_CANDIDATES || 120),
    memoryMaxResults: Number(process.env.COMPANION_LONG_INTERVIEW_MEMORY_MAX_RESULTS || 32),
    maxContextFallbacks: Number(process.env.COMPANION_LONG_INTERVIEW_MAX_CONTEXT_FALLBACKS || 0),
    productionSafeArtifact: process.env.COMPANION_PRODUCTION_SAFE_ARTIFACT === '1',
    openaiResponsesWebSearch: false,
    isolateContext: false,
    scenario: process.env.COMPANION_LONG_INTERVIEW_SCENARIO || 'single-task',
    answerCheckMode: process.env.COMPANION_LONG_INTERVIEW_ANSWER_CHECK_MODE || 'semantic',
    finalRecallMode: process.env.COMPANION_LONG_INTERVIEW_FINAL_RECALL_MODE || 'semantic',
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
    else if (arg === '--turns') options.turns = Number(next());
    else if (arg === '--filler-chars') options.fillerChars = Number(next());
    else if (arg === '--ai-timeout-ms') options.aiTimeoutMs = Number(next());
    else if (arg === '--settle-ms') options.settleMs = Number(next());
    else if (arg === '--artifacts-dir') options.artifactsDir = next();
    else if (arg === '--expect-memory-status') options.expectedMemoryStatus = next();
    else if (arg === '--allow-ai-miss') options.allowAiMiss = true;
    else if (arg === '--verify-memory') options.verifyMemory = true;
    else if (arg === '--memory-api-url') options.memoryApiUrl = next();
    else if (arg === '--memory-auth-token') options.memoryAuthToken = next();
    else if (arg === '--memory-auth-token-file') options.memoryAuthTokenFile = next();
    else if (arg === '--auth-store-path') options.authStorePath = next();
    else if (arg === '--memory-budget-chars') options.memoryBudgetChars = Number(next());
    else if (arg === '--memory-max-candidates') options.memoryMaxCandidates = Number(next());
    else if (arg === '--memory-max-results') options.memoryMaxResults = Number(next());
    else if (arg === '--max-context-fallbacks') options.maxContextFallbacks = Number(next());
    else if (arg === '--production-safe-artifact') options.productionSafeArtifact = true;
    else if (arg === '--web-search') options.openaiResponsesWebSearch = true;
    else if (arg === '--isolate-context') options.isolateContext = true;
    else if (arg === '--scenario') options.scenario = next();
    else if (arg === '--answer-check-mode') options.answerCheckMode = next();
    else if (arg === '--semantic-answer-checks') options.answerCheckMode = 'semantic';
    else if (arg === '--final-recall-mode') options.finalRecallMode = next();
    else if (arg === '--semantic-final-recall') options.finalRecallMode = 'semantic';
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  if (options.memoryApiUrl) options.memoryApiUrl = normalizeBaseUrl(options.memoryApiUrl);
  options.turns = Math.max(1, Math.floor(options.turns || 1));
  options.fillerChars = Math.max(0, Math.floor(options.fillerChars || 0));
  options.memoryBudgetChars = Math.max(4_000, Math.floor(options.memoryBudgetChars || 26_000));
  options.memoryMaxCandidates = Math.max(1, Math.floor(options.memoryMaxCandidates || 120));
  options.memoryMaxResults = Math.max(1, Math.floor(options.memoryMaxResults || 32));
  options.maxContextFallbacks = Math.max(0, Math.floor(options.maxContextFallbacks || 0));
  options.answerCheckMode = ['literal', 'semantic'].includes(options.answerCheckMode)
    ? options.answerCheckMode
    : 'literal';
  options.finalRecallMode = ['literal', 'semantic'].includes(options.finalRecallMode)
    ? options.finalRecallMode
    : 'literal';
  options.scenario = ['single-task', 'multi-topic'].includes(options.scenario)
    ? options.scenario
    : 'single-task';
  if (!options.token) options.token = extractTokenFromUrl(process.env.COMPANION_URL || options.baseUrl) || '';
  return options;
}

function printHelp() {
  console.log(`Companion long interview memory E2E

Usage:
  pnpm e2e:companion-long-interview -- --turns 8 --filler-chars 120000 --verify-memory

What it checks:
  - builds a long interview-shaped companion timeline without clearing history;
  - injects code/context/filler through the same companion HTTP APIs used by the app;
  - sends several real AI prompts: question, answer, clarification, answer, final recall;
  - verifies each AI answer uses the current question and memory diagnostics stay observable;
  - verifies final recall can recover early/middle requirements after large filler;
  - optionally calls backend /api/v1/interview-memory/context for retrieved-memory assertions.

Useful flags:
  --turns <n>                  Number of AI turns, default 8.
  --filler-chars <n>           Total long filler chars spread across turns, default 120000.
  --verify-memory              Verify backend memory retrieval for the active companion session.
  --memory-api-url <url>       Backend URL, default VITE_API_URL/INTERVIEW_MEMORY_API_URL/prod.
  --memory-auth-token <token>  Raw bearer token for backend memory API.
  --memory-auth-token-file <p> Raw token or auth_store.json.
  --auth-store-path <path>     Native auth store, default ~/Library/Application Support/HackInterview/auth_store.json.
  --memory-max-candidates <n>  Max backend candidates for broad memory verification, default 120.
  --memory-max-results <n>     Max backend results for broad memory verification, default 32.
  --max-context-fallbacks <n>   Allow up to n observable context fallbacks during long endurance runs, default 0.
  --expect-memory-status <s>   Expected companion memory status after each answer, default ok.
  --allow-ai-miss              Keep exit code 0 when answer checks miss.
  --web-search                 Enable OpenAI Responses web search.
  --isolate-context            Clear active context and start a fresh memory session before the run.
  --scenario <name>            single-task or multi-topic, default single-task.
  --answer-check-mode <mode>   literal or semantic, default semantic.
  --semantic-answer-checks     Alias for --answer-check-mode semantic.
  --final-recall-mode <mode>   literal or semantic, default semantic.
  --semantic-final-recall      Alias for --final-recall-mode semantic.
  --production-safe-artifact   Redact raw prompt/answer/context text in artifact.
  --self-test                  Run offline assertions for long-interview scenario helpers.
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
  return tokenFromJson(await readJsonIfExists(options.authStorePath));
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
      'x-companion-request-id': `long-interview-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
    await sleep(700);
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

function scoreMemoryDiagnostics(memory, expectedStatus) {
  const checks = [
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

  if (expectedStatus === 'fallback') {
    checks.push({
      label: 'fallback reason recorded',
      ok: typeof memory?.lastContextError === 'string' && memory.lastContextError.trim().length > 0,
      value: memory?.lastContextError,
    });
  }

  return checks;
}

function marker(runId, name) {
  return `LONG_INTERVIEW_E2E_${runId}_${name}`.replace(/[^A-Z0-9_]/gi, '_').toUpperCase();
}

function buildCodeAnchor(runId) {
  const debounceMarker = marker(runId, 'DEBOUNCE_TIMER_ARGUMENT');
  return [
    'Long interview E2E early code context.',
    `Контроль раннего вопроса: ${debounceMarker}.`,
    'Проект называется Северный мост. Собеседник будет спрашивать про debounceSearch и сохранение последнего аргумента.',
    '```ts',
    `const E2E_PROJECT_MARKER = '${debounceMarker}';`,
    'export function debounceSearch(fn: (query: string) => void, delayMs: number) {',
    '  let timer: ReturnType<typeof setTimeout> | undefined;',
    '  let lastQuery = "";',
    '  return (query: string) => {',
    '    lastQuery = query;',
    '    if (timer) clearTimeout(timer);',
    '    timer = setTimeout(() => fn(lastQuery), delayMs);',
    '  };',
    '}',
    '```',
  ].join('\n');
}

function buildQueueAnchor(runId) {
  const queueMarker = marker(runId, 'QUEUE_FIFO_NO_STACK');
  return [
    'Long interview E2E middle code context.',
    `Контроль очереди событий: ${queueMarker}.`,
    'Требование: события должны обрабатываться FIFO через очередь, а не LIFO через стек.',
    '```ts',
    'type EventJob = { id: string; payload: unknown };',
    'const queue: EventJob[] = [];',
    'export function pushJob(job: EventJob) { queue.push(job); }',
    'export function nextJob() { return queue.shift(); }',
    '```',
  ].join('\n');
}

function buildComplexityAnchor(runId) {
  const complexityMarker = marker(runId, 'LINEAR_NO_RECURSION');
  return [
    'Long interview E2E late constraint.',
    `Контроль сложности: ${complexityMarker}.`,
    'Собеседник уточнил: решение должно быть линейным O(n), без рекурсии и без вложенного перебора всех пар.',
  ].join('\n');
}

function buildLruAnchor(runId) {
  const lruMarker = marker(runId, 'LRU_TTL_EVICTION');
  return [
    'Long interview E2E multi-topic cache context.',
    `Контроль cache-задачи: ${lruMarker}.`,
    'Проект называется Полярная станция. Собеседник спрашивает про LRU cache с TTL и eviction старых значений.',
    '```ts',
    `const E2E_CACHE_MARKER = '${lruMarker}';`,
    'type CacheEntry = { key: string; value: string; expiresAt: number; lastUsedAt: number };',
    'export function shouldEvict(entry: CacheEntry, now: number, capacityExceeded: boolean) {',
    '  return entry.expiresAt <= now || capacityExceeded;',
    '}',
    '```',
  ].join('\n');
}

function buildSqlAnchor(runId) {
  const sqlMarker = marker(runId, 'SQL_LEFT_JOIN_WINDOW');
  return [
    'Long interview E2E multi-topic SQL context.',
    `Контроль SQL-задачи: ${sqlMarker}.`,
    'Нужно объяснить запрос, который сохраняет пользователей без заказов через LEFT JOIN и ранжирует покупки оконной функцией.',
    '```sql',
    `-- ${sqlMarker}`,
    'select u.id, u.name, row_number() over (partition by u.id order by o.created_at desc) as order_rank',
    'from users u',
    'left join orders o on o.user_id = u.id;',
    '```',
  ].join('\n');
}

function buildReactAnchor(runId) {
  const reactMarker = marker(runId, 'REACT_STALE_CLOSURE_MEMO');
  return [
    'Long interview E2E multi-topic React context.',
    `Контроль React-задачи: ${reactMarker}.`,
    'Собеседник проверяет stale closure, зависимости useCallback/useMemo и аккуратный rerender budget.',
    '```tsx',
    `const E2E_REACT_MARKER = '${reactMarker}';`,
    'function SearchBox({ onSearch }: { onSearch: (value: string) => void }) {',
    '  const [query, setQuery] = useState("");',
    '  const submit = useCallback(() => onSearch(query), [onSearch, query]);',
    '  return <button onClick={submit}>Search</button>;',
    '}',
    '```',
  ].join('\n');
}

function buildIdempotencyAnchor(runId) {
  const idempotencyMarker = marker(runId, 'IDEMPOTENCY_RETRY_BACKOFF');
  return [
    'Long interview E2E multi-topic distributed systems context.',
    `Контроль idempotency-задачи: ${idempotencyMarker}.`,
    'Сервис платежей должен принимать idempotency key, безопасно повторять transient ошибки и использовать bounded exponential backoff без дублирования списаний.',
  ].join('\n');
}

function buildFiller(runId, turnIndex, targetChars) {
  if (targetChars <= 0) return '';
  const line = [
    `Организационная пауза интервью, блок ${turnIndex}.`,
    'Собеседник обсуждает расписание встречи, формат ответа, звук, связь, заметки, планы релиза, стиль объяснения, ожидания команды, демонстрацию решения и общие детали созвона.',
  ].join(' ');
  const parts = [];
  let chars = 0;
  let index = 1;
  while (chars < targetChars) {
    const next = `${line} filler-line-${index}.`;
    parts.push(next);
    chars += next.length + 1;
    index += 1;
  }
  return parts.join('\n').slice(0, targetChars);
}

function baseTurns(runId) {
  const debounceMarker = marker(runId, 'DEBOUNCE_TIMER_ARGUMENT');
  const debounceRaceMarker = marker(runId, 'DEBOUNCE_RACE_CLARIFY');
  const queueMarker = marker(runId, 'QUEUE_FIFO_NO_STACK');
  const complexityMarker = marker(runId, 'LINEAR_NO_RECURSION');
  const codeSketchMarker = marker(runId, 'CODE_SKETCH_STABLE');
  const finalRecallMarker = marker(runId, 'FINAL_RECALL');

  return [
    {
      label: 'debounce initial question',
      contextBefore: buildCodeAnchor(runId),
      languageId: 'typescript',
      question: [
        'Собеседник спрашивает на интервью несколькими предложениями.',
        'В проекте Северный мост есть функция debounceSearch из кода выше.',
        'Почему при каждом новом вводе нужно отменять прошлый таймер, но при этом сохранять последний аргумент?',
        'Начни ответ точной фразой "Северный мост:", чтобы E2E мог проверить, что project context учитывается.',
        `В конце ответа напиши контрольный код ${debounceMarker}.`,
      ].join(' '),
      expected: ['север', 'мост', 'debounce', 'таймер', 'аргумент', debounceMarker],
    },
    {
      label: 'debounce clarification',
      question: [
        'Уточнение собеседника: пользователь быстро вводит "ab", потом "abc", потом стирает обратно.',
        'Какие race conditions здесь возможны, если старый таймер не отменить или использовать устаревший аргумент?',
        'Ответь как кандидат: коротко, но с причинно-следственной связью.',
        `В конце ответа напиши контрольный код ${debounceRaceMarker}.`,
      ].join(' '),
      expected: ['таймер', 'устар', ['аргумент', 'query', 'ввод', 'значен'], debounceRaceMarker],
    },
    {
      label: 'queue instead of stack',
      contextBefore: buildQueueAnchor(runId),
      languageId: 'typescript',
      question: [
        'Новый вопрос собеседника: теперь говорим про обработчик событий.',
        'Почему для событий нужна очередь FIFO, а не стек LIFO?',
        'Объясни, что сломается в пользовательском сценарии, если поздние события начнут обгонять ранние.',
        `В конце ответа напиши контрольный код ${queueMarker}.`,
      ].join(' '),
      expected: [['очеред', 'queue', 'fifo'], ['стек', 'lifo'], 'fifo', queueMarker],
    },
    {
      label: 'linear complexity constraint',
      contextBefore: buildComplexityAnchor(runId),
      contextRoute: 'system',
      languageId: 'text',
      question: [
        'Собеседник добавляет ограничение к прошлой задаче.',
        'Нужно объяснить решение с линейной сложностью и без рекурсии.',
        'Как бы ты сформулировал инвариант и почему вложенный перебор здесь плохой?',
        `В конце ответа напиши контрольный код ${complexityMarker}.`,
      ].join(' '),
      expected: ['линей', 'рекурс', 'инвариант', complexityMarker],
    },
    {
      label: 'code sketch with remembered constraints',
      question: [
        'Теперь собеседник просит короткий TypeScript sketch.',
        'Используй всё, что уже было: debounce должен не терять последний аргумент, события должны идти через очередь, сложность должна остаться линейной.',
        'Не надо большой код, достаточно каркаса и пояснения.',
        `В конце ответа напиши контрольный код ${codeSketchMarker}.`,
      ].join(' '),
      expected: ['typescript', 'debounce', ['очеред', 'queue', 'fifo'], 'линей', codeSketchMarker],
    },
    {
      label: 'final recall without restating markers',
      question: [
        'Финальный контроль памяти без повторения старых деталей.',
        'Собеседник просит собрать итог по раннему debounce-вопросу, middle queue-вопросу и late complexity-ограничению.',
        'Назови контрольные коды из предыдущих этапов и кратко объясни, что каждый доказывает.',
        'Не используй EXTRA_CLARIFY коды из промежуточных уточнений.',
        'Нужны именно исходные коды про debounce timer argument, queue FIFO no stack и linear no recursion.',
        'Не придумывай новые контрольные коды.',
        `Первой строкой обязательно напиши: FINAL_RECALL=${finalRecallMarker}.`,
      ].join(' '),
      expected: [
        debounceMarker,
        queueMarker,
        complexityMarker,
        finalRecallMarker,
        'debounce',
        ['очеред', 'queue', 'fifo'],
        'линей',
      ],
      recall: true,
    },
  ];
}

function buildTurns(runId, count) {
  const coreTurns = baseTurns(runId);
  if (count <= coreTurns.length) return coreTurns.slice(0, count);

  const finalRecallTurn = coreTurns.at(-1);
  const turns = coreTurns.slice(0, -1);
  for (let index = turns.length + 1; index < count; index += 1) {
    const extraMarker = marker(runId, `EXTRA_CLARIFY_${index}`);
    turns.push({
      label: `extra clarification ${index}`,
      question: [
        `Дополнительное уточнение интервью номер ${index}.`,
        'Собеседник проверяет, не потерял ли кандидат связь между debounce, очередью событий и линейной сложностью.',
        'Ответь одним компактным блоком и явно свяжи эти три темы.',
        `В конце ответа напиши контрольный код ${extraMarker}.`,
      ].join(' '),
      expected: ['debounce', ['очеред', 'queue', 'fifo'], 'линей', extraMarker],
    });
  }
  turns.push(finalRecallTurn);
  return turns;
}

function multiTopicTurns(runId) {
  const lruMarker = marker(runId, 'LRU_TTL_EVICTION');
  const lruRaceMarker = marker(runId, 'LRU_TTL_RACE_CLARIFY');
  const sqlMarker = marker(runId, 'SQL_LEFT_JOIN_WINDOW');
  const reactMarker = marker(runId, 'REACT_STALE_CLOSURE_MEMO');
  const idempotencyMarker = marker(runId, 'IDEMPOTENCY_RETRY_BACKOFF');
  const crossTopicMarker = marker(runId, 'CROSS_TOPIC_SYNTHESIS');
  const finalRecallMarker = marker(runId, 'MULTI_TOPIC_FINAL_RECALL');

  return [
    {
      label: 'multi-topic lru cache initial question',
      contextBefore: buildLruAnchor(runId),
      languageId: 'typescript',
      question: [
        'Собеседник задаёт первый большой вопрос интервью несколькими предложениями.',
        'В проекте Полярная станция нужно объяснить LRU cache с TTL.',
        'Почему expired записи надо удалять независимо от capacity, а при переполнении выбирать least recently used?',
        'Начни ответ точной фразой "Полярная станция:", чтобы проверить, что ранний project context попал в ответ.',
        `В конце ответа напиши контрольный код ${lruMarker}.`,
      ].join(' '),
      expected: ['полярная', 'станция', 'lru', 'ttl', ['evict', 'удал', 'вытесн'], lruMarker],
    },
    {
      label: 'multi-topic lru race clarification',
      question: [
        'Уточнение по cache-задаче: два запроса почти одновременно читают один ключ, а TTL истекает между read и write-back.',
        'Какие race conditions возможны и какой инвариант должен сохраняться, чтобы не вернуть устаревшее значение?',
        'Ответь как на интервью, без кода, но с конкретной причинно-следственной связью.',
        `В конце ответа напиши контрольный код ${lruRaceMarker}.`,
      ].join(' '),
      expected: ['ttl', ['race', 'гонк'], ['инвариант', 'устар'], lruRaceMarker],
    },
    {
      label: 'multi-topic sql join window question',
      contextBefore: buildSqlAnchor(runId),
      languageId: 'sql',
      question: [
        'Собеседник переключает тему на SQL.',
        'Почему в запросе из контекста важен LEFT JOIN, а не INNER JOIN, и зачем нужна оконная функция row_number?',
        'Объясни, как сохранить пользователей без заказов и выбрать последние заказы без потери строк.',
        `В конце ответа напиши контрольный код ${sqlMarker}.`,
      ].join(' '),
      expected: [['left join', 'лев'], ['row_number', 'окон'], ['null', 'без заказ'], sqlMarker],
    },
    {
      label: 'multi-topic react stale closure question',
      contextBefore: buildReactAnchor(runId),
      languageId: 'tsx',
      question: [
        'Новая тема интервью: React performance и корректность.',
        'По коду выше объясни, как stale closure возникает при неправильных зависимостях useCallback или useMemo.',
        'Почему нельзя просто выкинуть query из dependency array ради меньшего числа rerender?',
        `В конце ответа напиши контрольный код ${reactMarker}.`,
      ].join(' '),
      expected: [['stale', 'устаревш'], ['closure', 'замыкан'], ['usecallback', 'usememo', 'dependency'], reactMarker],
    },
    {
      label: 'multi-topic idempotency retry question',
      contextBefore: buildIdempotencyAnchor(runId),
      contextRoute: 'system',
      languageId: 'text',
      question: [
        'Собеседник задаёт distributed systems вопрос.',
        'Как проектировать retry для платежного API, чтобы transient 500 или network timeout не создавали двойное списание?',
        'Свяжи idempotency key, bounded backoff и хранение результата первой успешной операции.',
        `В конце ответа напиши контрольный код ${idempotencyMarker}.`,
      ].join(' '),
      expected: [['idempotency', 'идемпот'], ['retry', 'повтор'], 'backoff', idempotencyMarker],
    },
    {
      label: 'multi-topic cross-topic synthesis',
      question: [
        'Собеседник проверяет, не перемешались ли темы после долгой беседы.',
        'Сравни cache TTL eviction, SQL LEFT JOIN и платежный idempotency retry: что в них общее с точки зрения инвариантов?',
        'Не надо код, нужен компактный ответ кандидата с разграничением тем.',
        `В конце ответа напиши контрольный код ${crossTopicMarker}.`,
      ].join(' '),
      expected: ['ttl', ['left join', 'sql'], ['idempotency', 'идемпот'], ['инвариант', 'гарант'], crossTopicMarker],
    },
    {
      label: 'multi-topic final recall without restating markers',
      question: [
        'Финальный контроль памяти после долгого интервью без повторения старых деталей.',
        'Собеседник просит вспомнить самые ранние и средние темы: cache LRU/TTL, SQL LEFT JOIN/window function, React stale closure и idempotency retry.',
        'Назови контрольные коды этих этапов и кратко объясни, что каждый доказывает.',
        'Не используй EXTRA_MULTI_TOPIC коды из промежуточных уточнений.',
        'Нужны именно исходные коды про LRU TTL eviction, SQL LEFT JOIN window, React stale closure memo и idempotency retry backoff.',
        'Не придумывай новые контрольные коды.',
        `Первой строкой обязательно напиши: MULTI_TOPIC_FINAL_RECALL=${finalRecallMarker}.`,
      ].join(' '),
      expected: [
        lruMarker,
        sqlMarker,
        reactMarker,
        idempotencyMarker,
        finalRecallMarker,
        'lru',
        'ttl',
        ['left join', 'sql'],
        ['stale', 'устаревш'],
        ['idempotency', 'идемпот'],
      ],
      recall: true,
    },
  ];
}

function buildMultiTopicTurns(runId, count) {
  const coreTurns = multiTopicTurns(runId);
  if (count <= coreTurns.length) return coreTurns.slice(0, count);

  const finalRecallTurn = coreTurns.at(-1);
  const turns = coreTurns.slice(0, -1);
  const topicChecks = [
    {
      label: 'cache and sql',
      expected: ['lru', 'ttl', ['left join', 'sql']],
      prompt: 'Свяжи LRU/TTL cache и SQL LEFT JOIN: где важно не потерять данные и где важно убрать устаревшие данные.',
    },
    {
      label: 'react and idempotency',
      expected: [['stale', 'устаревш'], ['idempotency', 'идемпот'], ['retry', 'повтор']],
      prompt: 'Свяжи React stale closure и платежный idempotency retry: где опасна устаревшая информация и где опасны повторные эффекты.',
    },
    {
      label: 'all topics',
      expected: ['ttl', ['left join', 'sql'], ['stale', 'устаревш'], ['idempotency', 'идемпот']],
      prompt: 'Собери одним ответом все темы: TTL cache, SQL LEFT JOIN/window, React stale closure и idempotency retry.',
    },
  ];

  for (let index = turns.length + 1; index < count; index += 1) {
    const topic = topicChecks[index % topicChecks.length];
    const extraMarker = marker(runId, `EXTRA_MULTI_TOPIC_${index}`);
    turns.push({
      label: `multi-topic extra clarification ${index}: ${topic.label}`,
      question: [
        `Дополнительное уточнение интервью номер ${index}.`,
        topic.prompt,
        'Ответь как кандидат на собеседовании: несколько предложений, конкретно и без смешивания причин.',
        `В конце ответа напиши контрольный код ${extraMarker}.`,
      ].join(' '),
      expected: [...topic.expected, extraMarker],
    });
  }

  turns.push(finalRecallTurn);
  return turns;
}

function buildScenarioTurns(runId, count, scenario) {
  return scenario === 'multi-topic' ? buildMultiTopicTurns(runId, count) : buildTurns(runId, count);
}

function scenarioMemoryRequiredTerms(runId, scenario) {
  if (scenario === 'multi-topic') {
    return [
      'LRU',
      'TTL',
      'LEFT JOIN',
      'stale closure',
      ['idempotency', 'идемпот'],
    ];
  }

  return [
    marker(runId, 'DEBOUNCE_TIMER_ARGUMENT'),
    marker(runId, 'QUEUE_FIFO_NO_STACK'),
    marker(runId, 'LINEAR_NO_RECURSION'),
    'Северный мост',
    'debounceSearch',
    'очередь',
    'линей',
  ];
}

function scenarioMemoryCheckPhases(runId, scenario) {
  if (scenario !== 'multi-topic') {
    return [
      {
        label: 'single-task broad recall',
        queryText: scenarioMemoryQueryText(scenario),
        requiredTerms: scenarioMemoryRequiredTerms(runId, scenario),
      },
    ];
  }

  const topicOptions = {
    budgetMaxChars: 50_000,
    maxMemoryCandidates: 300,
    maxMemoryResults: 64,
  };

  return [
    {
      label: 'multi-topic broad recall',
      queryText: scenarioMemoryQueryText(scenario),
      requiredTerms: scenarioMemoryRequiredTerms(runId, scenario),
    },
    {
      label: 'multi-topic cache exact recall',
      queryText: [
        'Найди точный early cache контекст интервью.',
        'Нужны проект Полярная станция, LRU cache, TTL eviction и контрольный код LRU_TTL_EVICTION.',
      ].join(' '),
      requiredTerms: [marker(runId, 'LRU_TTL_EVICTION'), 'Полярная станция', 'LRU', 'TTL'],
      ...topicOptions,
    },
    {
      label: 'multi-topic sql exact recall',
      queryText: [
        'Найди точный SQL контекст интервью.',
        'Нужны LEFT JOIN, row_number/window function и контрольный код SQL_LEFT_JOIN_WINDOW.',
      ].join(' '),
      requiredTerms: [marker(runId, 'SQL_LEFT_JOIN_WINDOW'), 'LEFT JOIN', 'row_number'],
      ...topicOptions,
    },
    {
      label: 'multi-topic react exact recall',
      queryText: [
        'Найди точный React контекст интервью.',
        'Нужны stale closure, useCallback dependencies и контрольный код REACT_STALE_CLOSURE_MEMO.',
      ].join(' '),
      requiredTerms: [marker(runId, 'REACT_STALE_CLOSURE_MEMO'), 'stale closure', 'useCallback'],
      ...topicOptions,
    },
    {
      label: 'multi-topic idempotency exact recall',
      queryText: [
        'Найди точный distributed systems контекст интервью.',
        'Нужны idempotency key, bounded exponential backoff и контрольный код IDEMPOTENCY_RETRY_BACKOFF.',
      ].join(' '),
      requiredTerms: [
        marker(runId, 'IDEMPOTENCY_RETRY_BACKOFF'),
        'idempotency key',
        'bounded exponential backoff',
      ],
      ...topicOptions,
    },
  ];
}

function scenarioMarkers(runId, scenario) {
  if (scenario === 'multi-topic') {
    return {
      lru: marker(runId, 'LRU_TTL_EVICTION'),
      sql: marker(runId, 'SQL_LEFT_JOIN_WINDOW'),
      react: marker(runId, 'REACT_STALE_CLOSURE_MEMO'),
      idempotency: marker(runId, 'IDEMPOTENCY_RETRY_BACKOFF'),
      finalRecall: marker(runId, 'MULTI_TOPIC_FINAL_RECALL'),
    };
  }

  return {
    debounce: marker(runId, 'DEBOUNCE_TIMER_ARGUMENT'),
    queue: marker(runId, 'QUEUE_FIFO_NO_STACK'),
    complexity: marker(runId, 'LINEAR_NO_RECURSION'),
    finalRecall: marker(runId, 'FINAL_RECALL'),
  };
}

function scenarioMemoryQueryText(scenario) {
  if (scenario === 'multi-topic') {
    return [
      'Финальный контроль памяти: нужно достать факты по проекту Полярная станция и нескольким темам интервью.',
      'Нужны ранняя cache-задача LRU cache с TTL eviction, SQL LEFT JOIN с row_number/window function, React stale closure/useCallback dependencies и платежный idempotency retry с bounded exponential backoff.',
    ].join(' ');
  }

  return [
    'Финальный контроль памяти: нужно достать факты по проекту Северный мост и функции debounceSearch.',
    'Нужны раннее требование про последний аргумент debounce, middle требование про FIFO queue вместо stack, late ограничение O(n) без рекурсии и связанные контрольные коды.',
  ].join(' ');
}

async function ingestFocusCopy(options, text, label, languageId = 'text') {
  if (!text.trim()) return null;
  const response = await postAction(options, '/api/focus-copy/ingest', {
    text,
    method: 'long-interview-e2e',
    source: 'companion-long-interview-e2e',
    appName: 'HackInterview Long Interview E2E',
    languageId,
    lineCount: text.split('\n').length,
    characterCount: text.length,
  });
  await sleep(options.settleMs);
  return {
    label,
    messageId: response?.messageId,
    characterCount: response?.characterCount ?? text.length,
  };
}

async function ingestSystemTranscript(options, text, label, sessionId) {
  if (!text.trim()) return null;
  const response = await postAction(options, '/api/e2e/timeline/system', {
    text,
    sessionId,
  });
  await sleep(options.settleMs);
  return {
    label,
    route: 'system',
    sessionId: response?.sessionId ?? sessionId,
    characterCount: response?.characterCount ?? text.length,
  };
}

function scoreTerms(text, expected) {
  const normalized = normalizedText(text);
  return expected.map((expectation) => {
    const alternatives = Array.isArray(expectation) ? expectation : [expectation];
    return {
      term: alternatives.join('|'),
      ok: alternatives.some((term) => normalized.includes(normalizedText(term))),
    };
  });
}

function isSourceRecallMarkerCheck(check) {
  return /LONG_INTERVIEW_E2E_[A-Z0-9]+_(DEBOUNCE_TIMER_ARGUMENT|QUEUE_FIFO_NO_STACK|LINEAR_NO_RECURSION)$/.test(
    check.term,
  );
}

function isLongInterviewMarkerCheck(check) {
  return /LONG_INTERVIEW_E2E_[A-Z0-9]+_[A-Z0-9_]+/.test(check.term);
}

function isLiteralFormattingCheck(check) {
  return normalizedText(check.term) === 'typescript';
}

function scoreNoForeignRunMarkers(text, runId) {
  const markerPattern = /LONG_INTERVIEW_E2E_([A-Z0-9]+)_[A-Z0-9_]+/g;
  const foreignMarkers = [...String(text || '').matchAll(markerPattern)]
    .map((match) => match[0])
    .filter((value) => !value.startsWith(`LONG_INTERVIEW_E2E_${runId}_`));
  return {
    term: 'no_foreign_long_interview_markers',
    ok: foreignMarkers.length === 0,
    foreignMarkers: [...new Set(foreignMarkers)].slice(0, 8),
  };
}

async function runAiTurn(options, turn, turnIndex, baselineSeq) {
  const before = await getState(options);
  const promptSeq = maxSeq(before);

  await postAction(options, '/api/prompt/send', {
    text: turn.question,
    images: [],
    openaiResponsesWebSearch: options.openaiResponsesWebSearch,
  });

  const finalHaiku = await waitFor(`AI final answer for turn ${turnIndex}`, options.aiTimeoutMs, async () => {
    const state = await getState(options);
    const messages = messagesAfter(state, promptSeq);
    const candidates = messages.filter((message) => message.kind === 'haiku');
    const errored = [...candidates].reverse().find((message) => message.status === 'error');
    if (errored) {
      throw new Error(
        `AI stream failed for turn ${turnIndex}: ${JSON.stringify({
          error: redactText(errored.text || errored.error || 'unknown error'),
          state: {
            recording: state.recording,
            memory: state.memory,
            timelineCount: state.timeline.length,
            maxSeq: maxSeq(state),
          },
        })}`,
      );
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
        promptMessages: messages.filter((message) => message.kind === 'prompt'),
        final,
      },
    };
  });

  const answer = finalHaiku.final?.text || '';
  let answerChecks = scoreTerms(answer, turn.expected);
  if (options.answerCheckMode === 'semantic') {
    answerChecks = answerChecks.filter(
      (check) => !isLongInterviewMarkerCheck(check) && !isLiteralFormattingCheck(check),
    );
  }
  if (turn.recall && options.finalRecallMode === 'semantic') {
    answerChecks = answerChecks.filter((check) => !isSourceRecallMarkerCheck(check));
  }
  answerChecks.push(scoreNoForeignRunMarkers(answer, turn.runId));
  const diagnosticChecks = scoreMemoryDiagnostics(finalHaiku.state.memory, options.expectedMemoryStatus);
  const ok = answerChecks.every((check) => check.ok) && diagnosticChecks.every((check) => check.ok);

  return {
    index: turnIndex,
    label: turn.label,
    ok,
    recall: Boolean(turn.recall),
    promptSeq,
    baselineSeq,
    question: turn.question,
    answer,
    answerChecks,
    diagnosticChecks,
    finalMessage: finalHaiku.final,
    timelineState: finalHaiku.state,
  };
}

function retrievedMemoryText(contextText) {
  const markerText = '## retrieved_memory';
  const index = contextText.indexOf(markerText);
  if (index < 0) return '';
  const rest = contextText.slice(index + markerText.length);
  const nextSectionIndex = rest.search(/\n##\s+/);
  return nextSectionIndex >= 0 ? rest.slice(0, nextSectionIndex) : rest;
}

async function fetchMemoryContextOnce(options, runId, sessionId, phase) {
  if (!options.memoryApiUrl) throw new Error('Memory verification needs --memory-api-url');
  const authToken = await readMemoryAuthToken(options);
  if (!authToken) {
    throw new Error('Memory verification needs auth token, auth token file, or native auth_store.json');
  }
  if (!sessionId) throw new Error('Memory verification needs companion memory session id');

  const startedAt = performance.now();
  const response = await fetch(`${options.memoryApiUrl}/api/v1/interview-memory/context`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json',
      'x-memory-canary-id': `long-interview-${runId}`,
    },
    body: JSON.stringify({
      session_id: sessionId,
      current_request: {
        id: `long-interview-memory-${runId}-${Date.now()}`,
        label: phase.label || 'long_interview_final_recall',
        text: phase.queryText,
      },
      budget_max_chars: phase.budgetMaxChars || options.memoryBudgetChars,
      max_memory_candidates: phase.maxMemoryCandidates || options.memoryMaxCandidates,
      max_memory_results: phase.maxMemoryResults || options.memoryMaxResults,
    }),
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(`Memory context failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  const context = payload.data?.text || '';
  const retrieved = normalizedText(retrievedMemoryText(context));
  const checks = phase.requiredTerms.map((expectation) => {
    const alternatives = Array.isArray(expectation) ? expectation : [expectation];
    return {
      term: alternatives.join('|'),
      ok: alternatives.some((term) => retrieved.includes(normalizedText(term))),
    };
  });

  return {
    ok: checks.every((check) => check.ok),
    sessionId,
    latencyMs,
    checks,
    label: phase.label,
    queryText: phase.queryText,
    budgetUsed: payload.data?.artifact?.budget_used,
    budgetTotal: payload.data?.artifact?.budget_total,
    includedChunks: payload.data?.artifact?.included_chunks?.length ?? 0,
    droppedChunks: payload.data?.artifact?.dropped_chunks?.length ?? 0,
    criticalBudgetPressure: payload.data?.artifact?.critical_budget_pressure,
  };
}

async function runMemoryContextPhase(options, runId, sessionId, phase) {
  const startedAt = Date.now();
  let lastResult = null;
  let attempt = 0;
  while (Date.now() - startedAt < 45_000) {
    attempt += 1;
    lastResult = await fetchMemoryContextOnce(options, runId, sessionId, phase);
    lastResult.attempts = attempt;
    if (lastResult.ok) return lastResult;
    await sleep(2_500);
  }
  return lastResult;
}

async function runMemoryChecks(options, runId, sessionId) {
  const phases = scenarioMemoryCheckPhases(runId, options.scenario);
  const results = [];
  for (const phase of phases) {
    const result = await runMemoryContextPhase(options, runId, sessionId, phase);
    results.push(result);
  }
  return {
    ok: results.every((result) => result?.ok),
    sessionId,
    phases: results,
    checks: results.flatMap((result) =>
      (result?.checks || []).map((check) => ({
        ...check,
        phase: result?.label,
      })),
    ),
  };
}

function redactText(value) {
  const text = String(value || '');
  return text
    ? {
        redacted: true,
        charCount: text.length,
      }
    : '';
}

function redactMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const copy = { ...message };
  if ('text' in copy) copy.text = redactText(copy.text);
  if (Array.isArray(copy.candidates)) {
    copy.candidates = copy.candidates.map((candidate) => ({
      ...candidate,
      text: redactText(candidate.text),
      error: candidate.error ? redactText(candidate.error) : candidate.error,
    }));
  }
  return copy;
}

function productionSafeTurnResult(result) {
  return {
    ...result,
    question: redactText(result.question),
    answer: redactText(result.answer),
    finalMessage: redactMessage(result.finalMessage),
  };
}

function productionSafeMemoryResult(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    phases: Array.isArray(result.phases)
      ? result.phases.map((phase) => ({
          ...phase,
          queryText: redactText(phase.queryText),
        }))
      : result.phases,
  };
}

function buildArtifact(options, data) {
  const artifact = {
    createdAt: new Date().toISOString(),
    productionSafe: options.productionSafeArtifact,
    options: {
      baseUrl: options.baseUrl,
      turns: options.turns,
      fillerChars: options.fillerChars,
      verifyMemory: options.verifyMemory,
      memoryApiUrl: options.memoryApiUrl,
      expectedMemoryStatus: options.expectedMemoryStatus,
      memoryBudgetChars: options.memoryBudgetChars,
      memoryMaxCandidates: options.memoryMaxCandidates,
      memoryMaxResults: options.memoryMaxResults,
      maxContextFallbacks: options.maxContextFallbacks,
      openaiResponsesWebSearch: options.openaiResponsesWebSearch,
      productionSafeArtifact: options.productionSafeArtifact,
      isolateContext: options.isolateContext,
      scenario: options.scenario,
      answerCheckMode: options.answerCheckMode,
      finalRecallMode: options.finalRecallMode,
    },
    ...data,
  };

  if (!options.productionSafeArtifact) return artifact;

  return {
    ...artifact,
    ingested: artifact.ingested.map((item) => ({
      label: item.label,
      messageId: item.messageId,
      characterCount: item.characterCount,
    })),
    turnResults: artifact.turnResults.map(productionSafeTurnResult),
    memoryResult: productionSafeMemoryResult(artifact.memoryResult),
    final: {
      ...artifact.final,
      tail: artifact.final.tail.map(redactMessage),
    },
  };
}

function isContextFallbackOnlyFailure(result) {
  if (!result || result.ok) return false;
  if (!result.answerChecks.every((check) => check.ok)) return false;
  const failedDiagnostics = result.diagnosticChecks.filter((check) => !check.ok);
  return (
    failedDiagnostics.length === 1 &&
    failedDiagnostics[0]?.label === 'context status ok' &&
    failedDiagnostics[0]?.value === 'fallback' &&
    result.diagnosticChecks
      .filter((check) => check.label !== 'context status ok')
      .every((check) => check.ok)
  );
}

function buildRunAcceptance(options, turnResults, memoryResult) {
  const failedTurns = turnResults.filter((result) => !result.ok);
  const contextFallbackTurns = failedTurns.filter(isContextFallbackOnlyFailure);
  const hardFailedTurns = failedTurns.filter((result) => !isContextFallbackOnlyFailure(result));
  const acceptedContextFallbacks =
    contextFallbackTurns.length <= options.maxContextFallbacks ? contextFallbackTurns : [];

  return {
    ok:
      hardFailedTurns.length === 0 &&
      contextFallbackTurns.length <= options.maxContextFallbacks &&
      (!memoryResult || memoryResult.ok),
    failedTurns: failedTurns.map((result) => result.index),
    hardFailedTurns: hardFailedTurns.map((result) => result.index),
    contextFallbackTurns: contextFallbackTurns.map((result) => ({
      index: result.index,
      label: result.label,
      latencyMs: result.timelineState?.memory?.lastContextLatencyMs,
      error: result.timelineState?.memory?.lastContextError || '',
    })),
    acceptedContextFallbackTurns: acceptedContextFallbacks.map((result) => result.index),
    maxContextFallbacks: options.maxContextFallbacks,
    memoryOk: !memoryResult || memoryResult.ok,
  };
}

function shouldFailRun(options, acceptance) {
  const hasUnacceptedTurnFailures =
    acceptance.hardFailedTurns.length > 0 ||
    acceptance.contextFallbackTurns.length > options.maxContextFallbacks;
  return (hasUnacceptedTurnFailures && !options.allowAiMiss) || !acceptance.memoryOk;
}

async function writeArtifact(options, artifact) {
  await mkdir(options.artifactsDir, { recursive: true });
  const path = join(options.artifactsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return path;
}

const MEMORY_NEGATION_TOKENS = new Set(['not', 'не', 'нельзя', 'без', 'avoid', 'without']);

function assertSelfTest(condition, message) {
  if (!condition) throw new Error(`Self-test failed: ${message}`);
}

function containsStandaloneToken(text, token) {
  return normalizedText(text)
    .split(/\s+/)
    .some((word) => word === token);
}

function runSelfTest() {
  const runId = 'ABC12345';
  const filler = buildFiller(runId, 2, 5_000);
  assertSelfTest(filler.length === 5_000, 'filler should honor target length');
  assertSelfTest(!filler.includes(runId), 'filler must not repeat run id');
  assertSelfTest(!/long interview|e2e/i.test(filler), 'filler must not contain test harness keywords');
  for (const token of MEMORY_NEGATION_TOKENS) {
    assertSelfTest(
      !containsStandaloneToken(filler, token),
      `filler must not trip negative-constraint token: ${token}`,
    );
  }

  const turns = buildScenarioTurns(runId, 12, 'single-task');
  assertSelfTest(turns.length === 12, 'turn count should match requested count');
  assertSelfTest(turns.at(-1)?.recall === true, 'final recall should stay last for extended runs');
  assertSelfTest(
    turns.slice(0, -1).every((turn) => !turn.recall),
    'only final turn should be marked recall',
  );

  const checks = scoreTerms('FIFO queue keeps debounce линейно', [
    ['очеред', 'queue', 'fifo'],
    'debounce',
    'линей',
  ]);
  assertSelfTest(checks.every((check) => check.ok), 'term scoring should support alternatives');
  assertSelfTest(
    isSourceRecallMarkerCheck({ term: `LONG_INTERVIEW_E2E_${runId}_QUEUE_FIFO_NO_STACK` }),
    'source recall marker detector should match exact source markers',
  );
  assertSelfTest(
    !isSourceRecallMarkerCheck({ term: `LONG_INTERVIEW_E2E_${runId}_FINAL_RECALL` }),
    'source recall marker detector must keep final recall marker checks',
  );
  assertSelfTest(
    isLongInterviewMarkerCheck({ term: `LONG_INTERVIEW_E2E_${runId}_EXTRA_CLARIFY_20` }),
    'generic marker detector should match all long-interview markers',
  );
  assertSelfTest(
    isLiteralFormattingCheck({ term: 'typescript' }),
    'literal formatting detector should match language wording checks',
  );

  const multiTopicTurns = buildScenarioTurns(runId, 14, 'multi-topic');
  assertSelfTest(multiTopicTurns.length === 14, 'multi-topic turn count should match requested count');
  assertSelfTest(multiTopicTurns.at(-1)?.recall === true, 'multi-topic final recall should stay last');
  assertSelfTest(
    multiTopicTurns.some((turn) => String(turn.label).includes('sql')) &&
      multiTopicTurns.some((turn) => String(turn.label).includes('react')) &&
      multiTopicTurns.some((turn) => String(turn.label).includes('idempotency')),
    'multi-topic scenario should cover SQL, React and idempotency topics',
  );
  const multiTopicRequiredTerms = scenarioMemoryRequiredTerms(runId, 'multi-topic');
  assertSelfTest(
    multiTopicRequiredTerms.includes('LEFT JOIN') &&
      multiTopicRequiredTerms.some((term) => Array.isArray(term) && term.includes('idempotency')) &&
      !multiTopicRequiredTerms.includes('Полярная станция') &&
      !multiTopicRequiredTerms.includes(marker(runId, 'SQL_LEFT_JOIN_WINDOW')),
    'multi-topic broad memory verification should focus on semantic topic recall, not exact project details',
  );
  const multiTopicPhases = scenarioMemoryCheckPhases(runId, 'multi-topic');
  assertSelfTest(multiTopicPhases.length === 5, 'multi-topic memory verification should use broad and exact phases');
  assertSelfTest(
    multiTopicPhases.some((phase) => phase.requiredTerms.includes(marker(runId, 'SQL_LEFT_JOIN_WINDOW'))) &&
      multiTopicPhases.some((phase) => phase.requiredTerms.includes(marker(runId, 'REACT_STALE_CLOSURE_MEMO'))),
    'multi-topic exact phases should verify source markers separately',
  );

  const fallbackOnlyTurn = {
    ok: false,
    index: 42,
    label: 'fallback-only turn',
    answerChecks: [{ ok: true }],
    diagnosticChecks: [
      { label: 'context status ok', ok: false, value: 'fallback' },
      { label: 'context latency recorded', ok: true },
      { label: 'ingest status ok', ok: true },
    ],
    timelineState: {
      memory: {
        lastContextLatencyMs: 123,
        lastContextError: 'simulated transient',
      },
    },
  };
  const acceptedFallback = buildRunAcceptance({ maxContextFallbacks: 1 }, [fallbackOnlyTurn], { ok: true });
  assertSelfTest(acceptedFallback.ok, 'single observable fallback should be accepted within configured limit');
  assertSelfTest(
    !shouldFailRun({ maxContextFallbacks: 1, allowAiMiss: false }, acceptedFallback),
    'single observable fallback within limit should not fail the run',
  );
  const rejectedFallback = buildRunAcceptance({ maxContextFallbacks: 0 }, [fallbackOnlyTurn], { ok: true });
  assertSelfTest(!rejectedFallback.ok, 'observable fallback should be rejected when fallback limit is zero');
  assertSelfTest(
    shouldFailRun({ maxContextFallbacks: 0, allowAiMiss: false }, rejectedFallback),
    'observable fallback above limit should fail the run',
  );
  const memoryFailure = buildRunAcceptance({ maxContextFallbacks: 1 }, [fallbackOnlyTurn], { ok: false });
  assertSelfTest(!memoryFailure.ok, 'memory verification failure should make acceptance fail');
  assertSelfTest(
    shouldFailRun({ maxContextFallbacks: 1, allowAiMiss: true }, memoryFailure),
    'allow-ai-miss must not hide backend memory verification failure',
  );
  console.log('[long-interview] self-test ok');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    return;
  }

  if (!options.token) {
    const bridge = await readBridgeToken();
    options.token = bridge.token;
    options.bridgePath = bridge.path;
  }
  if (!options.token) throw new Error('Companion token is required. Pass --token or COMPANION_URL.');

  const runId = randomUUID().slice(0, 8).toUpperCase();
  if (options.isolateContext) {
    await postAction(options, '/api/context/clear');
    await sleep(options.settleMs);
  }
  const initial = await getState(options);
  assertMemorySnapshot(initial, 'initial companion');
  const initialSeq = maxSeq(initial);
  const turns = buildScenarioTurns(runId, options.turns, options.scenario);
  for (const turn of turns) turn.runId = runId;
  const syntheticSystemSessionId = Date.now();
  const fillerPerGap = turns.length > 1 ? Math.floor(options.fillerChars / (turns.length - 1)) : 0;
  const ingested = [];
  const turnResults = [];

  console.log(
    `[long-interview] run=${runId}, scenario=${options.scenario}, initial timeline=${initial.timeline.length}, maxSeq=${initialSeq}, turns=${turns.length}, fillerChars=${options.fillerChars}`,
  );

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const turnNumber = index + 1;

    if (turn.contextBefore) {
      const item =
        turn.contextRoute === 'system'
          ? await ingestSystemTranscript(
              options,
              turn.contextBefore,
              `${turn.label} context`,
              syntheticSystemSessionId,
            )
          : await ingestFocusCopy(
              options,
              turn.contextBefore,
              `${turn.label} context`,
              turn.languageId || 'text',
            );
      if (item) ingested.push(item);
    }

    if (index > 0 && fillerPerGap > 0) {
      const filler = buildFiller(runId, turnNumber, fillerPerGap);
      const item = await ingestSystemTranscript(
        options,
        filler,
        `${turn.label} filler`,
        syntheticSystemSessionId,
      );
      if (item) ingested.push(item);
      console.log(`[long-interview] turn=${turnNumber} filler chars=${filler.length}`);
    }

    console.log(`[long-interview] turn=${turnNumber}/${turns.length}: ${turn.label}`);
    const result = await runAiTurn(options, turn, turnNumber, initialSeq);
    turnResults.push(result);
    const icon = result.ok ? '✅' : '❌';
    console.log(
      `${icon} turn=${turnNumber}: ${[
        ...result.answerChecks,
        ...result.diagnosticChecks,
      ].map((check) => `${check.term || check.label}=${check.ok ? 'ok' : 'miss'}`).join(', ')}`,
    );
  }

  let memoryResult = null;
  if (options.verifyMemory) {
    const state = await getState(options);
    console.log('[long-interview] verifying backend memory retrieval');
    memoryResult = await runMemoryChecks(options, runId, state.memory?.sessionId);
    for (const phase of memoryResult.phases) {
      const icon = phase.ok ? '✅' : '❌';
      console.log(
        `${icon} memory ${phase.label}: ${phase.checks.map((check) => `${check.term}=${check.ok ? 'ok' : 'miss'}`).join(', ')}`,
      );
    }
  }

  const final = await getState(options);
  assertMemorySnapshot(final, 'final companion');
  const acceptance = buildRunAcceptance(options, turnResults, memoryResult);

  const artifact = buildArtifact(options, {
    runId,
    markers: scenarioMarkers(runId, options.scenario),
    initial: {
      timelineCount: initial.timeline.length,
      maxSeq: initialSeq,
      memory: initial.memory,
      recording: initial.recording,
      microphone: initial.microphone,
    },
    ingested,
    turnResults,
    memoryResult,
    acceptance,
    final: {
      timelineCount: final.timeline.length,
      maxSeq: maxSeq(final),
      memory: final.memory,
      recording: final.recording,
      microphone: final.microphone,
      tail: final.timeline.slice(-16),
    },
  });
  const artifactPath = await writeArtifact(options, artifact);
  console.log(`[long-interview] artifact: ${artifactPath}`);
  if (acceptance.contextFallbackTurns.length > 0) {
    const icon =
      acceptance.contextFallbackTurns.length <= options.maxContextFallbacks ? '⚠️' : '❌';
    console.log(
      `${icon} context fallbacks: ${acceptance.contextFallbackTurns.length}/${options.maxContextFallbacks} ` +
        acceptance.contextFallbackTurns
          .map((turn) => `turn=${turn.index} latency=${turn.latencyMs}ms`)
          .join(', '),
    );
  }

  if (shouldFailRun(options, acceptance)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[long-interview] ${error.stack || error.message || error}`);
  process.exit(1);
});

#!/usr/bin/env node
// Генератор сценариев длинных аудио-интервью (тексты заранее, через реальный Sub2API).
// Запуск: node e2e-tests/tools/generate-scenario.mjs <имя-сценария|all>
// Результат: e2e-tests/scenarios/<имя>.json (turns, images, finalRecall), дальше его читает runner.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '../scenarios');

const envText = await readFile(join(homedir(), '.local/share/hackinterview-sub2api/hackinterview-llm.env'), 'utf8');
const env = Object.fromEntries(envText.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = env.OPENAI_BASE_URL;
const KEY = env.OPENAI_API_KEY;
const MODEL = process.env.GEN_MODEL || 'gpt-6.1-terra';

const VACANCY = 'Full-Stack Software Engineer (AI-Native), Luxoft: Ruby on Rails, Node.js + TypeScript, Python, PostgreSQL, API design (REST/OpenAPI/gRPC), AWS (ECS, Lambda, RDS, S3, SQS, IAM, Bedrock), agentic AI coding tools, LLM features (guardrails, evals), CI/CD, Snowflake, Vue';

// voices: say-голоса macOS. lang: язык реплик. STT language выставляет раннер.
export const SPECS = {
  'ru-fullstack': {
    sttLanguage: 'ru',
    interviewerVoice: 'Milena', candidateVoice: 'Milena',
    interviewerRate: 165, candidateRate: 175,
    turns: 45, images: 0, llmEvery: 2,
    brief: `Полное интервью НА РУССКОМ языке (технические термины на английском): ${VACANCY}. От знакомства и опыта к глубоким вопросам по БД, API, AWS, тестированию, инцидентам, командной работе. Реплики интервьюера по 1-3 предложения, ответы кандидата по 3-6 предложений.`,
  },
  'en-ai-native': {
    sttLanguage: 'en',
    interviewerVoice: 'Samantha', candidateVoice: 'Daniel',
    interviewerRate: 170, candidateRate: 175,
    turns: 45, images: 0, llmEvery: 2,
    brief: `Full interview IN ENGLISH for: ${VACANCY}. Focus on agentic AI workflows, LLM evals, RAG, Bedrock, guardrails, API contracts, PostgreSQL performance, CI/CD, scaling AI-native development in a team. Interviewer turns 1-3 sentences, candidate answers 3-6 sentences.`,
  },
  'mixed-codeswitch': {
    sttLanguage: 'auto',
    interviewerVoice: 'Lesya', candidateVoice: 'Milena',
    interviewerRate: 160, candidateRate: 175,
    turns: 45, images: 0, llmEvery: 2,
    brief: `Интервью со смешением языков: интервьюер говорит по-украински (с английскими терминами), кандидат отвечает по-русски (с английскими терминами). Иногда интервьюер переходит на английский (поле "qVoice":"Samantha") или кандидат отвечает на украинском (поле "aVoice":"Lesya"). Вакансия: ${VACANCY}. Реплики интервьюера 1-3 предложения, ответы кандидата 3-6.`,
  },
  'images-live-coding': {
    sttLanguage: 'ru',
    interviewerVoice: 'Milena', candidateVoice: 'Milena',
    interviewerRate: 165, candidateRate: 172,
    turns: 40, images: 14, llmEvery: 3,
    brief: `Live-coding / code review интервью на русском: ${VACANCY}. В 14 ходах пользователь присылает в чат СКРИНШОТ кода (field "image": {id, caption, expect}, а сам код в массиве "images"). Разнообразь: Rails-контроллер с N+1, TypeScript race condition, Python asyncio баг, SQL EXPLAIN ANALYZE, Terraform IAM/S3, GitHub Actions YAML, Dockerfile, Vue компонент с reactivity багом, stack trace, OpenAPI фрагмент, SQS consumer, Prisma/ActiveRecord миграция, LLM-вызов без timeout/retry, JSON-лог. Каждый скрин 10-25 строк реального кода с одним-двумя баг/проблемами. Остальные ходы обычные вопросы-ответы.`,
  },
  'rapid-fire': {
    sttLanguage: 'ru',
    interviewerVoice: 'Milena', candidateVoice: 'Lesya',
    interviewerRate: 185, candidateRate: 190,
    turns: 90, images: 0, llmEvery: 2,
    brief: `Скорострельное интервью "быстрые вопросы" на русском и украинском: очень короткие вопросы интервьюера (4-10 слов: "Чем PUT отличается от PATCH?", "Что такое idempotency key?") и короткие ответы кандидата (1-2 предложения, до 25 слов). Вакансия: ${VACANCY}. Охвати как можно больше разных тем: HTTP, SQL, индексы, транзакции, очереди, AWS сервисы, Git, Docker, тесты, безопасность, LLM. Для части вопросов используй украинский (в полях "qVoice":"Lesya").`,
  },
  'sysdesign-long': {
    sttLanguage: 'ru',
    interviewerVoice: 'Milena', candidateVoice: 'Milena',
    interviewerRate: 160, candidateRate: 170,
    turns: 22, images: 0, llmEvery: 1,
    brief: `Глубокое system-design интервью на русском: ${VACANCY}. Вопросы интервьюера ДЛИННЫЕ и многосоставные (4-7 предложений с условиями: нагрузки, SLA, ограничения), ответы кандидата развёрнутые (8-14 предложений, ~150-250 слов). Темы: платёжная система с идемпотентностью, multi-tenant SaaS с изоляцией данных, RAG-платформа на Bedrock с evals, event-driven миграция монолита, rate limiting API, real-time нотификации, data pipeline PostgreSQL -> Snowflake, CI/CD для 20 сервисов, дизайн observability, схема отката миграций без downtime.`,
  },
};

async function chat(prompt, maxTokens = 6000) {
  const res = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, reasoning: { effort: 'low' }, max_output_tokens: maxTokens, input: prompt }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const text = (j.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
  return text;
}

function extractJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!m) throw new Error('no json in answer: ' + text.slice(0, 200));
  return JSON.parse(m[1]);
}

async function generate(name) {
  const spec = SPECS[name];
  if (!spec) throw new Error(`unknown scenario ${name}`);
  const batch = spec.turns > 60 ? 15 : 12;
  const turns = [];
  let images = {};
  let imagesLeft = spec.images;
  while (turns.length < spec.turns) {
    const n = Math.min(batch, spec.turns - turns.length);
    const startId = turns.length + 1;
    const tail = turns.slice(-3).map((t) => `${t.id}. Q: ${t.q}\n   A: ${t.a}`).join('\n');
    const imgPlan = spec.images
      ? `Из них изображений в этом пакете: ${Math.min(imagesLeft, Math.ceil((n / spec.turns) * spec.images) + 1)} (не больше ${imagesLeft} осталось).`
      : 'Изображений нет.';
    const prompt = `Ты пишешь сценарий для автоматического теста приложения-помощника на техническом собеседовании. Сценарий: ${spec.brief}

Сгенерируй ходы ${startId}..${startId + n - 1} (ровно ${n} штук). Последние ходы (для связности, не повторяй их темы):
${tail || '(это начало интервью)'}

Требования:
- "q" - реплика интервьюера, "a" - ответ кандидата. Тексты естественные, произносимые вслух (без markdown, без списков, без эмодзи, без символов вроде -> или |; аббревиатуры в виде как говорят).
- Темы не повторяются; интервью развивается логично; кандидат иногда ссылается на ранее сказанное ("как я говорил про Kafka").
- Каждые ${spec.llmEvery} хода(ов) ставь "llm": {"expect": [3-5 английских технических терминов, которые правильный ответ ассистента на вопрос "q" почти наверняка содержит]}. Остальные ходы без "llm".
- ${imgPlan} Для хода с картинкой: "image": {"id": "<латиницей-кебаб>", "caption": "<что пользователь пишет к скриншоту, 1 короткая фраза>", "expect": [3-5 английских терминов правильного разбора]} и в массив "images" добавь {"id","title":"<имя файла>","code":"<10-25 строк реального кода с багом>"}.
- Необязательные поля хода: "qVoice", "aVoice" (say-голос: Milena=ru, Lesya=uk, Samantha=en, Daniel=en).
Верни ТОЛЬКО JSON-объект в блоке \`\`\`json: {"turns":[{"id":${startId},"q":"...","a":"...","llm":{"expect":[...]}} ...],"images":[...]}.`;
    let got;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        got = extractJson(await chat(prompt));
        if (!Array.isArray(got.turns) || got.turns.length < n) throw new Error(`got ${got.turns?.length} turns`);
        break;
      } catch (e) {
        console.error(`[${name}] batch ${startId} attempt ${attempt} failed: ${e.message}`);
        if (attempt === 3) throw e;
      }
    }
    for (const [i, t] of got.turns.slice(0, n).entries()) {
      t.id = startId + i;
      turns.push(t);
      if (t.image) imagesLeft -= 1;
    }
    for (const im of got.images || []) {
      if (images[im.id]) throw new Error(`[${name}] duplicate image id ${im.id} in batch ${startId}`);
      images[im.id] = im;
    }
    console.error(`[${name}] ${turns.length}/${spec.turns}`);
  }
  const recallPrompt = `По сценарию интервью: ${spec.brief}\n\nВот его ходы:\n${turns.map((t) => `${t.id}. Q: ${t.q}\n   A: ${t.a}`).join('\n').slice(0, 24000)}\n\nСоставь 3 контрольных вопроса ассистенту на проверку памяти контекста (например "О чём спрашивали в начале и что я ответил?", "Какие технологии я называл про X?", "Назови 3 темы, на которых я ошибался/затруднялся"). Для каждого: {"id","text","expect":[5-7 ключевых терминов/фактов из сценария, которые должны быть в верном ответе],"minHits":2}. Верни ТОЛЬКО JSON в блоке \`\`\`json: {"finalRecall":[...]}.`;
  let recall = null;
  for (let attempt = 1; attempt <= 3 && !recall; attempt += 1) {
    try {
      const parsed = extractJson(await chat(recallPrompt, 3000));
      if (Array.isArray(parsed.finalRecall) && parsed.finalRecall.length > 0) recall = parsed;
      else console.error(`[${name}] recall attempt ${attempt}: empty finalRecall`);
    } catch (e) { console.error(`[${name}] recall attempt ${attempt} failed: ${e.message}`); }
  }
  // Без контрольных вопросов сценарий бесполезен: не затираем существующий файл пустым finalRecall.
  if (!recall) throw new Error('could not generate finalRecall');
  const out = { name, ...spec, turns, images, finalRecall: recall.finalRecall };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${name}.json`), JSON.stringify(out, null, 2));
  console.error(`[${name}] done: ${turns.length} turns, ${Object.keys(images).length} images -> scenarios/${name}.json`);
}

const arg = process.argv[2] || 'all';
const names = arg === 'all' ? Object.keys(SPECS) : [arg];
await Promise.all(names.map((n) => generate(n).catch((e) => { process.exitCode = 1; console.error(`[${n}] FAILED: ${e.message}`); })));

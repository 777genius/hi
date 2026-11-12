#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const durationMinutes = Number(process.env.ENDURANCE_MINUTES || 30);
const intervalSeconds = Number(process.env.ENDURANCE_INTERVAL_SECONDS || 60);
const aiEvery = Number(process.env.ENDURANCE_AI_EVERY || 5);
const audioDeviceIndex = String(process.env.ENDURANCE_BLACKHOLE_INDEX || '0');
const playbackVolume = String(process.env.ENDURANCE_VOLUME || '3');
const diagnosticDeviceIndex = process.env.ENDURANCE_DIAGNOSTIC_DEVICE_INDEX;
const persistentPlayback = process.env.ENDURANCE_PERSISTENT_PLAYBACK === '1';
const base = 'http://127.0.0.1:43821';
const tokenFile = join(homedir(), 'Library/Application Support/HackInterview/companion_bridge.json');
const token = JSON.parse(await readFile(tokenFile, 'utf8')).companionAccessToken;
const runId = randomUUID().slice(0, 8);
const artifactPath = join(tmpdir(), `hackinterview-endurance-${runId}.json`);
const report = { runId, startedAt: new Date().toISOString(), durationMinutes, intervalSeconds, aiEvery, turns: [], errors: [] };

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function request(path, body) {
  const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-companion-token': token,
      'x-companion-request-id': `endurance-${runId}-${randomUUID()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(payload).slice(0, 200)}`);
  return payload.data ?? payload;
}

async function state() { return request(`/api/state?token=${encodeURIComponent(token)}`); }
function count(items, kind) { return items.filter(item => item.kind === kind && item.status === 'final').length; }

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command}: ${error.slice(-400)}`)));
  });
}

const topics = [
    'Как устроена очередь задач с гарантией доставки сообщений?',
    'Почему таймаут сетевого запроса должен иметь верхнюю границу?',
    'Как обеспечить идемпотентность платежа при повторной попытке?',
    'Когда использовать индекс базы данных для сортировки записей?',
    'Как ограничить параллелизм обработчиков при высокой нагрузке?',
    'Чем отличается кэш с временем жизни от постоянного хранилища?',
    'Как проверить гонку данных между двумя рабочими потоками?',
    'Почему транзакция должна откатываться при ошибке записи?',
    'Как работает отмена асинхронной операции в интерфейсе?',
    'Что делать, если потоковый ответ сервера оборвался посередине?',
    'Как устроен левый джойн в запросе к базе данных?',
    'Почему замыкание в интерфейсе может видеть устаревшие данные?',
    'Как проверять повторную доставку события без дубликатов?',
    'Что такое обратное давление в конвейере обработки?',
    'Как выбрать размер пакета для передачи по сети?',
    'Почему важно сохранять порядок обновлений состояния?',
    'Как восстановить соединение после временного сбоя интернета?',
    'Как разбирать ошибки авторизации без бесконечных повторов?',
    'Как сделать безопасную пагинацию длинной истории сообщений?',
    'Когда лучше применять оптимистичное обновление интерфейса?',
    'Как избежать взаимной блокировки при работе с двумя ресурсами?',
    'Почему метрики задержки лучше среднего времени ответа?',
    'Как тестировать потоковые события при медленном клиенте?',
    'Как устроена политика вытеснения в локальном кэше?',
    'Чем полезна корреляция запросов в распределённых логах?',
    'Как обрабатывать частичный результат после ошибки модели?',
    'Как проверять целостность файлов локальной модели?',
    'Почему важно ограничивать размер очереди фоновых задач?',
    'Как оценивать скорость холодного запуска приложения?',
    'Какие инварианты нужны для длинной беседы с ассистентом?',
];
function questionForTurn(turn) {
  return `Вопрос номер ${turn}. ${topics[(turn - 1) % topics.length]}`;
}

function contentStems(text) {
  const ignored = new Set(['почему', 'когда', 'какие', 'какой', 'как', 'нужно', 'должен', 'чтобы', 'после', 'между', 'через', 'этого']);
  return new Set(text.toLowerCase().replaceAll('ё', 'е').match(/[а-яa-z]{5,}/g)
    ?.filter(word => !ignored.has(word)).map(word => word.slice(0, 5)) || []);
}

function matchesQuestion(turn, text) {
  const expected = contentStems(topics[(turn - 1) % topics.length]);
  const actual = contentStems(text);
  return [...expected].filter(stem => actual.has(stem)).length >= Math.min(3, expected.size);
}

async function playInterviewer(turn, deviceIndex = audioDeviceIndex) {
  const file = join(tmpdir(), `hackinterview-endurance-${runId}-${turn}.aiff`);
  await run('say', ['-v', 'Milena', '-o', file, questionForTurn(turn)]);
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-filter:a', `volume=${playbackVolume}`, '-f', 'audiotoolbox', '-audio_device_index', deviceIndex, '-']);
  } finally {
    await import('node:fs/promises').then(fs => fs.unlink(file).catch(() => {}));
  }
}

async function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let error = '';
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${command}: ${error.slice(-400)}`)));
  });
}

async function buildPersistentAudio(totalTurns) {
  const output = join(tmpdir(), `hackinterview-endurance-${runId}.pcm`);
  const bytesPerTurn = intervalSeconds * 48_000 * 2 * 2;
  const chunks = [];
  for (let turn = 1; turn <= totalTurns; turn += 1) {
    const file = join(tmpdir(), `hackinterview-endurance-${runId}-${turn}.aiff`);
    await run('say', ['-v', 'Milena', '-o', file, questionForTurn(turn)]);
    const speech = await runCapture('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-filter:a', `volume=${playbackVolume}`, '-ar', '48000', '-ac', '2', '-f', 's16le', '-']);
    await unlink(file).catch(() => {});
    if (speech.length >= bytesPerTurn) throw new Error(`Question ${turn} exceeds interval`);
    chunks.push(speech, Buffer.alloc(bytesPerTurn - speech.length));
  }
  await writeFile(output, Buffer.concat(chunks));
  return output;
}

async function waitForAnswer(afterSeq) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const snapshot = await state();
    const answer = snapshot.timeline.find(item => item.seq > afterSeq && item.kind === 'haiku'
      && (item.status === 'final' || item.status === 'error'));
    if (answer) return { status: answer.status, chars: answer.text.length, error: answer.status === 'error' ? answer.text.slice(0, 200) : '' };
    await sleep(500);
  }
  throw new Error('LLM answer did not finish in 120 seconds');
}

const initial = await state();
if (initial.recording.status !== 'Idle' || initial.memory.mode !== 'disabled') {
  throw new Error('Endurance run requires idle recording and isolated memory-disabled app');
}
const baseline = {
  system: count(initial.timeline, 'stt'),
  mic: count(initial.timeline, 'mic'),
  ai: count(initial.timeline, 'haiku'),
};
const totalTurns = Math.max(1, Math.ceil(durationMinutes * 60 / intervalSeconds));
const persistentAudioFile = persistentPlayback ? await buildPersistentAudio(totalTurns) : null;
let player = null;
let started = 0;
let failed = false;
try {
  if (!initial.microphone.appMuted) await request('/api/microphone/app/mute', {});
  await request('/api/record/start', {});
  if (persistentAudioFile) {
    player = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '48000', '-ac', '2',
      '-i', persistentAudioFile, '-f', 'audiotoolbox', '-audio_device_index', audioDeviceIndex, '-'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  started = Date.now();
  for (let turn = 1; turn <= totalTurns; turn += 1) {
    const due = started + (turn - 1) * intervalSeconds * 1000;
    if (Date.now() < due) await sleep(due - Date.now());
    const before = await state();
    if (before.recording.status !== 'Recording') throw new Error(`Recording stopped at turn ${turn}`);
    const beforeSeq = Math.max(0, ...before.timeline.map(item => item.seq));
    if (persistentAudioFile) await sleep(8_000);
    else await playInterviewer(turn);
    await sleep(1_500);
    await request('/api/e2e/timeline/microphone', {
      text: `Мой ответ номер ${turn}: проверяю таймаут, повторную попытку и порядок очереди.`,
      sessionId: before.recording.activeSessionId,
    });
    await sleep(2_000);
    let snapshot = await state();
    let systemAdded = matchesQuestion(turn, snapshot.timeline
      .filter(item => item.seq > beforeSeq && item.kind === 'stt' && item.status === 'final')
      .map(item => item.text).join(' '));
    let diagnostic = null;
    if (!systemAdded && diagnosticDeviceIndex) {
      await playInterviewer(turn, diagnosticDeviceIndex);
      await sleep(2_500);
      snapshot = await state();
      diagnostic = {
        deviceIndex: diagnosticDeviceIndex,
        systemAdded: matchesQuestion(turn, snapshot.timeline
          .filter(item => item.seq > beforeSeq && item.kind === 'stt' && item.status === 'final')
          .map(item => item.text).join(' ')),
      };
      systemAdded = diagnostic.systemAdded;
    }
    const micAdded = snapshot.timeline.some(item => item.seq > beforeSeq && item.kind === 'mic' && item.status === 'final');
    let ai = null;
    if (turn % aiEvery === 0 || turn === totalTurns) {
      const promptSeq = Math.max(0, ...snapshot.timeline.map(item => item.seq));
      await request('/api/prompt/send', {
        text: turn === totalTurns && totalTurns >= 30
          ? 'Назови темы самого первого и самого последнего вопросов собеседника в этом интервью. Ответь одним предложением.'
          : 'Кратко ответь на последний вопрос собеседника с учётом моего ответа.',
        images: [], openaiResponsesWebSearch: false,
      });
      ai = await waitForAnswer(promptSeq);
      snapshot = await state();
      if (turn === totalTurns && totalTurns >= 30 && ai.status === 'final') {
        const answer = snapshot.timeline.find(item => item.seq > promptSeq && item.kind === 'haiku' && item.status === 'final');
        ai.firstAndLastRecall = /очеред|доставк/i.test(answer?.text || '')
          && /инвариант|длинн.*бесед/i.test(answer?.text || '');
        ai.answer = (answer?.text || '').slice(0, 500);
      }
    }
    const record = {
      turn, elapsedSeconds: Math.round((Date.now() - started) / 1000), systemAdded, micAdded, ai, diagnostic,
      counts: { system: count(snapshot.timeline, 'stt') - baseline.system,
        mic: count(snapshot.timeline, 'mic') - baseline.mic,
        ai: count(snapshot.timeline, 'haiku') - baseline.ai },
      recording: snapshot.recording.status,
    };
    report.turns.push(record);
    record.observedCounts = {
      system: report.turns.filter(item => item.systemAdded).length,
      mic: report.turns.filter(item => item.micAdded).length,
      ai: report.turns.filter(item => item.ai?.status === 'final').length,
    };
    if (!systemAdded || !micAdded || ai?.status === 'error' || ai?.firstAndLastRecall === false) report.errors.push(record);
    await writeFile(artifactPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(record));
  }
} catch (error) {
  failed = true;
  report.errors.push({ fatal: String(error) });
} finally {
  if (player) player.kill('SIGTERM');
  await request('/api/record/stop', {}).catch(() => {});
  if (!initial.microphone.appMuted) await request('/api/microphone/app/unmute', {}).catch(() => {});
  if (persistentAudioFile) await unlink(persistentAudioFile).catch(() => {});
  report.finishedAt = new Date().toISOString();
  await writeFile(artifactPath, JSON.stringify(report, null, 2));
  console.log(`artifact=${artifactPath}`);
}
if (failed || report.errors.length) process.exitCode = 1;

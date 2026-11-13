#!/usr/bin/env node
// Длинный e2e-эксперимент: интервью на украинском (с английскими терминами) целиком через звук.
//  - интервьюер (say, голос Lesya) звучит в системный вывод -> ScreenCaptureKit (system audio);
//  - кандидат звучит в BlackHole 2ch, который на время прогона выбран как вход macOS -> микрофон;
//  - после части вопросов просим LLM ответить (реальные запросы к Sub2API через приложение);
//  - несколько раз прикрепляем картинку с кодом как сообщение пользователя;
//  - в конце проверяем, помнит ли LLM контекст всей беседы.
// Тексты и ожидания лежат в fixtures/ua-interview-script.mjs, заранее.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { CODE_IMAGES as DEFAULT_IMAGES, FINAL_RECALL_PROMPTS as DEFAULT_RECALL, TURNS as DEFAULT_TURNS } from './fixtures/ua-interview-script.mjs';

// Активный сценарий: по умолчанию встроенный украинский, либо JSON из e2e-tests/scenarios (флаг --scenario).
let TURNS = DEFAULT_TURNS;
let CODE_IMAGES = DEFAULT_IMAGES;
let FINAL_RECALL_PROMPTS = DEFAULT_RECALL;
let SCENARIO = { name: 'ua-backend', interviewerVoice: 'Lesya', candidateVoice: 'Lesya', interviewerRate: 160, candidateRate: 172 };
import { coverage } from './helpers/sttMatch.mjs';

const BRIDGE_FILE = join(homedir(), 'Library/Application Support/HackInterview/companion_bridge.json');

function parseArgs(argv) {
  const o = {
    baseUrl: process.env.COMPANION_BASE_URL || 'http://127.0.0.1:43821',
    durationMin: 40,
    turns: TURNS.length,
    voice: 'Lesya',
    interviewerRate: 160,
    candidateRate: 172,
    systemGain: 1.0,
    micGain: 2.0,
    blackhole: 'BlackHole 2ch',
    aiTimeoutMs: 180_000,
    sttMatchThreshold: 0.5,
    artifactsDir: '.e2e-artifacts/ua-interview-audio',
    skipImages: false,
    keepInput: false,
    scenario: '',
    judge: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--') continue;
    else if (a === '--duration-min') o.durationMin = Number(next());
    else if (a === '--turns') o.turns = Number(next());
    else if (a === '--voice') o.voice = next();
    else if (a === '--mic-gain') o.micGain = Number(next());
    else if (a === '--system-gain') o.systemGain = Number(next());
    else if (a === '--blackhole') o.blackhole = next();
    else if (a === '--artifacts-dir') o.artifactsDir = next();
    else if (a === '--skip-images') o.skipImages = true;
    else if (a === '--keep-input') o.keepInput = true;
    else if (a === '--scenario') o.scenario = next();
    else if (a === '--no-judge') o.judge = false;
    else if (a === '--base-url') o.baseUrl = next();
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(`[ua-interview ${new Date().toISOString().slice(11, 19)}]`, ...m);

function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    const out = [];
    let err = '';
    if (capture) child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(capture ? Buffer.concat(out).toString('utf8') : '') : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`)),
    );
  });
}

function runSync(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' };
}

// ---------- companion api ----------
let TOKEN = '';
let BASE = '';
async function api(path, body) {
  const init = body === undefined
    ? {}
    : {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-companion-token': TOKEN,
          'x-companion-request-id': `ua-${randomUUID()}`,
        },
        body: JSON.stringify(body),
      };
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(payload).slice(0, 300)}`);
  return payload.data ?? payload;
}
const getState = () => api(`/api/state?token=${encodeURIComponent(TOKEN)}`);
const maxSeq = (s) => Math.max(0, ...(s.timeline || []).map((m) => m.seq || 0));

// ---------- text matching (устойчиво к ru/uk различиям STT) ----------
function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll('і', 'и')
    .replaceAll('ї', 'и')
    .replaceAll('є', 'е')
    .replaceAll('ґ', 'г')
    .replaceAll('’', '')
    .replaceAll("'", '')
    .replace(/[^a-zа-я0-9+ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function stem(word) {
  return word.length > 5 ? word.slice(0, 5) : word;
}
function keyHit(haystack, key) {
  const words = norm(key).split(' ').filter(Boolean);
  if (words.length === 0) return false;
  return words.every((w) => haystack.includes(stem(w)));
}
function keyScore(text, keys) {
  const h = norm(text);
  const hits = keys.filter((k) => keyHit(h, k));
  return { score: keys.length ? hits.length / keys.length : 1, hits, missed: keys.filter((k) => !hits.includes(k)) };
}

// ---------- audio ----------
async function prepareAudio(dir, turns, o) {
  await mkdir(dir, { recursive: true });
  const files = [];
  for (const t of turns) {
    const qA = join(dir, `q${t.id}.aiff`);
    const aA = join(dir, `a${t.id}.aiff`);
    const qW = join(dir, `q${t.id}.wav`);
    const aW = join(dir, `a${t.id}.wav`);
    const aP = join(dir, `a${t.id}.pcm`);
    const qVoice = t.qVoice || SCENARIO.interviewerVoice || o.voice;
    const aVoice = t.aVoice || SCENARIO.candidateVoice || o.voice;
    await run('say', ['-v', qVoice, '-r', String(SCENARIO.interviewerRate || o.interviewerRate), '-o', qA, '--', t.q]);
    await run('say', ['-v', aVoice, '-r', String(SCENARIO.candidateRate || o.candidateRate), '-o', aA, '--', t.a]);
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', qA, '-filter:a', `volume=${o.systemGain}`, '-ar', '48000', '-ac', '2', qW]);
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', aA, '-filter:a', `volume=${o.micGain}`, '-ar', '48000', '-ac', '2', aW]);
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', aA, '-filter:a', `volume=${o.micGain}`, '-f', 's16le', '-ar', '48000', '-ac', '2', aP]);
    const dq = Number(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', qW], { capture: true }));
    const da = Number(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', aW], { capture: true }));
    files.push({ id: t.id, qWav: qW, aWav: aW, aPcm: aP, qSec: dq, aSec: da });
  }
  return files;
}

function audioToolboxIndex(label) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-f', 'lavfi', '-i', 'anullsrc', '-t', '0.01', '-f', 'audiotoolbox', '-list_devices', 'true', '-'], { encoding: 'utf8' });
  const devices = `${r.stdout}\n${r.stderr}`
    .split('\n')
    .map((l) => l.match(/\[AudioToolbox[^\]]*\]\s+\[(\d+)\]\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ index: Number(m[1]), label: m[2].trim() }));
  const hit = devices.find((d) => d.label.toLowerCase().includes(label.toLowerCase()));
  if (!hit) throw new Error(`AudioToolbox output "${label}" not found. Devices: ${JSON.stringify(devices)}`);
  return hit.index;
}

const playSystem = (wav) => run('afplay', [wav]);
// Кандидат звучит из процесса приложения (ScreenCaptureKit свой процесс исключает), поэтому реплика
// попадает только в микрофонный канал (BlackHole -> вход macOS) и не дублируется в системном.
const playMic = (pcmPath, device) => api('/api/e2e/play-audio', { path: pcmPath, device });

// ---------- images ----------
async function renderCodeImages(dir) {
  await mkdir(dir, { recursive: true });
  const py = `
import json, sys
from PIL import Image, ImageDraw, ImageFont
spec = json.load(sys.stdin)
font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 22)
bold = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 20, index=1)
for name, item in spec["images"].items():
    lines = item["code"].split("\\n")
    w = max(900, int(max(font.getlength(l) for l in lines)) + 80)
    h = 70 + len(lines) * 32 + 30
    img = Image.new("RGB", (w, h), (30, 30, 30))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, 44], fill=(45, 45, 48))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([16 + i * 26, 14, 30 + i * 26, 28], fill=c)
    d.text((110, 11), item["title"], fill=(200, 200, 200), font=bold)
    y = 62
    for l in lines:
        color = (212, 212, 212)
        s = l.strip()
        if s.startswith("#") or s.startswith("//") or s.startswith("--"): color = (106, 153, 85)
        elif s.startswith(("def ", "class ", "export ", "async ", "SELECT", "EXPLAIN", "WHERE", "ORDER", "LIMIT")): color = (86, 156, 214)
        d.text((24, y), l, fill=color, font=font)
        y += 32
    img.save(sys.argv[1] + "/" + name + ".png")
print("ok")
`;
  await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', '-c', py, dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`image render failed: ${err}`))));
    child.stdin.end(JSON.stringify({ images: CODE_IMAGES }));
  });
}

// ---------- waiting helpers ----------
async function waitForSystemFinal(afterSeq, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await getState();
    const item = (s.timeline || []).find((m) => m.seq > afterSeq && m.kind === 'stt' && m.status === 'final' && String(m.text || '').trim());
    if (item) return item;
    await sleep(700);
  }
  return null;
}

async function waitForAnswer(afterSeq, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const s = await getState();
    const answers = (s.timeline || []).filter((m) => m.seq > afterSeq && m.kind === 'haiku');
    last = answers[answers.length - 1] || last;
    const done = answers.find((m) => m.status === 'final' || m.status === 'error');
    if (done) return { item: done, latencyMs: Date.now() - start };
    await sleep(700);
  }
  return { item: last, latencyMs: Date.now() - start, timedOut: true };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.scenario) {
    SCENARIO = JSON.parse(await readFile(o.scenario, 'utf8'));
    TURNS = SCENARIO.turns;
    CODE_IMAGES = Object.fromEntries(Object.entries(SCENARIO.images || {}).map(([id, im]) => [id, { title: im.title || id, code: im.code || '' }]));
    FINAL_RECALL_PROMPTS = (SCENARIO.finalRecall || []).map((r) => ({ minHits: 2, ...r }));
    if (o.artifactsDir === '.e2e-artifacts/ua-interview-audio') o.artifactsDir = `.e2e-artifacts/${SCENARIO.name}`;
  }
  o.turns = Math.max(1, Math.min(TURNS.length, Math.floor(o.turns > 0 ? Math.min(o.turns, TURNS.length) : TURNS.length)));
  BASE = o.baseUrl.replace(/\/+$/, '');
  TOKEN = process.env.COMPANION_TOKEN || JSON.parse(await readFile(BRIDGE_FILE, 'utf8')).companionAccessToken;
  const health = await api('/api/health');
  const initial = await getState();
  log('health', JSON.stringify(health).slice(0, 80), 'recording', initial.recording?.status, 'memory', initial.memory?.mode);
  if (initial.recording?.status !== 'Idle') throw new Error('App must be idle before the experiment');
  // История теперь сохраняется на диск: чистить её у живого приложения нельзя. Только в тест-режиме (play-audio отвечает 404 вне него).
  const testMode = await fetch(`${BASE}/api/e2e/play-audio`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-companion-token': TOKEN }, body: '{}' }).then((r) => r.status !== 404).catch(() => false);
  if (!testMode && process.env.E2E_ALLOW_HISTORY_CLEAR !== '1') {
    throw new Error('Приложение запущено не в тест-режиме (INTERVIEW_TEST_MODE=1): e2e стёр бы реальную историю. Задай E2E_ALLOW_HISTORY_CLEAR=1, если это осознанно.');
  }
  await api('/api/history/clear', {}).catch((e) => log('history clear skipped:', e.message));
  await api('/api/context/clear', {}).catch((e) => log('context clear skipped:', e.message));

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(o.artifactsDir, runId);
  await mkdir(outDir, { recursive: true });
  const audioDir = join(tmpdir(), `ua-interview-${runId}`);

  const turns = TURNS.slice(0, o.turns);
  log(`preparing audio for ${turns.length} turns...`);
  const audio = await prepareAudio(audioDir, turns, o);
  const imagesDir = join(audioDir, 'images');
  await renderCodeImages(imagesDir);
  const totalAudioSec = audio.reduce((s, f) => s + f.qSec + f.aSec, 0);
  const budgetSec = o.durationMin * 60;
  const perTurnFixed = 4.5; // think pause + STT settle
  const gapSec = Math.max(3, (budgetSec - totalAudioSec - perTurnFixed * turns.length - 120) / turns.length);
  log(`audio ${(totalAudioSec / 60).toFixed(1)} min total, gap between turns ${gapSec.toFixed(1)}s, target ${o.durationMin} min`);

  // routing: macOS input -> BlackHole
  const previousInput = runSync('SwitchAudioSource', ['-c', '-t', 'input']).stdout;
  log(`input "${previousInput}" -> "${o.blackhole}", candidate audio played from the app process`);
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    if (!o.keepInput && previousInput) await run('SwitchAudioSource', ['-t', 'input', '-s', previousInput]).catch(() => {});
    log(`input restored to "${previousInput}"`);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await api('/api/record/stop', {}).catch(() => {});
      await restore();
      process.exit(130);
    });
  }

  const report = {
    runId,
    startedAt: new Date().toISOString(),
    options: o,
    audioMinutes: totalAudioSec / 60,
    turns: [],
    finalRecall: [],
    errors: [],
  };

  const startedMs = Date.now();
  try {
    await run('SwitchAudioSource', ['-t', 'input', '-s', o.blackhole]);
    await sleep(800);
    if (initial.microphone?.appMuted) await api('/api/microphone/app/unmute', {});
    await api('/api/record/start', {});
    for (let i = 0; i < 30; i += 1) {
      const s = await getState();
      if (s.recording?.status === 'Recording') break;
      await sleep(1000);
    }
    const started = await getState();
    log('recording', started.recording?.status, 'mic', JSON.stringify(started.microphone));
    // прогрев STT: играем короткую реплику, пока не придёт первый финал в системном канале
    {
      const warmWav = join(audioDir, 'warmup.wav');
      await run('say', ['-v', SCENARIO.interviewerVoice || o.voice, '-o', join(audioDir, 'warmup.aiff'), '--', SCENARIO.sttLanguage === 'en' ? 'Hello. Let us start the interview, can you hear me well?' : 'Добрий день. Починаємо співбесіду, чуєте мене добре?']);
      await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', join(audioDir, 'warmup.aiff'), '-ar', '48000', '-ac', '2', warmWav]);
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const s = await getState();
        const base = maxSeq(s);
        await playSystem(warmWav);
        const heard = await waitForSystemFinal(base, 25_000);
        log(`warm-up attempt ${attempt}: ${heard ? 'heard' : 'no transcript yet'}`);
        if (heard) break;
      }
      await sleep(3000);
    }

    for (let idx = 0; idx < turns.length; idx += 1) {
      const t = turns[idx];
      const f = audio[idx];
      const turnStart = Date.now();
      const before = await getState();
      if (before.recording?.status !== 'Recording') throw new Error(`Recording stopped before turn ${t.id}: ${before.recording?.status}`);
      const baseSeq = maxSeq(before);
      const rec = { id: t.id, baseSeq, q: t.q, a: t.a, aiRequested: false };

      // 1) интервьюер говорит в системный звук
      log(`turn ${t.id}/${turns.length}: interviewer (${f.qSec.toFixed(1)}s)`);
      await playSystem(f.qWav);
      const heardQ = await waitForSystemFinal(baseSeq, 20_000);
      rec.questionHeardAfterMs = heardQ ? Date.now() - turnStart : null;

      // 2) LLM-ответ на вопрос (пока кандидат "думает/отвечает")
      let aiPromise = null;
      let aiBaseSeq = null;
      const sendAi = async () => {
        const s = await getState();
        aiBaseSeq = maxSeq(s);
        rec.aiRequested = true;
        if (t.image && !o.skipImages) {
          const png = await readFile(join(imagesDir, `${t.image.id}.png`));
          await api('/api/prompt/send', {
            text: t.image.caption,
            images: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }],
          });
          rec.aiKind = 'image-prompt';
        } else if (t.llm) {
          await api('/api/ai/request', {});
          rec.aiKind = 'implicit-ai-request';
        } else {
          rec.aiRequested = false;
          return null;
        }
        const expect = t.image && !o.skipImages ? t.image.expect : t.llm.expect;
        const answer = await waitForAnswer(aiBaseSeq, o.aiTimeoutMs);
        const text = answer.item?.text || '';
        const sc = keyScore(text, expect);
        // Ключи на латинице, а ответ русский с вкраплениями терминов: достаточно одного совпадения, смысл оценивается по транскриптам.
        const need = 1;
        return {
          status: answer.item?.status || 'none',
          timedOut: Boolean(answer.timedOut),
          latencyMs: answer.latencyMs,
          chars: text.length,
          expect,
          hits: sc.hits,
          ok: answer.item?.status === 'final' && sc.hits.length >= need && text.length > 60,
          meta: answerMeta(text),
          text,
        };
      };
      if (t.llm || (t.image && !o.skipImages)) aiPromise = sendAi().catch((e) => ({ status: 'exception', ok: false, error: String(e.message || e), text: '' }));

      await sleep(1800);

      // 3) кандидат отвечает в микрофон (BlackHole)
      log(`turn ${t.id}: candidate (${f.aSec.toFixed(1)}s)${rec.aiRequested || aiPromise ? ' + LLM' : ''}`);
      await playMic(f.aPcm, o.blackhole);
      await sleep(4500);
      if (aiPromise) {
        rec.ai = await aiPromise;
        log(`turn ${t.id}: LLM ${rec.ai.ok ? 'OK' : 'CHECK'} status=${rec.ai.status} ${Math.round((rec.ai.latencyMs || 0) / 1000)}s hits=${(rec.ai.hits || []).length}/${(rec.ai.expect || []).length}`);
      }

      const after = await getState();
      const window = (after.timeline || []).filter((m) => m.seq > baseSeq && m.status === 'final');
      const sys = window.filter((m) => m.kind === 'stt').map((m) => m.text).join(' ');
      const mic = window.filter((m) => m.kind === 'mic').map((m) => m.text).join(' ');
      rec.systemText = sys;
      rec.micText = mic;
      rec.systemQ = { score: coverage(t.q, sys) }; // насколько распознан вопрос интервьюера в системном канале
      rec.micA = { score: coverage(t.a, mic) }; // насколько распознан ответ кандидата в микрофонном канале
      rec.leakA_in_system = coverage(t.a, sys); // голос кандидата в системном канале (SCK ловит и вывод в BlackHole)
      rec.leakQ_in_mic = coverage(t.q, mic);
      rec.systemOk = rec.systemQ.score >= o.sttMatchThreshold;
      rec.micOk = rec.micA.score >= o.sttMatchThreshold;
      rec.elapsedSec = (Date.now() - turnStart) / 1000;
      report.turns.push(rec);
      await writeFile(join(outDir, 'report.partial.json'), JSON.stringify(report, null, 2));
      log(`turn ${t.id}: system ${rec.systemQ.score.toFixed(2)} mic ${rec.micA.score.toFixed(2)} leakA->sys ${rec.leakA_in_system.toFixed(2)}`);

      // 4) пауза до следующего вопроса, чтобы уложиться в бюджет времени
      const targetEnd = startedMs + ((idx + 1) / turns.length) * (budgetSec - 150) * 1000 + 8000;
      const wait = Math.max(gapSec * 1000 * 0.5, targetEnd - Date.now());
      if (idx < turns.length - 1) await sleep(Math.min(wait, gapSec * 1000 * 2.5));
    }

    // финальные проверки памяти контекста
    for (const p of FINAL_RECALL_PROMPTS) {
      log(`final recall: ${p.id}`);
      const s = await getState();
      const base = maxSeq(s);
      await api('/api/prompt/send', { text: p.text });
      const answer = await waitForAnswer(base, o.aiTimeoutMs);
      const text = answer.item?.text || '';
      const sc = keyScore(text, p.expect);
      report.finalRecall.push({
        id: p.id,
        prompt: p.text,
        status: answer.item?.status || 'none',
        latencyMs: answer.latencyMs,
        hits: sc.hits,
        missed: sc.missed,
        ok: answer.item?.status === 'final' && sc.hits.length >= p.minHits,
        meta: answerMeta(text),
        text,
      });
    }
  } catch (error) {
    report.errors.push(String(error.stack || error));
    log('ERROR', error.message || error);
  } finally {
    await api('/api/record/stop', {}).catch((e) => report.errors.push(`stop: ${e.message}`));
    await restore();
  }

  if (o.judge) {
    log('judging assistant answers...');
    report.judge = await judgeAnswers(report, turns).catch((e) => [{ error: String(e) }]);
    const ok = report.judge.filter((j) => !j.error);
    const mean = (k) => avg(ok.map((j) => Number(j[k] ?? 0)));
    report.judgeSummary = {
      judged: ok.length,
      correct: mean('correct'), context: mean('context'), concise: mean('concise'),
      noQuestionsPct: ok.length ? Number((ok.filter((j) => j.noQuestions).length / ok.length).toFixed(3)) : 0,
      russianPct: ok.length ? Number((ok.filter((j) => j.russian).length / ok.length).toFixed(3)) : 0,
      firstPersonPct: ok.length ? Number((ok.filter((j) => j.firstPerson).length / ok.length).toFixed(3)) : 0,
      issues: ok.filter((j) => j.issue).map((j) => `#${j.id}: ${j.issue}`).slice(0, 25),
    };
    log('JUDGE', JSON.stringify(report.judgeSummary));
  }
  const finalState = await getState().catch(() => null);
  report.finishedAt = new Date().toISOString();
  report.wallMinutes = (Date.now() - startedMs) / 60000;
  report.memory = finalState?.memory;
  const ts = report.turns;
  const aiTurns = ts.filter((t) => t.aiRequested);
  report.summary = {
    turnsRun: ts.length,
    systemOk: ts.filter((t) => t.systemOk).length,
    micOk: ts.filter((t) => t.micOk).length,
    avgSystemScore: avg(ts.map((t) => t.systemQ?.score ?? 0)),
    avgMicScore: avg(ts.map((t) => t.micA?.score ?? 0)),
    avgLeakCandidateIntoSystem: avg(ts.map((t) => t.leakA_in_system ?? 0)),
    aiTurns: aiTurns.length,
    aiOk: aiTurns.filter((t) => t.ai?.ok).length,
    aiErrors: aiTurns.filter((t) => t.ai?.status !== 'final').length,
    avgAiLatencySec: avg(aiTurns.map((t) => (t.ai?.latencyMs || 0) / 1000)),
    answersUk: [...aiTurns.map((t) => t.ai?.meta), ...report.finalRecall.map((r) => r.meta)].filter((m) => m?.lang === 'uk').length,
    answersRu: [...aiTurns.map((t) => t.ai?.meta), ...report.finalRecall.map((r) => r.meta)].filter((m) => m?.lang === 'ru').length,
    answersWithQuestion: [...aiTurns.map((t) => t.ai?.meta), ...report.finalRecall.map((r) => r.meta)].filter((m) => m?.hasQuestion).length,
    avgAnswerWords: avg([...aiTurns.map((t) => t.ai?.meta?.words || 0), ...report.finalRecall.map((r) => r.meta?.words || 0)]),
    finalRecallOk: report.finalRecall.filter((r) => r.ok).length,
    finalRecallTotal: report.finalRecall.length,
    errors: report.errors.length,
  };
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, 'report.md'), renderMarkdown(report));
  log('SUMMARY', JSON.stringify(report.summary));
  log('report:', join(outDir, 'report.md'));
  process.exit(report.errors.length ? 1 : 0);
}


// ---------- LLM-судья качества ответов ассистента (после прогона, последовательно) ----------
async function readLlmEnv() {
  const text = await readFile(join(homedir(), '.local/share/hackinterview-sub2api/hackinterview-llm.env'), 'utf8');
  return Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

async function judgeAnswers(report, turns) {
  const env = await readLlmEnv();
  const results = [];
  // Профиль кандидата (если есть) считается подтверждённым источником фактов об опыте; HTML-комментарии как в приложении вырезаем.
  const profile = await readFile(process.env.INTERVIEW_PROFILE_FILE || join(homedir(), 'Library/Application Support/HackInterview/candidate_profile.md'), 'utf8')
    .then((t) => t.replace(/<!--[\s\S]*?-->/g, '').slice(0, 30_000)).catch(() => '');
  const items = report.turns.filter((t) => t.ai?.text).map((t) => ({ kind: 'turn', id: t.id, q: t.q, a: t.a, text: t.ai.text, hasImage: t.aiKind === 'image-prompt' }));
  for (const [index, item] of items.entries()) {
    const prev = turns.filter((x) => x.id < item.id).slice(-3).map((x) => `Интервьюер: ${x.q}\nКандидат: ${x.a}`).join('\n');
    const prompt = `Ты строгий проверяющий ответов ассистента для технического собеседования. Ассистент отвечает кандидату вслух-готовым текстом. Требования: ответ по-русски (термины на английском), чётко и по делу без воды, НЕ задаёт вопросов и не просит уточнений, говорит от первого лица в мужском роде, длина соответствует сложности вопроса, понимает контекст предыдущих реплик.

${profile ? `Профиль кандидата (подтверждённые факты об его опыте; ответ может на них опираться, это не выдумка):\n${profile}\n\n` : ''}Контекст:
${prev || '(начало)'}
Вопрос интервьюера: ${item.q}
${item.hasImage ? '(пользователь прислал скриншот кода, ассистент разбирает его)' : ''}
Ответ ассистента:
${item.text}

Оцени и верни ТОЛЬКО JSON: {"correct":0-2,"context":0-2,"concise":0-2,"noQuestions":true/false,"russian":true/false,"firstPerson":true/false,"issue":"одна фраза о главной проблеме или пустая строка"}. 2 = хорошо. Выдумкой считай только факты, которых нет ни в профиле, ни в репликах интервью.`;
    try {
      const res = await fetch(`${env.OPENAI_BASE_URL}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.OPENAI_RESPONSES_MODEL, reasoning: { effort: 'low' }, max_output_tokens: 600, input: prompt }),
        signal: AbortSignal.timeout(120_000),
      });
      const j = await res.json();
      const out = (j.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      const m = out.match(/\{[\s\S]*\}/);
      results.push({ id: item.id, ...JSON.parse(m[0]) });
    } catch (e) {
      results.push({ id: item.id, error: String(e.message || e) });
    }
    if (index % 10 === 9) log(`judge ${index + 1}/${items.length}`);
  }
  return results;
}

function answerMeta(text) {
  const t = String(text || '');
  const uk = (t.match(/[іїєґ]/gi) || []).length;
  const ru = (t.match(/[ыэъё]/gi) || []).length;
  const lang = uk > ru ? 'uk' : ru > uk ? 'ru' : /[а-яіїєґ]/i.test(t) ? 'cyr-unknown' : 'en';
  // вопросительный знак вне блоков кода и inline-кода
  const prose = t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  return { lang, hasQuestion: prose.includes('?'), words: (prose.match(/\S+/g) || []).length };
}

const avg = (xs) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : 0);

function renderMarkdown(r) {
  const L = [];
  L.push(`# UA interview audio e2e ${r.runId}`);
  L.push('');
  L.push(`Wall time: ${r.wallMinutes.toFixed(1)} min, audio ${r.audioMinutes.toFixed(1)} min`);
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(r.summary, null, 2));
  L.push('```');
  L.push('');
  L.push('| # | system STT | mic STT | leak cand->sys | LLM | lat s |');
  L.push('|---|---|---|---|---|---|');
  for (const t of r.turns) {
    const ai = t.ai ? `${t.ai.ok ? 'OK' : 'CHECK'} ${t.ai.status} ${t.ai.hits?.length ?? 0}/${t.ai.expect?.length ?? 0}` : '-';
    L.push(`| ${t.id} | ${t.systemQ?.score.toFixed(2)} | ${t.micA?.score.toFixed(2)} | ${t.leakA_in_system?.toFixed(2)} | ${ai} | ${t.ai ? Math.round((t.ai.latencyMs || 0) / 1000) : ''} |`);
  }
  L.push('');
  for (const t of r.turns) {
    L.push(`## Turn ${t.id}`);
    L.push(`- Q: ${t.q}`);
    L.push(`- system STT: ${t.systemText}`);
    L.push(`- A: ${t.a}`);
    L.push(`- mic STT: ${t.micText}`);
    if (t.ai) L.push(`- LLM (${t.aiKind}, ${t.ai.status}): ${String(t.ai.text).slice(0, 700)}`);
    L.push('');
  }
  if (r.judgeSummary) {
    L.push('## LLM judge');
    L.push('```json\n' + JSON.stringify(r.judgeSummary, null, 2) + '\n```');
  }
  L.push('## Final recall');
  for (const f of r.finalRecall) {
    L.push(`- **${f.id}** ${f.ok ? 'OK' : 'CHECK'} hits=${f.hits.join(', ')} missed=${f.missed.join(', ')}`);
    L.push(`  ${String(f.text).slice(0, 900)}`);
  }
  if (r.errors.length) {
    L.push('');
    L.push('## Errors');
    for (const e of r.errors) L.push('```\n' + e + '\n```');
  }
  return L.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

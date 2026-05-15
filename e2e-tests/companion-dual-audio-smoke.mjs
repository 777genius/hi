#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import process from 'node:process';

const DEFAULT_AUDIO = [
  '/Users/belief/Documents/2026-05-14 23.56.41.ogg',
  '/Users/belief/Documents/2026-05-14 23.57.41.ogg',
  '/Users/belief/Documents/2026-05-14 23.57.56.ogg',
];

const KNOWN_EXPECTED_WORDS = [
  'погода',
  'благодарю',
  'супер',
  'улыбаются',
  'прекрасно',
  'говорю',
  'слышишь',
];

const SYSTEM_MESSAGE_KINDS = new Set(['system', 'stt']);
const MIC_MESSAGE_KINDS = new Set(['mic', 'microphone']);

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.COMPANION_BASE_URL || process.env.COMPANION_URL || 'http://127.0.0.1:43821',
    token: process.env.COMPANION_TOKEN || '',
    audio: [],
    systemRuns: 1,
    micRuns: 1,
    gainDb: Number(process.env.COMPANION_AUDIO_GAIN_DB || 20),
    volume: Number(process.env.COMPANION_AUDIO_VOLUME || 3),
    startTimeoutMs: 20_000,
    transcriptionTimeoutMs: 65_000,
    settleMs: 4_000,
    artifactsDir: '.e2e-artifacts/companion-dual-audio',
    allowMicMiss: false,
    restoreMic: true,
    skipSystem: false,
    skipMic: false,
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
    else if (arg === '--audio') options.audio.push(next());
    else if (arg === '--system-runs') options.systemRuns = Number(next());
    else if (arg === '--mic-runs') options.micRuns = Number(next());
    else if (arg === '--gain-db') options.gainDb = Number(next());
    else if (arg === '--volume') options.volume = Number(next());
    else if (arg === '--start-timeout-ms') options.startTimeoutMs = Number(next());
    else if (arg === '--transcription-timeout-ms') options.transcriptionTimeoutMs = Number(next());
    else if (arg === '--settle-ms') options.settleMs = Number(next());
    else if (arg === '--artifacts-dir') options.artifactsDir = next();
    else if (arg === '--allow-mic-miss') options.allowMicMiss = true;
    else if (arg === '--no-restore-mic') options.restoreMic = false;
    else if (arg === '--skip-system') options.skipSystem = true;
    else if (arg === '--skip-mic') options.skipMic = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.audio.length === 0) options.audio = DEFAULT_AUDIO;
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!options.token) options.token = extractTokenFromUrl(process.env.COMPANION_URL || options.baseUrl) || '';
  return options;
}

function printHelp() {
  console.log(`Companion dual-audio smoke test

Usage:
  pnpm e2e:companion-audio -- --base-url http://127.0.0.1:43821 --token <token>

Defaults:
  - Reads token from COMPANION_TOKEN, COMPANION_URL, or the local companion bridge file.
  - Uses the three saved interview voice fixtures from ~/Documents.
  - Does not clear companion history. It validates only messages created after test start.

Useful flags:
  --audio <path>                 Add an audio fixture. Can be repeated.
  --skip-system                  Skip OS/system-audio phase.
  --skip-mic                     Skip microphone phase.
  --allow-mic-miss               Keep exit code 0 when microphone speech is not detected.
  --no-restore-mic               Do not restore app microphone mute state after the run.
  --system-runs <n>              Repeat system phase playback count.
  --mic-runs <n>                 Repeat microphone phase playback count.
  --gain-db <n>                  ffmpeg gain before afplay, default 20.
  --volume <n>                   afplay volume, default 3.
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

async function fileExists(path) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function prepareAudioFixtures(paths, gainDb) {
  const hasFfmpeg = commandExists('ffmpeg');
  const prepared = [];

  for (const source of paths) {
    if (!(await fileExists(source))) {
      throw new Error(`Audio fixture does not exist: ${source}`);
    }

    const extension = extname(source).toLowerCase();
    const afplayFriendly = ['.wav', '.aiff', '.aif', '.m4a', '.mp3', '.caf'].includes(extension);
    if (!hasFfmpeg && !afplayFriendly) {
      throw new Error(`ffmpeg is required to convert ${source} before afplay can use it`);
    }

    if (!hasFfmpeg) {
      prepared.push(source);
      continue;
    }

    const safeName = basename(source).replace(/[^a-zA-Z0-9._-]+/g, '_');
    const target = join(tmpdir(), `hackinterview-companion-audio-${safeName}-${gainDb}db.wav`);
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-af',
      `volume=${gainDb}dB`,
      '-ar',
      '48000',
      '-ac',
      '1',
      target,
    ]);
    prepared.push(target);
  }

  return prepared;
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
      'x-companion-request-id': `dual-audio-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue?.value)}`);
}

function maxSeq(snapshot) {
  return Math.max(0, ...snapshot.timeline.map((message) => Number(message.seq) || 0));
}

function messagesAfter(snapshot, baselineSeq) {
  return snapshot.timeline.filter((message) => Number(message.seq) > baselineSeq);
}

function phaseTexts(messages) {
  const systemMessages = messages.filter((message) => SYSTEM_MESSAGE_KINDS.has(message.kind));
  const micMessages = messages.filter((message) => MIC_MESSAGE_KINDS.has(message.kind));
  return {
    systemMessages,
    micMessages,
    systemText: systemMessages.map((message) => message.text).join(' '),
    micText: micMessages.map((message) => message.text).join(' '),
  };
}

function normalizedText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function meaningfulSpeech(text, expectedWords) {
  const normalized = normalizedText(text);
  const words = normalized.match(/[a-zа-яё0-9]+/gi) || [];
  const expectedHits = expectedWords.filter((word) => normalized.includes(word)).length;
  return {
    ok: words.length >= 3 && normalized.length >= 12,
    words: words.length,
    expectedHits,
    text: normalized,
  };
}

async function playAudioFiles(files, runs, volume) {
  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    for (const file of files) {
      await run('afplay', ['-v', String(volume), file]);
      await sleep(700);
    }
  }
}

async function runRecordingPhase(options, phase, config) {
  const before = await getState(options);
  const baselineSeq = maxSeq(before);

  if (config.appMicMuted !== undefined) {
    await postAction(options, config.appMicMuted ? '/api/microphone/app/mute' : '/api/microphone/app/unmute');
    await sleep(500);
  }

  await postAction(options, '/api/record/start');
  await waitFor(`${phase} recording start`, options.startTimeoutMs, async () => {
    const state = await getState(options);
    return {
      ok: state.recording?.status === 'Recording',
      value: {
        status: state.recording?.status,
        activeSessionId: state.recording?.activeSessionId,
        microphone: state.microphone,
      },
    };
  });

  await playAudioFiles(config.audioFiles, config.runs, options.volume);

  const during = await waitFor(`${phase} transcription`, options.transcriptionTimeoutMs, async () => {
    const state = await getState(options);
    const messages = messagesAfter(state, baselineSeq);
    const { systemMessages, micMessages, systemText, micText } = phaseTexts(messages);
    const targetText = phase === 'mic' ? micText : systemText;
    const score = meaningfulSpeech(targetText, KNOWN_EXPECTED_WORDS);
    return {
      ok: score.ok,
      value: {
        status: state.recording?.status,
        messageCount: messages.length,
        systemCount: systemMessages.length,
        micCount: micMessages.length,
        systemText,
        micText,
        live: state.live,
        score,
      },
    };
  }).catch((error) => ({ error }));

  await sleep(options.settleMs);
  await postAction(options, '/api/record/stop').catch(() => {});
  await waitFor(`${phase} recording stop`, options.startTimeoutMs, async () => {
    const state = await getState(options);
    return {
      ok: state.recording?.status === 'Idle' && Number(state.recording?.activeSessionId || 0) === 0,
      value: {
        status: state.recording?.status,
        activeSessionId: state.recording?.activeSessionId,
      },
    };
  });

  const after = await getState(options);
  const messages = messagesAfter(after, baselineSeq);
  const { systemMessages, micMessages, systemText, micText } = phaseTexts(messages);
  const targetText = phase === 'mic' ? micText : systemText;
  const score = meaningfulSpeech(targetText, KNOWN_EXPECTED_WORDS);

  return {
    phase,
    ok: score.ok,
    timedOut: Boolean(during?.error),
    error: during?.error ? String(during.error.message || during.error) : '',
    baselineSeq,
    finalSeq: maxSeq(after),
    messageCount: messages.length,
    systemCount: systemMessages.length,
    micCount: micMessages.length,
    systemText: normalizedText(systemText).slice(0, 800),
    micText: normalizedText(micText).slice(0, 800),
    sampleMessages: messages.slice(0, 12).map((message) => ({
      seq: message.seq,
      id: message.id,
      kind: message.kind,
      role: message.role,
      status: message.status,
      text: normalizedText(message.text).slice(0, 160),
      sessionId: message.sessionId,
    })),
    score,
    recordingAfterStop: after.recording,
    microphoneAfterStop: after.microphone,
  };
}

function detectAudioRouting() {
  const profiler = spawnSync('system_profiler', ['SPAudioDataType'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const output = profiler.stdout || '';
  const loopbackHints = ['blackhole', 'loopback', 'soundflower', 'vb-cable', 'aggregate'];
  const hasLoopbackInput = loopbackHints.some((hint) => output.toLowerCase().includes(hint));
  return {
    hasLoopbackInput,
    hasAfplay: commandExists('afplay'),
    hasFfmpeg: commandExists('ffmpeg'),
    audioDevicesExcerpt: output
      .split('\n')
      .filter((line) => /Default Input Device|Default Output Device|Input Source|Output Source|BlackHole|Loopback|Soundflower|VB-Cable|Микрофон|Динамики|наушники/i.test(line))
      .join('\n')
      .trim(),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.token) {
    const bridge = await readBridgeToken();
    options.token = bridge.token;
    options.bridgeTokenPath = bridge.path;
  }
  if (!options.token) {
    throw new Error('Companion token not found. Pass --token or set COMPANION_TOKEN/COMPANION_URL.');
  }

  const routing = detectAudioRouting();
  if (!routing.hasAfplay) throw new Error('afplay is required on macOS for this smoke test.');

  const audioFiles = await prepareAudioFixtures(options.audio, options.gainDb);
  const health = await companionFetch(options, '/api/health');
  const initialState = await getState(options);

  const results = [];
  if (!options.skipSystem) {
    console.log('[companion-audio] system phase: app mic muted, playing OS audio fixtures');
    results.push(
      await runRecordingPhase(options, 'system', {
        audioFiles,
        runs: options.systemRuns,
        appMicMuted: true,
      }),
    );
  }

  if (!options.skipMic) {
    console.log('[companion-audio] mic phase: app mic unmuted, playing fixtures for acoustic/loopback mic capture');
    results.push(
      await runRecordingPhase(options, 'mic', {
        audioFiles,
        runs: options.micRuns,
        appMicMuted: false,
      }),
    );
  }

  let finalState = await getState(options);
  if (options.restoreMic && typeof initialState.microphone?.appMuted === 'boolean') {
    const restorePath = initialState.microphone.appMuted
      ? '/api/microphone/app/mute'
      : '/api/microphone/app/unmute';
    await postAction(options, restorePath).catch((error) => {
      console.warn(`[companion-audio] failed to restore app mic state: ${error.message || error}`);
    });
    finalState = await getState(options);
  }

  const artifact = {
    createdAt: new Date().toISOString(),
    options: {
      baseUrl: options.baseUrl,
      audio: options.audio,
      preparedAudio: audioFiles,
      systemRuns: options.systemRuns,
      micRuns: options.micRuns,
      gainDb: options.gainDb,
      volume: options.volume,
      allowMicMiss: options.allowMicMiss,
      restoreMic: options.restoreMic,
      skipSystem: options.skipSystem,
      skipMic: options.skipMic,
    },
    health,
    routing,
    initial: {
      recording: initialState.recording,
      microphone: initialState.microphone,
      timelineCount: initialState.timeline?.length || 0,
      maxSeq: maxSeq(initialState),
    },
    results,
    final: {
      recording: finalState.recording,
      microphone: finalState.microphone,
      timelineCount: finalState.timeline?.length || 0,
      maxSeq: maxSeq(finalState),
    },
  };

  await mkdir(options.artifactsDir, { recursive: true });
  const artifactPath = join(options.artifactsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

  for (const result of results) {
    const icon = result.ok ? '✅' : '❌';
    console.log(
      `${icon} ${result.phase}: messages=${result.messageCount}, system=${result.systemCount}, mic=${result.micCount}, activeAfterStop=${result.recordingAfterStop?.activeSessionId}`,
    );
    if (!result.ok) {
      console.log(`   reason=${result.error || 'target speech was not detected in expected channel'}`);
      if (result.phase === 'mic' && !routing.hasLoopbackInput) {
        console.log('   note=no virtual loopback input detected; mic phase depends on the real microphone hearing playback');
      }
    }
  }
  console.log(`[companion-audio] artifact: ${artifactPath}`);

  const failing = results.filter((result) => {
    if (result.ok) return false;
    return !(result.phase === 'mic' && options.allowMicMiss);
  });
  if (failing.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`[companion-audio] ${error.stack || error.message || error}`);
  process.exit(1);
});

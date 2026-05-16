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

const DEFAULT_SYNTHETIC_SEGMENTS = [
  {
    label: 'queue',
    text: 'Вопрос интервью номер один. Проект Северный мост. Почему для событий нужна очередь, а не стек?',
    expected: ['вопрос', 'интервью', 'север', 'мост', 'очеред', 'стек'],
  },
  {
    label: 'debounce',
    text: 'Вопрос интервью номер два. Объясни debounce search. Почему нужно отменять прошлый таймер?',
    expected: ['вопрос', 'debounce', 'search', 'таймер', 'отмен'],
  },
  {
    label: 'complexity',
    text: 'Вопрос интервью номер три. Какая сложность нужна для линейной обработки списка?',
    expected: ['вопрос', 'сложност', 'линей', 'обработк', 'спис'],
  },
];

const SYSTEM_MESSAGE_KINDS = new Set(['system', 'stt']);
const MIC_MESSAGE_KINDS = new Set(['mic', 'microphone']);

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.COMPANION_BASE_URL || process.env.COMPANION_URL || 'http://127.0.0.1:43821',
    token: process.env.COMPANION_TOKEN || '',
    audio: [],
    synthetic: true,
    voice: process.env.COMPANION_SYNTH_VOICE || 'Milena',
    cycles: Number(process.env.COMPANION_AUDIO_CYCLES || 1),
    systemRuns: 1,
    micRuns: 1,
    gainDb: Number(process.env.COMPANION_AUDIO_GAIN_DB || 20),
    volume: Number(process.env.COMPANION_AUDIO_VOLUME || 3),
    minExpectedHits: Number(process.env.COMPANION_AUDIO_MIN_EXPECTED_HITS || 2),
    micRoute: process.env.COMPANION_MIC_ROUTE || 'auto',
    blackholeDevice: process.env.COMPANION_BLACKHOLE_DEVICE || 'BlackHole 2ch',
    startTimeoutMs: 20_000,
    transcriptionTimeoutMs: 65_000,
    settleMs: 4_000,
    artifactsDir: '.e2e-artifacts/companion-dual-audio',
    allowMicMiss: false,
    requireMic: false,
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
    else if (arg === '--audio') {
      options.audio.push(next());
      options.synthetic = false;
    }
    else if (arg === '--synthetic') options.synthetic = true;
    else if (arg === '--real-fixtures') {
      options.synthetic = false;
      if (options.audio.length === 0) options.audio = [...DEFAULT_AUDIO];
    }
    else if (arg === '--voice') options.voice = next();
    else if (arg === '--cycles') options.cycles = Number(next());
    else if (arg === '--system-runs') options.systemRuns = Number(next());
    else if (arg === '--mic-runs') options.micRuns = Number(next());
    else if (arg === '--mic-route') options.micRoute = next();
    else if (arg === '--blackhole-device') options.blackholeDevice = next();
    else if (arg === '--gain-db') options.gainDb = Number(next());
    else if (arg === '--volume') options.volume = Number(next());
    else if (arg === '--min-expected-hits') options.minExpectedHits = Number(next());
    else if (arg === '--start-timeout-ms') options.startTimeoutMs = Number(next());
    else if (arg === '--transcription-timeout-ms') options.transcriptionTimeoutMs = Number(next());
    else if (arg === '--settle-ms') options.settleMs = Number(next());
    else if (arg === '--artifacts-dir') options.artifactsDir = next();
    else if (arg === '--allow-mic-miss') options.allowMicMiss = true;
    else if (arg === '--require-mic') options.requireMic = true;
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

  if (!options.synthetic && options.audio.length === 0) options.audio = DEFAULT_AUDIO;
  options.cycles = Math.max(1, Math.floor(options.cycles || 1));
  options.minExpectedHits = Math.max(0, Math.floor(options.minExpectedHits || 0));
  if (!['auto', 'acoustic', 'blackhole'].includes(options.micRoute)) {
    throw new Error(`Unsupported --mic-route value: ${options.micRoute}`);
  }
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
  - Generates deterministic Russian interview audio with macOS say.
  - Does not clear companion history. It validates only messages created after test start.

Useful flags:
  --audio <path>                 Add an audio fixture. Can be repeated.
  --synthetic                    Use generated interview audio, default.
  --real-fixtures                Use the three saved voice fixtures from ~/Documents.
  --voice <name>                 macOS say voice for synthetic audio, default Milena.
  --min-expected-hits <n>        Required expected-term hits, default 2 for synthetic.
  --skip-system                  Skip OS/system-audio phase.
  --skip-mic                     Skip microphone phase.
  --mic-route <mode>             Mic injection route: auto, acoustic, blackhole. Default auto.
  --blackhole-device <name>      BlackHole input/output device name. Default "BlackHole 2ch".
  --allow-mic-miss               Keep exit code 0 when microphone speech is not detected.
  --require-mic                  Fail mic misses even when no virtual loopback input is detected.
  --no-restore-mic               Do not restore app microphone mute state after the run.
  --cycles <n>                   Repeat full system/mic phase set, default 1.
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

function runSync(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
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

async function generateSyntheticAudioFixtures(options) {
  if (!commandExists('say')) {
    throw new Error('macOS say is required for synthetic companion audio. Use --real-fixtures to use saved files.');
  }

  const generated = [];
  for (const segment of DEFAULT_SYNTHETIC_SEGMENTS) {
    const target = join(
      tmpdir(),
      `hackinterview-companion-synth-${segment.label}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.aiff`,
    );
    await run('say', ['-v', options.voice, '-o', target, segment.text]);
    generated.push(target);
  }
  return generated;
}

function expectedWordsForOptions(options) {
  if (!options.synthetic) {
    return [
      'погода',
      'благодарю',
      'супер',
      'улыбаются',
      'прекрасно',
      'говорю',
      'слышишь',
    ];
  }

  return [...new Set(DEFAULT_SYNTHETIC_SEGMENTS.flatMap((segment) => segment.expected))];
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

function meaningfulSpeech(text, expectedWords, minExpectedHits) {
  const normalized = normalizedText(text);
  const words = normalized.match(/[a-zа-яё0-9]+/gi) || [];
  const expectedHits = expectedWords.filter((word) => normalized.includes(word)).length;
  return {
    ok: words.length >= 3 && normalized.length >= 12 && expectedHits >= minExpectedHits,
    words: words.length,
    expectedHits,
    minExpectedHits,
    text: normalized,
  };
}

async function playAudioFileToAudioToolboxDevice(file, volume, deviceIndex) {
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file,
    '-filter:a',
    `volume=${volume}`,
    '-f',
    'audiotoolbox',
    '-audio_device_index',
    String(deviceIndex),
    '-',
  ]);
}

async function playAudioFiles(files, runs, volume, playback = {}) {
  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    for (const file of files) {
      if (typeof playback.audioToolboxDeviceIndex === 'number') {
        await playAudioFileToAudioToolboxDevice(file, volume, playback.audioToolboxDeviceIndex);
      } else {
        await run('afplay', ['-v', String(volume), file]);
      }
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

  await playAudioFiles(config.audioFiles, config.runs, options.volume, config.playback);

  const during = await waitFor(`${phase} transcription`, options.transcriptionTimeoutMs, async () => {
    const state = await getState(options);
    const messages = messagesAfter(state, baselineSeq);
    const { systemMessages, micMessages, systemText, micText } = phaseTexts(messages);
    const targetText = phase === 'mic' ? micText : systemText;
    const score = meaningfulSpeech(targetText, config.expectedWords, config.minExpectedHits);
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
  const score = meaningfulSpeech(targetText, config.expectedWords, config.minExpectedHits);

  return {
    phase,
    cycle: config.cycle,
    route: config.route || 'acoustic',
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

function switchAudioDevices(type) {
  if (!commandExists('SwitchAudioSource')) return [];
  const result = runSync('SwitchAudioSource', ['-a', '-t', type]);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function currentSwitchAudioDevice(type) {
  if (!commandExists('SwitchAudioSource')) return '';
  const result = runSync('SwitchAudioSource', ['-c', '-t', type]);
  return result.ok ? result.stdout.trim() : '';
}

function findBlackHoleDevice(devices, preferredName) {
  const normalizedPreferred = preferredName.trim().toLowerCase();
  return (
    devices.find((device) => device.toLowerCase() === normalizedPreferred) ||
    devices.find((device) => /^blackhole\s+\d+ch$/i.test(device)) ||
    devices.find((device) => device.toLowerCase().includes('blackhole')) ||
    ''
  );
}

function audioToolboxOutputDevices() {
  if (!commandExists('ffmpeg')) return [];
  const result = runSync('ffmpeg', [
    '-hide_banner',
    '-f',
    'lavfi',
    '-i',
    'anullsrc',
    '-t',
    '0.01',
    '-f',
    'audiotoolbox',
    '-list_devices',
    'true',
    '-',
  ]);
  const combined = `${result.stdout}\n${result.stderr}`;
  return combined
    .split('\n')
    .map((line) => {
      const match = line.match(/\[AudioToolbox[^\]]*\]\s+\[(\d+)\]\s+(.+)$/);
      if (!match) return null;
      return {
        index: Number(match[1]),
        label: match[2].trim(),
      };
    })
    .filter(Boolean);
}

function findAudioToolboxBlackHoleDevice(devices, preferredName) {
  const normalizedPreferred = preferredName.trim().toLowerCase();
  return (
    devices.find((device) => device.label.toLowerCase().includes(normalizedPreferred)) ||
    devices.find((device) => /blackhole\s+\d+ch/i.test(device.label)) ||
    devices.find((device) => device.label.toLowerCase().includes('blackhole')) ||
    null
  );
}

function detectAudioRouting(options) {
  const profiler = spawnSync('system_profiler', ['SPAudioDataType'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const output = profiler.stdout || '';
  const loopbackHints = ['blackhole', 'loopback', 'soundflower', 'vb-cable', 'aggregate'];
  const hasLoopbackInput = loopbackHints.some((hint) => output.toLowerCase().includes(hint));
  const switchAudioSourceAvailable = commandExists('SwitchAudioSource');
  const inputDevices = switchAudioDevices('input');
  const outputDevices = switchAudioDevices('output');
  const blackholeInput = findBlackHoleDevice(inputDevices, options.blackholeDevice);
  const blackholeOutput = findBlackHoleDevice(outputDevices, options.blackholeDevice);
  const audioToolboxOutputs = audioToolboxOutputDevices();
  const audioToolboxBlackHoleOutput = findAudioToolboxBlackHoleDevice(
    audioToolboxOutputs,
    options.blackholeDevice,
  );
  const blackholeAvailable = Boolean(blackholeInput && blackholeOutput && audioToolboxBlackHoleOutput);
  let selectedMicRoute = options.micRoute;
  if (selectedMicRoute === 'auto') selectedMicRoute = blackholeAvailable ? 'blackhole' : 'acoustic';
  if (selectedMicRoute === 'blackhole' && !blackholeAvailable) {
    throw new Error(
      [
        `BlackHole route requested, but matching input/output devices were not found for "${options.blackholeDevice}".`,
        'Install prerequisites with: brew install switchaudio-osx blackhole-2ch',
        'The route also requires ffmpeg with the AudioToolbox output device so test audio can be sent to BlackHole without changing your normal output.',
        'After installing BlackHole, macOS may require allowing/restarting audio services before the device appears.',
      ].join('\n'),
    );
  }
  return {
    hasLoopbackInput,
    hasAfplay: commandExists('afplay'),
    hasFfmpeg: commandExists('ffmpeg'),
    switchAudioSourceAvailable,
    selectedMicRoute,
    blackhole: {
      available: blackholeAvailable,
      requestedDevice: options.blackholeDevice,
      inputDevice: blackholeInput,
      outputDevice: blackholeOutput,
      audioToolboxOutput: audioToolboxBlackHoleOutput,
      currentInput: currentSwitchAudioDevice('input'),
      currentOutput: currentSwitchAudioDevice('output'),
    },
    audioToolboxOutputs,
    inputDevices,
    outputDevices,
    audioDevicesExcerpt: output
      .split('\n')
      .filter((line) => /Default Input Device|Default Output Device|Input Source|Output Source|BlackHole|Loopback|Soundflower|VB-Cable|Микрофон|Динамики|наушники/i.test(line))
      .join('\n')
      .trim(),
  };
}

async function activateBlackHoleMicRoute(route) {
  const previousInput = route.blackhole.currentInput;

  await run('SwitchAudioSource', ['-t', 'input', '-s', route.blackhole.inputDevice]);
  await sleep(800);

  return async () => {
    const errors = [];
    if (previousInput) {
      await run('SwitchAudioSource', ['-t', 'input', '-s', previousInput]).catch((error) => {
        errors.push(`input: ${error.message || error}`);
      });
    }
    await sleep(500);
    if (errors.length > 0) throw new Error(errors.join('; '));
  };
}

async function runWithOptionalMicRoute(routing, phase, task) {
  if (phase !== 'mic' || routing.selectedMicRoute !== 'blackhole') {
    return task();
  }

  console.log(
    `[companion-audio] routing macOS input through ${routing.blackhole.inputDevice}; test playback goes directly to AudioToolbox device #${routing.blackhole.audioToolboxOutput.index}, normal output is not changed`,
  );
  const restore = await activateBlackHoleMicRoute(routing);
  try {
    return await task();
  } finally {
    await restore().catch((error) => {
      console.warn(`[companion-audio] failed to restore macOS audio devices: ${error.message || error}`);
    });
  }
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

  const routing = detectAudioRouting(options);
  if (!routing.hasAfplay) throw new Error('afplay is required on macOS for this smoke test.');

  const sourceAudio = options.synthetic ? await generateSyntheticAudioFixtures(options) : options.audio;
  const audioFiles = await prepareAudioFixtures(sourceAudio, options.gainDb);
  const expectedWords = expectedWordsForOptions(options);
  const minExpectedHits = options.synthetic ? options.minExpectedHits : 0;
  const health = await companionFetch(options, '/api/health');
  const initialState = await getState(options);

  const results = [];
  for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
    if (!options.skipSystem) {
      console.log(
        `[companion-audio] cycle ${cycle}/${options.cycles}: system phase, app mic muted, playing ${options.synthetic ? 'synthetic interview audio' : 'OS audio fixtures'}`,
      );
      results.push(
        await runRecordingPhase(options, 'system', {
          audioFiles,
          runs: options.systemRuns,
          appMicMuted: true,
          cycle,
          route: 'system',
          expectedWords,
          minExpectedHits,
        }),
      );
    }

    if (!options.skipMic) {
      console.log(
        `[companion-audio] cycle ${cycle}/${options.cycles}: mic phase, app mic unmuted, route=${routing.selectedMicRoute}, playing ${options.synthetic ? 'synthetic interview audio' : 'fixtures'}`,
      );
      results.push(
        await runWithOptionalMicRoute(routing, 'mic', () =>
          runRecordingPhase(options, 'mic', {
            audioFiles,
            runs: options.micRuns,
            appMicMuted: false,
            cycle,
            route: routing.selectedMicRoute,
            playback:
              routing.selectedMicRoute === 'blackhole'
                ? { audioToolboxDeviceIndex: routing.blackhole.audioToolboxOutput.index }
                : undefined,
            expectedWords,
            minExpectedHits,
          }),
        ),
      );
    }
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
      synthetic: options.synthetic,
      voice: options.voice,
      sourceAudio,
      audio: options.audio,
      preparedAudio: audioFiles,
      expectedWords,
      minExpectedHits,
      syntheticSegments: options.synthetic ? DEFAULT_SYNTHETIC_SEGMENTS : [],
      cycles: options.cycles,
      systemRuns: options.systemRuns,
      micRuns: options.micRuns,
      micRoute: options.micRoute,
      selectedMicRoute: routing.selectedMicRoute,
      blackholeDevice: options.blackholeDevice,
      gainDb: options.gainDb,
      volume: options.volume,
      allowMicMiss: options.allowMicMiss,
      requireMic: options.requireMic,
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
      `${icon} cycle=${result.cycle} ${result.phase} route=${result.route}: messages=${result.messageCount}, system=${result.systemCount}, mic=${result.micCount}, activeAfterStop=${result.recordingAfterStop?.activeSessionId}`,
    );
    if (!result.ok) {
      console.log(`   reason=${result.error || 'target speech was not detected in expected channel'}`);
      if (result.phase === 'mic' && result.route !== 'blackhole' && !routing.hasLoopbackInput) {
        console.log(
          `   note=no virtual loopback input detected; mic phase depends on the real microphone hearing playback${options.requireMic ? '' : '; not counted as fatal by default'}`,
        );
      }
    }
  }
  console.log(`[companion-audio] artifact: ${artifactPath}`);

  const failing = results.filter((result) => {
    if (result.ok) return false;
    const micEnvironmentCannotInjectAudio =
      result.phase === 'mic' &&
      result.route !== 'blackhole' &&
      !options.requireMic &&
      !routing.hasLoopbackInput;
    return !(result.phase === 'mic' && (options.allowMicMiss || micEnvironmentCannotInjectAudio));
  });
  if (failing.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`[companion-audio] ${error.stack || error.message || error}`);
  process.exit(1);
});

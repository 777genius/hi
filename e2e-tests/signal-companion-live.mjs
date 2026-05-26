import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const DEFAULT_COMPANION_BASE_URL = 'http://127.0.0.1:43821';
const DEFAULT_PRIMARY_SIGNAL_API_URL = 'http://localhost:8081';
const DEFAULT_PEER_SIGNAL_API_URL = 'http://localhost:8082';

function parseArgs(argv) {
  const options = {
    companionBaseUrl: process.env.COMPANION_BASE_URL || process.env.COMPANION_URL || DEFAULT_COMPANION_BASE_URL,
    companionToken: process.env.COMPANION_TOKEN || '',
    primaryApiUrl: process.env.SIGNAL_E2E_PRIMARY_API_URL || process.env.SIGNAL_API_BASE_URL || DEFAULT_PRIMARY_SIGNAL_API_URL,
    peerApiUrl: process.env.SIGNAL_E2E_PEER_API_URL || DEFAULT_PEER_SIGNAL_API_URL,
    primaryNumber: process.env.SIGNAL_E2E_PRIMARY || process.env.SIGNAL_ACCOUNT_NUMBER || '',
    peerNumber: process.env.SIGNAL_E2E_PEER || '',
    timeoutMs: Number(process.env.SIGNAL_E2E_TIMEOUT_MS || 45_000),
    skipMemory: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === '--companion-url' || arg === '--companion-base-url') options.companionBaseUrl = next();
    else if (arg === '--token' || arg === '--companion-token') options.companionToken = next();
    else if (arg === '--primary-api-url') options.primaryApiUrl = next();
    else if (arg === '--peer-api-url') options.peerApiUrl = next();
    else if (arg === '--primary-number') options.primaryNumber = next();
    else if (arg === '--peer-number') options.peerNumber = next();
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--skip-memory') options.skipMemory = true;
    else if (arg === '--help' || arg === '-h') usage(0);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  options.companionBaseUrl = normalizeBaseUrl(options.companionBaseUrl);
  options.primaryApiUrl = normalizeBaseUrl(options.primaryApiUrl);
  options.peerApiUrl = normalizeBaseUrl(options.peerApiUrl);
  return options;
}

function usage(exitCode = 1) {
  console.log(`
Signal companion live E2E

Requires:
  - desktop app running with Signal enabled
  - primary signal-cli-rest-api on --primary-api-url
  - peer signal-cli-rest-api on --peer-api-url
  - companion server enabled

Example:
  SIGNAL_E2E_PRIMARY="+380..." SIGNAL_E2E_PEER="+373..." pnpm e2e:signal-companion

Options:
  --primary-number <phone>       Primary linked Signal account.
  --peer-number <phone>          Peer linked Signal account that sends the test message.
  --primary-api-url <url>        Default: ${DEFAULT_PRIMARY_SIGNAL_API_URL}
  --peer-api-url <url>           Default: ${DEFAULT_PEER_SIGNAL_API_URL}
  --companion-base-url <url>     Default: ${DEFAULT_COMPANION_BASE_URL}
  --companion-token <token>      Defaults to companion_bridge.json.
  --timeout-ms <ms>              Default: 45000.
  --skip-memory                  Do not require backend memory ingest status ok.
`);
  process.exit(exitCode);
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  try {
    const url = new URL(text);
    if (url.pathname.includes('companion.html') || url.pathname.startsWith('/c/')) {
      return url.origin;
    }
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return text.replace(/\/+$/, '');
  }
}

function mask(value) {
  const text = String(value || '').trim();
  if (text.length <= 4) return '***';
  return `***${text.slice(-4)}`;
}

async function loadDotEnv() {
  try {
    const text = await readFile('.env', 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const index = line.indexOf('=');
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional for CI and local overrides.
  }
}

async function resolveCompanionToken(options) {
  const fromUrl = extractTokenFromUrl(options.companionBaseUrl);
  if (options.companionToken) return options.companionToken;
  if (fromUrl) return fromUrl;

  const bridgePath = join(homedir(), 'Library/Application Support/HackInterview/companion_bridge.json');
  const raw = await readFile(bridgePath, 'utf8');
  const parsed = JSON.parse(raw);
  const token = String(parsed.companionAccessToken || '').trim();
  if (!token) throw new Error(`Companion token is missing in ${bridgePath}`);
  return token;
}

function extractTokenFromUrl(value) {
  try {
    const url = new URL(value);
    return url.searchParams.get('token')?.trim() || '';
  } catch {
    return '';
  }
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    ...init,
  });
  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { response, json, raw };
}

async function assertSignalAccount(apiUrl, expectedNumber, label) {
  const { response, json, raw } = await fetchJson(`${apiUrl}/v1/accounts`);
  if (!response.ok || !Array.isArray(json)) {
    throw new Error(`${label} accounts request failed: ${response.status} ${raw.slice(0, 220)}`);
  }
  if (expectedNumber && !json.includes(expectedNumber)) {
    throw new Error(`${label} does not include ${mask(expectedNumber)}; accounts=${json.map(mask).join(', ')}`);
  }
  console.log(`[signal-e2e] ${label} account ok: ${json.map(mask).join(', ')}`);
}

async function companionState(options, token) {
  const url = `${options.companionBaseUrl}/api/state?token=${encodeURIComponent(token)}`;
  const { response, json, raw } = await fetchJson(url);
  if (!response.ok || !json?.data) {
    throw new Error(`Companion state failed: ${response.status} ${raw.slice(0, 220)}`);
  }
  return json.data;
}

async function sendPeerMessage(options, marker) {
  const payload = {
    number: options.peerNumber,
    recipients: [options.primaryNumber],
    message: marker,
  };
  const { response, json, raw } = await fetchJson(`${options.peerApiUrl}/v2/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Signal send failed: ${response.status} ${raw.slice(0, 220)}`);
  }
  console.log(`[signal-e2e] sent marker via peer: ${marker}`);
  return json;
}

async function waitForSignalInCompanion(options, token, marker, sentAtMs) {
  const deadline = Date.now() + options.timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await companionState(options, token);
    const timeline = lastState.timeline || [];
    const match = timeline.find((item) => item?.kind === 'signal' && item?.text === marker);
    if (match) {
      if (options.skipMemory) return { state: lastState, match };

      const memory = lastState.memory || {};
      const memoryUpdatedAt = Number(memory.lastUpdatedAtMs || 0);
      if (
        memory.lastIngestStatus === 'ok'
        && !memory.lastIngestError
        && memoryUpdatedAt >= Math.min(Number(match.createdAtMs || sentAtMs || 0), sentAtMs || 0)
      ) {
        return { state: lastState, match };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `Signal marker did not reach companion in ${options.timeoutMs}ms. Last state: ${JSON.stringify({
      timelineLen: lastState?.timeline?.length ?? null,
      memory: lastState?.memory ?? null,
    })}`
  );
}

async function main() {
  await loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  if (!options.primaryNumber) throw new Error('Set SIGNAL_E2E_PRIMARY or --primary-number');
  if (!options.peerNumber) throw new Error('Set SIGNAL_E2E_PEER or --peer-number');

  const token = await resolveCompanionToken(options);
  await assertSignalAccount(options.primaryApiUrl, options.primaryNumber, 'primary');
  await assertSignalAccount(options.peerApiUrl, options.peerNumber, 'peer');

  const initial = await companionState(options, token);
  if (initial.authRequired) throw new Error('Companion reports authRequired=true');
  if (!initial.controls?.companionModeEnabled) throw new Error('Companion mode is not enabled');
  console.log(`[signal-e2e] companion ok: timeline=${initial.timeline?.length ?? 0}`);

  const marker = `signal-e2e-${Date.now()}`;
  const sendResult = await sendPeerMessage(options, marker);
  const sentAtMs = Number(sendResult?.timestamp || Date.now());
  const { match, state } = await waitForSignalInCompanion(options, token, marker, sentAtMs);

  console.log(JSON.stringify({
    ok: true,
    marker,
    message: {
      id: match.id,
      seq: match.seq,
      kind: match.kind,
      role: match.role,
      status: match.status,
      createdAtMs: match.createdAtMs,
    },
    memory: {
      mode: state.memory?.mode,
      lastIngestStatus: state.memory?.lastIngestStatus,
      lastIngestError: state.memory?.lastIngestError ?? null,
      lastUpdatedAtMs: state.memory?.lastUpdatedAtMs ?? null,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(`[signal-e2e] ${error.stack || error.message || error}`);
  process.exit(1);
});

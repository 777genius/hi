#!/usr/bin/env node
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

function parseArgs(argv) {
  const options = {
    apiUrl: process.env.INTERVIEW_MEMORY_E2E_API_URL || process.env.INTERVIEW_MEMORY_API_URL || 'http://127.0.0.1:8080',
    authFile: process.env.INTERVIEW_MEMORY_E2E_AUTH_FILE || '/tmp/hackinterview-memory-e2e-auth.json',
    tokenFile: process.env.INTERVIEW_MEMORY_E2E_TOKEN_FILE || '/tmp/hackinterview-memory-e2e-token.txt',
    authStorePath:
      process.env.HACKINTERVIEW_AUTH_STORE_PATH ||
      join(homedir(), 'Library/Application Support/HackInterview/auth_store.json'),
    clear: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;

    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };

    if (arg === '--api-url') options.apiUrl = next();
    else if (arg === '--auth-file') options.authFile = next();
    else if (arg === '--token-file') options.tokenFile = next();
    else if (arg === '--auth-store-path') options.authStorePath = next();
    else if (arg === '--clear') options.clear = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.apiUrl = normalizeBaseUrl(options.apiUrl);
  return options;
}

function printHelp() {
  console.log(`Prepare local backend auth for memory E2E

Usage:
  pnpm e2e:prepare-local-memory-auth -- --api-url http://127.0.0.1:8080

Inputs:
  --auth-file <path>        JSON with email/password, default /tmp/hackinterview-memory-e2e-auth.json
  --token-file <path>       Output raw access token file, default /tmp/hackinterview-memory-e2e-token.txt
  --auth-store-path <path>  Native Tauri auth_store.json path
  --clear                   Clear native auth session and remove the raw token file
`);
}

function normalizeBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.protocol}//${url.host}`;
}

function parseMs(value, field) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Bad ${field}: ${value}`);
  return timestamp;
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function unwrapSession(payload) {
  const data = payload.data || payload;
  const session = data.session || data;
  return {
    accessToken: session.access_token || data.access_token,
    refreshToken: session.refresh_token || data.refresh_token || null,
    accessExpiresAt: session.access_expires_at || data.access_expires_at,
    refreshExpiresAt: session.refresh_expires_at || data.refresh_expires_at || null,
    user: session.user || data.user || null,
  };
}

async function login(options, deviceId, credentials) {
  const response = await fetch(`${options.apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
      device_id: deviceId,
    }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  const session = unwrapSession(payload);
  if (!session.accessToken || !session.accessExpiresAt) {
    throw new Error(`Login response is missing access token or expiry: ${JSON.stringify(payload)}`);
  }
  return session;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const existingStore = await readJsonIfExists(options.authStorePath);

  if (options.clear) {
    const authStore = {
      device_id: String(existingStore?.device_id || `desktop-e2e-${randomUUID()}`),
      session: null,
    };
    await mkdir(dirname(options.authStorePath), { recursive: true });
    await writeFile(options.authStorePath, `${JSON.stringify(authStore, null, 2)}\n`);
    try {
      await unlink(options.tokenFile);
    } catch {}
    console.log(
      JSON.stringify(
        {
          ok: true,
          cleared: true,
          authStorePath: options.authStorePath,
          tokenFile: options.tokenFile,
        },
        null,
        2,
      ),
    );
    return;
  }

  const credentials = JSON.parse(await readFile(options.authFile, 'utf8'));
  if (!credentials.email || !credentials.password) {
    throw new Error(`Auth file must contain email and password: ${options.authFile}`);
  }

  const deviceId = String(existingStore?.device_id || `desktop-e2e-${randomUUID()}`);
  const session = await login(options, deviceId, credentials);

  const authStore = {
    device_id: deviceId,
    session: {
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      access_expires_at_ms: parseMs(session.accessExpiresAt, 'access_expires_at'),
      refresh_expires_at_ms: session.refreshExpiresAt
        ? parseMs(session.refreshExpiresAt, 'refresh_expires_at')
        : null,
      user: session.user
        ? {
            id: session.user.id,
            email: session.user.email,
            email_verified: Boolean(session.user.email_verified),
          }
        : null,
    },
  };

  await mkdir(dirname(options.authStorePath), { recursive: true });
  await writeFile(options.authStorePath, `${JSON.stringify(authStore, null, 2)}\n`);
  await mkdir(dirname(options.tokenFile), { recursive: true });
  await writeFile(options.tokenFile, `${session.accessToken}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        apiUrl: options.apiUrl,
        authStorePath: options.authStorePath,
        tokenFile: options.tokenFile,
        accessExpiresAt: session.accessExpiresAt,
        hasRefreshToken: Boolean(session.refreshToken),
        hasUser: Boolean(session.user),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

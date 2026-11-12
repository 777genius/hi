const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

// There is no safe fixed default: Companion may have bound a fallback port.
const DEFAULT_BACKEND_URL = '';
const DEFAULT_TIMEOUT_MS = 3000;

class BackendHttpError extends Error {
  constructor(message, statusCode, responseText) {
    super(message);
    this.name = 'BackendHttpError';
    this.statusCode = statusCode;
    this.responseText = responseText;
  }
}

class CompanionEndpointNotFoundError extends Error {
  constructor(message, searchedPaths) {
    super(message);
    this.name = 'CompanionEndpointNotFoundError';
    this.searchedPaths = searchedPaths;
  }
}

class CompanionIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompanionIdentityError';
  }
}

class CompanionTokenNotFoundError extends Error {
  constructor(message, searchedPaths) {
    super(message);
    this.name = 'CompanionTokenNotFoundError';
    this.searchedPaths = searchedPaths;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function uniqueByToken(sources) {
  const seen = new Set();
  const result = [];

  for (const source of sources) {
    const token = nonEmptyString(source?.token);
    if (!token || seen.has(token)) {
      continue;
    }

    seen.add(token);
    result.push({
      token,
      source: source.source || 'unknown',
      path: source.path || null,
    });
  }

  return result;
}

function positionToPayload(position) {
  if (!position) {
    return null;
  }

  return {
    line: Number.isInteger(position.line) ? position.line : null,
    character: Number.isInteger(position.character) ? position.character : null,
  };
}

function comparePositions(left, right) {
  const leftLine = Number.isInteger(left?.line) ? left.line : 0;
  const rightLine = Number.isInteger(right?.line) ? right.line : 0;
  if (leftLine !== rightLine) {
    return leftLine - rightLine;
  }

  const leftCharacter = Number.isInteger(left?.character) ? left.character : 0;
  const rightCharacter = Number.isInteger(right?.character) ? right.character : 0;
  return leftCharacter - rightCharacter;
}

function selectionToPayload(selection) {
  if (!selection) {
    return null;
  }

  return {
    start: positionToPayload(selection.start),
    end: positionToPayload(selection.end),
    active: positionToPayload(selection.active),
    anchor: positionToPayload(selection.anchor),
    isEmpty: Boolean(selection.isEmpty),
  };
}

function selectionIsEmpty(selection) {
  if (!selection) {
    return true;
  }

  if (typeof selection.isEmpty === 'boolean') {
    return selection.isEmpty;
  }

  return comparePositions(selection.start, selection.end) === 0;
}

function editorSelections(editor) {
  if (Array.isArray(editor?.selections) && editor.selections.length > 0) {
    return editor.selections;
  }

  return editor?.selection ? [editor.selection] : [];
}

function selectedTextFromEditor(editor) {
  const document = editor?.document;
  if (!document || typeof document.getText !== 'function') {
    return null;
  }

  const selections = editorSelections(editor).filter((selection) => !selectionIsEmpty(selection));
  if (selections.length === 0) {
    return null;
  }

  const parts = selections
    .map((selection) => document.getText(selection))
    .filter((value) => typeof value === 'string' && value.length > 0);

  if (parts.length === 0) {
    return null;
  }

  return {
    text: parts.join('\n'),
    method: parts.length > 1 ? 'selectedTextMulti' : 'selectedText',
    selection: selectionToPayload(selections[0]),
    selections: selections.map(selectionToPayload),
    selectionCount: parts.length,
  };
}

function documentUriToString(document) {
  if (!document?.uri) {
    return null;
  }

  if (typeof document.uri.toString === 'function') {
    return document.uri.toString();
  }

  return String(document.uri);
}

function documentFilePath(document) {
  if (document?.uri?.scheme === 'file' && nonEmptyString(document.uri.fsPath)) {
    return document.uri.fsPath;
  }

  if (!document?.isUntitled && nonEmptyString(document?.fileName)) {
    return document.fileName;
  }

  return null;
}

function buildPayloadFromEditor(editor, options = {}) {
  const document = editor?.document;
  if (!document || typeof document.getText !== 'function') {
    throw new Error('No active text editor document');
  }

  const selected = selectedTextFromEditor(editor);
  const text = selected?.text ?? document.getText();
  const filePath = documentFilePath(document);
  const uri = documentUriToString(document);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  return {
    schemaVersion: 1,
    source: 'editor-extension',
    method: selected?.method ?? 'activeFile',
    appName: options.appName || 'Cursor',
    text,
    characterCount: text.length,
    url: uri,
    filePath,
    title: filePath ? path.basename(filePath) : null,
    languageId: document.languageId || null,
    lineCount: Number.isInteger(document.lineCount) ? document.lineCount : null,
    isUntitled: Boolean(document.isUntitled),
    isDirty: Boolean(document.isDirty),
    selection: selected?.selection ?? selectionToPayload(editor.selection),
    selections: selected?.selections ?? editorSelections(editor).map(selectionToPayload),
    selectionCount: selected?.selectionCount ?? 0,
    createdAtMs: nowMs,
    extensionVersion: options.extensionVersion || null,
  };
}

function candidateConfigPaths(env = process.env, platform = process.platform) {
  const explicitPath = nonEmptyString(env.CLIPBOARD_TOOLS_CONFIG_PATH);
  if (explicitPath) {
    return [explicitPath];
  }

  const home = nonEmptyString(env.HOME) || os.homedir();
  if (platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    return [
      path.join(appSupport, 'ClipboardTools', 'bridge.json'),
    ];
  }

  if (platform === 'win32') {
    const appData = nonEmptyString(env.APPDATA) || path.join(home, 'AppData', 'Roaming');
    return [
      path.join(appData, 'ClipboardTools', 'bridge.json'),
    ];
  }

  const configHome = nonEmptyString(env.XDG_CONFIG_HOME) || path.join(home, '.config');
  return [
    path.join(configHome, 'ClipboardTools', 'bridge.json'),
  ];
}

function discoverCompanionEndpoint(options = {}) {
  const paths = candidateConfigPaths(options.env || process.env, options.platform || process.platform);
  const fsImpl = options.fsImpl || fs;
  for (const configPath of paths) {
    try {
      const bridge = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
      const port = bridge.companionPort;
      const instanceId = nonEmptyString(bridge.instanceId);
      if (
        bridge.schemaVersion === 2 &&
        bridge.companionActive === true &&
        Number.isInteger(port) &&
        port >= 1 &&
        port <= 65535 &&
        instanceId &&
        instanceId.length <= 128
      ) {
        return {
          url: `http://127.0.0.1:${port}/api/focus-copy/ingest`,
          instanceId,
          path: configPath,
        };
      }
    } catch (_error) {
      // Absent or stale metadata is never grounds for guessing a fixed port.
    }
  }
  throw new CompanionEndpointNotFoundError(
    'No active Companion endpoint in the private bridge file',
    paths
  );
}

function identityProof(token, instanceId, port, nonce) {
  return crypto.createHash('sha256')
    .update(`hack-interview-companion/v2:${token}:${instanceId}:${port}:${nonce}`)
    .digest('hex');
}

/**
 * Unauthenticated nonce challenge: no token or editor contents are transmitted
 * until the listener at the chosen URL proves possession of the local token.
 */
function verifyCompanionIdentity(url, token, expectedInstanceId, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new CompanionIdentityError('Companion URL must use http(s)');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  target.pathname = '/api/identity';
  target.search = new URLSearchParams({ nonce }).toString();
  target.hash = '';
  const client = target.protocol === 'https:' ? https : http;
  const maxResponseBytes = 16 * 1024;

  return new Promise((resolve, reject) => {
    const request = client.request(target, { method: 'GET', headers: { Accept: 'application/json' } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (part) => {
        size += part.length;
        if (size > maxResponseBytes) {
          request.destroy(new CompanionIdentityError('Companion identity response too large'));
          return;
        }
        chunks.push(Buffer.from(part));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new CompanionIdentityError('Companion identity challenge was rejected'));
          return;
        }
        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(new CompanionIdentityError('Invalid Companion identity response'));
          return;
        }
        const instanceId = nonEmptyString(data?.instanceId);
        if (
          data?.service !== 'hack-interview-companion' ||
          data?.schemaVersion !== 2 ||
          !instanceId ||
          (expectedInstanceId && instanceId !== expectedInstanceId) ||
          typeof data?.proof !== 'string'
        ) {
          reject(new CompanionIdentityError('Companion identity mismatch'));
          return;
        }
        const actual = Buffer.from(data.proof, 'hex');
        const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
        const expected = Buffer.from(identityProof(token, instanceId, port, nonce), 'hex');
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
          reject(new CompanionIdentityError('Companion identity proof mismatch'));
          return;
        }
        resolve();
      });
    });
    request.on('error', (error) => reject(
      error instanceof CompanionIdentityError
        ? error
        : new CompanionIdentityError('Companion identity challenge failed')
    ));
    request.setTimeout(timeoutMs, () => {
      request.destroy(new CompanionIdentityError('Companion identity challenge timed out'));
    });
    request.end();
  });
}

function candidateLogPaths(env = process.env, platform = process.platform) {
  return [];
}

function readTokenFromConfigFile(configPath, fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return (
      nonEmptyString(parsed.companion_access_token) ||
      nonEmptyString(parsed.companionAccessToken) ||
      nonEmptyString(parsed.accessToken) ||
      nonEmptyString(parsed.token)
    );
  } catch (_error) {
    return null;
  }
}

function readTokensFromLogFile(logPath, fsImpl = fs) {
  let raw;
  try {
    raw = fsImpl.readFileSync(logPath, 'utf8');
  } catch (_error) {
    return [];
  }

  const tail = raw.length > 512 * 1024 ? raw.slice(raw.length - 512 * 1024) : raw;
  const regex = /\/c\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;
  const tokens = [];
  let match;
  while ((match = regex.exec(tail)) !== null) {
    tokens.push(match[1]);
  }

  return tokens.reverse();
}

function discoverCompanionTokenCandidates(options = {}) {
  const sources = [];
  const explicitToken = nonEmptyString(options.explicitToken);
  if (explicitToken) {
    sources.push({ token: explicitToken, source: 'setting' });
  }

  const env = options.env || process.env;
  const envToken = nonEmptyString(env.CLIPBOARD_TOOLS_TOKEN);
  if (envToken) {
    sources.push({ token: envToken, source: 'env' });
  }

  if (options.autoDiscover === false) {
    return uniqueByToken(sources);
  }

  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  for (const configPath of candidateConfigPaths(env, platform)) {
    const token = readTokenFromConfigFile(configPath, fsImpl);
    if (token) {
      sources.push({ token, source: 'config', path: configPath });
    }
  }

  if (options.readLogTokens !== false) {
    for (const logPath of candidateLogPaths(env, platform)) {
      for (const token of readTokensFromLogFile(logPath, fsImpl)) {
        sources.push({ token, source: 'log', path: logPath });
      }
    }
  }

  return uniqueByToken(sources);
}

function discoverCompanionToken(options = {}) {
  return discoverCompanionTokenCandidates(options)[0]?.token || null;
}

function postJson(url, body, options = {}) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  const bodyText = JSON.stringify(body);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(bodyText),
  };

  const token = nonEmptyString(options.token);
  if (token) {
    headers['X-Companion-Token'] = token;
  }

  return new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: 'POST',
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf8');
          let responseBody = null;
          if (responseText.trim().length > 0) {
            try {
              responseBody = JSON.parse(responseText);
            } catch (_error) {
              responseBody = null;
            }
          }

          const statusCode = response.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new BackendHttpError(`Backend returned HTTP ${statusCode}`, statusCode, responseText));
            return;
          }

          resolve({
            statusCode,
            body: responseBody,
            responseText,
          });
        });
      }
    );

    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Backend request timed out after ${timeoutMs}ms`));
    });
    request.write(bodyText);
    request.end();
  });
}

async function captureAndSendActiveEditor(input) {
  const payload = buildPayloadFromEditor(input.editor, {
    appName: input.appName,
    extensionVersion: input.extensionVersion,
    nowMs: input.nowMs,
  });

  if (payload.text.trim().length === 0) {
    throw new Error('Active file is empty');
  }

  if (input.copyToClipboard !== false && input.clipboard?.writeText) {
    await input.clipboard.writeText(payload.text);
  }

  const tokenCandidates = discoverCompanionTokenCandidates({
    explicitToken: input.companionToken,
    autoDiscover: input.autoDiscoverToken,
    env: input.env,
    fsImpl: input.fsImpl,
    platform: input.platform,
    readLogTokens: input.readLogTokens,
  });

  const explicitUrl = nonEmptyString(input.backendUrl);
  const endpoint = explicitUrl
    ? { url: explicitUrl, instanceId: null }
    : discoverCompanionEndpoint({
      env: input.env,
      fsImpl: input.fsImpl,
      platform: input.platform,
    });
  const backendUrl = endpoint.url;
  if (tokenCandidates.length === 0) {
    throw new CompanionTokenNotFoundError(
      'Companion token not found',
      candidateConfigPaths(input.env || process.env, input.platform || process.platform)
    );
  }

  let lastAuthError = null;
  for (const candidate of tokenCandidates) {
    try {
      await verifyCompanionIdentity(
        backendUrl,
        candidate.token,
        endpoint.instanceId,
        input.requestTimeoutMs,
      );
      const response = await postJson(backendUrl, payload, {
        token: candidate.token,
        timeoutMs: input.requestTimeoutMs,
      });

      return {
        payload,
        response,
        tokenUsed: candidate.token,
        tokenSource: candidate.source,
      };
    } catch (error) {
      if (
        error instanceof CompanionIdentityError ||
        (error instanceof BackendHttpError && (error.statusCode === 401 || error.statusCode === 403))
      ) {
        lastAuthError = error;
        continue;
      }

      throw error;
    }
  }

  throw lastAuthError || new Error('Failed to authorize companion request');
}

module.exports = {
  BackendHttpError,
  CompanionIdentityError,
  CompanionEndpointNotFoundError,
  CompanionTokenNotFoundError,
  DEFAULT_BACKEND_URL,
  DEFAULT_TIMEOUT_MS,
  buildPayloadFromEditor,
  captureAndSendActiveEditor,
  candidateConfigPaths,
  candidateLogPaths,
  discoverCompanionTokenCandidates,
  discoverCompanionToken,
  discoverCompanionEndpoint,
  identityProof,
  verifyCompanionIdentity,
  postJson,
  readTokensFromLogFile,
};

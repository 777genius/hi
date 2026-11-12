import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const {
  captureAndSendActiveEditor,
  discoverCompanionToken,
  DEFAULT_BACKEND_URL,
  discoverCompanionEndpoint,
  CompanionEndpointNotFoundError,
  CompanionIdentityError,
  identityProof,
} = require('../src/client.js');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const expectedText = `function answer() {
  return 42;
}
`;
let receivedRequest = null;
const observedMethods = [];
const companionToken = 'test-token';
const instanceId = 'test-instance-001';

const server = http.createServer(async (request, response) => {
  observedMethods.push(request.method);
  if (request.method === 'GET' && request.url?.startsWith('/api/identity?')) {
    const nonce = new URL(request.url, 'http://127.0.0.1').searchParams.get('nonce');
    assert.match(nonce, /^[0-9a-f]{32}$/);
    assert.equal(request.headers['x-companion-token'], undefined, 'identity GET must not send token');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      service: 'hack-interview-companion',
      schemaVersion: 1,
      instanceId,
      proof: identityProof(companionToken, instanceId, nonce),
    }));
    return;
  }

  const rawBody = await readRequestBody(request);
  receivedRequest = {
    method: request.method,
    url: request.url,
    token: request.headers['x-companion-token'],
    contentType: request.headers['content-type'],
    body: JSON.parse(rawBody),
  };

  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ok: true, messageId: 'focus-copy:test', characterCount: receivedRequest.body.characterCount }));
});
const address = await listen(server);

try {
  const backendUrl = `http://127.0.0.1:${address.port}/api/focus-copy/ingest`;
  const clipboard = { value: '', async writeText(text) { this.value = text; } };
  const editor = {
    document: {
      getText: () => expectedText,
      uri: {
        scheme: 'file',
        fsPath: '/tmp/example.ts',
        toString: () => 'file:///tmp/example.ts',
      },
      fileName: '/tmp/example.ts',
      languageId: 'typescript',
      lineCount: 3,
      isUntitled: false,
      isDirty: true,
    },
    selection: {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 2 },
      active: { line: 1, character: 2 },
      anchor: { line: 1, character: 2 },
      isEmpty: true,
    },
  };

  const result = await captureAndSendActiveEditor({
    editor,
    clipboard,
    appName: 'Cursor',
    extensionVersion: '0.0.1-test',
    backendUrl,
    companionToken: 'test-token',
    copyToClipboard: true,
    requestTimeoutMs: 500,
    nowMs: 123456,
  });

  assert.equal(clipboard.value, expectedText);
  assert.equal(result.payload.text, expectedText);
  assert.equal(result.payload.filePath, '/tmp/example.ts');
  assert.equal(result.payload.languageId, 'typescript');
  assert.equal(result.payload.characterCount, expectedText.length);
  assert.equal(result.response.body.messageId, 'focus-copy:test');
  assert.equal(result.tokenSource, 'setting');

  assert.equal(receivedRequest.method, 'POST');
  assert.equal(receivedRequest.url, '/api/focus-copy/ingest');
  assert.equal(receivedRequest.token, 'test-token');
  assert.match(receivedRequest.contentType, /^application\/json/);
  assert.equal(receivedRequest.body.text, expectedText);
  assert.equal(receivedRequest.body.method, 'activeFile');
  assert.equal(receivedRequest.body.source, 'editor-extension');

  const selectedText = 'return 42;';
  const selectionEditor = {
    ...editor,
    document: {
      ...editor.document,
      getText: (range) => (range ? selectedText : expectedText),
    },
    selection: {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 12 },
      active: { line: 1, character: 12 },
      anchor: { line: 1, character: 2 },
      isEmpty: false,
    },
    selections: [
      {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 12 },
        active: { line: 1, character: 12 },
        anchor: { line: 1, character: 2 },
        isEmpty: false,
      },
    ],
  };

  receivedRequest = null;
  clipboard.value = '';
  const selectionResult = await captureAndSendActiveEditor({
    editor: selectionEditor,
    clipboard,
    appName: 'Cursor',
    extensionVersion: '0.0.3-test',
    backendUrl,
    companionToken: 'test-token',
    copyToClipboard: true,
    requestTimeoutMs: 500,
    nowMs: 123457,
  });

  assert.equal(clipboard.value, selectedText);
  assert.equal(selectionResult.payload.text, selectedText);
  assert.equal(selectionResult.payload.method, 'selectedText');
  assert.equal(selectionResult.payload.selectionCount, 1);
  assert.equal(receivedRequest.body.text, selectedText);
  assert.equal(receivedRequest.body.method, 'selectedText');
  assert.equal(receivedRequest.body.selectionCount, 1);

  const token = discoverCompanionToken({
    explicitToken: '',
    env: { CLIPBOARD_TOOLS_TOKEN: 'env-token' },
  });
  assert.equal(token, 'env-token');

  const bridgeToken = discoverCompanionToken({
    explicitToken: '',
    env: { HOME: '/tmp/focus-copy-home' },
    platform: 'darwin',
    fsImpl: {
      readFileSync(filePath) {
        if (filePath.endsWith('/ClipboardTools/bridge.json')) {
          return JSON.stringify({ companionAccessToken: 'bridge-token' });
        }
        throw new Error('not found');
      },
    },
  });
  assert.equal(bridgeToken, 'bridge-token');

  console.log('[PASS] Cursor extension e2e copied active file and posted backend payload');
} finally {
  await close(server);
}

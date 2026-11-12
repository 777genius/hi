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
      schemaVersion: 2,
      instanceId,
      proof: identityProof(companionToken, instanceId, address.port, nonce),
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


  assert.equal(DEFAULT_BACKEND_URL, '', 'never guess a fixed port');
  assert.deepEqual(observedMethods.slice(0, 2), ['GET', 'POST'], 'verify before POST');

  // Real collision: another listener owns the legacy preferred port.
  const unexpectedRequests = [];
  const dummy = http.createServer(async (request, response) => {
    unexpectedRequests.push({
      method: request.method,
      url: request.url,
      token: request.headers['x-companion-token'],
      body: await readRequestBody(request),
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ service: 'unrelated-app', proof: 'invalid' }));
  });

  await listen(dummy, 43821);
  try {
    const bridgeFile = '/tmp/clipboard-tools-e2e/bridge.json';
    const fakeBridge = (bridge) => ({
      env: { CLIPBOARD_TOOLS_CONFIG_PATH: bridgeFile },
      fsImpl: {
        readFileSync(file) {
          assert.equal(file, bridgeFile);
          return JSON.stringify(bridge);
        },
      },
    });
    const activeBridge = {
      schemaVersion: 2,
      companionAccessToken: companionToken,
      companionPort: address.port,
      companionActive: true,
      instanceId,
    };
    const options = fakeBridge(activeBridge);

    assert.equal(
      discoverCompanionEndpoint(options).url,
      backendUrl,
      'active endpoint comes from the bridge'
    );

    receivedRequest = null;
    const fallback = await captureAndSendActiveEditor({
      editor, clipboard, backendUrl: '', companionToken: '',
      copyToClipboard: false, requestTimeoutMs: 800, ...options,
    });
    assert.equal(fallback.tokenSource, 'config');
    assert.equal(fallback.response.body.messageId, 'focus-copy:test');
    assert.equal(receivedRequest?.body.text, expectedText);
    assert.deepEqual(unexpectedRequests, [], 'occupied 43821 must receive no request');

    // Stale bridge points to the wrong listener: challenge may be sent, but
    // no sensitive POST or bearer token must reach the unrelated server.
    const stale = fakeBridge({ ...activeBridge, companionPort: 43821 });
    await assert.rejects(
      captureAndSendActiveEditor({
        editor, clipboard, backendUrl: '', companionToken: '',
        copyToClipboard: false, requestTimeoutMs: 800, ...stale,
      }),
      CompanionIdentityError
    );
    assert.equal(unexpectedRequests.length, 1);
    assert.equal(unexpectedRequests[0].method, 'GET');
    assert.equal(unexpectedRequests[0].token, undefined);
    assert.equal(unexpectedRequests[0].body, '');

    // Even a user-configured URL cannot send secrets to an unverified server.
    await assert.rejects(
      captureAndSendActiveEditor({
        editor, clipboard,
        backendUrl: 'http://127.0.0.1:43821/api/focus-copy/ingest',
        companionToken, requestTimeoutMs: 800, copyToClipboard: false,
      }),
      CompanionIdentityError
    );
    assert.ok(unexpectedRequests.every((req) => req.method === 'GET' && !req.token && !req.body));

    // A malicious port owner might relay the challenge to the legitimate
    // fallback server. Port-bound proof must still reject the response.
    const originalHandler = dummy.listeners('request')[0];
    dummy.removeAllListeners('request');
    dummy.on('request', (request, response) => {
      unexpectedRequests.push({
        method: request.method,
        url: request.url,
        token: request.headers['x-companion-token'],
        body: '',
      });
      if (request.method !== 'GET') {
        response.writeHead(500);
        response.end();
        return;
      }
      http.get(`http://127.0.0.1:${address.port}${request.url}`, (actual) => {
        response.writeHead(actual.statusCode ?? 500, { 'Content-Type': 'application/json' });
        actual.pipe(response);
      }).on('error', () => {
        response.writeHead(502);
        response.end();
      });
    });
    try {
      await assert.rejects(
        captureAndSendActiveEditor({
          editor, clipboard, backendUrl: '', companionToken: '',
          copyToClipboard: false, requestTimeoutMs: 800, ...stale,
        }),
        CompanionIdentityError
      );
      assert.equal(unexpectedRequests.at(-1).method, 'GET');
      assert.equal(unexpectedRequests.at(-1).token, undefined);
      assert.equal(unexpectedRequests.at(-1).body, '');
      assert.equal(unexpectedRequests.some((req) => req.method === 'POST'), false);
    } finally {
      dummy.removeAllListeners('request');
      dummy.on('request', originalHandler);
    }

    // Disabled, missing or version-1 bridge state must fail closed before
    // opening a network connection.
    const observedBefore = observedMethods.length;
    const unexpectedBefore = unexpectedRequests.length;
    for (const badBridge of [
      { ...activeBridge, companionActive: false },
      { ...activeBridge, instanceId: null },
      { ...activeBridge, companionPort: null },
      { companionAccessToken: companionToken, schemaVersion: 1 },
    ]) {
      await assert.rejects(
        captureAndSendActiveEditor({
          editor, clipboard, backendUrl: '', companionToken: '',
          copyToClipboard: false, ...fakeBridge(badBridge),
        }),
        CompanionEndpointNotFoundError
      );
    }
    assert.equal(observedMethods.length, observedBefore);
    assert.equal(unexpectedRequests.length, unexpectedBefore);
  } finally {
    await close(dummy);
  }

  // A valid Companion can close the challenge connection before the POST.
  // Never put credentials/editor text on a newly opened unverified socket.
  let unexpectedPostsAfterClose = 0;
  let closingPort = 0;
  const closingServer = http.createServer((request, response) => {
    if (request.method !== 'GET') {
      unexpectedPostsAfterClose += 1;
      response.writeHead(500);
      response.end();
      return;
    }
    const nonce = new URL(request.url, 'http://127.0.0.1').searchParams.get('nonce');
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Connection': 'close',
    });
    response.end(JSON.stringify({
      service: 'hack-interview-companion',
      schemaVersion: 2,
      instanceId,
      proof: identityProof(companionToken, instanceId, closingPort, nonce),
    }));
  });
  const closingAddress = await listen(closingServer);
  closingPort = closingAddress.port;
  try {
    await assert.rejects(
      captureAndSendActiveEditor({
        editor, clipboard,
        backendUrl: `http://127.0.0.1:${closingPort}/api/focus-copy/ingest`,
        companionToken, copyToClipboard: false, requestTimeoutMs: 800,
      }),
      CompanionIdentityError
    );
    assert.equal(unexpectedPostsAfterClose, 0, 'closed socket cannot be replaced for sensitive POST');
  } finally {
    await close(closingServer);
  }

  console.log('[PASS] Cursor identity + occupied 43821: unrelated listener received no sensitive POST');
} finally {
  await close(server);
}

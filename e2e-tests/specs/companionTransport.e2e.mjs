import assert from 'node:assert/strict';
import net from 'node:net';
import { ensureE2E, findWindowHandleByLabel, invoke } from '../helpers/tauriE2e.mjs';

function assertInvokeResult(result, name) {
  if (!result || result.__error) throw new Error(`${name}: ${result?.__error ?? 'empty Tauri result'}`);
  return result;
}

async function getJson(url, expectedStatus = 200) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, expectedStatus, `unexpected HTTP status from ${new URL(url).pathname}`);
  return response.json();
}

async function openKeepAliveConnection(port) {
  const socket = net.connect({ port, host: '127.0.0.1' });
  await new Promise((resolve, reject) => {
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Companion HTTP keep-alive probe timed out'));
    }, 7000);
    let connected = false;
    // A forced close on Companion Stop may manifest as ECONNRESET. Keep
    // the error listener attached so revocation cannot crash the test runner.
    socket.on('error', (error) => {
      if (!connected) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    socket.on('data', (chunk) => {
      if (connected) return;
      response += chunk.toString();
      if (!response.includes('\r\n\r\n')) return;
      clearTimeout(timeout);
      connected = true;
      if (!/^HTTP\/1\.1 200 /.test(response)) {
        reject(new Error('Companion HTTP keep-alive probe did not return 200'));
      } else {
        resolve();
      }
    });
    socket.once('connect', () => {
      socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    });
  });
  if (socket.destroyed) throw new Error('Companion closed keep-alive socket before Stop');
  return socket;
}

async function openSnapshotStream(baseUrl, token) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/events?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'text/event-stream' },
    cache: 'no-store',
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/i);
  const reader = response.body.getReader();
  let buffer = '';
  const decoder = new TextDecoder();

  const nextSnapshot = async (timeoutMs = 10_000) => {
    const timeout = setTimeout(() => controller.abort(new Error('SSE snapshot timed out')), timeoutMs);
    try {
      for (;;) {
        const separator = buffer.indexOf('\n\n');
        if (separator !== -1) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const lines = frame.split('\n');
          if (!lines.includes('event: snapshot')) continue;
          const json = lines.find((line) => line.startsWith('data: '))?.slice(6);
          if (!json) throw new Error('SSE snapshot frame has no JSON data');
          return JSON.parse(json);
        }

        const result = await reader.read();
        if (result.done) throw new Error('SSE stream closed before snapshot arrived');
        buffer += decoder.decode(result.value, { stream: true });
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  const waitForClose = async (timeoutMs = 6_000) => {
    let deadlineExceeded = false;
    const timeout = setTimeout(() => {
      deadlineExceeded = true;
      controller.abort(new Error('SSE listener stayed open after disable'));
    }, timeoutMs);
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) return;
      }
    } catch (error) {
      if (deadlineExceeded) throw new Error('SSE listener stayed open after disable', { cause: error });
      // Abrupt server-side revocation may surface as ECONNRESET/undici
      // "terminated" rather than a clean EOF, and is equally valid.
      if (/terminated|socket|reset|aborted|closed/i.test(String(error))) return;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const close = () => controller.abort();
  return { nextSnapshot, waitForClose, close };
}

describe('Companion HTTP/SSE transport (real native Tauri)', () => {
  it('mirrors desktop state, streams monotonic revisions, and revokes old SSE after restart', async () => {
    await browser.switchToWindow(await findWindowHandleByLabel('main'));
    await ensureE2E();

    let stream;
    let nextStream;
    let keepAliveSocket;
    try {
      const started = assertInvokeResult(await invoke('enable_companion_mode'), 'enable companion');
      assert.equal(started.enabled, true);
      assert.ok(started.token);
      assert.ok(Number.isInteger(started.port) && started.port > 0);

      const base = `http://127.0.0.1:${started.port}`;
      const stateUrl = `${base}/api/state?token=${encodeURIComponent(started.token)}`;
      const first = await getJson(stateUrl);
      const desktop = assertInvokeResult(await invoke('get_companion_snapshot'), 'desktop companion snapshot');
      assert.ok(first.data.controls.instanceId, 'server identity should be published');
      assert.equal(first.data.controls.instanceId, desktop.data.controls.instanceId);
      assert.equal(first.data.recording.status, desktop.data.recording.status);

      const missingToken = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(missingToken.status, 401, 'unauthenticated state must stay protected');
      const invalidToken = await fetch(`${base}/api/state?token=not-companion`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(invalidToken.status, 403, 'invalid token must stay protected');

      stream = await openSnapshotStream(base, started.token);
      keepAliveSocket = await openKeepAliveConnection(started.port);
      const initial = await stream.nextSnapshot();
      assert.equal(initial.data.controls.instanceId, first.data.controls.instanceId);

      // enable() while active emits a fresh snapshot through the real live
      // HTTP listener without resetting the instance or losing the watch update.
      const alreadyEnabled = assertInvokeResult(await invoke('enable_companion_mode'), 'enable existing companion');
      assert.equal(alreadyEnabled.port, started.port);
      const updated = await stream.nextSnapshot();
      assert.equal(updated.data.controls.instanceId, initial.data.controls.instanceId);
      assert.ok(Number(updated.revision) > Number(initial.revision), 'SSE revision should advance');

      // Simulate the phone dropping Wi-Fi/TCP while desktop state changes.
      // A fresh GET + new SSE subscription must catch up without replaying
      // the disconnected stream's historical events.
      stream.close();
      assertInvokeResult(await invoke('enable_companion_mode'), 'publish while phone disconnected');
      const afterOfflineChange = await getJson(stateUrl);
      stream = await openSnapshotStream(base, started.token);
      const recovered = await stream.nextSnapshot();
      assert.ok(Number(recovered.revision) >= Number(afterOfflineChange.revision),
        'resubscribing after a dropped connection must not miss desktop updates');
      assert.equal(recovered.data.controls.instanceId, afterOfflineChange.data.controls.instanceId);

      // The test-only native STT fixture exercises the actual backend timeline
      // reducer, full HTTP snapshot, SSE and Tauri desktop command together.
      // Unlike a synthetic EventSource mock this proves cross-device parity.
      const injectedText = `companion-native-stt-${Date.now()}`;
      const injectResponse = await fetch(`${base}/api/e2e/timeline/system`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Companion-Token': started.token },
        body: JSON.stringify({ text: injectedText, sessionId: 777 }),
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(injectResponse.status, 200, 'native STT fixture must publish to Companion');
      let liveTranscript;
      for (let attempt = 0; attempt < 4; attempt++) {
        liveTranscript = await stream.nextSnapshot();
        if (liveTranscript.data.timeline.some((message) => message.text === injectedText)) break;
      }
      assert.equal(liveTranscript.data.timeline.filter((message) => message.text === injectedText).length, 1,
        'mobile SSE receives exactly one finalized STT message');
      assert.ok(Number(liveTranscript.revision) > Number(recovered.revision), 'new STT final advances revision');
      const desktopTranscript = assertInvokeResult(await invoke('get_companion_snapshot'), 'desktop STT snapshot');
      assert.equal(desktopTranscript.data.timeline.filter((message) => message.text === injectedText).length, 1,
        'desktop and phone must see the same native STT message');
      const mobileTranscript = await getJson(stateUrl);
      assert.equal(mobileTranscript.data.timeline.filter((message) => message.text === injectedText).length, 1,
        'HTTP resync and live SSE must agree on STT timeline');

      const oldSocketClosed = new Promise((resolve) => keepAliveSocket.once('close', resolve));
      const stopped = assertInvokeResult(await invoke('disable_companion_mode'), 'disable companion');
      assert.equal(stopped.enabled, false);
      await stream.waitForClose();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('old HTTP keep-alive socket was not revoked on Stop')), 6000);
        oldSocketClosed.then(() => {
          clearTimeout(timeout);
          resolve();
        });
      });

      const restarted = assertInvokeResult(await invoke('enable_companion_mode'), 're-enable companion');
      assert.equal(restarted.enabled, true);
      assert.equal(restarted.token, started.token, 'the private QR token persists across mode toggles');
      assert.ok(restarted.port > 0);

      const currentBase = `http://127.0.0.1:${restarted.port}`;
      const restartedState = await getJson(`${currentBase}/api/state?token=${encodeURIComponent(restarted.token)}`);
      assert.ok(restartedState.data.controls.instanceId);
      assert.notEqual(restartedState.data.controls.instanceId, initial.data.controls.instanceId,
        'restarted listener must begin a new revision epoch');
      nextStream = await openSnapshotStream(currentBase, restarted.token);
      const liveRestart = await nextStream.nextSnapshot();
      assert.equal(liveRestart.data.controls.instanceId, restartedState.data.controls.instanceId);
    } finally {
      stream?.close();
      nextStream?.close();
      keepAliveSocket?.destroy();
      const result = await invoke('disable_companion_mode');
      if (result?.__error) throw new Error(`cleanup companion: ${result.__error}`);
    }
  });
});

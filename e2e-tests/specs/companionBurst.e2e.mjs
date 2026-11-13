import assert from 'node:assert/strict';
import { ensureE2E, findWindowHandleByLabel, invoke, waitFor } from '../helpers/tauriE2e.mjs';

function nativeResult(value, operation) {
  assert.ok(value && !value.__error, `${operation}: ${value?.__error ?? 'no result'}`);
  return value;
}

async function probe(base, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await fetch(`${base}/events?token=${encodeURIComponent(token)}`, { signal: controller.signal });
    assert.equal(response.status, 200, 'real Companion SSE must open');
  } catch (error) {
    controller.abort();
    throw error;
  } finally { clearTimeout(timer); }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let latest = null;
  let failure = null;
  let previousRevision = -1;
  let buffer = '';
  const reading = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Companion SSE unexpectedly ended');
      buffer += decoder.decode(chunk.value, { stream: true });
      assert.ok(buffer.length <= 4 * 1024 * 1024, 'bounded SSE parser buffer');
      for (let boundary; (boundary = buffer.indexOf('\n\n')) !== -1;) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split('\n');
        if (!lines.includes('event: snapshot')) continue;
        const data = lines.find((line) => line.startsWith('data: '));
        assert.ok(data, 'snapshot must contain JSON');
        const next = JSON.parse(data.slice(6));
        const revision = Number(next.revision);
        assert.ok(Number.isSafeInteger(revision) && revision >= previousRevision, 'SSE revisions must not regress');
        previousRevision = revision;
        latest = next;
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) failure = error; });
  return {
    get latest() { if (failure) throw failure; return latest; },
    async close() { controller.abort(); await reading; },
  };
}

async function state(base, token) {
  const response = await fetch(`${base}/api/state?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  return response.json();
}

function messages(snapshot, prefix) {
  return (snapshot?.data.timeline ?? []).filter((item) => item.text.startsWith(prefix));
}

function contents(snapshot, prefix) {
  return messages(snapshot, prefix).map(({ id, text, seq }) => ({ id, text, seq })).sort((a, b) => a.seq - b.seq);
}

describe('Native Companion burst / slow-client convergence', () => {
  it('delivers 200 unique Unicode messages to live, repeatedly rejoined, HTTP and desktop clients', async () => {
    await browser.switchToWindow(await findWindowHandleByLabel('main'));
    await ensureE2E();
    let live;
    let rejoined;
    const seed = Date.now();
    const prefix = `native-burst-${seed}-`;
    const expectedTexts = [];
    try {
      const started = nativeResult(await invoke('enable_companion_mode'), 'enable Companion');
      const base = `http://127.0.0.1:${started.port}`;
      live = await probe(base, started.token);
      rejoined = await probe(base, started.token);
      await waitFor(() => !!live.latest && !!rejoined.latest);
      const instanceId = live.latest.data.controls.instanceId;

      for (let round = 0; round < 4; round++) {
        if (round > 0) { await rejoined.close(); rejoined = null; }
        // Four concurrent writers exercise publication ordering. A watch
        // channel may coalesce snapshots; only complete eventual state matters.
        for (let offset = 0; offset < 50; offset += 4) {
          const writes = Array.from({ length: Math.min(4, 50 - offset) }, async (_, local) => {
            const index = round * 50 + offset + local;
            const text = `${prefix}${index}: Русский / українська / 🎙️`;
            expectedTexts.push(text);
            const response = await fetch(`${base}/api/e2e/timeline/system`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Companion-Token': started.token },
              body: JSON.stringify({ text, sessionId: seed + index }),
              signal: AbortSignal.timeout(10_000),
            });
            assert.equal(response.status, 200, `native transcript ${index} was not accepted`);
            assert.equal((await response.json()).ok, true);
          });
          await Promise.all(writes);
        }
        const count = (round + 1) * 50;
        await waitFor(() => messages(live.latest, prefix).length === count, { timeoutMs: 20_000 });
        if (!rejoined) rejoined = await probe(base, started.token);
        await waitFor(() => messages(rejoined.latest, prefix).length === count, { timeoutMs: 20_000 });
        assert.equal(rejoined.latest.data.controls.instanceId, instanceId);
        assert.deepEqual(contents(rejoined.latest, prefix), contents(live.latest, prefix));
      }
      const http = await state(base, started.token);
      const desktop = nativeResult(await invoke('get_companion_snapshot'), 'desktop Companion state');
      const finalMessages = messages(http, prefix);
      assert.equal(finalMessages.length, 200);
      assert.equal(new Set(finalMessages.map((item) => item.id)).size, 200, 'no duplicate message IDs');
      assert.equal(new Set(finalMessages.map((item) => item.seq)).size, 200, 'no duplicate sequence numbers');
      assert.deepEqual(finalMessages.map((item) => item.text).sort(), expectedTexts.sort());
      for (const candidate of [live.latest, rejoined.latest, desktop]) {
        assert.deepEqual(contents(candidate, prefix), contents(http, prefix));
      }
      console.log('[PASS] Companion: 200 messages, 4 concurrent writers, 2 SSE clients, 3 reconnects; HTTP/desktop/SSE converge');
    } finally {
      await Promise.all([live?.close(), rejoined?.close()]);
      nativeResult(await invoke('disable_companion_mode'), 'disable Companion');
    }
  });
});

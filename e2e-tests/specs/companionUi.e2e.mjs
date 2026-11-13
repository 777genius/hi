import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { findWindowHandleByLabel, waitFor } from '../helpers/tauriE2e.mjs';
import { message, snapshot, startCompanionFixture } from '../helpers/companionFixture.mjs';

const rowIds = () => browser.execute(() => Array.from(document.querySelectorAll('.chat-row'), (row) => row.dataset.msgId));
const pageText = () => browser.execute(() => document.body.textContent);
let fixture;
let mainHandle;

async function openPage() {
  await browser.switchToWindow(mainHandle);
  await browser.url(fixture.url);
  await $('.controls-dock').waitForExist({ timeout: 15_000 });
  await waitFor(() => fixture.streamsOpened > 0);
  await waitFor(async () => await $('.dock-record-button').isEnabled());
}

async function assertNoPageErrors() {
  assert.deepEqual(await browser.execute(() => window.__uiErrors), [], 'mobile page must not throw during recovery');
}

async function clickTitle(title) {
  const button = await $(`button[title="${title}"]`);
  await button.waitForExist({ timeout: 15_000 });
  await button.waitForEnabled({ timeout: 15_000 });
  await button.click();
}

async function waitText(text) {
  await waitFor(async () => (await pageText()).includes(text));
}

async function screenshot(name) {
  await mkdir('.e2e-artifacts', { recursive: true });
  await browser.saveScreenshot(`.e2e-artifacts/companion-ui-${name}.png`);
}

describe('Built Companion UI over real browser HTTP/SSE (fault-injected server)', () => {
  before(async () => {
    mainHandle = await findWindowHandleByLabel('main');
    await browser.setWindowSize(430, 850);
  });
  beforeEach(async () => { fixture = null; fixture = await startCompanionFixture(); });
  afterEach(async function () {
    try {
      if (this.currentTest?.state === 'failed') await screenshot('failure');
    } finally {
      // Stop the page before the fixture; no reconnect timers leak into the next test.
      try { await browser.url('about:blank'); } finally { await fixture?.stop(); }
    }
  });

  it('recovers initial GET failure, renders 300 unique messages and preserves reading position', async () => {
    fixture.stateFailures = 1;
    await openPage();
    for (let start = 0; start < 300; start += 25) {
      fixture.state.data.timeline.push(...Array.from({ length: 25 }, (_, i) => message(start + i)));
      fixture.publish();
      await delay(35);
    }
    await waitFor(async () => (await rowIds()).length === 300);
    assert.deepEqual(await rowIds(), Array.from({ length: 300 }, (_, i) => `burst:${i}`));
    await waitText('burst 299: Русский / українська / 🎙️');

    const scrollTop = await browser.execute(() => {
      const scroll = document.querySelector('.chat-scroll');
      scroll.scrollTop = 120;
      scroll.dispatchEvent(new Event('scroll'));
      return scroll.scrollTop;
    });
    assert.ok(scrollTop > 0, 'a large feed must really overflow');
    for (let i = 0; i < 10; i++) {
      fixture.state.data.live = { partialText: `Live utterance ${i}`, partialStartedAtMs: 1_700_000_001_000 };
      fixture.publish();
      await delay(35);
    }
    await waitText('Live utterance 9');
    const after = await browser.execute(() => document.querySelector('.chat-scroll').scrollTop);
    assert.ok(Math.abs(after - scrollTop) <= 3, `reading position changed: ${scrollTop} → ${after}`);

    fixture.state.data.timeline.push({ ...message(300), text: 'Live utterance 9', createdAtMs: 1_700_000_001_000 });
    fixture.state.data.live = {};
    fixture.publish();
    await waitFor(async () => (await rowIds()).length === 301 && !(await rowIds()).includes('stt:live'));
    assert.equal(new Set(await rowIds()).size, 301);
    await assertNoPageErrors();
    await screenshot('burst');
  });

  it('operates record, mute, selection, prompt and context controls without duplicate pending commands', async () => {
    fixture.state.data.timeline = [message(0), message(1), message(2)];
    await openPage();
    const release = fixture.hold('/api/record/start');
    try {
      await $('.dock-record-button').click();
      await waitFor(() => fixture.count('/api/record/start') === 1);
      assert.equal(await $('.dock-record-button').isEnabled(), false);
      // Use the protocol click: WebdriverIO's convenience click waits for
      // enabled=true, which intentionally cannot happen until release().
      const disabledButton = await $('.dock-record-button');
      await browser.elementClick(disabledButton.elementId);
      assert.equal(fixture.count('/api/record/start'), 1);
    } finally { release(); }
    await clickTitle('Остановить запись');
    await waitFor(() => fixture.count('/api/record/stop') === 1);
    assert.equal(fixture.count('/api/record/start'), 1, 'no delayed duplicate start');
    await clickTitle('Замьютить микрофон только в приложении');
    await clickTitle('Включить микрофон в приложении');
    await waitFor(() => fixture.count('/api/microphone/app/unmute') === 1);
    assert.equal(fixture.count('/api/microphone/app/mute'), 1);
    assert.equal(fixture.count('/api/microphone/app/unmute'), 1);

    await $('[data-msg-id="burst:0"] .chat-bubble').click();
    await $('.selection-badge').waitForExist();
    await clickTitle('Сгенерировать ответ');
    await waitFor(() => fixture.count('/api/ai/request') === 1);
    assert.deepEqual(fixture.posts.find((post) => post.path === '/api/ai/request').body.selectedMessageIds, ['burst:0']);
    await clickTitle('Открыть сообщение в AI');
    await $('.ask-textarea').setValue('Проверка отправки — українська 🎙️');
    await $('.send-button').click();
    await waitText('Проверка отправки — українська 🎙️');
    assert.equal(fixture.count('/api/prompt/send'), 1);
    assert.ok(fixture.posts.every((post) => typeof post.requestId === 'string' && post.requestId.length > 0));
    const idsBeforeClear = await rowIds();
    await clickTitle('Очистить AI контекст');
    await waitFor(() => fixture.count('/api/context/clear') === 1);
    assert.deepEqual(await rowIds(), idsBeforeClear, 'context clearing must not clear visible history');
    await assertNoPageErrors();
    await screenshot('controls');
  });

  it('does not replay history clearing after the desktop applies it but the response is lost', async () => {
    fixture.state.data.timeline = [message(0), message(1)];
    await openPage();
    fixture.dropResponseFor = '/api/history/clear';
    await clickTitle('Очистить историю');
    await waitText('Не удалось подтвердить отправку');
    fixture.state.data.timeline.push(message(2, 'after-clear'));
    fixture.publish();
    await waitText('after-clear 2:');
    assert.equal(fixture.count('/api/history/clear'), 1);
    assert.deepEqual(await rowIds(), ['after-clear:2']);
    await waitText('Не удалось подтвердить отправку');
    await assertNoPageErrors();
  });

  it('rejects malformed high-revision snapshots before they crash or permanently freeze the feed', async () => {
    fixture.state.data.timeline = [message(0, 'healthy')];
    await openPage();
    for (const corruption of [{ live: null }, { timeline: [null] }]) {
      const streamsBefore = fixture.streamsOpened;
      fixture.sendSnapshot({ revision: '999999', data: { ...fixture.state.data, ...corruption } });
      await waitFor(() => fixture.streamsOpened > streamsBefore);
      const next = message(fixture.state.data.timeline.length, 'healthy');
      fixture.state.data.timeline.push(next);
      fixture.publish();
      await waitText(next.text);
      await assertNoPageErrors();
    }
    assert.equal((await rowIds()).length, 3);
  });

  it('catches up after TCP loss and accepts a restarted server without keeping an old selection', async () => {
    fixture.state = snapshot('old-server', 5000);
    fixture.state.data.timeline = [message(0, 'before-restart')];
    await openPage();
    await $('[data-msg-id="before-restart:0"] .chat-bubble').click();
    await $('.selection-badge').waitForExist();
    await browser.execute(() => { window.__sameDocument = 'not-reloaded'; });
    fixture.dropStreams();
    fixture.state = snapshot('new-server', 1);
    // Same message id, entirely different session: selection must be cleared.
    fixture.state.data.timeline = [{ ...message(0, 'before-restart'), text: 'New process after restart' }];
    await waitText('New process after restart');
    assert.equal(await $('.selection-badge').isExisting(), false);
    assert.equal(await browser.execute(() => window.__sameDocument), 'not-reloaded');
    fixture.sendSnapshot({ ...fixture.state, revision: '0', data: { ...fixture.state.data, timeline: [{ ...message(8), text: 'STALE SNAPSHOT' }] } });
    fixture.state.data.timeline.push(message(1, 'caught-up'));
    fixture.publish();
    await waitText('caught-up 1:');
    assert.equal((await pageText()).includes('STALE SNAPSHOT'), false);
    await assertNoPageErrors();
  });

  it('recovers a silent half-open SSE stream using the real watchdog without page reload', async function () {
    this.timeout(85_000);
    await openPage();
    const opened = fixture.streamsOpened;
    fixture.heartbeatEnabled = false;
    await browser.execute(() => { window.__sameDocument = 'watchdog-test'; });
    await waitFor(() => fixture.streamsOpened > opened, { timeoutMs: 65_000, intervalMs: 500 });
    fixture.heartbeatEnabled = true;
    fixture.state.data.timeline.push(message(0, 'watchdog-recovered'));
    fixture.publish();
    await waitText('watchdog-recovered 0:');
    assert.equal(await browser.execute(() => window.__sameDocument), 'watchdog-test');
    await assertNoPageErrors();
    await screenshot('recovered');
  });
});

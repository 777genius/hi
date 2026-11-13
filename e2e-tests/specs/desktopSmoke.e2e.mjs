import { expect } from 'expect-webdriverio';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureE2E, findWindowHandleByLabel, openSettingsWindow } from '../helpers/tauriE2e.mjs';
import { captureDesktopSnapshot } from '../helpers/desktopSnapshot.mjs';

describe('macOS Tauri desktop smoke', () => {
  it('renders the real main window and opens settings', async () => {
    const main = await findWindowHandleByLabel('main');
    await browser.switchToWindow(main);
    await ensureE2E();
    const shown = await browser.executeAsync(done => {
      window.__TAURI__.window.getCurrentWindow().show().then(() => done(true)).catch(error => done(String(error)));
    });
    if (shown !== true) throw new Error(`Could not show the desktop window: ${shown}`);

    // A standalone debug binary has a separate macOS Screen Recording grant.
    // Check the permission UI, then uncover the conversation for renderer tests.
    const permissionOverlay = await $('.permission-warning-overlay');
    if (await permissionOverlay.isExisting()) {
      await expect($('.permission-warning-minimize')).toBeExisting();
      await browser.execute(() => { document.querySelector('.permission-warning-overlay')?.remove(); });
    }

    await expect($('.record-button')).toBeExisting();
    await expect($('[data-testid="open-settings"]')).toBeExisting();
    await expect($('.chat-scroll')).toBeExisting();
    const mainSnapshot = await captureDesktopSnapshot('main');
    if (process.env.E2E_SCREENSHOT_DIR) {
      await mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
      await browser.saveScreenshot(join(process.env.E2E_SCREENSHOT_DIR, 'hackinterview-main.png'));
    }
    if (!mainSnapshot.elements.some(element => element.classes.includes('record-button'))) {
      throw new Error('The live desktop snapshot is missing the record button');
    }

    if (process.env.E2E_EXPECT_HISTORY === '1') {
      const rows = await browser.execute(() => [...document.querySelectorAll('.chat-row')].map(row => ({
        text: row.textContent || '',
        classes: row.className,
        hasMicIcon: Boolean(row.querySelector('.mdi-microphone')),
      })));
      if (!rows.some(row => row.text.includes('Вопрос номер один') && row.classes.includes('incoming'))) {
        throw new Error('The first interviewer question is missing from the desktop timeline');
      }
      if (!rows.some(row => row.text.includes('Мой ответ номер 1') && row.hasMicIcon)) {
        throw new Error('The microphone response is missing its desktop icon');
      }
      if (!rows.some(row => row.classes.includes('assistant-response') && row.text.trim())) {
        throw new Error('The LLM answer is missing from the desktop timeline');
      }
    }

    await openSettingsWindow();
    const settings = await findWindowHandleByLabel('settings');
    await browser.switchToWindow(settings);
    await ensureE2E();
    await expect($('.settings-window')).toBeExisting();
    await captureDesktopSnapshot('settings');
    if (process.env.E2E_SCREENSHOT_DIR) {
      await browser.saveScreenshot(join(process.env.E2E_SCREENSHOT_DIR, 'hackinterview-settings.png'));
    }
  });
});

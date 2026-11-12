import { writeFile } from 'node:fs/promises';

/** A compact, agent-readable map of the live Tauri window. */
export async function captureDesktopSnapshot(label) {
  const snapshot = await browser.execute(() => {
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return {
      title: document.title,
      url: location.href,
      elements: [...document.querySelectorAll('button, input, textarea, select, [role], [data-testid], .chat-row')]
        .filter(visible)
        .map((element) => {
          const box = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute('role'),
            testId: element.getAttribute('data-testid'),
            classes: String(element.className || '').slice(0, 160),
            label: (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 180),
            enabled: !element.disabled,
            box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
          };
        }),
    };
  });
  const result = { label, capturedAt: new Date().toISOString(), ...snapshot };
  if (process.env.E2E_SNAPSHOT_PATH) {
    const prefix = process.env.E2E_SNAPSHOT_PATH.replace(/\.json$/, '');
    const path = `${prefix}-${label}.json`;
    await writeFile(path, JSON.stringify(result, null, 2));
  }
  return result;
}

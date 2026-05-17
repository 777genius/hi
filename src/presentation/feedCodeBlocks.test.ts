// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { isCodeBlockExpandedFromTarget, toggleCodeBlockCollapseFromTarget } from './feedCodeBlocks';

describe('toggleCodeBlockCollapseFromTarget', () => {
  it('toggles collapsed state from a code-block toggle button', () => {
    document.body.innerHTML = `
      <div class="code-block code-block-collapsible collapsed">
        <button class="code-block-toggle" type="button">
          <span class="inner"></span>
        </button>
      </div>
    `;
    const inner = document.querySelector('.inner');
    const block = document.querySelector('.code-block-collapsible');
    expect(inner).toBeTruthy();
    expect(block).toBeTruthy();
    expect(block?.classList.contains('collapsed')).toBe(true);
    expect(isCodeBlockExpandedFromTarget(inner)).toBe(false);

    const handled = toggleCodeBlockCollapseFromTarget(inner);

    expect(handled).toBe(true);
    expect(block?.classList.contains('collapsed')).toBe(false);
    expect(isCodeBlockExpandedFromTarget(inner)).toBe(true);
  });

  it('returns false for unrelated targets', () => {
    document.body.innerHTML = `<div class="chat-row"><span class="plain-text">hello</span></div>`;
    const text = document.querySelector('.plain-text');

    expect(toggleCodeBlockCollapseFromTarget(text)).toBe(false);
  });
});

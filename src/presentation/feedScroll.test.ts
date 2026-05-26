import { describe, expect, it } from 'vitest';
import { isNearScrollBottom, scrollBottomRemaining, scrollElementToBottom } from './feedScroll';

describe('feed scroll helpers', () => {
  it('treats a viewport near the bottom as pinned', () => {
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 424, clientHeight: 500 }, 80)).toBe(true);
    expect(scrollBottomRemaining({ scrollHeight: 1000, scrollTop: 424, clientHeight: 500 })).toBe(76);
  });

  it('does not treat a viewport reading older messages as pinned', () => {
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 500 }, 80)).toBe(false);
  });

  it('keeps bottom sticking independent of new content height after render', () => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1000 });
    element.scrollTop = 500;

    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1800 });
    scrollElementToBottom(element);

    expect(element.scrollTop).toBe(1800);
  });
});

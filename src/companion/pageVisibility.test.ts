import { describe, expect, it } from 'vitest';
import { isCompanionPageVisible } from './pageVisibility';

describe('isCompanionPageVisible', () => {
  it('treats visible page as visible', () => {
    expect(isCompanionPageVisible({ visibilityState: 'visible' })).toBe(true);
  });

  it('treats hidden page as not visible', () => {
    expect(isCompanionPageVisible({ visibilityState: 'hidden' })).toBe(false);
  });

  it('treats unknown lifecycle states as not visible', () => {
    expect(isCompanionPageVisible({ visibilityState: 'prerender' })).toBe(false);
  });

  it('defaults to visible when document is unavailable', () => {
    expect(isCompanionPageVisible()).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { abortCompanionRequests, wasCompanionRequestHiddenAborted } from './requestAbortState';

describe('requestAbortState', () => {
  it('marks lifecycle-hidden aborts so pagehide aborts are not misclassified as timeouts', () => {
    const controller = new AbortController();

    abortCompanionRequests([controller], 'hidden');

    expect(controller.signal.aborted).toBe(true);
    expect(wasCompanionRequestHiddenAborted(controller, { visibilityState: 'visible' })).toBe(true);
  });

  it('does not treat generic aborts as hidden when page is still visible', () => {
    const controller = new AbortController();

    abortCompanionRequests([controller], 'generic');

    expect(controller.signal.aborted).toBe(true);
    expect(wasCompanionRequestHiddenAborted(controller, { visibilityState: 'visible' })).toBe(false);
  });

  it('treats hidden document state as hidden even without explicit lifecycle mark', () => {
    const controller = new AbortController();

    expect(wasCompanionRequestHiddenAborted(controller, { visibilityState: 'hidden' })).toBe(true);
    expect(wasCompanionRequestHiddenAborted(controller, { visibilityState: 'prerender' })).toBe(true);
  });
});

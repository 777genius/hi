import { afterEach, describe, expect, it, vi } from 'vitest';
import { companionRetryDelayMs, createCompanionReconnectScheduler, createCompanionStreamWatchdog } from './reconnectScheduler';

afterEach(() => {
  vi.useRealTimers();
});

describe('Companion reconnect lifecycle', () => {
  it('bounds retry delay without tight loops', () => {
    expect([0, 1, 2, 3, 4, 8].map(companionRetryDelayMs))
      .toEqual([1500, 3000, 6000, 12000, 15000, 15000]);
  });

  it('retries a failed initial connection repeatedly and coalesces timers', () => {
    vi.useFakeTimers();
    const reconnect = vi.fn();
    const scheduler = createCompanionReconnectScheduler(reconnect, () => true);

    scheduler.schedule();
    scheduler.schedule();
    vi.advanceTimersByTime(1499);
    expect(reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    vi.advanceTimersByTime(3000);
    expect(reconnect).toHaveBeenCalledTimes(2);

    scheduler.schedule();
    vi.advanceTimersByTime(6000);
    expect(reconnect).toHaveBeenCalledTimes(3);
    scheduler.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suspends when hidden/offline, then resets after live SSE opens', () => {
    vi.useFakeTimers();
    let available = true;
    const reconnect = vi.fn();
    const scheduler = createCompanionReconnectScheduler(reconnect, () => available);

    scheduler.schedule();
    available = false;
    vi.advanceTimersByTime(1500);
    expect(reconnect).not.toHaveBeenCalled();
    scheduler.schedule();
    expect(vi.getTimerCount()).toBe(0);

    available = true;
    scheduler.schedule();
    scheduler.reset();
    expect(vi.getTimerCount()).toBe(0);
    scheduler.schedule();
    vi.advanceTimersByTime(1499);
    expect(reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('does not run a cancelled retry after unmount or invalid credentials', () => {
    vi.useFakeTimers();
    let connectedToValidInstance = true;
    const reconnect = vi.fn();
    const scheduler = createCompanionReconnectScheduler(reconnect, () => connectedToValidInstance);

    scheduler.schedule();
    connectedToValidInstance = false;
    scheduler.cancel();
    vi.advanceTimersByTime(30000);
    scheduler.schedule();
    expect(reconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Companion live SSE watchdog', () => {
  it('fires after a silent half-open connection but not while receiving heartbeats', () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watchdog = createCompanionStreamWatchdog(onStall);
    watchdog.start();

    vi.advanceTimersByTime(30000);
    watchdog.heartbeat();
    vi.advanceTimersByTime(40000);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10000);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on hidden page and after an SSE reconnect', () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watchdog = createCompanionStreamWatchdog(onStall);
    watchdog.start();
    vi.advanceTimersByTime(32000);
    watchdog.stop();
    vi.advanceTimersByTime(120000);
    expect(onStall).not.toHaveBeenCalled();
    watchdog.start();
    vi.advanceTimersByTime(15000);
    watchdog.heartbeat();
    vi.advanceTimersByTime(35000);
    expect(onStall).not.toHaveBeenCalled();
    watchdog.stop();
  });
});

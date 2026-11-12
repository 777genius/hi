/**
 * One retry owner for the Companion HTTP/SSE connection.
 * Browser lifecycle handlers can cancel pending work without resetting backoff.
 */
export const COMPANION_RETRY_BASE_MS = 1_500;
export const COMPANION_RETRY_MAX_MS = 15_000;

export function companionRetryDelayMs(failedAttempts: number): number {
  const exponent = Math.max(0, Math.min(4, Math.floor(failedAttempts)));
  return Math.min(COMPANION_RETRY_MAX_MS, COMPANION_RETRY_BASE_MS * 2 ** exponent);
}

export function createCompanionReconnectScheduler(
  reconnect: () => void,
  canReconnect: () => boolean,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failedAttempts = 0;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const reset = () => {
    cancel();
    failedAttempts = 0;
  };

  const schedule = () => {
    if (timer !== null || !canReconnect()) return;
    const delay = companionRetryDelayMs(failedAttempts);
    failedAttempts = Math.min(failedAttempts + 1, 5);
    timer = setTimeout(() => {
      timer = null;
      if (canReconnect()) reconnect();
    }, delay);
  };

  return { schedule, cancel, reset };
}

/**
 * EventSource does not surface SSE comment keepalives. The server sends a
 * named heartbeat so a half-open mobile connection can be detected.
 */
export const COMPANION_STREAM_STALE_MS = 45_000;
export const COMPANION_STREAM_WATCHDOG_INTERVAL_MS = 10_000;

export function createCompanionStreamWatchdog(onStall: () => void) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastActivityAt = 0;

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const heartbeat = () => {
    lastActivityAt = Date.now();
  };

  const start = () => {
    stop();
    heartbeat();
    timer = setInterval(() => {
      if (Date.now() - lastActivityAt > COMPANION_STREAM_STALE_MS) {
        stop();
        onStall();
      }
    }, COMPANION_STREAM_WATCHDOG_INTERVAL_MS);
  };

  return { start, heartbeat, stop };
}

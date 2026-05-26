export const DEFAULT_SCROLL_BOTTOM_THRESHOLD_PX = 72;

export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function scrollBottomRemaining(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - (metrics.scrollTop + metrics.clientHeight));
}

export function isNearScrollBottom(
  metrics: ScrollMetrics,
  thresholdPx = DEFAULT_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollBottomRemaining(metrics) <= thresholdPx;
}

export function scrollElementToBottom(element: HTMLElement): void {
  element.scrollTop = element.scrollHeight;
}

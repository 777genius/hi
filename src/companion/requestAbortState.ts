export type CompanionAbortReason = 'generic' | 'hidden';

type DocumentLike = {
  visibilityState?: string;
};

const hiddenLifecycleControllers = new WeakSet<AbortController>();

export function abortCompanionRequests(
  controllers: Iterable<AbortController>,
  reason: CompanionAbortReason = 'generic'
): void {
  for (const controller of controllers) {
    if (reason === 'hidden') {
      hiddenLifecycleControllers.add(controller);
    }
    controller.abort();
  }
}

export function wasCompanionRequestHiddenAborted(
  controller: AbortController,
  documentLike?: DocumentLike | null
): boolean {
  const visibilityState = documentLike?.visibilityState;
  if (visibilityState === 'hidden' || visibilityState === 'prerender') {
    return true;
  }

  return hiddenLifecycleControllers.has(controller);
}

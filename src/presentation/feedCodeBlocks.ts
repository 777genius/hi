type ClosestCapableTarget = EventTarget & {
  nodeType?: number;
  parentElement?: Element | null;
  closest?: (selector: string) => Element | null;
};

function resolveElementTarget(target: EventTarget | null): Element | null {
  const value = target as ClosestCapableTarget | null;
  if (!value) return null;
  if (value.nodeType === 1 && typeof value.closest === 'function') {
    return value as unknown as Element;
  }
  const parent = value.parentElement;
  if (parent && typeof parent.closest === 'function') {
    return parent;
  }
  return null;
}

function codeBlockFromTarget(target: EventTarget | null): Element | null {
  const element = resolveElementTarget(target);
  if (!element) return null;

  const toggle = element.closest('.code-block-toggle');
  if (!toggle) return null;

  return toggle.closest('.code-block-collapsible');
}

export function isCodeBlockExpandedFromTarget(target: EventTarget | null): boolean {
  const block = codeBlockFromTarget(target);
  return !!block && !block.classList.contains('collapsed');
}

export function toggleCodeBlockCollapseFromTarget(target: EventTarget | null): boolean {
  const block = codeBlockFromTarget(target);
  if (!block) return false;

  block.classList.toggle('collapsed');
  return true;
}

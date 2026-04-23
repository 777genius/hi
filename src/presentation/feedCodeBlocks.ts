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

export function toggleCodeBlockCollapseFromTarget(target: EventTarget | null): boolean {
  const element = resolveElementTarget(target);
  if (!element) return false;

  const toggle = element.closest('.code-block-toggle');
  if (!toggle) return false;

  const block = toggle.closest('.code-block-collapsible');
  if (!block) return false;

  block.classList.toggle('collapsed');
  return true;
}

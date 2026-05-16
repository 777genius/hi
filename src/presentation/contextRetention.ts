export const DEFAULT_MAX_CONTEXT_CHARS = 48_000;

const DEFAULT_RECENT_CONTEXT_CHARS = 32_000;

export type ContextRetentionPart = {
  kind: string;
  line: string;
};

function normalizePart<T extends ContextRetentionPart>(part: T): T | null {
  const line = String(part.line ?? '').trim();
  if (!line) return null;
  return { ...part, kind: String(part.kind ?? '') as T['kind'], line };
}

function joinedLength(parts: readonly ContextRetentionPart[]): number {
  return parts.reduce((sum, part, index) => sum + part.line.length + (index > 0 ? 1 : 0), 0);
}

function canAppend(parts: readonly ContextRetentionPart[], line: string, maxChars: number): boolean {
  return joinedLength(parts) + line.length + (parts.length > 0 ? 1 : 0) <= maxChars;
}

function trimLineTail(line: string, maxChars: number): string {
  const trimmed = String(line ?? '').trim();
  if (trimmed.length <= maxChars) return trimmed;

  const tail = trimmed.slice(trimmed.length - maxChars);
  const firstLineBreak = tail.indexOf('\n');
  if (firstLineBreak >= 0 && firstLineBreak < tail.length - 1) {
    return tail.slice(firstLineBreak + 1).trim();
  }
  return tail.trim();
}

function trimLineHead(line: string, maxChars: number): string {
  const trimmed = String(line ?? '').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trim();
}

function isImportantOlderPart(part: ContextRetentionPart): boolean {
  if (part.kind === 'prompt') return true;
  if (part.kind === 'haiku') return false;

  const line = part.line;
  const lower = line.toLowerCase();
  const markers = [
    '```',
    '=>',
    'function ',
    'class ',
    'interface ',
    'struct ',
    'impl ',
    'const ',
    'let ',
    'var ',
    'def ',
    'func ',
    'select ',
    ' from ',
    ' where ',
    ' join ',
    'useeffect',
    'error',
    'exception',
    'stack',
    'trace',
    'deadlock',
    'race',
    'sql',
    'react',
    'python',
    'typescript',
    'javascript',
    'rust',
    'код',
    'почему',
    'как ',
    'что ',
    'задач',
    'ошиб',
    'индекс',
  ];

  return (
    line.length > 800 ||
    line.includes('?') ||
    line.includes('{') ||
    line.includes(';') ||
    markers.some((marker) => lower.includes(marker))
  );
}

export function trimContextText(text: string, maxChars = DEFAULT_MAX_CONTEXT_CHARS): string {
  const parts = String(text ?? '')
    .split('\n')
    .map((line) => ({ kind: 'raw', line }));
  return trimContextParts(parts, maxChars);
}

export function selectContextParts<T extends ContextRetentionPart>(
  rawParts: readonly T[],
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
): T[] {
  const parts = rawParts.map(normalizePart).filter((part): part is T => part !== null);
  if (parts.length === 0) return [];

  const fullLength = joinedLength(parts);
  if (fullLength <= maxChars) return parts;

  const recentLimit = Math.min(DEFAULT_RECENT_CONTEXT_CHARS, maxChars);
  const recent: T[] = [];
  let recentStart = parts.length;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (recent.length === 0 && part.line.length > recentLimit) {
      recent.unshift({ ...part, line: trimLineTail(part.line, recentLimit) });
      recentStart = index;
      break;
    }
    if (!canAppend(recent, part.line, recentLimit)) break;
    recent.unshift(part);
    recentStart = index;
  }

  const anchorBudget = Math.max(0, maxChars - joinedLength(recent) - (recent.length > 0 ? 1 : 0));
  const anchorCandidates = parts
    .slice(0, recentStart)
    .map((part, index) => ({ index, part }))
    .filter(({ part }) => isImportantOlderPart(part));
  const anchors: Array<{ index: number; part: T }> = [];
  const selectedAnchorIndexes = new Set<number>();

  function addAnchorCandidate(index: number, part: T): void {
    if (selectedAnchorIndexes.has(index)) return;

    if (canAppend(anchors.map((anchor) => anchor.part), part.line, anchorBudget)) {
      anchors.push({ index, part });
      selectedAnchorIndexes.add(index);
      return;
    }

    const used = joinedLength(anchors.map((anchor) => anchor.part));
    const separator = anchors.length > 0 ? 1 : 0;
    const remaining = anchorBudget - used - separator;
    if (remaining < 400) return;

    const line = trimLineHead(part.line, remaining);
    if (!line) return;
    anchors.push({ index, part: { ...part, line } });
    selectedAnchorIndexes.add(index);
  }

  if (anchorCandidates.length > 0) {
    const oldest = anchorCandidates[0];
    addAnchorCandidate(oldest.index, oldest.part);
  }

  for (let index = anchorCandidates.length - 1; index >= 0; index -= 1) {
    const candidate = anchorCandidates[index];
    addAnchorCandidate(candidate.index, candidate.part);
  }

  anchors.sort((left, right) => left.index - right.index);
  const selected = [...anchors.map((anchor) => anchor.part), ...recent];
  if (selected.length === 0) {
    const fallback = trimLineTail(parts.map((part) => part.line).join('\n'), maxChars);
    return fallback ? [{ ...parts[parts.length - 1], line: fallback }] : [];
  }

  const selectedText = selected.map((part) => part.line).join('\n');
  if (selectedText.length <= maxChars) return selected;

  const fallback = trimLineTail(selectedText, maxChars);
  return fallback ? [{ ...selected[selected.length - 1], line: fallback }] : [];
}

export function trimContextParts(
  rawParts: readonly ContextRetentionPart[],
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
): string {
  return selectContextParts(rawParts, maxChars)
    .map((part) => part.line)
    .join('\n');
}

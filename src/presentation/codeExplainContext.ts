import type { ChatMessage } from '@/stores/chat';

const DEFAULT_MAX_CONTEXT_CHARS = 12_000;

type CodeExplainContextMessage = Pick<ChatMessage, 'id' | 'kind' | 'status' | 'text' | 'deleted'>;

function formatCodeExplainContextLine(message: CodeExplainContextMessage): string {
  const text = String(message.text ?? '').trim();
  if (!text) return '';
  if (message.kind === 'stt') return `ОС: ${text}`;
  if (message.kind === 'mic') return `МИКРОФОН: ${text}`;
  if (message.kind === 'prompt') return `ЗАПРОС: ${text}`;
  if (message.kind === 'haiku') return `ПОМОЩНИК: ${text}`;
  return text;
}

function isUsableCodeExplainContextMessage(message: CodeExplainContextMessage): boolean {
  if (message.deleted) return false;
  if (message.kind === 'haiku' && message.status !== 'final') return false;
  return true;
}

export function trimCodeExplainContextText(
  text: string,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
): string {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length <= maxChars) return trimmed;

  const tail = trimmed.slice(trimmed.length - maxChars);
  const firstLineBreak = tail.indexOf('\n');
  if (firstLineBreak >= 0 && firstLineBreak < tail.length - 1) {
    return tail.slice(firstLineBreak + 1).trim();
  }
  return tail.trim();
}

export function buildCodeExplainContextUpToMessageId(
  messages: readonly CodeExplainContextMessage[],
  messageId: string,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
): string {
  const parts: string[] = [];

  for (const message of messages) {
    if (!isUsableCodeExplainContextMessage(message)) {
      if (message.id === messageId) break;
      continue;
    }

    const line = formatCodeExplainContextLine(message);
    if (line) parts.push(line);
    if (message.id === messageId) break;
  }

  return trimCodeExplainContextText(parts.join('\n'), maxChars);
}

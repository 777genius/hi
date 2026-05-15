import type { ChatMessage } from '@/stores/chat';
import {
  DEFAULT_MAX_CONTEXT_CHARS,
  trimContextParts,
  trimContextText,
  type ContextRetentionPart,
} from './contextRetention';

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
  return trimContextText(text, maxChars);
}

export function buildCodeExplainContextUpToMessageId(
  messages: readonly CodeExplainContextMessage[],
  messageId: string,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
): string {
  const parts: ContextRetentionPart[] = [];

  for (const message of messages) {
    if (!isUsableCodeExplainContextMessage(message)) {
      if (message.id === messageId) break;
      continue;
    }

    const line = formatCodeExplainContextLine(message);
    if (line) parts.push({ kind: message.kind, line });
    if (message.id === messageId) break;
  }

  return trimContextParts(parts, maxChars);
}

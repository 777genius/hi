import type { ConversationFeedMessage } from '@/presentation/conversationFeed';

export const MAX_COMPANION_SELECTED_MESSAGE_IDS = 200;

export function isCompanionMessageSelectable(message: ConversationFeedMessage): boolean {
  return (
    message.status === 'final'
    && !message.deleted
    && message.kind !== 'haiku'
    && message.text.trim().length > 0
  );
}

export function normalizeCompanionSelectedIds(
  ids: readonly string[],
  messages: readonly ConversationFeedMessage[],
): string[] {
  const selectableIds = new Set(
    messages
      .filter(isCompanionMessageSelectable)
      .map((message) => message.id),
  );
  const result: string[] = [];
  const seen = new Set<string>();

  for (const rawId of ids) {
    const id = String(rawId ?? '').trim();
    if (!id || seen.has(id) || !selectableIds.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_COMPANION_SELECTED_MESSAGE_IDS) break;
  }

  return result;
}

export function toggleCompanionSelectedId(
  currentIds: readonly string[],
  message: ConversationFeedMessage,
  messages: readonly ConversationFeedMessage[],
): string[] {
  if (!isCompanionMessageSelectable(message)) {
    return normalizeCompanionSelectedIds(currentIds, messages);
  }

  const normalized = normalizeCompanionSelectedIds(currentIds, messages);
  if (normalized.includes(message.id)) {
    return normalized.filter((id) => id !== message.id);
  }

  return normalizeCompanionSelectedIds([...normalized, message.id], messages);
}

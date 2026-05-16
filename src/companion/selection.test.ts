import { describe, expect, it } from 'vitest';
import type { ConversationFeedMessage } from '@/presentation/conversationFeed';
import {
  MAX_COMPANION_SELECTED_MESSAGE_IDS,
  isCompanionMessageSelectable,
  normalizeCompanionSelectedIds,
  toggleCompanionSelectedId,
} from './selection';

function message(
  id: string,
  overrides: Partial<ConversationFeedMessage> = {},
): ConversationFeedMessage {
  return {
    id,
    kind: 'stt',
    role: 'incoming',
    status: 'final',
    text: `message ${id}`,
    createdAtMs: 1,
    seq: 1,
    ...overrides,
  };
}

describe('companion selection helper', () => {
  it('allows only durable non-assistant final messages', () => {
    expect(isCompanionMessageSelectable(message('stt:1'))).toBe(true);
    expect(isCompanionMessageSelectable(message('mic:1', { kind: 'mic' }))).toBe(true);
    expect(isCompanionMessageSelectable(message('prompt:1', { kind: 'prompt' }))).toBe(true);
    expect(isCompanionMessageSelectable(message('focus-copy:1'))).toBe(true);

    expect(isCompanionMessageSelectable(message('haiku:1', { kind: 'haiku' }))).toBe(false);
    expect(isCompanionMessageSelectable(message('stt:live', { status: 'streaming' }))).toBe(false);
    expect(isCompanionMessageSelectable(message('stt:deleted', { deleted: true }))).toBe(false);
    expect(isCompanionMessageSelectable(message('stt:empty', { text: '   ' }))).toBe(false);
  });

  it('filters stale ids, duplicates, invalid ids and caps the payload', () => {
    const messages = Array.from({ length: MAX_COMPANION_SELECTED_MESSAGE_IDS + 5 }, (_, index) =>
      message(`stt:${index}`));
    const ids = [
      'missing',
      'stt:2',
      'stt:2',
      ...messages.map((item) => item.id),
    ];

    const normalized = normalizeCompanionSelectedIds(ids, messages);

    expect(normalized).toHaveLength(MAX_COMPANION_SELECTED_MESSAGE_IDS);
    expect(normalized[0]).toBe('stt:2');
    expect(new Set(normalized).size).toBe(normalized.length);
    expect(normalized).not.toContain('missing');
  });

  it('toggles selected ids without losing valid existing selection', () => {
    const messages = [
      message('stt:1'),
      message('mic:1', { kind: 'mic' }),
      message('haiku:1', { kind: 'haiku' }),
    ];

    expect(toggleCompanionSelectedId(['stt:1'], messages[1], messages)).toEqual(['stt:1', 'mic:1']);
    expect(toggleCompanionSelectedId(['stt:1', 'mic:1'], messages[0], messages)).toEqual(['mic:1']);
    expect(toggleCompanionSelectedId(['stt:1'], messages[2], messages)).toEqual(['stt:1']);
  });
});

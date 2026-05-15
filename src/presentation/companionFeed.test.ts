import { describe, expect, it, vi } from 'vitest';
import { buildCompanionConversationFeedMessages } from './companionFeed';
import type { CompanionSnapshotData } from '@/windowing/stateSync';

function makeSnapshot(overrides: Partial<CompanionSnapshotData> = {}): CompanionSnapshotData {
  return {
    authRequired: false,
    recording: {
      status: 'Idle',
      activeSessionId: 0,
    },
    microphone: {
      muted: false,
      enabled: true,
      supported: true,
      source: 'os',
      systemMuted: false,
      systemSupported: true,
      systemSource: 'os',
      appMuted: false,
      appEnabled: true,
    },
    controls: {
      historyFloorSeq: 0,
      contextFloorSeq: 0,
      conversationGeneration: 1,
      companionModeEnabled: true,
      desktopBlackoutEnabled: false,
      lastAction: null,
    },
    live: {},
    timeline: [],
    ...overrides,
  };
}

describe('buildCompanionConversationFeedMessages', () => {
  it('preserves timeline order and inserts haiku after anchor', () => {
    const snapshot = makeSnapshot({
      timeline: [
        {
          id: 'stt-1',
          seq: 1,
          kind: 'stt',
          role: 'incoming',
          status: 'final',
          text: 'Question',
          createdAtMs: 100,
        },
        {
          id: 'haiku-1',
          seq: 3,
          kind: 'haiku',
          role: 'outgoing',
          status: 'final',
          text: 'Answer',
          createdAtMs: 120,
          insertAfterId: 'stt-1',
        },
        {
          id: 'mic-1',
          seq: 2,
          kind: 'mic',
          role: 'outgoing',
          status: 'final',
          text: 'My reply',
          createdAtMs: 110,
        },
      ],
    });

    expect(buildCompanionConversationFeedMessages(snapshot).map((message) => message.id)).toEqual([
      'stt-1',
      'haiku-1',
      'mic-1',
    ]);
  });

  it('adds live partial entries after durable base messages', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'));

    const snapshot = makeSnapshot({
      live: {
        partialText: 'live system',
        microphonePartialText: 'live mic',
      },
      timeline: [
        {
          id: 'stt-1',
          seq: 1,
          kind: 'stt',
          role: 'incoming',
          status: 'final',
          text: 'Question',
          createdAtMs: 100,
        },
      ],
    });

    expect(buildCompanionConversationFeedMessages(snapshot).map((message) => message.id)).toEqual([
      'stt-1',
      'stt:live',
      'mic:live',
    ]);

    vi.useRealTimers();
  });

  it('keeps deleted messages for the shared feed renderer', () => {
    const snapshot = makeSnapshot({
      timeline: [
        {
          id: 'mic-1',
          seq: 1,
          kind: 'mic',
          role: 'outgoing',
          status: 'final',
          text: 'Deleted text',
          createdAtMs: 100,
          deleted: true,
        },
      ],
    });

    const [message] = buildCompanionConversationFeedMessages(snapshot);
    expect(message).toMatchObject({
      id: 'mic-1',
      deleted: true,
      text: 'Deleted text',
    });
  });

  it('maps assistant candidates from companion snapshots', () => {
    const snapshot = makeSnapshot({
      timeline: [
        {
          id: 'haiku-1',
          seq: 1,
          kind: 'haiku',
          role: 'outgoing',
          status: 'streaming',
          text: 'Primary',
          createdAtMs: 100,
          activeCandidateId: 'anthropic',
          candidates: [
            {
              id: 'anthropic',
              label: 'Anthropic',
              provider: 'anthropic',
              model: 'claude-test',
              status: 'streaming',
              text: 'Primary',
            },
            {
              id: 'openai_responses',
              label: 'OpenAI',
              provider: 'openai_responses',
              model: 'gpt-5.4-mini',
              status: 'final',
              text: 'Secondary',
            },
          ],
        },
      ],
    });

    const [message] = buildCompanionConversationFeedMessages(snapshot);

    expect(message.activeCandidateId).toBe('anthropic');
    expect(message.candidates).toMatchObject([
      { id: 'anthropic', label: 'Anthropic', status: 'streaming', text: 'Primary' },
      { id: 'openai_responses', label: 'OpenAI', status: 'final', text: 'Secondary' },
    ]);
  });

  it('suppresses a live stt duplicate that exactly matches a fresh durable final message', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'));

    const snapshot = makeSnapshot({
      live: {
        partialText: 'What is closure',
        partialStartedAtMs: Date.now(),
      },
      timeline: [
        {
          id: 'stt-1',
          seq: 1,
          kind: 'stt',
          role: 'incoming',
          status: 'final',
          text: 'What is closure?',
          createdAtMs: Date.now() - 300,
        },
      ],
    });

    expect(buildCompanionConversationFeedMessages(snapshot).map((message) => message.id)).toEqual([
      'stt-1',
    ]);

    vi.useRealTimers();
  });

  it('suppresses a live mic duplicate that exactly matches a fresh durable final message', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'));

    const snapshot = makeSnapshot({
      live: {
        microphonePartialText: 'Let me think',
        microphonePartialStartedAtMs: Date.now(),
      },
      timeline: [
        {
          id: 'mic-1',
          seq: 1,
          kind: 'mic',
          role: 'outgoing',
          status: 'final',
          text: 'Let me think',
          createdAtMs: Date.now() - 500,
        },
      ],
    });

    expect(buildCompanionConversationFeedMessages(snapshot).map((message) => message.id)).toEqual([
      'mic-1',
    ]);

    vi.useRealTimers();
  });

  it('keeps a repeated live phrase when it is not an immediate transition duplicate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'));

    const snapshot = makeSnapshot({
      live: {
        partialText: 'JavaScript',
        partialStartedAtMs: Date.now(),
      },
      timeline: [
        {
          id: 'stt-1',
          seq: 1,
          kind: 'stt',
          role: 'incoming',
          status: 'final',
          text: 'JavaScript',
          createdAtMs: Date.now() - 10_000,
        },
      ],
    });

    expect(buildCompanionConversationFeedMessages(snapshot).map((message) => message.id)).toEqual([
      'stt-1',
      'stt:live',
    ]);

    vi.useRealTimers();
  });

  it('keeps a haiku anchored after the latest durable stt when live stt was deduped away', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T10:00:00Z'));

    const now = Date.now();
    const snapshot = makeSnapshot({
      live: {
        partialText: 'What is closure',
        partialStartedAtMs: now,
      },
      timeline: [
        {
          id: 'stt-1',
          seq: 1,
          kind: 'stt',
          role: 'incoming',
          status: 'final',
          text: 'What is closure?',
          createdAtMs: now - 200,
        },
        {
          id: 'haiku-1',
          seq: 2,
          kind: 'haiku',
          role: 'outgoing',
          status: 'streaming',
          text: 'A closure is...',
          createdAtMs: now + 50,
          insertAfterId: 'stt:live',
        },
        {
          id: 'mic-1',
          seq: 3,
          kind: 'mic',
          role: 'outgoing',
          status: 'final',
          text: 'Need a short answer',
          createdAtMs: now + 100,
        },
      ],
    });

    expect(buildCompanionConversationFeedMessages(snapshot).map((message) => message.id)).toEqual([
      'stt-1',
      'haiku-1',
      'mic-1',
    ]);

    vi.useRealTimers();
  });

  it('still appends a haiku when live anchor is missing and there is no durable stt fallback', () => {
    const snapshot = makeSnapshot({
      timeline: [
        {
          id: 'mic-1',
          seq: 1,
          kind: 'mic',
          role: 'outgoing',
          status: 'final',
          text: 'Need an answer',
          createdAtMs: 100,
        },
        {
          id: 'haiku-1',
          seq: 2,
          kind: 'haiku',
          role: 'outgoing',
          status: 'streaming',
          text: 'Working on it',
          createdAtMs: 110,
          insertAfterId: 'stt:live',
        },
      ],
    });

    expect(buildCompanionConversationFeedMessages(snapshot).map((message) => message.id)).toEqual([
      'mic-1',
      'haiku-1',
    ]);
  });
});

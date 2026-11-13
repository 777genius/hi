import { describe, expect, it } from 'vitest';
import { isCompanionSnapshotEnvelope } from './snapshotEpoch';
import { buildCompanionConversationFeedMessages } from '@/presentation/companionFeed';

function validSnapshot() {
  return {
    revision: '42',
    data: {
      authRequired: false,
      controls: { companionModeEnabled: true, instanceId: 'server-a' },
      microphone: { appMuted: false },
      recording: { status: 'Idle' },
      live: {},
      timeline: [{
        id: 'stt:1', seq: 1, kind: 'stt', role: 'incoming', status: 'final',
        text: 'Русский / українська / 🎙️', createdAtMs: 1234,
      }],
    },
  };
}

const corruptions: Array<[string, (data: Record<string, unknown>) => void]> = [
  ['missing live state', (data) => { delete data.live; }],
  ['null live state', (data) => { data.live = null; }],
  ['null timeline entry', (data) => { data.timeline = [null]; }],
  ['non-string message id', (data) => { data.timeline = [{ ...validSnapshot().data.timeline[0], id: 7 }]; }],
  ['non-string message text', (data) => { data.timeline = [{ ...validSnapshot().data.timeline[0], text: {} }]; }],
  ['invalid attachment list', (data) => { data.timeline = [{ ...validSnapshot().data.timeline[0], attachments: {} }]; }],
  ['null attachment', (data) => { data.timeline = [{ ...validSnapshot().data.timeline[0], attachments: [null] }]; }],
  ['invalid candidate list', (data) => { data.timeline = [{ ...validSnapshot().data.timeline[0], candidates: {} }]; }],
  ['invalid candidate text', (data) => { data.timeline = [{ ...validSnapshot().data.timeline[0], candidates: [{ id: 'a', text: {} }] }]; }],
  ['duplicate message ids', (data) => { const message = validSnapshot().data.timeline[0]; data.timeline = [message, { ...message, seq: 2 }]; }],
  ['invalid server identity', (data) => { data.controls = { companionModeEnabled: true, instanceId: {} }; }],
  ['missing auth state', (data) => { delete data.authRequired; }],
];

describe('Companion snapshot safety before revision acknowledgement', () => {
  it.each(corruptions)('rejects %s even with a much higher revision', (_name, corrupt) => {
    const snapshot = validSnapshot();
    snapshot.revision = '999999';
    corrupt(snapshot.data);
    expect(isCompanionSnapshotEnvelope(snapshot)).toBe(false);
  });

  it('accepts a valid server snapshot and renders Unicode without throwing', () => {
    const snapshot: unknown = validSnapshot();
    expect(isCompanionSnapshotEnvelope(snapshot)).toBe(true);
    if (!isCompanionSnapshotEnvelope(snapshot)) throw new Error('valid fixture rejected');
    expect(buildCompanionConversationFeedMessages(snapshot)[0]?.text).toBeUndefined();
  });

  it('preserves optional legacy fields and unknown future fields', () => {
    const snapshot = validSnapshot();
    const data: Record<string, unknown> = snapshot.data;
    data.controls = { companionModeEnabled: true, instanceId: null };
    data.futureCapability = { version: 2 };
    expect(isCompanionSnapshotEnvelope(snapshot)).toBe(true);
  });
});

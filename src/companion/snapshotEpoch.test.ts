import { describe, expect, it } from 'vitest';
import type { CompanionSnapshotData, TauriSnapshotEnvelope } from '@/windowing/stateSync';
import { isCompanionSnapshotEnvelope, shouldApplyCompanionSnapshot } from './snapshotEpoch';

function snapshot(revision: string, instanceId?: string): TauriSnapshotEnvelope<CompanionSnapshotData> {
  return {
    revision: revision as TauriSnapshotEnvelope<CompanionSnapshotData>['revision'],
    data: {
      controls: { instanceId } as CompanionSnapshotData['controls'],
    } as CompanionSnapshotData,
  };
}

describe('Companion snapshot epochs', () => {
  it('rejects stale updates inside the current server instance', () => {
    expect(shouldApplyCompanionSnapshot(snapshot('8', 'server-a'), 9, 'server-a')).toBe(false);
    expect(shouldApplyCompanionSnapshot(snapshot('9', 'server-a'), 9, 'server-a')).toBe(true);
    expect(shouldApplyCompanionSnapshot(snapshot('10', 'server-a'), 9, 'server-a')).toBe(true);
  });

  it('accepts lower revisions after a desktop restart with persisted bearer token', () => {
    expect(shouldApplyCompanionSnapshot(snapshot('1', 'server-b'), 2400, 'server-a')).toBe(true);
  });

  it('does not treat missing instance identity as proof of a new epoch', () => {
    expect(shouldApplyCompanionSnapshot(snapshot('1'), 2400, 'server-a')).toBe(false);
    expect(shouldApplyCompanionSnapshot(snapshot('1', 'server-a'), 2400, null)).toBe(false);
  });

  it('rejects corrupt revisions rather than reverting the phone to an empty snapshot', () => {
    expect(shouldApplyCompanionSnapshot(snapshot('invalid', 'server-a'), 1, 'server-a')).toBe(false);
    expect(shouldApplyCompanionSnapshot(snapshot('-5', 'server-a'), 1, 'server-a')).toBe(false);
  });
});

describe('Companion transport envelope validation', () => {
  const valid = {
    revision: '5',
    data: {
      authRequired: false,
      live: {},
      controls: { companionModeEnabled: true, instanceId: 'server-a' },
      recording: { status: 'Recording' },
      microphone: { appMuted: false },
      timeline: [],
    },
  };

  it('requires the state fields needed for mobile synchronization', () => {
    expect(isCompanionSnapshotEnvelope(valid)).toBe(true);
    expect(isCompanionSnapshotEnvelope({})).toBe(false);
    expect(isCompanionSnapshotEnvelope({ revision: '2', data: {} })).toBe(false);
    expect(isCompanionSnapshotEnvelope({ ...valid, revision: 'broken' })).toBe(false);
    expect(isCompanionSnapshotEnvelope({ ...valid, revision: '-1' })).toBe(false);
    expect(isCompanionSnapshotEnvelope({ ...valid, data: { ...valid.data, timeline: null } })).toBe(false);
    expect(isCompanionSnapshotEnvelope({ ...valid, data: { ...valid.data, microphone: null } })).toBe(false);
    expect(isCompanionSnapshotEnvelope({ ...valid, data: { ...valid.data, microphone: { appMuted: 'no' } } })).toBe(false);
  });
});

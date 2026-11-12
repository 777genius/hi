import type { CompanionSnapshotData, TauriSnapshotEnvelope } from '@/windowing/stateSync';

type CompanionSnapshot = TauriSnapshotEnvelope<CompanionSnapshotData>;

/** Companion revisions are monotonic only inside one desktop server instance. */
export function shouldApplyCompanionSnapshot(
  next: CompanionSnapshot,
  currentRevision: number,
  currentInstanceId: string | null,
): boolean {
  const revision = Number(next.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return false;

  const nextInstanceId = next.data?.controls?.instanceId ?? null;
  if (currentInstanceId && nextInstanceId && currentInstanceId !== nextInstanceId) {
    return true;
  }
  return revision >= currentRevision;
}

/** Validate untrusted HTTP/SSE bodies before acknowledging transport health. */
export function isCompanionSnapshotEnvelope(value: unknown): value is CompanionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<CompanionSnapshot>;
  if (typeof envelope.revision !== 'string' || !/^\\d+$/.test(envelope.revision)) return false;
  const revision = Number(envelope.revision);
  if (!Number.isSafeInteger(revision)) return false;
  const data = envelope.data;
  return !!data
    && typeof data === 'object'
    && !!data.controls
    && typeof data.controls.companionModeEnabled === 'boolean'
    && !!data.recording
    && typeof data.recording.status === 'string'
    && Array.isArray(data.timeline);
}

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

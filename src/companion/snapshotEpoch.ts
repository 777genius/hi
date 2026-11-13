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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

function optionalArray(value: unknown, valid: (item: unknown) => boolean): boolean {
  return value == null || (Array.isArray(value) && value.every(valid));
}

function validMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.text === 'string'
    && typeof value.kind === 'string' && typeof value.role === 'string' && typeof value.status === 'string'
    && Number.isSafeInteger(value.seq) && Number(value.seq) >= 0
    && typeof value.createdAtMs === 'number' && Number.isFinite(value.createdAtMs)
    && optionalText(value.insertAfterId) && optionalText(value.activeCandidateId)
    && optionalArray(value.attachments, (attachment) => isRecord(attachment)
      && typeof attachment.id === 'string' && typeof attachment.mime === 'string'
      && typeof attachment.dataUrl === 'string')
    && optionalArray(value.candidates, (candidate) => isRecord(candidate)
      && typeof candidate.id === 'string'
      && ['label', 'provider', 'model', 'status', 'text', 'error'].every((key) => optionalText(candidate[key])));
}

/** Validate fields the feed dereferences before acknowledging a new revision. */
export function isCompanionSnapshotEnvelope(value: unknown): value is CompanionSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value.revision !== 'string' || !/^[0-9]+$/.test(value.revision)) return false;
  if (!Number.isSafeInteger(Number(value.revision))) return false;
  const data = value.data;
  if (!isRecord(data)
    || typeof data.authRequired !== 'boolean'
    || !isRecord(data.controls) || typeof data.controls.companionModeEnabled !== 'boolean'
    || !optionalText(data.controls.instanceId)
    || !isRecord(data.microphone) || typeof data.microphone.appMuted !== 'boolean'
    || !isRecord(data.recording) || typeof data.recording.status !== 'string'
    || !isRecord(data.live)
    || !Array.isArray(data.timeline)) return false;

  // Partial strings are optional, but the containing object is not. Accept
  // unknown fields so adding server capabilities does not break older phones.
  const live = data.live;
  if (!['partialText', 'finalText', 'microphonePartialText'].every((key) => optionalText(live[key]))) return false;
  const ids = new Set<string>();
  for (const message of data.timeline) {
    if (!validMessage(message)) return false;
    const id = (message as Record<string, unknown>).id as string;
    if (ids.has(id)) return false; // Duplicate Vue keys can silently reuse the wrong row.
    ids.add(id);
  }
  return true;
}

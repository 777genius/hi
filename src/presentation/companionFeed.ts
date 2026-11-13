import type {
  ConversationFeedAttachment,
  ConversationFeedMessage,
  ConversationLlmCandidate,
} from './conversationFeed';
import type { CompanionSnapshotData } from '@/windowing/stateSync';

const LIVE_STT_MESSAGE_ID = 'stt:live';
const LIVE_MIC_MESSAGE_ID = 'mic:live';
const LIVE_STT_SEQ = 9_000_000;
const LIVE_MIC_SEQ = 9_000_001;
const LIVE_DUPLICATE_WINDOW_MS = 2_500;
const FEED_KINDS = new Set<ConversationFeedMessage['kind']>(['stt', 'mic', 'signal', 'haiku', 'prompt']);
const FEED_ROLES = new Set<ConversationFeedMessage['role']>(['incoming', 'outgoing']);
const FEED_STATUSES = new Set<ConversationFeedMessage['status']>(['final', 'streaming', 'error']);

function sortByTimelineOrder(a: ConversationFeedMessage, b: ConversationFeedMessage): number {
  return (a.createdAtMs - b.createdAtMs) || (a.seq - b.seq);
}

function toAttachments(
  attachments: CompanionSnapshotData['timeline'][number]['attachments']
): ConversationFeedAttachment[] {
  return (attachments ?? []).map((attachment) => ({
    id: attachment.id,
    kind: 'image' as const,
    mime: attachment.mime,
    dataUrl: attachment.dataUrl,
  }));
}

function toCandidateStatus(status: string | null | undefined): ConversationLlmCandidate['status'] {
  return FEED_STATUSES.has(status as ConversationLlmCandidate['status'])
    ? (status as ConversationLlmCandidate['status'])
    : 'streaming';
}

function toCandidates(
  candidates: CompanionSnapshotData['timeline'][number]['candidates']
): ConversationLlmCandidate[] {
  return (candidates ?? [])
    .filter((candidate) => candidate?.id)
    .map((candidate) => ({
      id: candidate.id,
      label: candidate.label || candidate.id,
      provider: candidate.provider || '',
      model: candidate.model || '',
      status: toCandidateStatus(candidate.status),
      text: candidate.text || '',
      error: candidate.error ?? undefined,
    }));
}

function toFeedMessage(message: CompanionSnapshotData['timeline'][number]): ConversationFeedMessage {
  const kind = FEED_KINDS.has(message.kind as ConversationFeedMessage['kind'])
    ? (message.kind as ConversationFeedMessage['kind'])
    : 'stt';
  const role = FEED_ROLES.has(message.role as ConversationFeedMessage['role'])
    ? (message.role as ConversationFeedMessage['role'])
    : 'incoming';
  const status = FEED_STATUSES.has(message.status as ConversationFeedMessage['status'])
    ? (message.status as ConversationFeedMessage['status'])
    : 'final';

  return {
    id: message.id,
    kind,
    role,
    status,
    text: message.text,
    createdAtMs: message.createdAtMs,
    seq: message.seq,
    insertAfterId: message.insertAfterId ?? undefined,
    deleted: !!message.deleted,
    sttIndex: message.sttIndex ?? undefined,
    attachments: toAttachments(message.attachments),
    candidates: toCandidates(message.candidates),
    activeCandidateId: message.activeCandidateId ?? undefined,
  };
}

function normalizeForLiveDedup(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[.,!?;:"'`(){}\[\]<>\-–—_\\/|@#$%^&*+=~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldAppendLiveMessage(
  durable: ConversationFeedMessage[],
  kind: 'stt' | 'mic',
  text: string,
  startedAtMs?: number | null
): boolean {
  const normalizedText = normalizeForLiveDedup(text);
  if (!normalizedText) {
    return false;
  }

  const lastDurable = [...durable]
    .reverse()
    .find((message) => message.kind === kind && !message.deleted && normalizeForLiveDedup(message.text));

  if (!lastDurable) {
    return true;
  }

  const effectiveStartedAtMs = Number.isFinite(startedAtMs)
    ? Number(startedAtMs)
    : Date.now();
  const closeInTime = Math.abs(effectiveStartedAtMs - lastDurable.createdAtMs) <= LIVE_DUPLICATE_WINDOW_MS;
  if (!closeInTime) {
    return true;
  }

  return normalizeForLiveDedup(lastDurable.text) !== normalizedText;
}

function resolveHaikuInsertIndex(
  ordered: ConversationFeedMessage[],
  message: ConversationFeedMessage
): number {
  if (!message.insertAfterId) {
    return -1;
  }

  const directIndex = ordered.findIndex((item) => item.id === message.insertAfterId);
  if (directIndex >= 0) {
    return directIndex;
  }

  if (message.insertAfterId !== LIVE_STT_MESSAGE_ID) {
    return -1;
  }

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const candidate = ordered[index];
    if (candidate.kind !== 'stt') {
      continue;
    }
    if (candidate.id === LIVE_STT_MESSAGE_ID) {
      continue;
    }
    return index;
  }

  return -1;
}

export function buildCompanionConversationFeedMessages(
  snapshot: CompanionSnapshotData | null | undefined
): ConversationFeedMessage[] {
  if (!snapshot) {
    return [];
  }

  const durable = [...(snapshot.timeline ?? [])]
    .sort((a, b) => (a.createdAtMs - b.createdAtMs) || (a.seq - b.seq))
    .map(toFeedMessage);

  const base = durable.filter((message) => message.kind !== 'haiku');

  const livePartialText = String(snapshot.live.partialText ?? '').trim();
  if (shouldAppendLiveMessage(durable, 'stt', livePartialText, snapshot.live.partialStartedAtMs)) {
    base.push({
      id: LIVE_STT_MESSAGE_ID,
      kind: 'stt',
      role: 'incoming',
      status: 'streaming',
      text: livePartialText,
      createdAtMs: Number(snapshot.live.partialStartedAtMs || Date.now()),
      seq: LIVE_STT_SEQ,
    });
  }

  const liveMicrophoneText = String(snapshot.live.microphonePartialText ?? '').trim();
  if (
    shouldAppendLiveMessage(
      durable,
      'mic',
      liveMicrophoneText,
      snapshot.live.microphonePartialStartedAtMs
    )
  ) {
    base.push({
      id: LIVE_MIC_MESSAGE_ID,
      kind: 'mic',
      role: 'outgoing',
      status: 'streaming',
      text: liveMicrophoneText,
      createdAtMs: Number(snapshot.live.microphonePartialStartedAtMs || Date.now()),
      seq: LIVE_MIC_SEQ,
    });
  }

  base.sort(sortByTimelineOrder);

  const ordered = [...base];
  const haikuMessages = durable
    .filter((message) => message.kind === 'haiku')
    .sort(sortByTimelineOrder);

  for (const message of haikuMessages) {
    if (!message.insertAfterId) {
      ordered.push(message);
      continue;
    }

    let insertIndex = resolveHaikuInsertIndex(ordered, message);
    if (insertIndex >= 0) {
      // Несколько ответов к одному вопросу идут в порядке создания: пропускаем уже вставленные ответы,
      // иначе каждый следующий окажется выше предыдущего (порядок наоборот).
      while (ordered[insertIndex + 1]?.kind === 'haiku') {
        insertIndex += 1;
      }
      ordered.splice(insertIndex + 1, 0, message);
    } else {
      ordered.push(message);
    }
  }

  return ordered;
}

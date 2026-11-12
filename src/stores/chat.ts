import { defineStore } from 'pinia';
import { computed, nextTick, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriAvailable } from '../utils/tauri';
import type { CompanionSnapshotData } from '@/windowing/stateSync';
import { CMD_SET_COMPANION_SYSTEM_PROMPT } from '@/windowing/stateSync';
import {
  EVENT_HAIKU_CANDIDATE_START,
  EVENT_HAIKU_DELTA,
  EVENT_HAIKU_DONE,
  EVENT_HAIKU_ERROR,
  EVENT_MICROPHONE_MUTE_STATE,
  EVENT_SIGNAL_MESSAGE,
  EVENT_TRANSCRIPTION_FINAL,
  EVENT_TRANSCRIPTION_PARTIAL,
  type FinalTranscriptionPayload,
  type HaikuCandidateStartPayload,
  type HaikuDeltaPayload,
  type HaikuDonePayload,
  type HaikuErrorPayload,
  type MicrophoneMuteStatePayload,
  type PartialTranscriptionPayload,
  type SignalMessagePayload,
} from '../types';
import { appendTranscriptText, mergeTranscriptText } from '../utils/transcriptionText';
import {
  selectContextParts,
  type ContextRetentionPart,
} from '@/presentation/contextRetention';
import { useTranscriptionStore } from './transcription';
import { dataUrlToBase64 } from '@/utils/promptImages';

type ChatMessageKind = 'stt' | 'haiku' | 'mic' | 'prompt' | 'signal';
type ChatMessageRole = 'incoming' | 'outgoing';
type ChatMessageStatus = 'final' | 'streaming' | 'error';

export type ChatAttachment =
  | {
      id: string;
      kind: 'image';
      mime: string;
      dataUrl: string;
    };

export interface ChatLlmCandidate {
  id: string;
  label: string;
  provider: string;
  model: string;
  status: ChatMessageStatus;
  text: string;
  error?: string;
}

export interface ChatMessage {
  id: string;
  kind: ChatMessageKind;
  role: ChatMessageRole;
  status: ChatMessageStatus;
  text: string;
  createdAtMs: number;
  seq: number;
  // Для вставки ответа LLM в середину чата (после выбранного сообщения).
  insertAfterId?: string;
  deleted?: boolean;
  // Для STT сообщений: индекс utterance, чтобы выбирать anchor
  sttIndex?: number;
  attachments?: ChatAttachment[];
  candidates?: ChatLlmCandidate[];
  activeCandidateId?: string;
}

type MemoryRequestEvidencePayload = {
  id: string;
  label: string;
  text: string;
};

type MemoryContextEvidencePayload = {
  selectedMessages: MemoryRequestEvidencePayload[];
  currentCode: MemoryRequestEvidencePayload[];
  recentTimeline: MemoryRequestEvidencePayload[];
};

type ChatContextRetentionPart = ContextRetentionPart & {
  id: string;
  kind: ChatMessageKind;
};

const MIN_HOVER_TRIGGER_MS = 120;
const MIC_DOMINANCE_HOLD_MS = 1200;
const LIVE_STT_MESSAGE_ID = 'stt:live';
const LIVE_MIC_MESSAGE_ID = 'mic:live';
const DEFAULT_SYSTEM_PROMPT = `Ты — ассистент на техническом собеседовании. Отвечай по-русски.

Контекст ниже — транскрипция, возможны ошибки распознавания. В нём есть строки:
- "ОС:" — то, что я слышу (обычно реплики собеседника/вопросы).
- "МИКРОФОН:" — то, что говорю я (мои ответы/мысли/иногда могу повторить вопрос).
- "ПОМОЩНИК:" — предыдущие ответы ассистента (можно использовать как контекст).
- "ЗАПРОС:" — мой ручной вопрос/вставка, если я явно отправил сообщение в AI.

Твоя задача:
1) Если есть свежий "ЗАПРОС:" — ответь на него, используя "ОС:", "МИКРОФОН:" и "ПОМОЩНИК:" как контекст.
2) Если "ЗАПРОС:" нет — найди последний явный или неявный вопрос/задачу: в первую очередь из строк "ОС:". Если строк "ОС:" нет — используй строки "МИКРОФОН:".
3) Дать лучший краткий ответ по делу (без воды), можно с короткими примерами/шагами.
4) Если речь распознана неточно, выбери наиболее вероятный смысл и ответь прямо, без уточняющих вопросов.
5) Возможно в вопросах не будет "?". Ты должен понимать где вопросы.

Формат ответа:
- По умолчанию отвечай коротким связным абзацем. Список нужен только для действительно нескольких пунктов или если его попросили.
- Затем (если нужно) короткий пример кода.
- Не пересказывай весь контекст и не цитируй теги "ОС:"/"МИКРОФОН:"/"ПОМОЩНИК:"/"ЗАПРОС:".

Правила для кода:
- Если приводишь код, выводи его в Markdown fenced-блоке:
  \`\`\`<language>
  ...код...
  \`\`\`
- Вместо <language> подставляй реальный язык (например: dart, ts, js, python, go, rust, bash, sql).
- Для упоминаний технических идентификаторов (имя переменной/класса/функции/пакета/файла/поля/метода) используй inline code в Markdown (одинарные обратные кавычки).
- Если это именно код (даже короткий фрагмент/выражение) и важна подсветка — используй fenced-блок с языком.
- Код должен быть ровно отформатирован: без нумерации строк, с корректными отступами, без мусорных префиксов.
- Старайся давать минимально‑самодостаточный пример, который иллюстрирует главную идею (как на собеседовании).
- Если полный код слишком длинный, допускается сокращать только с помощью комментариев соответствующего языка (например "// ...", "# ...", "/* ... */") и после блока 1 строкой объяснить, что именно опущено. Не вставляй голые "..." как код.`;
const SYSTEM_PROMPT_STORAGE_KEY = 'llmSystemPrompt';
const LEGACY_SYSTEM_PROMPT_STORAGE_KEY = 'anthropicSystemPrompt';
const OPENAI_RESPONSES_WEB_SEARCH_STORAGE_KEY = 'openaiResponsesWebSearchEnabledV2';

export const useChatStore = defineStore('chat', () => {
  const transcription = useTranscriptionStore();

  const anchorMode = ref<'tail' | 'fixed'>('tail');
  const anchorSttIndex = ref<number>(0);
  const anchorCharOffset = ref<number>(0);

  function readStoredSystemPrompt(): string | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const v = localStorage.getItem(SYSTEM_PROMPT_STORAGE_KEY);
      if (v) return v;
      const legacy = localStorage.getItem(LEGACY_SYSTEM_PROMPT_STORAGE_KEY);
      if (legacy) {
        // Миграция: сохраняем под новым ключом, чтобы больше не зависеть от провайдера.
        localStorage.setItem(SYSTEM_PROMPT_STORAGE_KEY, legacy);
        return legacy;
      }
      return null;
    } catch {
      return null;
    }
  }

  const systemPrompt = ref<string>(readStoredSystemPrompt() || DEFAULT_SYSTEM_PROMPT);

  function readStoredBoolean(key: string, fallback = false): boolean {
    if (typeof localStorage === 'undefined') return fallback;
    try {
      const value = localStorage.getItem(key);
      if (value === '1' || value === 'true') return true;
      if (value === '0' || value === 'false') return false;
    } catch {
      // ignore
    }
    return fallback;
  }

  const openaiResponsesWebSearchEnabled = ref<boolean>(
    readStoredBoolean(OPENAI_RESPONSES_WEB_SEARCH_STORAGE_KEY, false)
  );

  // "Очистка контекста" для LLM без удаления сообщений:
  // новые запросы берут STT только начиная с этого индекса.
  const contextFloorSttIndex = ref<number>(0);
  const contextClearedAtMs = ref<number>(0);

  // Выделение сообщений (для контекста LLM и позиционирования ответа).
  const selectedMessageIds = ref<string[]>([]);

  const haikuMessages = ref<ChatMessage[]>([]);
  const activeHaikuRequests = ref<Record<string, true>>({});
  const lastHoverTriggerAtMs = ref<number>(0);

  const liveSttSinceMs = ref<number>(0);
  const liveMicSinceMs = ref<number>(0);

  // Microphone transcription (best-effort, separate stream)
  const microphoneEnabled = ref<boolean>(true);
  const micMessages = ref<ChatMessage[]>([]);
  const promptMessages = ref<ChatMessage[]>([]);
  const signalMessages = ref<ChatMessage[]>([]);
  const micPartialText = ref<string>('');
  const micAccumulatedText = ref<string>('');
  const micCurrentUtteranceStart = ref<number>(-1);
  const micLastFinalizedText = ref<string>('');
  const systemAudioLevel = ref<number>(0);
  const micAudioLevel = ref<number>(0);
  const micDominantUntilMs = ref<number>(0);
  const microphoneMuteSupported = ref<boolean>(false);
  const microphoneMuteSource = ref<string>('unknown');
  const companionModeEnabled = ref<boolean>(false);

  const isHaikuStreaming = computed(() => Object.keys(activeHaikuRequests.value).length > 0);
  const ignoredHaikuRequestIds = ref<Record<string, true>>({});

  const CROSS_STREAM_DEDUP_WINDOW_MS = 8000;
  const CROSS_STREAM_DEDUP_RECENT_LIMIT = 6;

  /**
   * Проверка "системный STT повторяет микрофон".
   *
   * Зачем: в реальности бывает loopback/monitoring, когда микрофонный сигнал попадает в системный звук.
   * Тогда одна и та же фраза распознаётся двумя потоками (source=system и source=microphone) и в UI
   * выглядит как дублирование.
   *
   * Почему фильтруем здесь (а не в `transcription`):
   * - `transcription` — это "источник правды" по системному каналу и используется в других местах,
   *   там нежелательно терять данные.
   * - чат/контекст для LLM — слой представления: можно безопасно скрывать очевидные дубли,
   *   сохранив оригинальные utterances в сторе транскрипции.
   *
   * Как работает:
   * - сравниваем candidate с несколькими последними финальными микрофонными сообщениями (`micMessages`)
   *   в небольшом временном окне (`CROSS_STREAM_DEDUP_WINDOW_MS`).
   * - дополнительно сравниваем с live микрофонным текстом, но только для "свежих" системных событий,
   *   чтобы не влиять на историю при отложенных апдейтах.
   *
   * Ограничения:
   * - если пользователь дословно повторил фразу собеседника (и микрофон доминировал), системная реплика
   *   может быть скрыта как дубль. При этом данные в `transcription.finalUtterances` остаются.
   */
  function isSystemTextDuplicateOfMic(text: string, systemTimestampMs: number): boolean {
    const candidate = String(text ?? '').trim();
    if (!candidate) return false;

    const ts = Number.isFinite(systemTimestampMs) ? systemTimestampMs : Date.now();

    // Сравниваем с последними микрофонными utterances (они появляются только когда микрофон доминирует).
    for (
      let i = micMessages.value.length - 1;
      i >= 0 && micMessages.value.length - i <= CROSS_STREAM_DEDUP_RECENT_LIMIT;
      i--
    ) {
      const m = micMessages.value[i];
      if (!m?.text) continue;
      if (!Number.isFinite(m.createdAtMs)) continue;
      if (Math.abs(ts - m.createdAtMs) > CROSS_STREAM_DEDUP_WINDOW_MS) continue;
      if (isNearDuplicateText(candidate, m.text)) return true;
    }

    // И с текущим live mic (только если событие "свежее", чтобы не влиять на историю).
    const liveMic = liveMicText.value;
    if (liveMic && Math.abs(Date.now() - ts) <= 2500 && isMicDominantNow()) {
      if (isNearDuplicateText(candidate, liveMic)) return true;
    }

    return false;
  }

  const sttMessages = computed<ChatMessage[]>(() =>
    transcription.finalUtterances
      .map((u, idx) => ({
        id: u.id,
        kind: 'stt' as const,
        role: 'incoming' as const,
        status: 'final' as const,
        text: u.text,
        createdAtMs: u.timestamp,
        seq: idx,
        sttIndex: idx,
      }))
      .filter((m) => !isSystemTextDuplicateOfMic(m.text, m.createdAtMs))
  );

  const messages = computed<ChatMessage[]>(() => {
    const base = [
      ...sttMessages.value,
      ...micMessages.value,
      ...signalMessages.value,
      ...promptMessages.value,
      ...haikuMessages.value,
    ];
    if (liveSttMessage.value) base.push(liveSttMessage.value);
    if (liveMicMessage.value) base.push(liveMicMessage.value);
    base.sort((a, b) => (a.createdAtMs - b.createdAtMs) || (a.seq - b.seq));

    return base;
  });

  const livePartialText = computed(() => {
    const accumulated = String(transcription.accumulatedText ?? '').trim();
    const partial = String(transcription.partialText ?? '').trim();
    return mergeTranscriptText(accumulated, partial).trim();
  });
  const liveMicText = computed(() =>
    mergeTranscriptText(micAccumulatedText.value, micPartialText.value).trim()
  );

  watch(
    () => livePartialText.value,
    (next, prev) => {
      const n = String(next ?? '').trim();
      const p = String(prev ?? '').trim();
      if (n && !p) liveSttSinceMs.value = Date.now();
      if (!n) liveSttSinceMs.value = 0;
    },
    { immediate: true }
  );

  watch(
    () => liveMicText.value,
    (next, prev) => {
      const n = String(next ?? '').trim();
      const p = String(prev ?? '').trim();
      if (n && !p) liveMicSinceMs.value = Date.now();
      if (!n) liveMicSinceMs.value = 0;
    },
    { immediate: true }
  );

  const liveSttMessage = computed<ChatMessage | null>(() => {
    const t = livePartialText.value.trim();
    if (!t) return null;
    if (isSystemTextDuplicateOfMic(t, Date.now())) return null;
    return {
      id: LIVE_STT_MESSAGE_ID,
      kind: 'stt',
      role: 'incoming',
      status: 'streaming',
      text: t,
      createdAtMs: liveSttSinceMs.value || Date.now(),
      seq: 9_000_000,
    };
  });

  const liveMicMessage = computed<ChatMessage | null>(() => {
    const t = liveMicText.value.trim();
    if (!t) return null;
    return {
      id: LIVE_MIC_MESSAGE_ID,
      kind: 'mic',
      role: 'outgoing',
      status: 'streaming',
      text: t,
      createdAtMs: liveMicSinceMs.value || Date.now(),
      seq: 9_000_001,
    };
  });

  const hasAnySttText = computed(
    () =>
      (transcription.finalUtterances?.length ?? 0) > 0 ||
      signalMessages.value.some((message) => !message.deleted && !!message.text.trim()) ||
      livePartialText.value.length > 0
  );
  const hasContextToClear = computed(
    () =>
      contextFloorSttIndex.value < (transcription.finalUtterances?.length ?? 0) ||
      [...micMessages.value, ...signalMessages.value, ...promptMessages.value]
        .some((message) =>
          !message.deleted &&
          message.status === 'final' &&
          message.createdAtMs > contextClearedAtMs.value
        )
  );
  const selectedCount = computed(() => selectedMessageIds.value.length);
  const hasSelection = computed(() => selectedCount.value > 0);

  const selectedSet = computed<Set<string>>(() => new Set(selectedMessageIds.value));

  function primaryCandidate(message: ChatMessage): ChatLlmCandidate | null {
    return (
      message.candidates?.find((candidate) => candidate.id === 'anthropic') ??
      message.candidates?.[0] ??
      null
    );
  }

  function activeCandidate(message: ChatMessage): ChatLlmCandidate | null {
    if (!message.candidates?.length) return null;
    const activeId = message.activeCandidateId || primaryCandidate(message)?.id;
    return message.candidates.find((candidate) => candidate.id === activeId) ?? primaryCandidate(message);
  }

  function assistantTextForContext(message: ChatMessage): string {
    if (message.kind !== 'haiku') return String(message.text ?? '').trim();
    const selectedCandidate = activeCandidate(message);
    const activeText = String(selectedCandidate?.text ?? '').trim();
    if (activeText) return activeText;
    const primaryText = String(primaryCandidate(message)?.text ?? '').trim();
    return primaryText || String(message.text ?? '').trim();
  }

  function textForContext(message: ChatMessage): string {
    return message.kind === 'haiku' ? assistantTextForContext(message) : String(message.text ?? '').trim();
  }

  function formatMessageForContext(message: ChatMessage): string {
    const text = textForContext(message);
    if (!text) return '';
    if (message.kind === 'mic') return `МИКРОФОН: ${text}`;
    if (message.kind === 'prompt') return `ЗАПРОС: ${text}`;
    if (message.kind === 'stt' || message.kind === 'signal') return `ОС: ${text}`;
    if (message.kind === 'haiku') return `ПОМОЩНИК: ${text}`;
    return text;
  }

  function memoryLabelForMessageKind(kind: ChatMessageKind): string {
    if (kind === 'stt') return 'system_audio';
    if (kind === 'mic') return 'microphone';
    if (kind === 'signal') return 'signal';
    if (kind === 'prompt') return 'manual_prompt';
    if (kind === 'haiku') return 'assistant';
    return 'recent_timeline';
  }

  function contextLineEvidenceText(line: string): string {
    const trimmed = String(line ?? '').trim();
    for (const prefix of ['ОС:', 'МИКРОФОН:', 'ЗАПРОС:', 'ПОМОЩНИК:']) {
      if (trimmed.startsWith(prefix)) {
        return trimmed.slice(prefix.length).trimStart();
      }
    }
    return trimmed;
  }

  function buildMemoryContextEvidenceFromParts(
    parts: readonly ChatContextRetentionPart[],
    options: { selectedOnly?: boolean } = {}
  ): MemoryContextEvidencePayload {
    const evidence: MemoryContextEvidencePayload = {
      selectedMessages: [],
      currentCode: [],
      recentTimeline: [],
    };

    for (const part of parts) {
      const text = contextLineEvidenceText(part.line);
      if (!text) continue;

      if (part.id.startsWith('focus-copy:')) {
        evidence.currentCode.push({
          id: part.id,
          label: 'current_code',
          text,
        });
        continue;
      }

      const item = {
        id: part.id,
        label: memoryLabelForMessageKind(part.kind),
        text,
      };

      if (options.selectedOnly) {
        evidence.selectedMessages.push(item);
      } else {
        evidence.recentTimeline.push(item);
      }
    }

    return evidence;
  }

  function normalizeForDedup(v: string): string {
    return String(v ?? '')
      .toLowerCase()
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[.,!?;:"'`(){}\[\]<>\-–—_\\/|@#$%^&*+=~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function jaccard(a: string, b: string): number {
    const aa = normalizeForDedup(a).split(' ').filter(Boolean);
    const bb = normalizeForDedup(b).split(' ').filter(Boolean);
    if (aa.length === 0 || bb.length === 0) return 0;
    const A = new Set(aa);
    const B = new Set(bb);
    let inter = 0;
    for (const t of A) if (B.has(t)) inter += 1;
    const union = A.size + B.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  function isNearDuplicateText(a: string, b: string): boolean {
    const na = normalizeForDedup(a);
    const nb = normalizeForDedup(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const minLen = Math.min(na.length, nb.length);
    const maxLen = Math.max(na.length, nb.length);
    if (minLen >= 10 && (na.includes(nb) || nb.includes(na)) && minLen / maxLen >= 0.85) return true;
    return jaccard(na, nb) >= 0.9;
  }

  function isMicTextDuplicateOfSystem(text: string, nowMs: number): boolean {
    const candidate = String(text ?? '').trim();
    if (!candidate) return false;

    // Сравниваем с последними системными utterances (динамики).
    const recent = transcription.finalUtterances ?? [];
    for (let i = recent.length - 1; i >= 0 && recent.length - i <= 6; i--) {
      const u = recent[i];
      if (!u) continue;
      // по времени — только последние ~20 секунд
      if (Number.isFinite(nowMs) && Number.isFinite(u.timestamp) && nowMs - u.timestamp > 20_000) continue;
      if (isNearDuplicateText(candidate, u.text)) return true;
    }

    // И с текущим live partial от динамиков.
    const sysLive = livePartialText.value;
    if (sysLive && isNearDuplicateText(candidate, sysLive)) return true;

    return false;
  }

  function uniqStable(ids: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function isSelected(id: string): boolean {
    return selectedSet.value.has(id);
  }

  function isSelectableMessage(message: ChatMessage | undefined): boolean {
    return !!message && !message.deleted && message.kind !== 'haiku' && message.status === 'final';
  }

  function filterSelectableIds(ids: string[]): string[] {
    const next = uniqStable(ids);
    const allowed = new Set(
      messages.value
        .filter((message) => isSelectableMessage(message))
        .map((message) => message.id)
    );
    return next.filter((id) => allowed.has(id));
  }

  function clearSelection(): void {
    selectedMessageIds.value = [];
  }

  function setSelection(ids: string[], additive: boolean = false): void {
    const next = filterSelectableIds(ids);
    if (!additive) {
      selectedMessageIds.value = next;
      return;
    }
    selectedMessageIds.value = uniqStable([...selectedMessageIds.value, ...next]);
  }

  function toggleSelection(id: string): void {
    const [selectableId] = filterSelectableIds([id]);
    if (!selectableId) return;
    const ids = filterSelectableIds(selectedMessageIds.value);
    if (ids.includes(selectableId)) {
      selectedMessageIds.value = ids.filter((x) => x !== selectableId);
    } else {
      selectedMessageIds.value = uniqStable([...ids, selectableId]);
    }
  }

  function selectOnly(id: string): void {
    selectedMessageIds.value = filterSelectableIds([id]);
  }

  function editMessageText(messageId: string, nextText: string): void {
    const t = String(nextText ?? '').trim();
    if (!t) return;

    // STT: редактируем в transcription store, чтобы контекст/отображение было единым.
    if (messageId.startsWith('stt:')) {
      transcription.editFinalUtterance(messageId, t);
      return;
    }

    // MIC: редактируем локальный список.
    const micIdx = micMessages.value.findIndex((m) => m.id === messageId);
    if (micIdx >= 0) {
      micMessages.value[micIdx] = { ...micMessages.value[micIdx], text: t };
      return;
    }

    // SIGNAL: отдельный внешний входящий источник, но в контексте ведёт себя как ОС.
    const signalIdx = signalMessages.value.findIndex((m) => m.id === messageId);
    if (signalIdx >= 0) {
      signalMessages.value[signalIdx] = { ...signalMessages.value[signalIdx], text: t };
      return;
    }

    // PROMPT: редактируем локальный список.
    const pIdx = promptMessages.value.findIndex((m) => m.id === messageId);
    if (pIdx >= 0) {
      promptMessages.value[pIdx] = { ...promptMessages.value[pIdx], text: t };
    }
  }

  function deleteMessage(messageId: string): void {
    const baseBefore = messages.value.filter((m) => m.kind !== 'haiku');
    const idxBefore = baseBefore.findIndex((m) => m.id === messageId);
    const prevBaseId = idxBefore > 0 ? baseBefore[idxBefore - 1]?.id : undefined;

    selectedMessageIds.value = selectedMessageIds.value.filter((id) => id !== messageId);

    // STT
    if (messageId.startsWith('stt:')) {
      transcription.deleteFinalUtterance(messageId);
      // Если у haiku был якорь на удалённое сообщение — пытаемся привязать к предыдущему base-сообщению.
      haikuMessages.value = haikuMessages.value.map((h) =>
        h.insertAfterId === messageId ? { ...h, insertAfterId: prevBaseId } : h
      );
      return;
    }

    // MIC
    const micIdx = micMessages.value.findIndex((m) => m.id === messageId);
    if (micIdx >= 0) {
      micMessages.value.splice(micIdx, 1);
      haikuMessages.value = haikuMessages.value.map((h) =>
        h.insertAfterId === messageId ? { ...h, insertAfterId: prevBaseId } : h
      );
      return;
    }

    // SIGNAL
    const signalIdx = signalMessages.value.findIndex((m) => m.id === messageId);
    if (signalIdx >= 0) {
      signalMessages.value.splice(signalIdx, 1);
      haikuMessages.value = haikuMessages.value.map((h) =>
        h.insertAfterId === messageId ? { ...h, insertAfterId: prevBaseId } : h
      );
      return;
    }

    // PROMPT
    const pIdx = promptMessages.value.findIndex((m) => m.id === messageId);
    if (pIdx >= 0) {
      promptMessages.value.splice(pIdx, 1);
      haikuMessages.value = haikuMessages.value.map((h) =>
        h.insertAfterId === messageId ? { ...h, insertAfterId: prevBaseId } : h
      );
      return;
    }

    // HAIKU
    const hIdx = haikuMessages.value.findIndex((m) => m.id === messageId);
    if (hIdx >= 0) {
      ignoredHaikuRequestIds.value = { ...ignoredHaikuRequestIds.value, [messageId]: true };
      haikuMessages.value[hIdx] = {
        ...haikuMessages.value[hIdx],
        deleted: true,
        status: 'final',
        text: 'Сообщение удалено',
      };
      markRequestDone(messageId);
    }
  }

  function sanitizeSystemPrompt(v: string): string {
    const t = String(v ?? '').trim();
    return t.length > 0 ? t : DEFAULT_SYSTEM_PROMPT;
  }

  function saveSystemPrompt(next: string): void {
    const v = sanitizeSystemPrompt(next);
    systemPrompt.value = v;
    try {
      localStorage.setItem(SYSTEM_PROMPT_STORAGE_KEY, v);
      // Best-effort: поддерживаем старый ключ, чтобы не ломать обратную совместимость.
      localStorage.setItem(LEGACY_SYSTEM_PROMPT_STORAGE_KEY, v);
    } catch {
      // ignore
    }
    void syncCompanionSystemPrompt();
  }

  function setOpenAiResponsesWebSearchEnabled(enabled: boolean): void {
    openaiResponsesWebSearchEnabled.value = !!enabled;
  }

  function toggleOpenAiResponsesWebSearch(): void {
    setOpenAiResponsesWebSearchEnabled(!openaiResponsesWebSearchEnabled.value);
  }

  watch(
    () => openaiResponsesWebSearchEnabled.value,
    (enabled) => {
      try {
        localStorage.setItem(OPENAI_RESPONSES_WEB_SEARCH_STORAGE_KEY, enabled ? '1' : '0');
      } catch {
        // ignore
      }
    }
  );

  async function syncCompanionSystemPrompt(): Promise<void> {
    if (!isTauriAvailable()) return;
    try {
      await invoke(CMD_SET_COMPANION_SYSTEM_PROMPT, {
        prompt: sanitizeSystemPrompt(systemPrompt.value),
      });
    } catch (err) {
      console.warn('Failed to sync companion system prompt:', err);
    }
  }
  function isMicDominantNow(nowMs: number = Date.now()): boolean {
    return nowMs < micDominantUntilMs.value;
  }

  function updateMicDominance(nowMs: number): void {
    const mic = Math.max(0, Math.min(1, Number(micAudioLevel.value || 0)));
    const sys = Math.max(0, Math.min(1, Number(systemAudioLevel.value || 0)));

    // Абсолютный порог (иначе "шевеление" микрофона будет считаться доминированием)
    if (mic < 0.08) return;

    // Доминирование микрофона: заметно громче системного аудио.
    // Если системного аудио нет/очень тихо, достаточно абсолютного порога выше.
    const dominant = sys < 0.02 ? mic >= 0.10 : mic >= sys * 1.8 || mic >= sys + 0.12;
    if (dominant) {
      micDominantUntilMs.value = Math.max(micDominantUntilMs.value, nowMs + MIC_DOMINANCE_HOLD_MS);
    }
  }

  function normalizeAnchor(): void {
    const maxIdx = (transcription.finalUtterances?.length ?? 0) - 1;
    if (maxIdx < 0) {
      anchorSttIndex.value = 0;
      anchorCharOffset.value = 0;
      anchorMode.value = 'tail';
      contextFloorSttIndex.value = 0;
      return;
    }

    if (anchorMode.value === 'tail') {
      anchorSttIndex.value = maxIdx;
      anchorCharOffset.value = 0;
      return;
    }

    if (anchorSttIndex.value > maxIdx) anchorSttIndex.value = maxIdx;
    if (anchorSttIndex.value < 0) anchorSttIndex.value = 0;
    if (anchorCharOffset.value < 0) anchorCharOffset.value = 0;
  }

  watch(
    () => sttMessages.value.length,
    () => normalizeAnchor(),
    { immediate: true }
  );

  // Если Haiku был заякорен на live-partial, то после появления финального STT
  // переякориваем его на последний финальный STT id — чтобы ответ не "оставался внизу".
  watch(
    () => transcription.finalUtterances?.length ?? 0,
    (next, prev) => {
      if (next <= prev) return;
      const last = transcription.finalUtterances?.[next - 1];
      if (!last?.id) return;
      if (!haikuMessages.value.some((h) => h.insertAfterId === LIVE_STT_MESSAGE_ID)) return;
      haikuMessages.value = haikuMessages.value.map((h) =>
        h.insertAfterId === LIVE_STT_MESSAGE_ID ? { ...h, insertAfterId: last.id } : h
      );
    }
  );

  function setAnchorToSttIndex(index: number): void {
    anchorMode.value = 'fixed';
    anchorSttIndex.value = index;
    anchorCharOffset.value = 0;
    normalizeAnchor();
  }

  function setAnchorToSttSelection(index: number, charOffset: number): void {
    anchorMode.value = 'fixed';
    anchorSttIndex.value = index;
    anchorCharOffset.value = Math.max(0, Math.floor(charOffset));
    normalizeAnchor();
  }

  function followTail(): void {
    anchorMode.value = 'tail';
    anchorCharOffset.value = 0;
    normalizeAnchor();
  }

  function clearLlmContext(): void {
    contextFloorSttIndex.value = transcription.finalUtterances?.length ?? 0;
    contextClearedAtMs.value = Date.now();
    followTail();
  }

  function isMessageOutOfContext(msg: ChatMessage): boolean {
    if (msg.kind === 'stt') {
      const idx = typeof msg.sttIndex === 'number' ? msg.sttIndex : -1;
      return idx >= 0 && idx < contextFloorSttIndex.value;
    }
    return contextClearedAtMs.value > 0 && msg.createdAtMs <= contextClearedAtMs.value;
  }

  function messageToContextPart(message: ChatMessage): ChatContextRetentionPart | null {
    const line = formatMessageForContext(message);
    if (!line) return null;
    return {
      id: message.id,
      kind: message.kind,
      line,
    };
  }

  function buildHaikuContext(options: {
    selectionMode?: 'respect' | 'ignore';
    includeFullHistory?: boolean;
  } = {}): { text: string; parts: ChatContextRetentionPart[] } {
    const parts: ChatContextRetentionPart[] = [];
    const selectionMode = options.selectionMode ?? 'respect';

    if (selectionMode === 'respect' && hasSelection.value) {
      const selected = selectedSet.value;
      for (const msg of messages.value) {
        if (!selected.has(msg.id)) continue;
        if (msg.deleted) continue;
        if (msg.kind === 'haiku' && msg.status !== 'final') continue;
        const part = messageToContextPart(msg);
        if (part) parts.push(part);
      }

      const selectedParts = selectContextParts(parts);
      return {
        text: selectedParts.map((part) => part.line).join('\n'),
        parts: selectedParts,
      };
    }

    // Если ничего не выделено — отправляем весь контекст (в порядке чата).
    for (const msg of messages.value) {
      if (msg.deleted) continue;
      if (msg.kind === 'haiku' && msg.status !== 'final') continue;
      if (!options.includeFullHistory && isMessageOutOfContext(msg)) continue;
      const part = messageToContextPart(msg);
      if (part) parts.push(part);
    }

    const selectedParts = selectContextParts(parts);
    return {
      text: selectedParts.map((part) => part.line).join('\n'),
      parts: selectedParts,
    };
  }

  function buildHaikuContextText(): string {
    return buildHaikuContext({ selectionMode: 'respect' }).text;
  }

  function resolveInsertAfterId(): string | undefined {
    if (hasSelection.value) {
      const selected = selectedSet.value;
      let last: string | undefined = undefined;
      for (const msg of messages.value) {
        if (selected.has(msg.id)) last = msg.id;
      }
      return last;
    }

    if (liveSttMessage.value) {
      return LIVE_STT_MESSAGE_ID;
    }

    // По умолчанию (без выделения) фиксируем ответ Haiku "в истории" — после последнего base-сообщения
    // на момент запроса. Это убирает эффект, когда старые ответы LLM "уезжают" вниз.
    let lastBaseId: string | undefined = undefined;
    for (const msg of messages.value) {
      if (msg.kind === 'haiku') continue;
      lastBaseId = msg.id;
    }
    return lastBaseId;
  }

  const canRequestHaiku = computed(() => buildHaikuContextText().length > 0);

  function markRequestActive(requestId: string): void {
    activeHaikuRequests.value = { ...activeHaikuRequests.value, [requestId]: true };
  }

  function markRequestDone(requestId: string): void {
    if (!activeHaikuRequests.value[requestId]) return;
    const next = { ...activeHaikuRequests.value };
    delete next[requestId];
    activeHaikuRequests.value = next;
  }

  function upsertHaikuMessage(requestId: string, patch: Partial<ChatMessage>): void {
    const idx = haikuMessages.value.findIndex((m) => m.id === requestId);
    if (idx >= 0) {
      // Важно: insertAfterId сохраняем, если не пришло новое значение.
      const prev = haikuMessages.value[idx];
      haikuMessages.value[idx] = {
        ...prev,
        ...patch,
        insertAfterId: patch.insertAfterId ?? prev.insertAfterId,
      };
      return;
    }

    // Если сообщение ещё не создано (например delta пришёл очень быстро), создаём.
    haikuMessages.value.push({
      id: requestId,
      kind: 'haiku',
      role: 'outgoing',
      status: patch.status ?? 'streaming',
      text: patch.text ?? '',
      createdAtMs: patch.createdAtMs ?? Date.now(),
      seq: patch.seq ?? (2_000_000 + haikuMessages.value.length),
      insertAfterId: patch.insertAfterId,
    });
  }

  function preserveStreamingTextFromLocalState(next: ChatMessage): ChatMessage {
    const current = haikuMessages.value.find((message) => message.id === next.id);
    if (!current) return next;
    if (current.status === 'final' && next.status === 'streaming') return current;

    const merged: ChatMessage = { ...next };
    if (
      current.status === 'streaming'
      && next.status === 'streaming'
      && current.text.length > next.text.length
      && current.text.startsWith(next.text)
    ) {
      merged.text = current.text;
    }

    if (next.candidates?.length && current.candidates?.length) {
      merged.candidates = next.candidates.map((candidate) => {
        const existing = current.candidates?.find((item) => item.id === candidate.id);
        if (
          existing
          && existing.status === 'streaming'
          && candidate.status === 'streaming'
          && existing.text.length > candidate.text.length
          && existing.text.startsWith(candidate.text)
        ) {
          return { ...candidate, text: existing.text };
        }
        return candidate;
      });
    }

    return merged;
  }

  function normalizeCandidateStatus(status: string | null | undefined): ChatMessageStatus {
    return status === 'final' || status === 'error' || status === 'streaming' ? status : 'streaming';
  }

  function recomputeHaikuMessageFromCandidates(message: ChatMessage): ChatMessage {
    const candidates = message.candidates ?? [];
    if (candidates.length === 0) return message;

    const primary = primaryCandidate(message) ?? candidates[0];
    const active = activeCandidate(message) ?? primary;
    const hasStreaming = candidates.some((candidate) => candidate.status === 'streaming');
    const hasFinal = candidates.some((candidate) => candidate.status === 'final');
    const status: ChatMessageStatus = hasStreaming ? 'streaming' : hasFinal ? 'final' : 'error';

    return {
      ...message,
      status,
      text: primary?.text || message.text,
      activeCandidateId: active?.id ?? primary?.id ?? message.activeCandidateId,
    };
  }

  function settlePendingHaikuCandidates(
    message: ChatMessage,
    status: Exclude<ChatMessageStatus, 'streaming'>,
    fallbackError?: string
  ): ChatMessage {
    const candidates = message.candidates ?? [];
    if (candidates.length === 0) return { ...message, status };

    return recomputeHaikuMessageFromCandidates({
      ...message,
      candidates: candidates.map((candidate) => {
        if (candidate.status !== 'streaming') return candidate;
        if (status === 'error') {
          const error = fallbackError || 'Ошибка';
          return {
            ...candidate,
            status,
            text: candidate.text || `Ошибка: ${error}`,
            error,
          };
        }
        return { ...candidate, status };
      }),
    });
  }

  function upsertHaikuCandidate(
    requestId: string,
    patch: Partial<ChatLlmCandidate> & { id: string }
  ): void {
    upsertHaikuMessage(requestId, { status: 'streaming' });

    const idx = haikuMessages.value.findIndex((m) => m.id === requestId);
    if (idx < 0) return;

    const message = haikuMessages.value[idx];
    const candidates = [...(message.candidates ?? [])];
    const candidateIdx = candidates.findIndex((candidate) => candidate.id === patch.id);
    const previous = candidateIdx >= 0 ? candidates[candidateIdx] : null;
    const nextCandidate: ChatLlmCandidate = {
      id: patch.id,
      label: patch.label ?? previous?.label ?? patch.id,
      provider: patch.provider ?? previous?.provider ?? '',
      model: patch.model ?? previous?.model ?? '',
      status: normalizeCandidateStatus(patch.status ?? previous?.status),
      text: patch.text ?? previous?.text ?? '',
      error: patch.error ?? previous?.error,
    };

    if (candidateIdx >= 0) {
      candidates[candidateIdx] = nextCandidate;
    } else {
      candidates.push(nextCandidate);
    }

    const activeCandidateId = message.activeCandidateId ?? primaryCandidate({ ...message, candidates })?.id ?? patch.id;
    haikuMessages.value[idx] = recomputeHaikuMessageFromCandidates({
      ...message,
      candidates,
      activeCandidateId,
    });
  }

  function appendHaikuCandidateDelta(
    requestId: string,
    payload: HaikuDeltaPayload
  ): void {
    const candidateId = payload.candidate_id;
    if (!candidateId) {
      upsertHaikuMessage(requestId, {
        status: 'streaming',
        text: (haikuMessages.value.find((m) => m.id === requestId)?.text ?? '') + payload.delta,
      });
      return;
    }

    const existing = haikuMessages.value
      .find((message) => message.id === requestId)
      ?.candidates?.find((candidate) => candidate.id === candidateId);
    upsertHaikuCandidate(requestId, {
      id: candidateId,
      label: payload.candidate_label ?? existing?.label ?? candidateId,
      provider: payload.provider ?? existing?.provider ?? '',
      model: payload.model ?? existing?.model ?? '',
      status: 'streaming',
      text: (existing?.text ?? '') + payload.delta,
    });
  }

  function selectHaikuCandidate(messageId: string, candidateId: string): void {
    if (!messageId || !candidateId) return;
    const idx = haikuMessages.value.findIndex((message) => message.id === messageId);
    if (idx < 0) return;
    const message = haikuMessages.value[idx];
    if (!message.candidates?.some((candidate) => candidate.id === candidateId)) return;
    haikuMessages.value[idx] = recomputeHaikuMessageFromCandidates({
      ...message,
      activeCandidateId: candidateId,
    });
  }

  async function requestHaikuFromAnchor(): Promise<void> {
    if (!isTauriAvailable()) return;

    const now = Date.now();
    if (now - lastHoverTriggerAtMs.value < MIN_HOVER_TRIGGER_MS) return;
    lastHoverTriggerAtMs.value = now;

    const context = buildHaikuContext({ selectionMode: 'respect' });
    const contextText = context.text;
    if (!contextText) return;

    const insertAfterId = resolveInsertAfterId();
    const memoryContextEvidence = buildMemoryContextEvidenceFromParts(context.parts, {
      selectedOnly: hasSelection.value,
    });

    const requestId = await invoke<string>('start_haiku_stream', {
      text: contextText,
      system_prompt: sanitizeSystemPrompt(systemPrompt.value),
      openaiResponsesWebSearch: openaiResponsesWebSearchEnabled.value,
      memoryContextEvidence,
      companionMeta: {
        insertAfterId,
        createdAtMs: now,
      },
    });
    markRequestActive(requestId);

    upsertHaikuMessage(requestId, {
      status: 'streaming',
      text: '',
      createdAtMs: now,
      seq: 2_000_000 + haikuMessages.value.length + 1,
      insertAfterId,
    });
  }

  type PromptImageDraft = {
    id: string;
    mime: string;
    dataUrl: string;
    dataBase64: string;
  };

  function createLocalId(prefix: string): string {
    try {
      const uuid =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : null;
      if (uuid) return `${prefix}:${uuid}`;
    } catch {
      // ignore
    }
    return `${prefix}:${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function sendPromptToLlm(input: { text: string; images?: PromptImageDraft[] }): Promise<void> {
    if (!isTauriAvailable()) return;

    const promptText = String(input.text ?? '').trim();
    const images = (input.images ?? []).filter((x) => x && x.mime && x.dataBase64);
    if (!promptText && images.length === 0) return;

    const promptMessageId = createLocalId('prompt');
    const createdAtMs = Date.now();

    const context = buildHaikuContext({ selectionMode: 'ignore' });
    const contextText = context.text;
    const memoryContextEvidence = buildMemoryContextEvidenceFromParts(context.parts);
    const contextImageLimit = Math.min(2, Math.max(0, 10 - images.length));
    const contextImages = (contextImageLimit ? promptMessages.value
      .filter((message) => !message.deleted && !isMessageOutOfContext(message))
      .flatMap((message) => message.attachments ?? [])
      .slice(-contextImageLimit) : [])
      .map((attachment) => ({
        mediaType: attachment.mime,
        dataBase64: dataUrlToBase64(attachment.dataUrl),
      }))
      .filter((image) => image.dataBase64);

    promptMessages.value.push({
      id: promptMessageId,
      kind: 'prompt',
      role: 'outgoing',
      status: 'final',
      text: promptText,
      createdAtMs,
      seq: 1_500_000 + promptMessages.value.length,
      attachments: images.map((img) => ({
        id: img.id,
        kind: 'image',
        mime: img.mime,
        dataUrl: img.dataUrl,
      })),
    });

    try {
      const requestId = await invoke<string>('start_haiku_chat_stream', {
        contextText: contextText,
        questionText: promptText,
        images: images.map((img) => ({
          mediaType: img.mime,
          dataBase64: img.dataBase64,
        })),
        contextImages,
        systemPrompt: sanitizeSystemPrompt(systemPrompt.value),
        openaiResponsesWebSearch: openaiResponsesWebSearchEnabled.value,
        memoryContextEvidence,
        companionMeta: {
          promptMessageId,
          promptCreatedAtMs: createdAtMs,
          createdAtMs,
        },
      });

      markRequestActive(requestId);
      upsertHaikuMessage(requestId, {
        status: 'streaming',
        text: '',
        createdAtMs,
        seq: 2_000_000 + haikuMessages.value.length + 1,
        insertAfterId: promptMessageId,
      });
    } catch (err) {
      haikuMessages.value.push({
        id: createLocalId('haiku_error'),
        kind: 'haiku',
        role: 'outgoing',
        status: 'error',
        text: err instanceof Error ? `Ошибка: ${err.message}` : `Ошибка: ${String(err)}`,
        createdAtMs: Date.now(),
        seq: 2_000_000 + haikuMessages.value.length + 1,
        insertAfterId: promptMessageId,
      });
    }
  }

  async function replyToMessageWithAi(messageId: string): Promise<void> {
    if (!isTauriAvailable()) return;
    const msg = messages.value.find((m) => m.id === messageId);
    if (!msg || msg.deleted) return;

    const questionText = String(msg.text ?? '').trim();
    if (!questionText) return;

    const context = buildHaikuContext({ selectionMode: 'ignore', includeFullHistory: true });
    const contextText = context.text;
    const memoryContextEvidence = buildMemoryContextEvidenceFromParts(context.parts);
    const createdAtMs = Date.now();

    try {
      const requestId = await invoke<string>('start_haiku_chat_stream', {
        contextText: contextText,
        questionText: questionText,
        images: [],
        systemPrompt: sanitizeSystemPrompt(systemPrompt.value),
        openaiResponsesWebSearch: openaiResponsesWebSearchEnabled.value,
        memoryContextEvidence,
        companionMeta: {
          insertAfterId: messageId,
          createdAtMs,
        },
      });

      markRequestActive(requestId);
      upsertHaikuMessage(requestId, {
        status: 'streaming',
        text: '',
        createdAtMs,
        seq: 2_000_000 + haikuMessages.value.length + 1,
        insertAfterId: messageId,
      });
    } catch (err) {
      haikuMessages.value.push({
        id: createLocalId('haiku_error'),
        kind: 'haiku',
        role: 'outgoing',
        status: 'error',
        text: err instanceof Error ? `Ошибка: ${err.message}` : `Ошибка: ${String(err)}`,
        createdAtMs: Date.now(),
        seq: 2_000_000 + haikuMessages.value.length + 1,
        insertAfterId: messageId,
      });
    }
  }

  function cancelHaikuRequest(requestId: string): void {
    if (!requestId) return;

    // Игнорируем все будущие события по этому requestId.
    ignoredHaikuRequestIds.value = { ...ignoredHaikuRequestIds.value, [requestId]: true };

    // Снимаем индикатор "стримится" (чтобы UI не завис).
    markRequestDone(requestId);

    // Убираем сообщение из чата полностью (без "Сообщение удалено").
    const idx = haikuMessages.value.findIndex((m) => m.id === requestId);
    if (idx >= 0) haikuMessages.value.splice(idx, 1);
  }

  function cancelActiveHaikuStreams(): void {
    const ids = Object.keys(activeHaikuRequests.value);
    if (ids.length === 0) return;
    for (const id of ids) cancelHaikuRequest(id);

    // После отмены разрешаем повторный триггер без задержки (hover всё равно будет "разоружён" в UI).
    lastHoverTriggerAtMs.value = 0;

  }

  function clearLiveMicBuffers(): void {
    micPartialText.value = '';
    micAccumulatedText.value = '';
    micLastFinalizedText.value = '';
    micCurrentUtteranceStart.value = -1;
    micAudioLevel.value = 0;
    micDominantUntilMs.value = 0;
    liveMicSinceMs.value = 0;
  }

  function finalizedRangeKey(start?: number, duration?: number): string {
    const s = Number(start);
    const d = Number(duration);
    if (!Number.isFinite(s) || !Number.isFinite(d) || d <= 0) return '';
    return `${s.toFixed(3)}|${d.toFixed(3)}`;
  }

  async function waitForUiPaint(): Promise<void> {
    await nextTick();
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      return;
    }
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  async function setMicrophoneEnabled(enabled: boolean): Promise<void> {
    const targetEnabled = !!enabled;
    microphoneEnabled.value = targetEnabled;

    if (!targetEnabled) {
      clearLiveMicBuffers();
    }

    if (!isTauriAvailable()) return;
    try {
      // Даём UI шанс отрисовать новый state до нативного IPC/AppleScript,
      // иначе кнопка визуально "запаздывает", хотя state уже сменили.
      await waitForUiPaint();
      const payload = await invoke<MicrophoneMuteStatePayload>('set_microphone_muted', {
        muted: !targetEnabled,
      });
      applyMicrophoneMuteState(payload);
    } catch (err) {
      microphoneEnabled.value = !targetEnabled;
      console.warn('Failed to toggle system microphone mute:', err);
    }
  }

  async function toggleMicrophoneEnabled(): Promise<void> {
    await setMicrophoneEnabled(!microphoneEnabled.value);
  }

  let unlistenDelta: UnlistenFn | null = null;
  let unlistenDone: UnlistenFn | null = null;
  let unlistenError: UnlistenFn | null = null;
  let unlistenCandidateStart: UnlistenFn | null = null;
  let unlistenMicPartial: UnlistenFn | null = null;
  let unlistenMicFinal: UnlistenFn | null = null;
  let unlistenSystemLevel: UnlistenFn | null = null;
  let unlistenMicLevel: UnlistenFn | null = null;
  let unlistenMicMuteState: UnlistenFn | null = null;
  let unlistenSignalMessage: UnlistenFn | null = null;

  function applyMicrophoneMuteState(payload: MicrophoneMuteStatePayload | null | undefined): void {
    const muted = !!payload?.muted;
    microphoneEnabled.value = !muted;
    microphoneMuteSupported.value = !!payload?.supported;
    microphoneMuteSource.value = String(payload?.source ?? 'unknown');

    if (muted) {
      clearLiveMicBuffers();
    }
  }

  async function syncMicrophoneMuteState(): Promise<void> {
    if (!isTauriAvailable()) return;
    try {
      const payload = await invoke<MicrophoneMuteStatePayload>('get_microphone_mute_state');
      applyMicrophoneMuteState(payload);
      await invoke('set_microphone_transcription_enabled', { enabled: !payload.muted });
    } catch (err) {
      console.warn('Failed to sync microphone mute state:', err);
    }
  }

  function upsertSignalMessage(payload: SignalMessagePayload | null | undefined): void {
    const text = String(payload?.text ?? '').trim();
    const id = String(payload?.id ?? '').trim();
    if (!id || !text) return;

    const timestamp = Number(payload?.timestamp);
    const createdAtMs = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
    const existingIndex = signalMessages.value.findIndex((message) => message.id === id);
    const next: ChatMessage = {
      id,
      kind: 'signal',
      role: 'incoming',
      status: 'final',
      text,
      createdAtMs,
      seq: 1_250_000 + (existingIndex >= 0 ? existingIndex : signalMessages.value.length),
    };

    if (existingIndex >= 0) {
      signalMessages.value[existingIndex] = {
        ...signalMessages.value[existingIndex],
        ...next,
        seq: signalMessages.value[existingIndex].seq,
      };
      return;
    }

    signalMessages.value.push(next);
  }

  async function initialize(): Promise<void> {
    if (!isTauriAvailable()) return;
    if (
      unlistenDelta ||
      unlistenDone ||
      unlistenError ||
      unlistenCandidateStart ||
      unlistenMicPartial ||
      unlistenMicFinal ||
      unlistenSystemLevel ||
      unlistenMicLevel ||
      unlistenMicMuteState ||
      unlistenSignalMessage
    ) {
      return;
    }

    type AudioLevelPayload = { level: number };

    // System audio level (from main transcription service)
    unlistenSystemLevel = await listen<AudioLevelPayload>('audio:level', (event) => {
      const level = Number(event.payload?.level ?? 0);
      systemAudioLevel.value = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
      updateMicDominance(Date.now());
    });

    // Microphone audio level (from microphone transcription service)
    unlistenMicLevel = await listen<AudioLevelPayload>('microphone:level', (event) => {
      if (!microphoneEnabled.value) {
        micAudioLevel.value = 0;
        micDominantUntilMs.value = 0;
        return;
      }
      const level = Number(event.payload?.level ?? 0);
      micAudioLevel.value = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
      updateMicDominance(Date.now());
    });

    unlistenMicMuteState = await listen<MicrophoneMuteStatePayload>(EVENT_MICROPHONE_MUTE_STATE, (event) => {
      applyMicrophoneMuteState(event.payload);
    });

    unlistenSignalMessage = await listen<SignalMessagePayload>(EVENT_SIGNAL_MESSAGE, (event) => {
      upsertSignalMessage(event.payload);
    });

    unlistenCandidateStart = await listen<HaikuCandidateStartPayload>(
      EVENT_HAIKU_CANDIDATE_START,
      (event) => {
        const requestId = event.payload.request_id;
        const candidateId = event.payload.candidate_id;
        if (!requestId || !candidateId) return;
        if (ignoredHaikuRequestIds.value[requestId]) return;
        markRequestActive(requestId);
        upsertHaikuCandidate(requestId, {
          id: candidateId,
          label: event.payload.candidate_label || candidateId,
          provider: event.payload.provider || '',
          model: event.payload.model || '',
          status: 'streaming',
          text: '',
        });
      }
    );

    unlistenDelta = await listen<HaikuDeltaPayload>(EVENT_HAIKU_DELTA, (event) => {
      const requestId = event.payload.request_id;
      const delta = event.payload.delta;
      if (!requestId || !delta) return;
      if (ignoredHaikuRequestIds.value[requestId]) return;

      appendHaikuCandidateDelta(requestId, event.payload);
    });

    unlistenDone = await listen<HaikuDonePayload>(EVENT_HAIKU_DONE, (event) => {
      const requestId = event.payload.request_id;
      if (!requestId) return;
      if (ignoredHaikuRequestIds.value[requestId]) return;
      if (event.payload.candidate_id) {
        const existing = haikuMessages.value
          .find((message) => message.id === requestId)
          ?.candidates?.find((candidate) => candidate.id === event.payload.candidate_id);
        upsertHaikuCandidate(requestId, {
          id: event.payload.candidate_id,
          label: event.payload.candidate_label ?? existing?.label ?? event.payload.candidate_id,
          provider: event.payload.provider ?? existing?.provider ?? '',
          model: event.payload.model ?? existing?.model ?? '',
          status: 'final',
          text: existing?.text ?? '',
        });
        return;
      }
      markRequestDone(requestId);
      const existing = haikuMessages.value.find((message) => message.id === requestId);
      upsertHaikuMessage(
        requestId,
        existing?.candidates?.length
          ? settlePendingHaikuCandidates(existing, 'final')
          : { status: 'final' }
      );
    });

    unlistenError = await listen<HaikuErrorPayload>(EVENT_HAIKU_ERROR, (event) => {
      const requestId = event.payload.request_id;
      const error = event.payload.error;
      if (!requestId) return;
      if (ignoredHaikuRequestIds.value[requestId]) return;
      if (event.payload.candidate_id) {
        const existing = haikuMessages.value
          .find((message) => message.id === requestId)
          ?.candidates?.find((candidate) => candidate.id === event.payload.candidate_id);
        upsertHaikuCandidate(requestId, {
          id: event.payload.candidate_id,
          label: event.payload.candidate_label ?? existing?.label ?? event.payload.candidate_id,
          provider: event.payload.provider ?? existing?.provider ?? '',
          model: event.payload.model ?? existing?.model ?? '',
          status: 'error',
          text: existing?.text || (error ? `Ошибка: ${error}` : 'Ошибка'),
          error: error || 'Ошибка',
        });
        return;
      }
      markRequestDone(requestId);
      const existing = haikuMessages.value.find((message) => message.id === requestId);
      upsertHaikuMessage(
        requestId,
        existing?.candidates?.length
          ? settlePendingHaikuCandidates(existing, 'error', error || 'Ошибка')
          : {
              status: 'error',
              text: error ? `Ошибка: ${error}` : 'Ошибка',
            }
      );
    });

    unlistenMicPartial = await listen<PartialTranscriptionPayload>(
      EVENT_TRANSCRIPTION_PARTIAL,
      (event) => {
        if (event.payload.source !== 'microphone') return;
        if (!microphoneEnabled.value) return;

        // Защита: микрофонные события не должны попадать в чат вне активной записи.
        if (!transcription.isRecording && !transcription.isStarting && !transcription.isProcessing) return;

        // Если микрофон не доминирует — не показываем, чтобы не дублировать системный звук.
        if (!isMicDominantNow()) {
          clearLiveMicBuffers();
          return;
        }

        if (event.payload.is_segment_final) {
          const newText = event.payload.text.trim();
          const segmentKey = finalizedRangeKey(event.payload.start, event.payload.duration);
          if (newText && segmentKey && segmentKey === micLastFinalizedText.value) return;
          if (newText && isMicTextDuplicateOfSystem(newText, Date.now())) {
            clearLiveMicBuffers();
            return;
          }

          micAccumulatedText.value = appendTranscriptText(micAccumulatedText.value, newText);

          micLastFinalizedText.value = segmentKey;
          micPartialText.value = '';
          return;
        }

        // Interim update
        if (micCurrentUtteranceStart.value === event.payload.start || micCurrentUtteranceStart.value === -1) {
          micCurrentUtteranceStart.value = event.payload.start;
          const t = event.payload.text;
          if (t && isMicTextDuplicateOfSystem(t, Date.now())) {
            clearLiveMicBuffers();
            return;
          }
          micPartialText.value = t;
          return;
        }

        // Deepgram can move to the next segment start before speech_final.
        // Keep it live until the real final/finalize event closes the utterance.
        if (micPartialText.value) {
          micAccumulatedText.value = mergeTranscriptText(
            micAccumulatedText.value,
            micPartialText.value
          );
        }

        micCurrentUtteranceStart.value = event.payload.start;
        micPartialText.value = event.payload.text;
      }
    );

    unlistenMicFinal = await listen<FinalTranscriptionPayload>(
      EVENT_TRANSCRIPTION_FINAL,
      (event) => {
        if (event.payload.source !== 'microphone') return;
        if (!microphoneEnabled.value) return;

        if (!transcription.isRecording && !transcription.isStarting && !transcription.isProcessing) return;

        if (!isMicDominantNow()) {
          clearLiveMicBuffers();
          return;
        }

        const finalKey = finalizedRangeKey(event.payload.start, event.payload.duration);
        const isDuplicateFinalRange =
          !!event.payload.text &&
          !!finalKey &&
          finalKey === micLastFinalizedText.value &&
          !!micAccumulatedText.value.trim();
        const utteranceText = isDuplicateFinalRange
          ? micAccumulatedText.value.trim()
          : event.payload.text
            ? appendTranscriptText(micAccumulatedText.value, event.payload.text).trim()
            : mergeTranscriptText(micAccumulatedText.value, micPartialText.value).trim();

        if (utteranceText && !isMicTextDuplicateOfSystem(utteranceText, Date.now())) {
          micMessages.value.push({
            id: `mic:${event.payload.session_id}:${micMessages.value.length}`,
            kind: 'mic',
            role: 'outgoing',
            status: 'final',
            text: utteranceText,
            createdAtMs: event.payload.timestamp,
            seq: 1_000_000 + micMessages.value.length,
          });
        }

        micAccumulatedText.value = '';
        micPartialText.value = '';
        micLastFinalizedText.value = '';
        micCurrentUtteranceStart.value = -1;
      }
    );

    await syncMicrophoneMuteState();
    await syncCompanionSystemPrompt();
  }

  function cleanup(): void {
    if (unlistenDelta) unlistenDelta();
    if (unlistenDone) unlistenDone();
    if (unlistenError) unlistenError();
    if (unlistenCandidateStart) unlistenCandidateStart();
    if (unlistenMicPartial) unlistenMicPartial();
    if (unlistenMicFinal) unlistenMicFinal();
    if (unlistenSystemLevel) unlistenSystemLevel();
    if (unlistenMicLevel) unlistenMicLevel();
    if (unlistenMicMuteState) unlistenMicMuteState();
    if (unlistenSignalMessage) unlistenSignalMessage();
    unlistenDelta = null;
    unlistenDone = null;
    unlistenError = null;
    unlistenCandidateStart = null;
    unlistenMicPartial = null;
    unlistenMicFinal = null;
    unlistenSystemLevel = null;
    unlistenMicLevel = null;
    unlistenMicMuteState = null;
    unlistenSignalMessage = null;
  }

  function clearChatOutgoing(): void {
    haikuMessages.value = [];
    micMessages.value = [];
    promptMessages.value = [];
    clearLiveMicBuffers();
    systemAudioLevel.value = 0;
    activeHaikuRequests.value = {};
    ignoredHaikuRequestIds.value = {};
  }

  function clearAllHistory(): void {
    clearSelection();
    contextFloorSttIndex.value = 0;
    contextClearedAtMs.value = 0;

    transcription.clearHistoryUiOnly();

    haikuMessages.value = [];
    activeHaikuRequests.value = {};
    ignoredHaikuRequestIds.value = {};

    micMessages.value = [];
    promptMessages.value = [];
    signalMessages.value = [];
    clearLiveMicBuffers();
    systemAudioLevel.value = 0;
    liveSttSinceMs.value = 0;

    followTail();
  }

  function hydrateFromCompanionSnapshot(snapshot: CompanionSnapshotData): void {
    const timeline = [...(snapshot.timeline ?? [])]
      .filter((message) => !message.deleted)
      .sort((a, b) => a.seq - b.seq);

    const toAttachments = (attachments: CompanionSnapshotData['timeline'][number]['attachments']) =>
      (attachments ?? []).map((attachment) => ({
        id: attachment.id,
        kind: 'image' as const,
        mime: attachment.mime,
        dataUrl: attachment.dataUrl,
      }));

    const toCandidates = (candidates: CompanionSnapshotData['timeline'][number]['candidates']) =>
      (candidates ?? [])
        .filter((candidate) => candidate?.id)
        .map((candidate) => ({
          id: candidate.id,
          label: candidate.label || candidate.id,
          provider: candidate.provider || '',
          model: candidate.model || '',
          status: normalizeCandidateStatus(candidate.status),
          text: candidate.text || '',
          error: candidate.error ?? undefined,
        }));

    micMessages.value = timeline
      .filter((message) => message.kind === 'mic')
      .map((message) => ({
        id: message.id,
        kind: 'mic' as const,
        role: (message.role as ChatMessageRole) || 'outgoing',
        status: (message.status as ChatMessageStatus) || 'final',
        text: message.text,
        createdAtMs: message.createdAtMs,
        seq: message.seq,
        attachments: toAttachments(message.attachments),
      }));

    promptMessages.value = timeline
      .filter((message) => message.kind === 'prompt')
      .map((message) => ({
        id: message.id,
        kind: 'prompt' as const,
        role: (message.role as ChatMessageRole) || 'outgoing',
        status: (message.status as ChatMessageStatus) || 'final',
        text: message.text,
        createdAtMs: message.createdAtMs,
        seq: message.seq,
        attachments: toAttachments(message.attachments),
      }));

    signalMessages.value = timeline
      .filter((message) => message.kind === 'signal')
      .map((message) => ({
        id: message.id,
        kind: 'signal' as const,
        role: (message.role as ChatMessageRole) || 'incoming',
        status: (message.status as ChatMessageStatus) || 'final',
        text: message.text,
        createdAtMs: message.createdAtMs,
        seq: message.seq,
        attachments: toAttachments(message.attachments),
      }));

    haikuMessages.value = timeline
      .filter((message) => message.kind === 'haiku')
      .map((message) => ({
        id: message.id,
        kind: 'haiku' as const,
        role: (message.role as ChatMessageRole) || 'outgoing',
        status: (message.status as ChatMessageStatus) || 'streaming',
        text: message.text,
        createdAtMs: message.createdAtMs,
        seq: message.seq,
        insertAfterId: message.insertAfterId ?? undefined,
        attachments: toAttachments(message.attachments),
        candidates: toCandidates(message.candidates),
        activeCandidateId: message.activeCandidateId ?? undefined,
      }))
      .map(preserveStreamingTextFromLocalState);

    activeHaikuRequests.value = Object.fromEntries(
      haikuMessages.value
        .filter((message) => message.status === 'streaming')
        .map((message) => [message.id, true] as const)
    );

    microphoneEnabled.value = !!snapshot.microphone.enabled;
    microphoneMuteSupported.value = !!snapshot.microphone.supported;
    microphoneMuteSource.value = String(snapshot.microphone.source ?? 'unknown');
    companionModeEnabled.value = !!snapshot.controls.companionModeEnabled;

    micPartialText.value = String(snapshot.live.microphonePartialText ?? '');
    micAccumulatedText.value = '';
    micLastFinalizedText.value = '';
    micCurrentUtteranceStart.value = -1;
    systemAudioLevel.value = 0;
    liveMicSinceMs.value = micPartialText.value
      ? Number(snapshot.live.microphonePartialStartedAtMs || Date.now())
      : 0;

    selectedMessageIds.value = filterSelectableIds(selectedMessageIds.value);
  }

  return {
    messages,
    sttMessages,
    signalMessages,
    haikuMessages,
    microphoneEnabled,
    microphoneMuteSupported,
    microphoneMuteSource,
    companionModeEnabled,
    setMicrophoneEnabled,
    toggleMicrophoneEnabled,
    syncMicrophoneMuteState,

    selectedCount,
    hasSelection,
    selectedMessageIds,
    isSelected,
    clearSelection,
    setSelection,
    toggleSelection,
    selectOnly,
    editMessageText,

    anchorMode,
    anchorSttIndex,
    anchorCharOffset,
    setAnchorToSttIndex,
    setAnchorToSttSelection,
    followTail,

    hasAnySttText,
    canRequestHaiku,
    hasContextToClear,
    systemPrompt,
    saveSystemPrompt,
    openaiResponsesWebSearchEnabled,
    setOpenAiResponsesWebSearchEnabled,
    toggleOpenAiResponsesWebSearch,
    clearLlmContext,
    isMessageOutOfContext,
    livePartialText,
    liveMicText,

    isHaikuStreaming,
    requestHaikuFromAnchor,
    sendPromptToLlm,
    replyToMessageWithAi,
    selectHaikuCandidate,
    cancelActiveHaikuStreams,
    clearChatOutgoing,
    clearAllHistory,
    hydrateFromCompanionSnapshot,
    deleteMessage,

    initialize,
    cleanup,
  };
});

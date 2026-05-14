<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { toDataURL as toQrDataUrl } from 'qrcode';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getVersion } from '@tauri-apps/api/app';
import { useTranscriptionStore } from '../../stores/transcription';
import { useChatStore } from '../../stores/chat';
import { useAppConfigStore } from '../../stores/appConfig';
import { useSttConfigStore } from '../../stores/sttConfig';
import { useAuthStore } from '../../features/auth/store/authStore';
import { useAuth } from '../../features/auth';
import { SettingsPanel } from '../../features/settings';
import ProfilePopover from './ProfilePopover.vue';
import UpdateIndicator from './UpdateIndicator.vue';
import UpdateDialog from './UpdateDialog.vue';
import AudioVisualizer from './AudioVisualizer.vue';
import ConversationFeed from './ConversationFeed.vue';
import { playShowSound, playDoneSound, preloadUiSounds } from '../../utils/sound';
import { createPromptImageDraft, type PromptImageDraft } from '../../utils/promptImages';
import { renderMarkdownToSafeHtml } from '@/utils/markdown';
import { isTauriAvailable } from '../../utils/tauri';
import {
  EVENT_RECORDING_WINDOW_SHOWN,
  EVENT_CODE_EXPLAIN_DELTA,
  EVENT_CODE_EXPLAIN_DONE,
  EVENT_CODE_EXPLAIN_ERROR,
  type CodeExplainDeltaPayload,
  type CodeExplainDonePayload,
  type CodeExplainErrorPayload,
} from '@/types';
import { useAudioPermissions } from '@/composables/useAudioPermissions';
import {
  CMD_COMPANION_CLEAR_CONTEXT,
  CMD_COMPANION_CLEAR_HISTORY,
  CMD_COMPANION_REQUEST_AI,
  CMD_COMPANION_SEND_PROMPT,
  CMD_ENABLE_COMPANION_MODE,
  CMD_GET_COMPANION_SERVER_STATUS,
  CMD_GET_COMPANION_SNAPSHOT,
  STATE_SYNC_INVALIDATION_EVENT,
  TOPIC_COMPANION_UI,
  type CompanionActionResponse,
  type CompanionServerStatus,
  type CompanionSnapshotData,
  type StateSyncInvalidationEventPayload,
  type TauriSnapshotEnvelope,
} from '@/windowing/stateSync';

// Простая поддержка перетаскивания мышью по шапке
async function onDragMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  if (!isTauriAvailable()) return;
  let el = e.target as HTMLElement | null;
  while (el && el !== (e.currentTarget as HTMLElement)) {
    if (el.classList && el.classList.contains('no-drag')) return;
    el = el.parentElement;
  }
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    await getCurrentWebviewWindow().startDragging();
  } catch (err) {
    console.error('Failed to start dragging:', err);
  }
}

const store = useTranscriptionStore();
const chatStore = useChatStore();
const appConfigStore = useAppConfigStore();
const sttConfigStore = useSttConfigStore();
const authStore = useAuthStore();
const auth = useAuth();
const { t } = useI18n();
const showSettings = ref(false);
const showProfile = ref(false);
const showUpdateDialog = ref(false);
const appVersion = ref('');
const glowColor = ref<'blue' | 'red' | null>(null);
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
const microphoneMuteHotkeyLabel = computed(() => (isMac ? 'Option+Z' : 'Alt+Z'));

const audioPermissions = useAudioPermissions();

const shouldShowSystemAudioPermissionWarning = computed(() => {
  return !audioPermissions.systemAudioGranted.value;
});

const shouldShowMicrophonePermissionWarning = computed(() => {
  return chatStore.microphoneEnabled && !audioPermissions.microphoneGranted.value;
});

// Debouncing для hotkey - блокирует повторные вызовы в течение 500ms
let hotkeyDebounceTimeout: number | null = null;
let isHotkeyProcessing = false;

let unlistenHotkey: UnlistenFn | null = null;
let unlistenAutoHide: UnlistenFn | null = null;
let unlistenStartRequested: UnlistenFn | null = null;
let unlistenWindowShown: UnlistenFn | null = null;
let unlistenCompanionInvalidation: UnlistenFn | null = null;
let unlistenCodeExplainDelta: UnlistenFn | null = null;
let unlistenCodeExplainDone: UnlistenFn | null = null;
let unlistenCodeExplainError: UnlistenFn | null = null;

const companionRevision = ref('0');
const companionHistoryFloorSeq = ref(0);
const companionContextFloorSeq = ref(0);
const companionConversationGeneration = ref(0);
const companionActiveSessionId = ref(0);
const localCommitMutationsDisabled = computed(() => chatStore.companionModeEnabled);
const companionMenuOpen = ref(false);
const companionServerStatus = ref<CompanionServerStatus | null>(null);
const companionServerBusy = ref(false);
const companionTransientMessage = ref('');
const companionQrDataUrl = ref('');
let companionTransientMessageTimeout: number | null = null;
let companionStatusRetryTimeout: number | null = null;
const conversationFeedRef = ref<{ scrollEl: HTMLElement | null } | null>(null);

const companionPrimaryUrl = computed(() => {
  const status = companionServerStatus.value;
  return status?.localNetworkUrl || status?.localUrl || '';
});
const companionLanUrl = computed(() => companionServerStatus.value?.localNetworkUrl || '');
const companionLoopbackUrl = computed(() => companionServerStatus.value?.localUrl || '');
const companionReady = computed(() => companionPrimaryUrl.value.length > 0);
const companionStatusLine = computed(() => {
  if (companionServerBusy.value) return 'Поднимаю companion на компьютере';
  if (companionLanUrl.value) return 'Готово - открой QR с телефона в той же Wi-Fi сети';
  if (companionLoopbackUrl.value) return 'Companion активен локально на этом компьютере';
  if (companionServerStatus.value?.enabled) return 'Companion включён, но адрес ещё определяется';
  return 'Companion пока не включён';
});

// Ref для области чата (для автоскролла)
const chatScrollRef = computed(() => conversationFeedRef.value?.scrollEl ?? null);

const CODE_EXPLAIN_SYSTEM_PROMPT = `Ты — ассистент на техническом собеседовании. Отвечай по-русски.

Тебе дают:
- "Выделенный фрагмент" — текст или код, на который нужно ответить/объяснить.
- "Контекст чата" — история сообщений ДО выбранного сообщения включительно.

В контексте чата есть строки:
- "ОС:" — то, что я слышу (обычно реплики собеседника/вопросы).
- "МИКРОФОН:" — то, что говорю я (мои ответы/мысли/иногда могу повторить вопрос).
- "ПОМОЩНИК:" — предыдущие ответы ассистента.

Твоя задача:
1) Понять, что пользователь хочет про выделенный фрагмент: объяснить, исправить, улучшить, ответить на вопрос, или дать краткий разбор.
2) Дать лучший краткий ответ по делу (без воды), используя контекст чата, но не пересказывая его целиком.
3) Если запрос неясен из-за распознавания/обрывков — задай 1 уточняющий вопрос и предложи 1–2 вероятные интерпретации.

Формат ответа:
- Сначала 3–7 буллетов (каждый пункт начинай с "- ").
- Затем (если нужно) короткий пример кода (в fenced-блоке).

Правила для кода:
- Для упоминаний технических идентификаторов используй inline code (одинарные обратные кавычки).
- Для кода/выражений (даже коротких), если важна подсветка, используй fenced-блок с языком.
- Код — без нумерации строк, с корректными отступами.`;

type CodeSelectionUi = {
  visible: boolean;
  x: number;
  y: number;
  messageId: string | null;
  language: string | null;
  selectedText: string;
  isCode: boolean;
};

const codeSelectionUi = ref<CodeSelectionUi>({
  visible: false,
  x: 0,
  y: 0,
  messageId: null,
  language: null,
  selectedText: '',
  isCode: false,
});

const codeExplainDialogOpen = ref(false);
const codeExplainStatus = ref<'idle' | 'streaming' | 'final' | 'error'>('idle');
const codeExplainRequestId = ref<string | null>(null);
const codeExplainRawText = ref('');
const codeExplainHtml = ref('');
const codeExplainError = ref<string>('');
let codeExplainRenderRaf: number | null = null;
let suppressCodeSelectionUiUntilMs = 0;

function scheduleCodeExplainRender(): void {
  if (codeExplainRenderRaf !== null) return;
  codeExplainRenderRaf = window.requestAnimationFrame(() => {
    codeExplainRenderRaf = null;
    codeExplainHtml.value = renderMarkdownToSafeHtml(codeExplainRawText.value, { codeCollapse: false });
  });
}

function closestElementFromNode(node: Node | null): HTMLElement | null {
  if (!node) return null;
  if (node.nodeType === Node.ELEMENT_NODE) return node as HTMLElement;
  return node.parentElement;
}

function getLanguageFromCodeEl(el: Element | null): string | null {
  if (!el) return null;
  const codeEl = el.closest('code');
  const codeClass = codeEl?.getAttribute('class') ?? '';
  const m = codeClass.match(/\blanguage-([a-z0-9_+#.-]+)\b/i);
  if (m?.[1]) return String(m[1]).toLowerCase();

  const block = el.closest<HTMLElement>('.code-block');
  const dl = block?.dataset?.lang;
  if (dl) return String(dl).toLowerCase();
  return null;
}

function hideCodeSelectionUi(): void {
  codeSelectionUi.value = {
    visible: false,
    x: 0,
    y: 0,
    messageId: null,
    language: null,
    selectedText: '',
    isCode: false,
  };
}

let selectionRaf: number | null = null;
function updateCodeSelectionFromDom(): void {
  if (Date.now() < suppressCodeSelectionUiUntilMs) {
    hideCodeSelectionUi();
    return;
  }

  const container = chatScrollRef.value;
  if (!container) {
    hideCodeSelectionUi();
    return;
  }

  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hideCodeSelectionUi();
    return;
  }

  const selectedText = sel.toString();
  if (!selectedText || !selectedText.trim()) {
    hideCodeSelectionUi();
    return;
  }

  const anchorEl = closestElementFromNode(sel.anchorNode);
  const focusEl = closestElementFromNode(sel.focusNode);
  if (!anchorEl || !focusEl) {
    hideCodeSelectionUi();
    return;
  }

  if (!container.contains(anchorEl) || !container.contains(focusEl)) {
    hideCodeSelectionUi();
    return;
  }

  // Не мешаем инлайн-редактуре.
  if (anchorEl.closest('.chat-text-editable') || focusEl.closest('.chat-text-editable')) {
    hideCodeSelectionUi();
    return;
  }

  const anchorRow = anchorEl.closest<HTMLElement>('.chat-row[data-msg-id]');
  const focusRow = focusEl.closest<HTMLElement>('.chat-row[data-msg-id]');
  const anchorMsgId = anchorRow?.dataset?.msgId ?? null;
  const focusMsgId = focusRow?.dataset?.msgId ?? null;
  if (!anchorMsgId || !focusMsgId) {
    hideCodeSelectionUi();
    return;
  }

  // Не показываем кнопку, если выделение пересекает несколько сообщений.
  if (anchorMsgId !== focusMsgId) {
    hideCodeSelectionUi();
    return;
  }

  const messageId = anchorMsgId;

  const inCodeBlock =
    !!anchorEl.closest('pre, .code-block') && !!focusEl.closest('pre, .code-block');

  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  const rect = (rects?.length ? rects[rects.length - 1] : range.getBoundingClientRect()) as DOMRect;
  if (!rect || (!rect.width && !rect.height)) {
    hideCodeSelectionUi();
    return;
  }

  const language = inCodeBlock ? (getLanguageFromCodeEl(anchorEl) ?? getLanguageFromCodeEl(focusEl)) : null;

  const btnSize = 36;
  const pad = 10;
  const x = Math.min(window.innerWidth - btnSize - pad, Math.max(pad, rect.right + 8));
  const y = Math.min(window.innerHeight - btnSize - pad, Math.max(pad, rect.top - btnSize - 8));

  codeSelectionUi.value = {
    visible: true,
    x,
    y,
    messageId,
    language,
    selectedText: selectedText.trim(),
    isCode: inCodeBlock,
  };
}

function onSelectionChange(): void {
  if (selectionRaf !== null) return;
  selectionRaf = window.requestAnimationFrame(() => {
    selectionRaf = null;
    updateCodeSelectionFromDom();
  });
}

function buildContextUpToMessageId(messageId: string): string {
  const parts: string[] = [];
  const list = chatStore.messages;

  function formatLine(m: { kind: string; text: string }): string {
    const t = String(m.text ?? '').trim();
    if (!t) return '';
    if (m.kind === 'stt') return `ОС: ${t}`;
    if (m.kind === 'mic') return `МИКРОФОН: ${t}`;
    if (m.kind === 'haiku') return `ПОМОЩНИК: ${t}`;
    return t;
  }

  let reached = false;
  for (const m of list) {
    const line = formatLine(m);
    if (line) parts.push(line);
    if (m.id === messageId) {
      reached = true;
      break;
    }
  }

  // Fallback: если по какой-то причине не нашли id в списке
  if (!reached) {
    const m = list.find((x) => x.id === messageId);
    const line = m ? formatLine(m) : '';
    if (line) parts.push(line);
  }

  // Ограничиваем размер контекста (best-effort), чтобы не взрывать запрос.
  const MAX_CHARS = 12_000;
  let text = parts.join('\n').trim();
  if (text.length > MAX_CHARS) text = text.slice(text.length - MAX_CHARS);
  return text;
}

const onExplainSelectedCode = async () => {
  const messageId = codeSelectionUi.value.messageId;
  const selectedText = codeSelectionUi.value.selectedText;
  if (!messageId || !selectedText) return;

  const contextText = buildContextUpToMessageId(messageId);
  if (!contextText) return;

  const lang = codeSelectionUi.value.isCode ? (codeSelectionUi.value.language ?? '') : 'text';
  const fenced = lang ? `\`\`\`${lang}` : '```';

  const requestText = [
    'Выделенный фрагмент (фокус):',
    fenced,
    selectedText,
    '```',
    '',
    'Контекст чата (до выбранного сообщения включительно):',
    contextText,
  ].join('\n');

  codeExplainDialogOpen.value = true;
  codeExplainStatus.value = 'streaming';
  const localRequestId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `explain-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  codeExplainRequestId.value = localRequestId;
  codeExplainError.value = '';
  codeExplainRawText.value = '';
  codeExplainHtml.value = '';

  try {
    const requestId = await invoke<string>('start_code_explain_stream', {
      text: requestText,
      system_prompt: CODE_EXPLAIN_SYSTEM_PROMPT,
      request_id: localRequestId,
    });
    // На всякий случай синхронизируем request_id, если backend вернул другое значение.
    codeExplainRequestId.value = requestId || localRequestId;
  } catch (err) {
    codeExplainStatus.value = 'error';
    codeExplainRequestId.value = null;
    codeExplainError.value = err instanceof Error ? err.message : String(err);
  } finally {
    // Убираем кнопку и глушим её на короткое время, чтобы не "мигала" при неизменившемся выделении.
    suppressCodeSelectionUiUntilMs = Date.now() + 900;
    hideCodeSelectionUi();
  }
};

const promptMenuOpen = ref(false);
const promptDraft = ref<string>(chatStore.systemPrompt);

watch(
  () => promptMenuOpen.value,
  (open) => {
    if (open) {
      promptDraft.value = chatStore.systemPrompt;
    }
  }
);

const saveSystemPrompt = () => {
  chatStore.saveSystemPrompt(promptDraft.value);
  promptMenuOpen.value = false;
};

function applyCompanionSnapshot(snapshot: TauriSnapshotEnvelope<CompanionSnapshotData>): void {
  const nextRevision = Number(snapshot.revision || '0');
  const currentRevision = Number(companionRevision.value || '0');
  if (Number.isFinite(nextRevision) && Number.isFinite(currentRevision) && nextRevision < currentRevision) {
    return;
  }

  const nextHistoryFloor = Number(snapshot.data.controls.historyFloorSeq || 0);
  const nextContextFloor = Number(snapshot.data.controls.contextFloorSeq || 0);
  const nextGeneration = Number(snapshot.data.controls.conversationGeneration || 0);
  const nextSessionId = Number(snapshot.data.recording.activeSessionId || 0);
  const lastAction = snapshot.data.controls.lastAction || null;

  const historyAdvanced = nextHistoryFloor > companionHistoryFloorSeq.value;
  const contextAdvanced = nextContextFloor > companionContextFloorSeq.value;
  const generationAdvanced = nextGeneration > companionConversationGeneration.value;
  const sessionAdvanced = nextSessionId > 0 && nextSessionId !== companionActiveSessionId.value;

  if (lastAction === 'started' && sessionAdvanced) {
    store.clearText();
    chatStore.clearChatOutgoing();
  } else if (lastAction === 'cleared_history' && (historyAdvanced || generationAdvanced)) {
    chatStore.clearAllHistory();
  } else if (lastAction === 'cleared_context' && (contextAdvanced || generationAdvanced)) {
    chatStore.clearLlmContext();
  }

  store.hydrateFromCompanionSnapshot(snapshot.data);
  chatStore.hydrateFromCompanionSnapshot(snapshot.data);

  companionRevision.value = snapshot.revision;
  companionHistoryFloorSeq.value = nextHistoryFloor;
  companionContextFloorSeq.value = nextContextFloor;
  companionConversationGeneration.value = nextGeneration;
  companionActiveSessionId.value = nextSessionId;
}

async function refreshCompanionSnapshot(): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    const snapshot = await invoke<TauriSnapshotEnvelope<CompanionSnapshotData>>(CMD_GET_COMPANION_SNAPSHOT);
    applyCompanionSnapshot(snapshot);
  } catch (err) {
    console.debug('[companion] refresh failed:', err);
  }
}

function clearCompanionTransientMessageTimer(): void {
  if (companionTransientMessageTimeout !== null) {
    window.clearTimeout(companionTransientMessageTimeout);
    companionTransientMessageTimeout = null;
  }
}

function clearCompanionStatusRetryTimer(): void {
  if (companionStatusRetryTimeout !== null) {
    window.clearTimeout(companionStatusRetryTimeout);
    companionStatusRetryTimeout = null;
  }
}

function setCompanionTransientMessage(message: string, timeoutMs = 2600): void {
  companionTransientMessage.value = message;
  clearCompanionTransientMessageTimer();
  companionTransientMessageTimeout = window.setTimeout(() => {
    companionTransientMessage.value = '';
    companionTransientMessageTimeout = null;
  }, timeoutMs);
}

async function refreshCompanionServerStatus(): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    companionServerStatus.value = await invoke<CompanionServerStatus>(CMD_GET_COMPANION_SERVER_STATUS);
  } catch (err) {
    console.debug('[companion] status refresh failed:', err);
  }
}

function scheduleCompanionStatusRetry(): void {
  if (!import.meta.env.DEV || companionReady.value) return;
  clearCompanionStatusRetryTimer();
  companionStatusRetryTimeout = window.setTimeout(() => {
    companionStatusRetryTimeout = null;
    void refreshCompanionServerStatus();
  }, 1400);
}

async function ensureCompanionReady(): Promise<void> {
  if (!isTauriAvailable() || companionServerBusy.value) return;
  companionServerBusy.value = true;
  try {
    const status =
      companionServerStatus.value?.enabled && companionPrimaryUrl.value
        ? await invoke<CompanionServerStatus>(CMD_GET_COMPANION_SERVER_STATUS)
        : await invoke<CompanionServerStatus>(CMD_ENABLE_COMPANION_MODE);
    companionServerStatus.value = status;
    if (status.localNetworkUrl || status.localUrl) {
      setCompanionTransientMessage('Ссылка для телефона готова');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setCompanionTransientMessage(`Не удалось поднять companion: ${message}`, 4200);
  } finally {
    companionServerBusy.value = false;
  }
}

async function copyCompanionUrl(): Promise<void> {
  const url = companionPrimaryUrl.value;
  if (!url) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      await invoke('copy_to_clipboard_native', { text: url });
    }
    setCompanionTransientMessage('Ссылка скопирована');
  } catch (err) {
    try {
      await invoke('copy_to_clipboard_native', { text: url });
      setCompanionTransientMessage('Ссылка скопирована');
    } catch (fallbackErr) {
      const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr ?? err);
      setCompanionTransientMessage(`Не удалось скопировать ссылку: ${message}`, 4200);
    }
  }
}

watch(
  () => companionPrimaryUrl.value,
  async (url) => {
    if (!url) {
      companionQrDataUrl.value = '';
      return;
    }

    try {
      companionQrDataUrl.value = await toQrDataUrl(url, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 220,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });
    } catch (err) {
      companionQrDataUrl.value = '';
      console.debug('[companion] qr generation failed:', err);
    }
  },
  { immediate: true }
);

watch(
  () => companionMenuOpen.value,
  (open) => {
    if (!open) return;
    void ensureCompanionReady();
  }
);

async function runCompanionClear(commandName: string): Promise<void> {
  if (!isTauriAvailable()) return;
  const response = await invoke<CompanionActionResponse>(commandName);
  if (response.snapshot) {
    applyCompanionSnapshot(response.snapshot);
  }
}

async function runCompanionPromptSend(input: {
  text: string;
  images?: PromptImageDraft[];
}): Promise<CompanionActionResponse | null> {
  if (!isTauriAvailable()) return null;

  const response = await invoke<CompanionActionResponse>(CMD_COMPANION_SEND_PROMPT, {
    text: input.text,
    images: (input.images ?? []).map((img) => ({
      mediaType: img.mime,
      dataBase64: img.dataBase64,
    })),
  });
  if (response.snapshot) {
    applyCompanionSnapshot(response.snapshot);
  }
  return response;
}

const clearLlmContext = async () => {
  await runCompanionClear(CMD_COMPANION_CLEAR_CONTEXT);
};

const askComposerOpen = ref(false);
const askDraftText = ref('');
const askDraftImages = ref<PromptImageDraft[]>([]);
const askTextareaRef = ref<HTMLTextAreaElement | null>(null);
const askSendInFlight = ref(false);
const askSendStatusText = ref('');
const askSendStatusTone = ref<'warn' | 'error' | ''>('');

const canSendAsk = computed(() => {
  return askDraftText.value.trim().length > 0 || askDraftImages.value.length > 0;
});

function appendAskText(text: string): void {
  const t = String(text ?? '');
  if (!t.trim()) return;
  if (!askDraftText.value) {
    askDraftText.value = t;
    return;
  }
  const needsNewline = !askDraftText.value.endsWith('\n');
  askDraftText.value = `${askDraftText.value}${needsNewline ? '\n' : ''}${t}`;
}

async function addAskImageFromFile(file: File): Promise<void> {
  const nextImage = await createPromptImageDraft(file, { prefix: 'img' });
  if (!nextImage) {
    throw new Error('Не удалось подготовить изображение к отправке.');
  }
  askDraftImages.value.push(nextImage);
}

async function onPaste(e: ClipboardEvent): Promise<void> {
  // Не перехватываем paste, если фокус в текстовом поле (textarea, input, contenteditable).
  const active = document.activeElement;
  if (active) {
    const tag = active.tagName?.toLowerCase();
    if (
      tag === 'textarea' ||
      tag === 'input' ||
      (active as HTMLElement).isContentEditable
    ) {
      return;
    }
  }

  const cd = e.clipboardData;
  if (!cd) return;

  const text = cd.getData('text/plain');
  const hasText = !!text && !!text.trim();
  const items = Array.from(cd.items ?? []);
  const imageItems = items.filter((it) => it.kind === 'file' && String(it.type ?? '').startsWith('image/'));
  const hasImages = imageItems.length > 0;

  if (!hasText && !hasImages) return;

  // Открываем композер сразу, а контент докидываем асинхронно.
  askComposerOpen.value = true;
  if (hasText) appendAskText(text);

  let addedImages = 0;
  let lastImageError = '';
  for (const it of imageItems) {
    const f = it.getAsFile();
    if (!f) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await addAskImageFromFile(f);
      addedImages += 1;
    } catch (error) {
      lastImageError = error instanceof Error ? error.message : 'Не удалось подготовить изображение к отправке.';
    }
  }

  if (lastImageError) {
    askSendStatusTone.value = 'warn';
    askSendStatusText.value = lastImageError;
  } else if (addedImages > 0) {
    askSendStatusTone.value = '';
    askSendStatusText.value = '';
  }

  nextTick(() => {
    askTextareaRef.value?.focus();
  });
}

function removeAskImage(id: string): void {
  if (askSendInFlight.value) return;
  askDraftImages.value = askDraftImages.value.filter((x) => x.id !== id);
}

function toggleAskComposer(): void {
  askComposerOpen.value = !askComposerOpen.value;
  if (askComposerOpen.value) {
    nextTick(() => {
      askTextareaRef.value?.focus();
    });
  }
}

async function sendAsk(): Promise<void> {
  if (!canSendAsk.value || askSendInFlight.value) return;
  askSendInFlight.value = true;
  askSendStatusText.value = '';
  askSendStatusTone.value = '';
  const payload = {
    text: askDraftText.value,
    images: askDraftImages.value,
  };
  try {
    if (chatStore.companionModeEnabled) {
      const response = await runCompanionPromptSend(payload);
      if (!response?.ok) {
        switch (response?.actionResult) {
          case 'busy_transition':
            askSendStatusTone.value = 'warn';
            askSendStatusText.value = 'Подожди - предыдущее действие ещё выполняется.';
            break;
          case 'rejected_auth':
            askSendStatusTone.value = 'error';
            askSendStatusText.value = 'Нужно заново авторизоваться на компьютере.';
            break;
          default:
            askSendStatusTone.value = 'error';
            askSendStatusText.value = 'Не удалось отправить сообщение.';
            break;
        }
        return;
      }
    } else {
      await chatStore.sendPromptToLlm(payload);
    }

    askDraftText.value = '';
    askDraftImages.value = [];
    askComposerOpen.value = false;
    askSendStatusText.value = '';
    askSendStatusTone.value = '';
  } catch (err) {
    askSendStatusTone.value = 'error';
    askSendStatusText.value = err instanceof Error ? err.message : 'Не удалось отправить сообщение.';
  } finally {
    askSendInFlight.value = false;
  }
}

const editingMessageId = ref<string | null>(null);

function escapeAttrValue(v: string): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getEditingEl(id: string): HTMLElement | null {
  const container = chatScrollRef.value;
  if (!container) return null;
  return container.querySelector<HTMLElement>(`[data-edit-id="${escapeAttrValue(id)}"]`);
}

function moveCaretToEnd(el: HTMLElement): void {
  try {
    const sel = window.getSelection?.();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    // ignore
  }
}

function getEditableText(el: HTMLElement | null): string {
  if (!el) return '';
  // innerText корректно переводит <div>/<br> в \n
  const t = (el.innerText ?? '').replace(/\r\n/g, '\n').replace(/\u00A0/g, ' ');
  return t.trim();
}

const startInlineEdit = (msg: { id: string; kind: string }) => {
  if (localCommitMutationsDisabled.value) return;
  if (msg.kind === 'haiku') return;
  editingMessageId.value = msg.id;
  nextTick(() => {
    const el = getEditingEl(msg.id);
    el?.focus();
    if (el) moveCaretToEnd(el);
  });
};

const cancelInlineEdit = () => {
  editingMessageId.value = null;
};

const saveInlineEdit = () => {
  if (localCommitMutationsDisabled.value) return;
  const id = editingMessageId.value;
  if (!id) return;
  const el = getEditingEl(id);
  const text = getEditableText(el);
  chatStore.editMessageText(id, text);
  cancelInlineEdit();
};

const makeQuestion = (msg: { id: string; text: string }) => {
  if (localCommitMutationsDisabled.value) return;
  const trimmed = msg.text.trimEnd();
  const updated = trimmed.endsWith('.') ? trimmed.slice(0, -1) + '?' : trimmed + '?';
  chatStore.editMessageText(msg.id, updated);
};

const replyWithAi = (msg: { id: string }) => {
  if (localCommitMutationsDisabled.value) return;
  void chatStore.replyToMessageWithAi(msg.id);
};

const onInlineEditKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelInlineEdit();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    saveInlineEdit();
  }
};

function maybeAutoScrollToBottom(): void {
  // Во время стриминга ответа LLM не скроллим автоматически —
  // пользователь сам контролирует позицию чтения.
  if (chatStore.isHaikuStreaming) return;
  const el = chatScrollRef.value;
  if (!el) return;
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (isNearBottom) {
    el.scrollTop = el.scrollHeight;
  }
}

watch(
  () => chatStore.messages,
  () => {
    nextTick(() => maybeAutoScrollToBottom());
  },
  { deep: true }
);

watch(
  () => chatStore.livePartialText,
  () => {
    nextTick(() => maybeAutoScrollToBottom());
  }
);

watch(
  () => chatStore.liveMicText,
  () => {
    nextTick(() => maybeAutoScrollToBottom());
  }
);

onMounted(async () => {
  if (!isTauriAvailable()) {
    store.error = t('main.tauriUnavailable');
    return;
  }

  // Загружаем версию приложения
  try {
    appVersion.value = await getVersion();
  } catch {}

  // Прогреваем звуки заранее, чтобы "done" был надёжным даже при быстром auto-hide окна.
  void preloadUiSounds();

  await store.initialize();
  await chatStore.initialize();
  await appConfigStore.startSync();
  await sttConfigStore.startSync();
  await refreshCompanionSnapshot();
  await refreshCompanionServerStatus();
  scheduleCompanionStatusRetry();

  // Очищаем UI при фактическом показе окна (НЕ через focus: main может быть nonactivating NSPanel).
  // Важно: не очищаем посреди активной записи — иначе можно потерять текст если пользователь скрыл и снова показал окно.
  unlistenWindowShown = await listen(EVENT_RECORDING_WINDOW_SHOWN, async () => {
    void auth.initialize({ silent: true });
    void appConfigStore.refresh();
    void chatStore.syncMicrophoneMuteState();
    await refreshCompanionSnapshot();

    // Если UI рассинхронизировался (например окно было скрыто и JS "заморозили"),
    // сначала сверяемся с backend: он источник правды по статусу записи.
    const backendStatus = await store.reconcileBackendStatus('window_shown');
    if (backendStatus === 'Idle' || backendStatus === null) {
      // После reconcile UI должен быть не в Recording — тогда смело чистим.
      if (!store.isRecording && !store.isStarting && !store.isProcessing) {
        store.clearText();
        chatStore.clearChatOutgoing();
      }
      return;
    }
  });

  unlistenCompanionInvalidation = await listen<StateSyncInvalidationEventPayload>(
    STATE_SYNC_INVALIDATION_EVENT,
    async (event) => {
      if (event.payload.topic !== TOPIC_COMPANION_UI) return;
      await refreshCompanionSnapshot();
      if (!companionReady.value && chatStore.companionModeEnabled) {
        await refreshCompanionServerStatus();
      }
    }
  );

  // Слушаем событие нажатия горячей клавиши для записи
  unlistenHotkey = await listen('hotkey:toggle-recording', async () => {
    await handleHotkeyToggle();
  });

  // Слушаем запрос на старт записи (от hotkey через Rust)
  unlistenStartRequested = await listen('recording:start-requested', async () => {
    console.log('[Hotkey] Received recording:start-requested');
    console.log('[Hotkey] store.status =', store.status);
    console.log('[Hotkey] store.isIdle =', store.isIdle);
    // Важно: доверяем Rust-стороне, но UI может рассинхронизироваться (особенно когда окно скрыто).
    // Поэтому сначала сверяемся с backend, а потом решаем можно ли стартовать.
    const backendStatus = await store.reconcileBackendStatus('start_requested');
    if (backendStatus && backendStatus !== 'Idle') {
      console.log('[Hotkey] Skipped - backend not idle:', backendStatus);
      return;
    }

    // Гарантируем "чистый лист" перед новым стартом.
    store.clearText();
    chatStore.clearChatOutgoing();

    console.log('[Hotkey] Starting recording...');
    await store.startRecording();
    console.log('[Hotkey] startRecording completed');
  });

  // Слушаем статус для звука и автоскрытия окна при остановке
  unlistenAutoHide = await listen<{ status: string; stopped_via_hotkey?: boolean }>('recording:status', async (event) => {
    // Проигрываем звук при ЛЮБОЙ остановке записи (через hotkey, кнопку, или автоматически)
    if (event.payload.status === 'Idle') {
      console.log('[Sound] Recording stopped, playing done sound');
      playDoneSound();

      // Автоматически скрываем окно ТОЛЬКО когда запись остановлена через hotkey
      if (event.payload.stopped_via_hotkey) {
        console.log('[AutoHide] Stopped via hotkey, hiding window');
        setTimeout(async () => {
          try {
            const window = getCurrentWebviewWindow();
            await window.hide();
            console.log('[AutoHide] Window hidden successfully');
          } catch (err) {
            console.error('[AutoHide] Failed to hide window:', err);
          }
        }, 50);
      }
    }
  });

  unlistenCodeExplainDelta = await listen<CodeExplainDeltaPayload>(EVENT_CODE_EXPLAIN_DELTA, (event) => {
    const requestId = event.payload.request_id;
    const delta = event.payload.delta;
    if (!requestId || !delta) return;
    if (codeExplainRequestId.value !== requestId) return;
    codeExplainRawText.value += delta;
    scheduleCodeExplainRender();
  });

  unlistenCodeExplainDone = await listen<CodeExplainDonePayload>(EVENT_CODE_EXPLAIN_DONE, (event) => {
    const requestId = event.payload.request_id;
    if (!requestId) return;
    if (codeExplainRequestId.value !== requestId) return;
    codeExplainStatus.value = 'final';
  });

  unlistenCodeExplainError = await listen<CodeExplainErrorPayload>(EVENT_CODE_EXPLAIN_ERROR, (event) => {
    const requestId = event.payload.request_id;
    if (!requestId) return;
    if (codeExplainRequestId.value !== requestId) return;
    codeExplainStatus.value = 'error';
    codeExplainError.value = String(event.payload.error ?? 'Ошибка');
  });

  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('paste', onPaste);
});

onUnmounted(() => {
  store.cleanup();
  chatStore.cleanup();
  appConfigStore.stopSync();
  sttConfigStore.stopSync();
  if (unlistenHotkey) {
    unlistenHotkey();
  }
  if (unlistenAutoHide) {
    unlistenAutoHide();
  }
  if (unlistenStartRequested) {
    unlistenStartRequested();
  }
  if (unlistenWindowShown) {
    unlistenWindowShown();
  }
  if (unlistenCompanionInvalidation) {
    unlistenCompanionInvalidation();
  }
  if (unlistenCodeExplainDelta) unlistenCodeExplainDelta();
  if (unlistenCodeExplainDone) unlistenCodeExplainDone();
  if (unlistenCodeExplainError) unlistenCodeExplainError();
  unlistenCodeExplainDelta = null;
  unlistenCodeExplainDone = null;
  unlistenCodeExplainError = null;
  unlistenCompanionInvalidation = null;
  clearCompanionTransientMessageTimer();
  clearCompanionStatusRetryTimer();

  document.removeEventListener('selectionchange', onSelectionChange);
  document.removeEventListener('paste', onPaste);
});

const handleToggle = async () => {
  // Воспроизводим звук сразу при клике на кнопку Start
  if (store.isIdle) {
    console.log('Playing show sound on button click');
    playShowSound();
  }

  await store.toggleRecording();
};

// Обёртка для клика — запускает glow pulse эффект и переключает запись
const onRecordClick = (e: MouseEvent) => {
  glowColor.value = store.isRecording ? 'red' : 'blue';
  const btn = e.currentTarget as HTMLElement;
  btn.addEventListener('animationend', () => { glowColor.value = null; }, { once: true });
  handleToggle();
};

const handleHotkeyToggle = async () => {
  // Защита от случайных двойных нажатий (debouncing)
  if (isHotkeyProcessing) {
    console.log('Hotkey ignored - previous call still processing');
    return;
  }

  // Очищаем предыдущий таймер если он есть
  if (hotkeyDebounceTimeout !== null) {
    clearTimeout(hotkeyDebounceTimeout);
  }

  // Устанавливаем флаг что обрабатываем hotkey
  isHotkeyProcessing = true;

  try {
    await invoke('toggle_recording_with_window');
  } catch (err) {
    console.error('Failed to toggle recording via hotkey:', err);
  } finally {
    // Разрешаем следующий вызов через 500ms (защита от случайных двойных нажатий)
    hotkeyDebounceTimeout = window.setTimeout(() => {
      isHotkeyProcessing = false;
      hotkeyDebounceTimeout = null;
    }, 500);
  }
};

const openSettings = () => {
  if (isTauriAvailable()) {
    invoke('show_settings_window');
    return;
  }
  showSettings.value = true;
};

const profileInitialSection: Ref<'none' | 'license' | 'gift'> = ref('none');

const openProfile = () => {
  if (isTauriAvailable()) {
    invoke('show_profile_window', { initialSection: 'none' });
    return;
  }
  profileInitialSection.value = 'none';
  showProfile.value = true;
};

const openProfileWithLicense = () => {
  if (isTauriAvailable()) {
    invoke('show_profile_window', { initialSection: 'license' });
    return;
  }
  profileInitialSection.value = 'license';
  showProfile.value = true;
};

const closeProfile = () => {
  showProfile.value = false;
};

// Если store запросил открытие формы лицензии (например, через кнопку в ошибке)
watch(() => store.wantsLicenseActivation, (val) => {
  if (val) {
    store.wantsLicenseActivation = false;
    openProfileWithLicense();
  }
});

watch(
  () => chatStore.companionModeEnabled,
  (enabled) => {
    if (!enabled) return;
    editingMessageId.value = null;
    hideCodeSelectionUi();
  }
);

const closeSettings = async () => {
  showSettings.value = false;
  await appConfigStore.refresh();
};

const minimizeWindow = async () => {
  try {
    await invoke('toggle_window');
  } catch (err) {
    console.error('Failed to minimize window:', err);
  }
};

const haikuHoverArmed = ref(true);

const onHaikuHover = async () => {
  try {
    if (chatStore.companionModeEnabled) {
      const response = await invoke<CompanionActionResponse>(CMD_COMPANION_REQUEST_AI, {
        questionText: null,
      });
      if (response.snapshot) {
        applyCompanionSnapshot(response.snapshot);
      }
      return;
    }
    await chatStore.requestHaikuFromAnchor();
  } catch (err) {
    console.error('Failed to start Haiku stream:', err);
  }
};

const onHaikuPointerEnter = async () => {
  // Запускаем только при "входе извне". Если курсор уже был над кнопкой,
  // или мы только что отменили запрос — не триггерим повторно.
  if (!haikuHoverArmed.value) return;
  if (chatStore.isHaikuStreaming) return;
  haikuHoverArmed.value = false;
  await onHaikuHover();
};

const onHaikuPointerLeave = () => {
  haikuHoverArmed.value = true;
};

const onHaikuClick = () => {
  if (chatStore.companionModeEnabled) return;
  if (!chatStore.isHaikuStreaming) return;
  chatStore.cancelActiveHaikuStreams();
  // Требуем реальный выход курсора, чтобы следующий запуск был только "снаружи".
  haikuHoverArmed.value = false;
};

const onMicToggleClick = async () => {
  try {
    await chatStore.toggleMicrophoneEnabled();
  } catch (err) {
    console.error('Failed to toggle microphone:', err);
  }
};

function isAdditiveSelection(e: MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

const onChatRowMouseMove = (e: MouseEvent) => {
  const row = (e.currentTarget as HTMLElement);
  const rect = row.getBoundingClientRect();
  const y = Math.max(0, e.clientY - rect.top - 14);
  row.style.setProperty('--actions-y', `${y}px`);
};

const onMessageClick = (
  e: MouseEvent,
  message: { id: string; kind: 'stt' | 'mic' | 'haiku' | 'prompt'; status: 'final' | 'streaming' | 'error'; deleted?: boolean },
) => {
  if (editingMessageId.value) return;
  if (message.kind === 'haiku' || message.deleted || message.status !== 'final') return;
  // Если пользователь выделяет текст внутри пузыря — не мешаем.
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (sel && !sel.isCollapsed && sel.toString().trim()) return;

  if (isAdditiveSelection(e)) {
    chatStore.toggleSelection(message.id);
    return;
  }
  chatStore.selectOnly(message.id);
};

const onFeedRowMouseMove = (e: MouseEvent) => {
  onChatRowMouseMove(e);
};

const onFeedMessageClick = (
  e: MouseEvent,
  msg: { id: string; kind: 'stt' | 'mic' | 'haiku' | 'prompt'; status: 'final' | 'streaming' | 'error'; deleted?: boolean },
) => {
  onMessageClick(e, msg);
};

const clearMessageSelection = () => {
  chatStore.clearSelection();
};

const clearAllHistory = async () => {
  await runCompanionClear(CMD_COMPANION_CLEAR_HISTORY);
};

const lassoActive = ref(false);
const lassoRect = ref<{ left: number; top: number; width: number; height: number } | null>(null);
let lassoStartClient: { x: number; y: number } | null = null;
let lassoAdditive = false;
let lassoBaseSelection: string[] = [];

function rectIntersects(a: DOMRect, b: { left: number; top: number; right: number; bottom: number }): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function computeIdsInViewportRect(viewport: { left: number; top: number; right: number; bottom: number }): string[] {
  const container = chatScrollRef.value;
  if (!container) return [];
  const rows = Array.from(container.querySelectorAll<HTMLElement>('.chat-row[data-msg-id]'));
  const ids: string[] = [];
  for (const el of rows) {
    const id = el.dataset.msgId;
    if (!id) continue;
    const bubble = el.querySelector<HTMLElement>('.chat-bubble') ?? el;
    const r = bubble.getBoundingClientRect();
    if (rectIntersects(r, viewport)) ids.push(id);
  }
  return ids;
}

function updateLasso(clientX: number, clientY: number): void {
  const container = chatScrollRef.value;
  if (!container || !lassoStartClient) return;

  const cr = container.getBoundingClientRect();
  const left = Math.min(lassoStartClient.x, clientX);
  const right = Math.max(lassoStartClient.x, clientX);
  const top = Math.min(lassoStartClient.y, clientY);
  const bottom = Math.max(lassoStartClient.y, clientY);

  const viewportRect = { left, top, right, bottom };
  const idsInRect = computeIdsInViewportRect(viewportRect);
  const nextIds = lassoAdditive ? [...lassoBaseSelection, ...idsInRect] : idsInRect;
  chatStore.setSelection(nextIds, false);

  // Рисуем прямоугольник в координатах контента scroll-контейнера.
  const contentLeft = left - cr.left + container.scrollLeft;
  const contentTop = top - cr.top + container.scrollTop;
  lassoRect.value = {
    left: contentLeft,
    top: contentTop,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

const onChatMouseDown = (e: MouseEvent) => {
  if (e.button !== 0) return;
  const container = chatScrollRef.value;
  if (!container) return;

  const target = e.target as HTMLElement | null;
  if (!target) return;
  // Не начинаем "рамку" если кликнули по bubble/кнопкам внутри сообщений.
  // Но разрешаем старт рамки в пустом пространстве строки (вокруг bubble).
  if (target.closest('.chat-bubble') || target.closest('.chat-actions')) return;

  lassoAdditive = isAdditiveSelection(e);
  lassoBaseSelection = lassoAdditive ? [...chatStore.selectedMessageIds] : [];
  lassoStartClient = { x: e.clientX, y: e.clientY };
  lassoActive.value = true;
  updateLasso(e.clientX, e.clientY);

  const onMove = (ev: MouseEvent) => {
    if (!lassoActive.value) return;
    updateLasso(ev.clientX, ev.clientY);
  };
  const onUp = (ev: MouseEvent) => {
    if (!lassoActive.value) return;
    updateLasso(ev.clientX, ev.clientY);
    lassoActive.value = false;
    lassoStartClient = null;
    lassoRect.value = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  e.preventDefault();
};
</script>

<template>
  <div class="popover-container">
    <div class="popover">
      <div
        v-if="shouldShowSystemAudioPermissionWarning || shouldShowMicrophonePermissionWarning"
        class="permission-warning-overlay no-drag"
      >
        <div class="permission-warning-card">
          <div class="permission-warning-title">
            Ожидаем разрешения
          </div>

          <div v-if="shouldShowSystemAudioPermissionWarning" class="permission-warning-item">
            <span class="mdi mdi-monitor-screenshot permission-warning-icon" />
            <div class="permission-warning-text">
              Нужен доступ для захвата системного звука (Screen Recording).
            </div>
          </div>

          <div v-if="shouldShowMicrophonePermissionWarning" class="permission-warning-item">
            <span class="mdi mdi-microphone permission-warning-icon" />
            <div class="permission-warning-text">
              Нужен доступ к микрофону.
            </div>
          </div>

          <div class="permission-warning-actions">
            <button class="permission-warning-btn" @click="audioPermissions.refresh">
              Проверить снова
            </button>
            <button
              v-if="shouldShowSystemAudioPermissionWarning"
              class="permission-warning-btn permission-warning-btn-secondary"
              @click="audioPermissions.requestSystemAudioPermission"
            >
              Запросить доступ
            </button>
          </div>
        </div>
      </div>
      <AudioVisualizer :active="store.isStarting || store.isRecording" />
      <div class="popover-content">
      <!-- Header -->
      <div class="header" data-tauri-drag-region @mousedown="onDragMouseDown">
        <div class="title-row">
          <span v-if="appVersion" class="app-version">{{ appVersion }}</span>
          <UpdateIndicator class="no-drag" @click="showUpdateDialog = true" />
        </div>
        <div class="header-right">
          <v-tooltip :text="t('main.minimize')" location="bottom">
            <template #activator="{ props: tp }">
              <button v-bind="tp" class="minimize-button no-drag" @click="minimizeWindow">
                <span class="mdi mdi-window-minimize"></span>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip v-if="authStore.isAuthenticated" :text="t('profile.title')" location="bottom">
            <template #activator="{ props: tp }">
              <button v-bind="tp" class="profile-button no-drag" @click="openProfile">
                <span class="mdi mdi-account-circle-outline"></span>
              </button>
            </template>
          </v-tooltip>
          <v-menu
            v-model="companionMenuOpen"
            :close-on-content-click="false"
            location="bottom end"
            offset="8"
          >
            <template #activator="{ props: menuProps }">
              <v-tooltip text="Открыть на телефоне" location="bottom">
                <template #activator="{ props: tp }">
                  <button
                    v-bind="{ ...menuProps, ...tp }"
                    class="companion-button no-drag"
                    :class="{ active: companionMenuOpen || companionReady }"
                  >
                    <span class="mdi mdi-cellphone-link"></span>
                  </button>
                </template>
              </v-tooltip>
            </template>

            <v-card class="companion-menu-card no-drag">
              <v-card-title class="companion-menu-title">
                <div>
                  <div class="companion-menu-heading">Телефон</div>
                  <div class="companion-menu-subtitle">{{ companionStatusLine }}</div>
                </div>
                <v-btn
                  icon="mdi-refresh"
                  variant="text"
                  density="comfortable"
                  :loading="companionServerBusy"
                  @click="ensureCompanionReady"
                />
              </v-card-title>
              <v-divider />
              <v-card-text class="companion-menu-content">
                <div class="companion-menu-note">
                  На компьютере окно можно свернуть. Телефон будет работать через локальный companion server.
                </div>

                <div v-if="companionQrDataUrl" class="companion-qr-shell">
                  <img class="companion-qr-image" :src="companionQrDataUrl" alt="QR с companion ссылкой" />
                </div>
                <div v-else class="companion-qr-placeholder">
                  Ссылка появится после старта companion
                </div>

                <div class="companion-link-block">
                  <div class="companion-link-label">Ссылка для телефона</div>
                  <div class="companion-link-value">
                    {{ companionLanUrl || companionLoopbackUrl || 'Companion ещё не поднялся' }}
                  </div>
                </div>

                <div v-if="companionLanUrl && companionLoopbackUrl" class="companion-link-secondary">
                  Local: {{ companionLoopbackUrl }}
                </div>

                <div v-if="companionTransientMessage" class="companion-inline-status">
                  {{ companionTransientMessage }}
                </div>
              </v-card-text>
              <v-divider />
              <v-card-actions class="companion-menu-actions">
                <v-btn variant="text" :disabled="!companionReady" @click="copyCompanionUrl">
                  Скопировать
                </v-btn>
                <v-btn color="primary" variant="flat" :loading="companionServerBusy" @click="ensureCompanionReady">
                  {{ companionReady ? 'Обновить' : 'Включить' }}
                </v-btn>
              </v-card-actions>
            </v-card>
          </v-menu>
          <v-menu
            v-model="promptMenuOpen"
            :close-on-content-click="false"
            location="bottom end"
            offset="8"
          >
            <template #activator="{ props: menuProps }">
              <v-tooltip text="Системный промпт" location="bottom">
                <template #activator="{ props: tp }">
                  <button
                    v-bind="{ ...menuProps, ...tp }"
                    class="prompt-button no-drag"
                  >
                    <span class="mdi mdi-text-box-edit-outline"></span>
                  </button>
                </template>
              </v-tooltip>
            </template>

            <v-card class="no-drag" min-width="420" max-width="520">
              <v-card-title>Системный промпт</v-card-title>
              <v-divider />
              <v-card-text>
                <v-textarea
                  v-model="promptDraft"
                  label="Инструкция для модели"
                  variant="outlined"
                  auto-grow
                  rows="6"
                  hide-details
                />
              </v-card-text>
              <v-divider />
              <v-card-actions>
                <v-spacer />
                <v-btn variant="text" @click="promptMenuOpen = false">Отмена</v-btn>
                <v-btn color="primary" variant="flat" @click="saveSystemPrompt">Сохранить</v-btn>
              </v-card-actions>
            </v-card>
          </v-menu>
          <v-tooltip :text="t('main.settings')" location="bottom">
            <template #activator="{ props: tp }">
              <button v-bind="tp" class="settings-button no-drag" data-testid="open-settings" @click="openSettings">
                <span class="mdi mdi-cog-outline"></span>
              </button>
            </template>
          </v-tooltip>
        </div>
      </div>

      <!-- Connection Warning Banner -->
      <transition name="banner-fade">
        <div v-if="store.hasConnectionIssue && store.isRecording" class="connection-warning">
          <div class="warning-icon">⚠️</div>
          <div class="warning-text">
            {{ store.connectionQuality === 'Recovering'
              ? t('main.connectionRecovering')
              : t('main.connectionPoor') }}
          </div>
        </div>
      </transition>

      <!-- Transcription Display -->
      <div class="chat-area">
        <ConversationFeed
          ref="conversationFeedRef"
          :messages="chatStore.messages"
          :empty-text="store.displayText"
          :selecting="lassoActive"
          :editing-message-id="editingMessageId"
          :anchor-mode="chatStore.anchorMode"
          :anchor-stt-index="chatStore.anchorSttIndex"
          :messages-clickable="true"
          :is-selected="chatStore.isSelected"
          :is-out-of-context="chatStore.isMessageOutOfContext"
          @scroll-mousedown="onChatMouseDown"
          @row-mousemove="onFeedRowMouseMove"
          @message-click="onFeedMessageClick"
          @inline-edit-keydown="onInlineEditKeydown"
        >
          <template #overlay>
            <div
              v-if="lassoActive && lassoRect"
              class="lasso-rect"
              :style="{
                left: `${lassoRect.left}px`,
                top: `${lassoRect.top}px`,
                width: `${lassoRect.width}px`,
                height: `${lassoRect.height}px`,
              }"
            />
          </template>

          <template v-if="!localCommitMutationsDisabled" #actions="{ msg }">
            <template v-if="msg.kind !== 'haiku' && msg.status === 'final'">
              <template v-if="editingMessageId === msg.id">
                <button class="chat-action-button" title="Сохранить" @click="saveInlineEdit">
                  <span class="mdi mdi-check" />
                </button>
                <button class="chat-action-button" title="Отмена" @click="cancelInlineEdit">
                  <span class="mdi mdi-close" />
                </button>
              </template>
              <template v-else>
                <button class="chat-action-button" title="Редактировать" @click="startInlineEdit(msg)">
                  <span class="mdi mdi-pencil-outline" />
                </button>
                <button class="chat-action-button" title="Ответить" @click="replyWithAi(msg)">
                  <span class="mdi mdi-robot-outline" />
                </button>
                <button class="chat-action-button" title="Сделать вопросом" @click="makeQuestion(msg)">
                  <span class="mdi mdi-help-circle-outline" />
                </button>
              </template>
            </template>

            <button
              v-if="msg.kind === 'haiku' || msg.status === 'final'"
              class="chat-action-button"
              title="Удалить"
              @click="chatStore.deleteMessage(msg.id)"
            >
              <span class="mdi mdi-trash-can-outline" />
            </button>
          </template>
        </ConversationFeed>

        <div v-if="store.error || store.hasError" class="error-container">
          <div class="error-row">
            <div class="error-icon">⚠️</div>
            <div class="error-message">
              {{ store.error || t('main.errorGeneric') }}
            </div>
          </div>

          <button
            v-if="store.canReconnect"
            class="error-action-button no-drag"
            :disabled="store.isStarting || store.isProcessing || store.isConnecting"
            @click="store.reconnect()"
          >
            {{ t('errors.actions.reconnect') }}
          </button>

          <button
            v-if="store.canActivateLicense"
            class="error-action-button no-drag"
            @click="openProfileWithLicense"
          >
            {{ t('errors.actions.activateLicense') }}
          </button>
        </div>
      </div>

      <div v-if="askComposerOpen" class="ask-composer no-drag">
        <div class="ask-composer-header">
          <div class="ask-composer-title">Сообщение</div>
          <button class="ask-composer-close" title="Скрыть" @click="askComposerOpen = false">
            <span class="mdi mdi-close" />
          </button>
        </div>

        <textarea
          ref="askTextareaRef"
          v-model="askDraftText"
          class="ask-textarea"
          rows="3"
          placeholder="Вставьте текст или изображения и нажмите «Отправить»"
          :disabled="askSendInFlight"
        />

        <div v-if="askDraftImages.length > 0" class="ask-attachments">
          <div v-for="img in askDraftImages" :key="img.id" class="ask-attachment">
            <img class="ask-attachment-img" :src="img.dataUrl" alt="Вложение" />
            <button class="ask-attachment-remove" title="Удалить" :disabled="askSendInFlight" @click="removeAskImage(img.id)">
              <span class="mdi mdi-close" />
            </button>
          </div>
        </div>

        <div class="ask-actions">
          <div
            v-if="askSendStatusText"
            class="ask-status"
            :class="{ warn: askSendStatusTone === 'warn', error: askSendStatusTone === 'error' }"
          >
            {{ askSendStatusText }}
          </div>
          <button class="ask-send-button" :disabled="!canSendAsk || askSendInFlight" @click="sendAsk">
            <span class="mdi mdi-send" />
            {{ askSendInFlight ? 'Отправка...' : 'Отправить' }}
          </button>
        </div>
      </div>

      <!-- Controls -->
      <div class="controls">
        <div class="controls-center">
          <v-tooltip
            :text="chatStore.microphoneEnabled
              ? `Замьютить микрофон (${microphoneMuteHotkeyLabel})`
              : `Размьютить микрофон (${microphoneMuteHotkeyLabel})`"
            location="top"
          >
            <template #activator="{ props: tp }">
              <button
                v-bind="tp"
                class="mic-toggle-button no-drag"
                :class="{ disabled: !chatStore.microphoneEnabled }"
                @click="onMicToggleClick"
              >
                <span
                  class="mdi"
                  :class="chatStore.microphoneEnabled ? 'mdi-microphone' : 'mdi-microphone-off'"
                ></span>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip :text="store.isRecording ? 'Остановить запись' : store.isProcessing ? 'Обработка...' : 'Начать запись'" location="top">
            <template #activator="{ props: tp }">
              <button
                v-bind="tp"
                v-ripple="{ class: store.isRecording ? 'text-red' : 'text-blue' }"
                class="record-button no-drag"
                :class="{
                  recording: store.isRecording,
                  starting: store.isStarting,
                  processing: store.isProcessing,
                  'glow-blue': glowColor === 'blue',
                  'glow-red': glowColor === 'red',
                }"
                :disabled="store.isProcessing || store.isStarting"
                @click="onRecordClick"
              >
                <span v-if="store.isRecording" class="mdi mdi-stop"></span>
                <span v-else-if="store.isProcessing" class="mdi mdi-cached record-icon-spin"></span>
                <span v-else class="mdi mdi-record-circle-outline"></span>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip :text="chatStore.isHaikuStreaming ? (chatStore.companionModeEnabled ? 'Генерация идёт на backend' : 'Отменить генерацию') : 'Отправить в AI'" location="top">
            <template #activator="{ props: tp }">
              <button
                v-bind="tp"
                class="haiku-button no-drag"
                :class="{ loading: chatStore.isHaikuStreaming }"
                :disabled="(!chatStore.canRequestHaiku && !chatStore.isHaikuStreaming) || (chatStore.companionModeEnabled && chatStore.isHaikuStreaming)"
                @pointerenter="onHaikuPointerEnter"
                @pointerleave="onHaikuPointerLeave"
                @click="onHaikuClick"
              >
                <span v-if="chatStore.isHaikuStreaming" class="haiku-spinner" />
                <span v-else class="mdi mdi-robot haiku-icon" />
              </button>
            </template>
          </v-tooltip>
        </div>
        <div class="controls-right no-drag">
          <v-tooltip v-if="chatStore.selectedCount > 0" text="Снять выделение" location="top">
            <template #activator="{ props: tp }">
              <div v-bind="tp" class="selection-clear-wrapper">
                <button
                  class="selection-clear-button"
                  @click="clearMessageSelection"
                >
                  <span class="mdi mdi-close-circle-outline"></span>
                </button>
                <span class="selection-badge">{{ chatStore.selectedCount }}</span>
              </div>
            </template>
          </v-tooltip>

          <v-tooltip text="Очистить контекст AI" location="top">
            <template #activator="{ props: tp }">
              <button
                v-bind="tp"
                class="context-clear-button"
                :disabled="!chatStore.hasContextToClear"
                @click="clearLlmContext"
              >
                <span class="mdi mdi-broom"></span>
              </button>
            </template>
          </v-tooltip>

          <v-tooltip text="Очистить историю" location="top">
            <template #activator="{ props: tp }">
              <button
                v-bind="tp"
                class="history-clear-button"
                @click="clearAllHistory"
              >
                <span class="mdi mdi-trash-can-outline"></span>
              </button>
            </template>
          </v-tooltip>

        </div>
      </div>
      </div>
    </div>

    <!-- Settings Modal -->
    <SettingsPanel v-if="showSettings" @close="closeSettings" />

    <!-- Profile Modal -->
    <ProfilePopover v-if="showProfile" :initial-section="profileInitialSection" @close="closeProfile" />

    <!-- Update Dialog -->
    <UpdateDialog v-model="showUpdateDialog" />

    <button
      class="ask-fab no-drag"
      :class="{ open: askComposerOpen }"
      title="Сообщение"
      @click="toggleAskComposer"
    >
      <span class="mdi mdi-message-text-outline" />
    </button>

    <button
      v-if="codeSelectionUi.visible"
      class="code-selection-robot-button no-drag"
      :style="{ left: `${codeSelectionUi.x}px`, top: `${codeSelectionUi.y}px` }"
      title="Спросить про выделенное"
      @mousedown.prevent.stop
      @click.prevent.stop="onExplainSelectedCode"
    >
      <span class="mdi mdi-robot-outline" />
    </button>

    <v-dialog v-model="codeExplainDialogOpen" max-width="720">
      <v-card class="no-drag">
        <v-card-title class="d-flex align-center justify-space-between">
          <span>Объяснение кода</span>
          <v-btn icon="mdi-close" variant="text" @click="codeExplainDialogOpen = false" />
        </v-card-title>
        <v-divider />
        <v-card-text style="max-height: 62vh; overflow: auto">
          <div v-if="codeExplainStatus === 'error'" class="text-error">
            Ошибка: {{ codeExplainError }}
          </div>
          <div v-else class="chat-markdown" v-html="codeExplainHtml" />
          <span v-if="codeExplainStatus === 'streaming'" class="chat-cursor">▍</span>
        </v-card-text>
      </v-card>
    </v-dialog>

  </div>
</template>

<style scoped>
.popover-container {
  display: block;
  inset: 0;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  overflow: visible;
  background: transparent;
  padding: 0;
}

.popover {
  background: #14161b;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-xl);
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  box-sizing: border-box;
  overflow: hidden;
  position: relative;
}

.permission-warning-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  padding: 16px;
}

.permission-warning-card {
  width: min(520px, 100%);
  background: rgba(20, 22, 27, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  padding: 14px 14px 12px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
}

::global(.theme-light) .permission-warning-card {
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(0, 0, 0, 0.12);
}

.permission-warning-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text);
  margin-bottom: 10px;
}

.permission-warning-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  margin-bottom: 8px;
}

::global(.theme-light) .permission-warning-item {
  background: rgba(0, 0, 0, 0.04);
}

.permission-warning-icon {
  font-size: 18px;
  color: rgba(244, 67, 54, 0.95);
  margin-top: 1px;
}

.permission-warning-text {
  font-size: 13px;
  line-height: 1.35;
  color: var(--color-text);
  opacity: 0.92;
}

.permission-warning-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.permission-warning-btn {
  border: 1px solid rgba(244, 67, 54, 0.65);
  background: rgba(244, 67, 54, 0.9);
  color: #fff;
  padding: 6px 10px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 13px;
}

.permission-warning-btn:hover {
  background: rgba(244, 67, 54, 0.98);
}

.permission-warning-btn-secondary {
  background: transparent;
  color: var(--color-text);
}

.permission-warning-btn-secondary:hover {
  background: rgba(255, 255, 255, 0.08);
}

:global(.theme-light) .popover-container {
  background: transparent;
}

:global(.theme-light) .popover {
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.popover-content {
  padding: var(--spacing-sm);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  position: relative;
  z-index: 1;
}

.chat-area {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.chat-area :deep(.scroll-to-bottom-button) {
  right: 16px;
  bottom: 84px;
  z-index: 27;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-sm);
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
  background: transparent;
  cursor: grab;
}

.header > *,
.header .title-row,
.header .title,
.header .app-version {
  pointer-events: none;
}

.header .no-drag {
  pointer-events: auto;
  cursor: default;
}

:global(.theme-light) .header {
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.title {
  font-size: 19px;
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-shrink: 0;
}

.haiku-button {
  width: 48px;
  height: 48px;
  padding: 0;
  border-radius: 12px;
  border: 1px solid rgba(244, 67, 54, 0.45);
  background: rgba(244, 67, 54, 0.9);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.9;
  transition: all 0.15s ease;
}

.haiku-button:hover:not(:disabled) {
  opacity: 1;
  transform: scale(1.05);
}

.haiku-button:disabled {
  opacity: 0.35;
  cursor: default;
  transform: none;
}

.context-clear-button:disabled {
  opacity: 0.3;
  cursor: default;
}

.haiku-button.loading {
  background: rgba(244, 67, 54, 0.18);
}

.haiku-icon {
  font-size: 22px;
  color: #fff;
}

.haiku-spinner {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.35);
  border-top-color: rgba(255, 255, 255, 0.95);
  animation: haiku-spin 0.8s linear infinite;
}

.mic-toggle-button {
  width: 48px;
  height: 48px;
  padding: 0;
  border-radius: 12px;
  border: 1px solid rgba(59, 130, 246, 0.35);
  background: rgba(59, 130, 246, 0.18);
  color: rgba(255, 255, 255, 0.95);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  opacity: 0.92;
  transition: all 0.15s ease;
}

.mic-toggle-button:hover {
  opacity: 1;
  transform: scale(1.05);
}

.mic-toggle-button.disabled {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.12);
  opacity: 0.6;
}

.mic-toggle-button.disabled:hover {
  transform: none;
}

@keyframes haiku-spin {
  to {
    transform: rotate(360deg);
  }
}

.minimize-button,
.companion-button,
.settings-button,
.profile-button {
  background: none;
  border: none;
  font-size: 22px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  transition: all 0.2s ease;
  opacity: 0.8;
  color: var(--color-text);
}

.minimize-button {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  color: var(--color-text);
}

.minimize-button:hover,
.companion-button:hover,
.settings-button:hover,
.profile-button:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
}

.companion-button.active {
  opacity: 1;
  background: rgba(59, 130, 246, 0.18);
  color: rgba(255, 255, 255, 0.95);
}


:global(.theme-light) .minimize-button:hover,
:global(.theme-light) .companion-button:hover,
:global(.theme-light) .settings-button:hover,
:global(.theme-light) .profile-button:hover {
  background: rgba(0, 0, 0, 0.06);
}

:global(.theme-light) .minimize-button {
  color: #1f2937;
}

:global(.os-windows) .popover {
  padding: var(--spacing-xs);
}

:global(.os-windows) .header {
  padding: 0 var(--spacing-xs);
}

:global(.os-windows) .header-right {
  gap: var(--spacing-xs);
}

:global(.os-windows) .minimize-button,
:global(.os-windows) .companion-button,
:global(.os-windows) .settings-button {
  padding: 2px 4px;
}

:global(.os-windows) .settings-button {
  font-size: 19px;
}

.chat-action-button {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-text);
  opacity: 0.9;
  transition: background 0.12s ease, opacity 0.12s ease, transform 0.12s ease;
}

.chat-action-button:hover {
  background: rgba(255, 255, 255, 0.14);
  opacity: 1;
  transform: translateY(-0.5px);
}
.code-selection-robot-button {
  position: fixed;
  z-index: 30;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 10px;
  border: 1px solid rgba(244, 67, 54, 0.35);
  background: rgba(244, 67, 54, 0.22);
  color: rgba(255, 255, 255, 0.95);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
  transition: transform 0.12s ease, background 0.12s ease, opacity 0.12s ease;
}

.code-selection-robot-button:hover {
  transform: scale(1.06);
  background: rgba(244, 67, 54, 0.32);
}

.code-selection-robot-button:active {
  transform: scale(0.98);
}

.error-container {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm);
  background: rgba(244, 67, 54, 0.15);
  border: 1px solid rgba(244, 67, 54, 0.3);
  border-radius: var(--radius-sm);
  animation: shake 0.5s ease-in-out;
}

.error-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.error-icon {
  font-size: 22px;
  flex-shrink: 0;
}

.error-message {
  font-size: 14px;
  color: var(--color-error);
  line-height: 1.4;
  flex: 1;
}

.error-action-button {
  align-self: flex-start;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(244, 67, 54, 0.35);
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.error-action-button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
}

.error-action-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@keyframes shake {
  0%, 100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-5px);
  }
  75% {
    transform: translateX(5px);
  }
}

.ask-composer {
  width: 100%;
  box-sizing: border-box;
  padding: 10px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ask-composer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ask-composer-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text);
  opacity: 0.9;
}

.ask-composer-close {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.9;
  transition: background 0.12s ease, opacity 0.12s ease, transform 0.12s ease;
}

.ask-composer-close:hover {
  background: rgba(255, 255, 255, 0.14);
  opacity: 1;
  transform: translateY(-0.5px);
}

.ask-textarea {
  width: 100%;
  box-sizing: border-box;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.22);
  color: var(--color-text);
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.35;
  resize: vertical;
  min-height: 74px;
  max-height: 240px;
  outline: none;
}

.ask-textarea:focus {
  border-color: rgba(59, 130, 246, 0.55);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.18);
}

.ask-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.ask-attachment {
  position: relative;
  width: 110px;
  height: 74px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.2);
}

.ask-attachment-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.ask-attachment-remove {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 26px;
  height: 26px;
  border-radius: 9px;
  border: none;
  background: rgba(0, 0, 0, 0.55);
  color: rgba(255, 255, 255, 0.95);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(6px);
  transition: transform 0.12s ease, background 0.12s ease;
}

.ask-attachment-remove:disabled {
  opacity: 0.45;
  cursor: default;
  transform: none;
}

.ask-attachment-remove:hover {
  transform: scale(1.04);
  background: rgba(0, 0, 0, 0.7);
}

.ask-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.ask-status {
  width: 100%;
  font-size: 12px;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.65);
}

.ask-status.warn {
  color: #f4c95d;
}

.ask-status.error {
  color: #ff9a8f;
}

.ask-send-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  border: 1px solid rgba(59, 130, 246, 0.45);
  background: rgba(59, 130, 246, 0.92);
  color: #fff;
  cursor: pointer;
  font-size: 13px;
  font-weight: 700;
  transition: transform 0.12s ease, opacity 0.12s ease, background 0.12s ease;
}

.ask-send-button:hover:not(:disabled) {
  transform: translateY(-0.5px);
  opacity: 1;
  background: rgba(59, 130, 246, 1);
}

.ask-send-button:disabled {
  opacity: 0.45;
  cursor: default;
  transform: none;
}

.ask-fab {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 52px;
  height: 52px;
  border-radius: 16px;
  border: 1px solid rgba(59, 130, 246, 0.4);
  background: rgba(59, 130, 246, 0.92);
  color: rgba(255, 255, 255, 0.98);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
  transition: transform 0.12s ease, opacity 0.12s ease, background 0.12s ease;
  z-index: 28;
}

.ask-fab:hover {
  transform: scale(1.04);
}

.ask-fab.open {
  background: rgba(59, 130, 246, 0.28);
}

.controls {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  box-sizing: border-box;
  margin-top: auto;
  padding-bottom: 7px;
}

.controls-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.controls-right {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
}

.controls-right .selection-clear-button,
.controls-right .context-clear-button,
.controls-right .history-clear-button {
  width: 48px;
  height: 48px;
  padding: 0;
  border-radius: 12px;
  font-size: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
  opacity: 0.9;
}

.controls-right .selection-clear-button:hover,
.controls-right .history-clear-button:hover {
  opacity: 1;
  transform: scale(1.05);
}

.controls-right .context-clear-button {
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.95);
}

.controls-right .context-clear-button:hover:not(:disabled) {
  opacity: 1;
  transform: scale(1.05);
  background: rgba(255, 255, 255, 0.14);
}

.controls-right .context-clear-button:disabled {
  opacity: 0.3;
  cursor: default;
  transform: none;
}

.controls-right .history-clear-button {
  border: 1px solid rgba(244, 67, 54, 0.4);
  background: rgba(244, 67, 54, 0.18);
  color: rgba(255, 255, 255, 0.95);
}

.controls-right .history-clear-button:hover {
  background: rgba(244, 67, 54, 0.3);
}

.prompt-button {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  font-size: 20px;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: opacity 0.15s, background 0.15s;
  opacity: 0.7;
}

.prompt-button:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.08);
}

.companion-menu-card {
  width: min(340px, calc(100vw - 20px));
  border-radius: 18px;
}

.companion-menu-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.companion-menu-heading {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text);
}

.companion-menu-subtitle {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--color-text-secondary);
}

.companion-menu-content {
  display: grid;
  gap: 12px;
}

.companion-menu-note {
  font-size: 13px;
  line-height: 1.45;
  color: var(--color-text-secondary);
}

.companion-qr-shell,
.companion-qr-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  padding: 12px;
  background: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.18);
}

.companion-qr-image {
  width: min(220px, 100%);
  height: auto;
  display: block;
  border-radius: 12px;
}

.companion-qr-placeholder {
  min-height: 180px;
  font-size: 13px;
  line-height: 1.45;
  text-align: center;
  color: var(--color-text-secondary);
}

.companion-link-block {
  display: grid;
  gap: 6px;
}

.companion-link-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-secondary);
}

.companion-link-value,
.companion-link-secondary,
.companion-inline-status {
  word-break: break-all;
  overflow-wrap: anywhere;
}

.companion-link-value {
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.2);
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.45;
}

.companion-link-secondary {
  font-size: 12px;
  line-height: 1.45;
  color: var(--color-text-secondary);
}

.companion-inline-status {
  font-size: 12px;
  line-height: 1.45;
  color: #8ec5ff;
}

.companion-menu-actions {
  justify-content: space-between;
}

.selection-clear-wrapper {
  position: relative;
  display: inline-flex;
}

.selection-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 10px;
  background: #4caf50;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 20px;
  text-align: center;
  pointer-events: none;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  z-index: 1;
}

.controls-right .selection-clear-button {
  border: 1px solid rgba(244, 67, 54, 0.4);
  background: rgba(244, 67, 54, 0.18);
  color: rgba(255, 255, 255, 0.95);
}

.controls-right .selection-clear-button:hover {
  background: rgba(244, 67, 54, 0.3);
}

.record-button {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--color-accent);
  color: #fff;
  border: none;
  font-size: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform 0.2s ease, background 0.2s ease, opacity 0.2s ease;
  overflow: visible;
}

/* Glow pulse эффект снаружи кнопки */
.record-button.glow-blue {
  animation: glow-pulse-blue 1s cubic-bezier(0.2, 0, 0.2, 1) forwards;
}

.record-button.glow-red {
  animation: glow-pulse-red 1s cubic-bezier(0.2, 0, 0.2, 1) forwards;
}

@keyframes glow-pulse-blue {
  0% {
    box-shadow: 0 0 0 0 rgba(33, 150, 243, 0.5);
  }
  30% {
    box-shadow: 0 0 16px 10px rgba(33, 150, 243, 0.35);
  }
  100% {
    box-shadow: 0 0 0 20px rgba(33, 150, 243, 0);
  }
}

@keyframes glow-pulse-red {
  0% {
    box-shadow: 0 0 0 0 rgba(244, 67, 54, 0.5);
  }
  30% {
    box-shadow: 0 0 16px 10px rgba(244, 67, 54, 0.35);
  }
  100% {
    box-shadow: 0 0 0 20px rgba(244, 67, 54, 0);
  }
}

.record-button:hover:not(:disabled) {
  transform: scale(1.08);
  box-shadow: var(--shadow-md);
}

.record-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.record-button.starting {
  background: var(--color-warning);
  opacity: 0.8;
  animation: pulse 1.5s infinite;
}

.record-button.recording {
  background: var(--color-error);
}

.record-button.processing {
  background: var(--color-warning);
}

@keyframes pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.06); }
}

.record-icon-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.footer {
  display: none;
}

:global(.theme-light) .footer {
  position: relative;
  border-top: none;
}

:global(.theme-light) .footer::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -1px;
  height: 3px;
  background: transparent;
}

.hint {
  font-size: 13px;
  color: var(--color-text-secondary);
  word-wrap: break-word;
  overflow-wrap: break-word;
  text-align: center;
}

/* Connection Warning Banner */
.connection-warning {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm);
  background: rgba(255, 193, 7, 0.15);
  border: 1px solid rgba(255, 193, 7, 0.3);
  border-radius: var(--radius-sm);
  width: 100%;
  box-sizing: border-box;
}

.connection-warning .warning-icon {
  font-size: 19px;
  flex-shrink: 0;
}

.connection-warning .warning-text {
  font-size: 14px;
  color: #ffc107;
  line-height: 1.4;
  flex: 1;
}

/* Banner Fade Animation */
.banner-fade-enter-active,
.banner-fade-leave-active {
  transition: all 0.3s ease;
}

.banner-fade-enter-from {
  opacity: 0;
  transform: translateY(-10px);
}

.banner-fade-leave-to {
  opacity: 0;
  transform: translateY(-5px);
}

/* Версия приложения */
.app-version {
  font-size: 10px;
  font-weight: 400;
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.35));
  white-space: nowrap;
  user-select: none;
}

/* Бейдж "Есть обновление" рядом с заголовком */
.title-row {
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

@media (max-width: 560px) {
  .chat-area :deep(.scroll-to-bottom-button) {
    right: 12px;
    bottom: 74px;
  }

  .popover-content {
    padding: 6px;
  }

  .header {
    padding: 6px;
  }

  .header-right {
    gap: 6px;
  }

  .controls-center,
  .controls-right {
    gap: 8px;
  }

  .controls-right {
    left: 6px;
  }

  .haiku-button,
  .mic-toggle-button,
  .controls-right .selection-clear-button,
  .controls-right .context-clear-button,
  .controls-right .history-clear-button {
    width: 42px;
    height: 42px;
    border-radius: 10px;
    font-size: 18px;
  }

  .haiku-spinner {
    width: 28px;
    height: 28px;
  }

  .record-button {
    width: 58px;
    height: 58px;
    font-size: 24px;
  }
}

@media (max-width: 420px) {
  .chat-area :deep(.scroll-to-bottom-button) {
    right: 10px;
    bottom: 68px;
  }

  .popover-content {
    padding: 4px;
  }

  .header {
    padding: 4px;
  }

  .title {
    font-size: 16px;
  }

  .app-version {
    display: none;
  }

  .header-right {
    gap: 2px;
  }

  .minimize-button,
  .companion-button,
  .settings-button,
  .profile-button,
  .prompt-button {
    font-size: 20px;
    padding: 1px 4px;
  }

  .controls-center,
  .controls-right {
    gap: 6px;
  }

  .controls-right {
    left: 4px;
  }

  .haiku-button,
  .mic-toggle-button,
  .controls-right .selection-clear-button,
  .controls-right .context-clear-button,
  .controls-right .history-clear-button {
    width: 38px;
    height: 38px;
    border-radius: 10px;
    font-size: 17px;
  }

  .record-button {
    width: 54px;
    height: 54px;
    font-size: 22px;
  }

  .ask-fab {
    right: 12px;
    bottom: 12px;
    width: 46px;
    height: 46px;
    border-radius: 14px;
    font-size: 20px;
  }
}

@media (max-width: 340px) {
  .title {
    font-size: 14px;
  }

  .header-right {
    gap: 0;
  }

  .minimize-button,
  .companion-button,
  .settings-button,
  .profile-button,
  .prompt-button {
    font-size: 18px;
    padding: 1px 3px;
  }

  .controls-right {
    display: block;
    left: 4px;
    width: 82px;
    min-height: 82px;
    transform: translateY(-50%);
  }

  .controls-right .selection-clear-wrapper {
    position: absolute;
    right: 0;
    bottom: 0;
  }

  .controls-right .context-clear-button {
    position: absolute;
    left: 0;
    bottom: 0;
  }

  .controls-right .history-clear-button {
    position: absolute;
    left: 0;
    top: 0;
  }
}

::global(.theme-light) .prompt-button:hover,
::global(.theme-light) .context-clear-button:hover {
  background: rgba(0, 0, 0, 0.06);
}
</style>

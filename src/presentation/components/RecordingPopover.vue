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
import { buildCodeExplainContextUpToMessageId } from '@/presentation/codeExplainContext';
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
import { useTestInterviewer } from '@/composables/useTestInterviewer';
import { useAudioPermissions } from '@/composables/useAudioPermissions';
import {
  CMD_COMPANION_CLEAR_CONTEXT,
  CMD_COMPANION_CLEAR_HISTORY,
  CMD_COMPANION_REQUEST_AI,
  CMD_COMPANION_SET_DESKTOP_BLACKOUT,
  CMD_COMPANION_SEND_PROMPT,
  CMD_CANCEL_HAIKU_STREAMS,
  CMD_ENABLE_COMPANION_MODE,
  CMD_GET_COMPANION_SERVER_STATUS,
  CMD_GET_COMPANION_SNAPSHOT,
  COMPANION_SNAPSHOT_EVENT,
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
const webSearchToggleTooltip = computed(() =>
  chatStore.openaiResponsesWebSearchEnabled
    ? 'Web search для OpenAI включён'
    : 'Web search для OpenAI выключен'
);

const audioPermissions = useAudioPermissions();
const testInterviewer = useTestInterviewer();
function onTestInterviewerClick(e: MouseEvent) {
  if (e.shiftKey) void testInterviewer.reset();
  else void testInterviewer.askNext();
}

const shouldShowSystemAudioPermissionWarning = computed(() => {
  return !audioPermissions.systemAudioGranted.value;
});

const shouldShowMicrophonePermissionWarning = computed(() => {
  return chatStore.microphoneEnabled && !audioPermissions.microphoneGranted.value;
});

type FocusCopyHelperInfo = {
  app_bundle_path: string;
  executable_path: string;
  accessibility_target_path: string;
  accessibility_target_exists: boolean;
};

const hasAccessibilityPermission = ref(true);
const accessibilityPermissionBusy = ref(false);
const accessibilityPermissionError = ref('');
const accessibilityPermissionStatus = ref('');
const focusCopyHelperInfo = ref<FocusCopyHelperInfo | null>(null);
const focusCopyHelperRevealBusy = ref(false);
let accessibilityPermissionRefreshTimer: number | null = null;

const shouldShowAccessibilityPermissionBanner = computed(() => {
  return isMac && !hasAccessibilityPermission.value;
});

// Статус хоткеев копирования из редактора показываем, пока лента пуста: сразу видно, работают ли они.
const hotkeyStatusLine = computed(() => {
  if (!isMac) return '';
  return hasAccessibilityPermission.value
    ? '✓ Ctrl+Shift+A и Ctrl+Shift+S готовы: выдели текст в редакторе и нажми'
    : '✗ Ctrl+Shift+A и Ctrl+Shift+S не работают: нужен доступ Accessibility для Telegram';
});
const emptyFeedText = computed(() =>
  [store.displayText, hotkeyStatusLine.value].filter(Boolean).join('\n\n')
);

const accessibilityPermissionTooltip = computed(() => {
  return hasAccessibilityPermission.value
    ? 'Открыть Accessibility'
    : 'Запросить Accessibility';
});

const accessibilityPermissionTitle = computed(() => {
  return hasAccessibilityPermission.value
    ? 'Accessibility: Ctrl+Shift+A'
    : 'Нужен Accessibility';
});

const accessibilityPermissionText = computed(() => {
  if (!focusCopyHelperInfo.value?.accessibility_target_exists) {
    return 'Сначала соберите Telegram.app через pnpm copy-helper:build, потом добавьте её в Accessibility.';
  }

  return hasAccessibilityPermission.value
    ? 'Если Telegram не копирует текст, добавьте .app ниже в Accessibility.'
    : 'Доступ нужен для чтения текста в активном поле и восстановления caret.';
});

const accessibilityPermissionButtonLabel = computed(() => {
  if (accessibilityPermissionBusy.value) return 'Открываю...';
  return hasAccessibilityPermission.value ? 'Открыть доступ' : 'Запросить доступ';
});

async function refreshAccessibilityPermission(): Promise<void> {
  if (!isTauriAvailable() || !isMac) {
    hasAccessibilityPermission.value = true;
    accessibilityPermissionError.value = '';
    accessibilityPermissionStatus.value = '';
    return;
  }

  try {
    hasAccessibilityPermission.value = await invoke<boolean>('check_focus_copy_helper_accessibility');
    accessibilityPermissionError.value = '';
    accessibilityPermissionStatus.value = `${hasAccessibilityPermission.value ? 'Helper доступ есть' : 'Helper доступа нет'} - ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  } catch (err) {
    hasAccessibilityPermission.value = false;
    accessibilityPermissionError.value = err instanceof Error ? err.message : String(err);
  }
}

async function loadFocusCopyHelperInfo(): Promise<void> {
  if (!isTauriAvailable() || !isMac) {
    focusCopyHelperInfo.value = null;
    return;
  }

  try {
    focusCopyHelperInfo.value = await invoke<FocusCopyHelperInfo>('get_focus_copy_helper_info');
  } catch (err) {
    accessibilityPermissionError.value = err instanceof Error ? err.message : String(err);
  }
}

async function revealFocusCopyHelper(): Promise<void> {
  if (focusCopyHelperRevealBusy.value) return;
  focusCopyHelperRevealBusy.value = true;
  accessibilityPermissionError.value = '';

  try {
    await invoke('reveal_focus_copy_helper');
    await loadFocusCopyHelperInfo();
  } catch (err) {
    accessibilityPermissionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    focusCopyHelperRevealBusy.value = false;
  }
}

function scheduleAccessibilityPermissionRefresh(delayMs: number): void {
  if (accessibilityPermissionRefreshTimer !== null) {
    window.clearTimeout(accessibilityPermissionRefreshTimer);
  }

  accessibilityPermissionRefreshTimer = window.setTimeout(() => {
    accessibilityPermissionRefreshTimer = null;
    void refreshAccessibilityPermission();
  }, delayMs);
}

async function requestAccessibilityPermission(): Promise<void> {
  if (accessibilityPermissionBusy.value) return;
  accessibilityPermissionBusy.value = true;
  accessibilityPermissionError.value = '';

  try {
    await refreshAccessibilityPermission();
    if (hasAccessibilityPermission.value) {
      return;
    }

    await invoke('request_accessibility_permission');
    await refreshAccessibilityPermission();
    await loadFocusCopyHelperInfo();
    scheduleAccessibilityPermissionRefresh(2000);
  } catch (err) {
    accessibilityPermissionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    accessibilityPermissionBusy.value = false;
  }
}

// Debouncing для hotkey - блокирует повторные вызовы в течение 500ms
let hotkeyDebounceTimeout: number | null = null;
let isHotkeyProcessing = false;

let unlistenHotkey: UnlistenFn | null = null;
let unlistenAutoHide: UnlistenFn | null = null;
let unlistenStartRequested: UnlistenFn | null = null;
let unlistenWindowShown: UnlistenFn | null = null;
let unlistenCompanionInvalidation: UnlistenFn | null = null;
let unlistenCompanionSnapshot: UnlistenFn | null = null;
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
const companionDesktopBlackoutEnabled = ref(false);
const companionDesktopBlackoutBusy = ref(false);
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
const companionDesktopBlackoutTitle = computed(() => (
  companionDesktopBlackoutEnabled.value
    ? 'Показать окно приложения на компьютере'
    : 'Затемнить окно приложения на компьютере'
));
const companionDesktopBlackoutButtonLabel = computed(() => (
  companionDesktopBlackoutEnabled.value ? 'Показать' : 'Затемнить'
));
const companionDesktopBlackoutStatus = computed(() => (
  companionDesktopBlackoutEnabled.value ? 'Окно сейчас затемнено' : 'Окно сейчас видно'
));
const companionDesktopBlackoutIcon = computed(() => (
  companionDesktopBlackoutEnabled.value ? 'mdi-monitor-off' : 'mdi-monitor'
));
const companionStatusLine = computed(() => {
  if (companionServerBusy.value) return 'Поднимаю companion на компьютере';
  if (companionLanUrl.value) return 'Готово - открой QR с телефона в той же Wi-Fi сети';
  if (companionLoopbackUrl.value) return 'Companion активен локально на этом компьютере';
  if (companionServerStatus.value?.enabled) return 'Companion включён, но адрес ещё определяется';
  return 'Companion пока не включён';
});

// Ref для области чата (для автоскролла)
const chatScrollRef = computed(() => conversationFeedRef.value?.scrollEl ?? null);

const CODE_EXPLAIN_SYSTEM_PROMPT = `Ты — ассистент на техническом собеседовании. Всегда отвечай по-русски, даже если вопрос задан на украинском или английском. Технические термины оставляй на английском.

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

const onExplainSelectedCode = async () => {
  const messageId = codeSelectionUi.value.messageId;
  const selectedText = codeSelectionUi.value.selectedText;
  if (!messageId || !selectedText) return;

  const contextText = buildCodeExplainContextUpToMessageId(chatStore.messages, messageId);
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
  companionDesktopBlackoutEnabled.value = !!snapshot.data.controls.desktopBlackoutEnabled;

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

async function toggleCompanionDesktopBlackout(): Promise<void> {
  if (!isTauriAvailable() || companionDesktopBlackoutBusy.value) return;

  const enabled = !companionDesktopBlackoutEnabled.value;
  companionDesktopBlackoutBusy.value = true;
  try {
    const response = await invoke<CompanionActionResponse>(CMD_COMPANION_SET_DESKTOP_BLACKOUT, {
      enabled,
    });
    if (response.snapshot) {
      applyCompanionSnapshot(response.snapshot);
    }

    if (!response.ok) {
      const message = response.actionResult === 'busy_transition'
        ? 'Подожди - предыдущее действие ещё выполняется.'
        : response.actionResult === 'rejected_auth'
          ? 'Нужно заново авторизоваться на компьютере.'
          : 'Не удалось переключить затемнение.';
      setCompanionTransientMessage(message, 4200);
      return;
    }

    setCompanionTransientMessage(
      enabled ? 'Окно приложения затемнено' : 'Окно приложения снова видно',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setCompanionTransientMessage(`Не удалось переключить затемнение: ${message}`, 4200);
  } finally {
    companionDesktopBlackoutBusy.value = false;
  }
}

async function runCompanionPromptSend(input: {
  text: string;
  images?: PromptImageDraft[];
}): Promise<CompanionActionResponse | null> {
  if (!isTauriAvailable()) return null;

  const args: Record<string, unknown> = {
    text: input.text,
    images: (input.images ?? []).map((img) => ({
      mediaType: img.mime,
      dataBase64: img.dataBase64,
    })),
    openaiResponsesWebSearch: chatStore.openaiResponsesWebSearchEnabled,
  };
  if (chatStore.selectedMessageIds.length > 0) {
    args.selectedMessageIds = chatStore.selectedMessageIds;
  }

  const response = await invoke<CompanionActionResponse>(CMD_COMPANION_SEND_PROMPT, args);
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
      chatStore.clearSelection();
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
  await loadFocusCopyHelperInfo();
  await refreshAccessibilityPermission();
  await refreshCompanionSnapshot();
  await refreshCompanionServerStatus();
  scheduleCompanionStatusRetry();

  // Очищаем UI при фактическом показе окна (НЕ через focus: main может быть nonactivating NSPanel).
  // Важно: не очищаем посреди активной записи — иначе можно потерять текст если пользователь скрыл и снова показал окно.
  unlistenWindowShown = await listen(EVENT_RECORDING_WINDOW_SHOWN, async () => {
    void auth.initialize({ silent: true });
    void appConfigStore.refresh();
    void chatStore.syncMicrophoneMuteState();
    void loadFocusCopyHelperInfo();
    void refreshAccessibilityPermission();
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
      const nextRevision = Number(event.payload.revision || '0');
      const currentRevision = Number(companionRevision.value || '0');
      if (
        Number.isFinite(nextRevision)
        && Number.isFinite(currentRevision)
        && nextRevision <= currentRevision
      ) {
        if (!companionReady.value && chatStore.companionModeEnabled) {
          await refreshCompanionServerStatus();
        }
        return;
      }
      await refreshCompanionSnapshot();
      if (!companionReady.value && chatStore.companionModeEnabled) {
        await refreshCompanionServerStatus();
      }
    }
  );

  unlistenCompanionSnapshot = await listen<TauriSnapshotEnvelope<CompanionSnapshotData>>(
    COMPANION_SNAPSHOT_EVENT,
    (event) => {
      if (!event.payload.data.controls.companionModeEnabled && !chatStore.companionModeEnabled) {
        return;
      }
      applyCompanionSnapshot(event.payload);
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
  stopHaikuWaitTimer();
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
  if (unlistenCompanionSnapshot) {
    unlistenCompanionSnapshot();
  }
  if (unlistenCodeExplainDelta) unlistenCodeExplainDelta();
  if (unlistenCodeExplainDone) unlistenCodeExplainDone();
  if (unlistenCodeExplainError) unlistenCodeExplainError();
  if (accessibilityPermissionRefreshTimer !== null) {
    window.clearTimeout(accessibilityPermissionRefreshTimer);
    accessibilityPermissionRefreshTimer = null;
  }
  unlistenCodeExplainDelta = null;
  unlistenCodeExplainDone = null;
  unlistenCodeExplainError = null;
  unlistenCompanionInvalidation = null;
  unlistenCompanionSnapshot = null;
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
const haikuStopInFlight = ref(false);
const haikuRequestPending = ref(false);
const haikuWaitSeconds = ref(0);
let haikuWaitTimer: ReturnType<typeof setInterval> | null = null;
let haikuWaitStartedAt = 0;

function stopHaikuWaitTimer(): void {
  if (haikuWaitTimer) clearInterval(haikuWaitTimer);
  haikuWaitTimer = null;
}

function startHaikuWaitTimer(): void {
  stopHaikuWaitTimer();
  haikuWaitStartedAt = Date.now();
  haikuWaitSeconds.value = 0;
  haikuWaitTimer = setInterval(() => {
    haikuWaitSeconds.value = Math.floor((Date.now() - haikuWaitStartedAt) / 1000);
  }, 1000);
}

const onHaikuHover = async () => {
  try {
    if (chatStore.companionModeEnabled) {
      const args: Record<string, unknown> = {
        questionText: null,
        openaiResponsesWebSearch: chatStore.openaiResponsesWebSearchEnabled,
      };
      if (chatStore.selectedMessageIds.length > 0) {
        args.selectedMessageIds = chatStore.selectedMessageIds;
      }

      const response = await invoke<CompanionActionResponse>(CMD_COMPANION_REQUEST_AI, args);
      if (response.snapshot) {
        applyCompanionSnapshot(response.snapshot);
      }
      if (response.ok) {
        chatStore.clearSelection();
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
  if (chatStore.isHaikuStreaming || haikuRequestPending.value) return;
  haikuHoverArmed.value = false;
  haikuRequestPending.value = true;
  startHaikuWaitTimer();
  try {
    await onHaikuHover();
  } finally {
    haikuRequestPending.value = false;
    if (!chatStore.isHaikuStreaming) stopHaikuWaitTimer();
  }
};

const onHaikuPointerLeave = () => {
  haikuHoverArmed.value = true;
};

const stopHaikuGeneration = async () => {
  if (!chatStore.isHaikuStreaming) return;
  if (haikuStopInFlight.value) return;
  haikuStopInFlight.value = true;
  chatStore.cancelActiveHaikuStreams();
  try {
    const response = await invoke<CompanionActionResponse>(CMD_CANCEL_HAIKU_STREAMS);
    if (response.snapshot) {
      applyCompanionSnapshot(response.snapshot);
    }
  } catch (err) {
    console.error('Failed to cancel companion AI stream:', err);
  }
  // Требуем реальный выход курсора, чтобы следующий запуск был только "снаружи".
  haikuHoverArmed.value = false;
};

const onHaikuStopHover = async () => {
  await stopHaikuGeneration();
};

const onHaikuStopClick = async () => {
  await stopHaikuGeneration();
};

watch(
  () => chatStore.isHaikuStreaming,
  (streaming) => {
    if (!streaming) {
      haikuStopInFlight.value = false;
      if (!haikuRequestPending.value) stopHaikuWaitTimer();
    }
  }
);

const onMicToggleClick = async () => {
  try {
    await chatStore.toggleMicrophoneEnabled();
  } catch (err) {
    console.error('Failed to toggle microphone:', err);
  }
};

const onWebSearchToggleClick = () => {
  chatStore.toggleOpenAiResponsesWebSearch();
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
  message: { id: string; kind: 'stt' | 'mic' | 'signal' | 'haiku' | 'prompt'; status: 'final' | 'streaming' | 'error'; deleted?: boolean },
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
  msg: { id: string; kind: 'stt' | 'mic' | 'signal' | 'haiku' | 'prompt'; status: 'final' | 'streaming' | 'error'; deleted?: boolean },
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
          <div class="permission-warning-heading">
            <div class="permission-warning-title">Ожидаем разрешения</div>
            <button
              class="permission-warning-minimize no-drag"
              type="button"
              :aria-label="t('main.minimize')"
              :title="t('main.minimize')"
              @click="minimizeWindow"
            >
              <span class="mdi mdi-window-minimize" aria-hidden="true" />
            </button>
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
            <button
              v-if="shouldShowMicrophonePermissionWarning"
              class="permission-warning-btn permission-warning-btn-secondary"
              @click="audioPermissions.requestMicrophonePermission"
            >
              Запросить микрофон
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
          <v-tooltip
            v-if="testInterviewer.enabled.value"
            :text="testInterviewer.lastQuestion.value
              ? `Следующий вопрос (озвучен ${testInterviewer.lastQuestion.value.number}/${testInterviewer.total.value}). Shift+клик: сначала`
              : 'Тест-интервьюер: озвучить первый вопрос'"
            location="bottom"
          >
            <template #activator="{ props: tp }">
              <button
                v-bind="tp"
                class="minimize-button test-interviewer-button no-drag"
                :disabled="testInterviewer.busy.value"
                @click="onTestInterviewerClick"
              >
                <span class="mdi mdi-account-voice"></span>
                <span v-if="testInterviewer.lastQuestion.value" class="test-interviewer-counter">
                  {{ testInterviewer.lastQuestion.value.number }}/{{ testInterviewer.total.value }}
                </span>
              </button>
            </template>
          </v-tooltip>
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

                <div class="companion-desktop-control">
                  <div class="companion-desktop-control-copy">
                    <div class="companion-desktop-control-title">Экран компьютера</div>
                    <div class="companion-desktop-control-status">{{ companionDesktopBlackoutStatus }}</div>
                  </div>
                  <v-btn
                    variant="tonal"
                    size="small"
                    :prepend-icon="companionDesktopBlackoutIcon"
                    :title="companionDesktopBlackoutTitle"
                    :color="companionDesktopBlackoutEnabled ? 'warning' : undefined"
                    :loading="companionDesktopBlackoutBusy"
                    :disabled="!companionReady"
                    @click="toggleCompanionDesktopBlackout"
                  >
                    {{ companionDesktopBlackoutButtonLabel }}
                  </v-btn>
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

            <v-card class="system-prompt-card no-drag">
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
              <v-card-actions class="system-prompt-actions">
                <v-btn variant="text" @click="promptMenuOpen = false">Отмена</v-btn>
                <v-btn color="primary" variant="flat" @click="saveSystemPrompt">Сохранить</v-btn>
              </v-card-actions>
            </v-card>
          </v-menu>
          <v-tooltip :text="accessibilityPermissionTooltip" location="bottom">
            <template #activator="{ props: tp }">
              <button
                v-if="isMac && !hasAccessibilityPermission"
                v-bind="tp"
                class="accessibility-button no-drag"
                :class="{ active: !hasAccessibilityPermission }"
                :title="accessibilityPermissionTooltip"
                :disabled="accessibilityPermissionBusy"
                @click="requestAccessibilityPermission"
              >
                <span class="mdi mdi-shield-key-outline"></span>
              </button>
            </template>
          </v-tooltip>
          <v-tooltip :text="t('main.settings')" location="bottom">
            <template #activator="{ props: tp }">
              <button v-bind="tp" class="settings-button no-drag" data-testid="open-settings" @click="openSettings">
                <span class="mdi mdi-cog-outline"></span>
              </button>
            </template>
          </v-tooltip>
        </div>
      </div>

      <transition name="banner-fade">
        <div v-if="shouldShowAccessibilityPermissionBanner" class="accessibility-permission-banner no-drag">
          <span class="mdi mdi-shield-key-outline accessibility-permission-icon" />
          <div class="accessibility-permission-copy">
            <div class="accessibility-permission-title">
              {{ accessibilityPermissionTitle }}
            </div>
            <div class="accessibility-permission-text">
              {{ accessibilityPermissionText }}
              <span v-if="accessibilityPermissionError">
                {{ accessibilityPermissionError }}
              </span>
            </div>
            <div
              v-if="focusCopyHelperInfo?.accessibility_target_path"
              class="accessibility-permission-path"
              :title="focusCopyHelperInfo.accessibility_target_path"
            >
              {{ focusCopyHelperInfo.accessibility_target_path }}
            </div>
            <div v-if="accessibilityPermissionStatus" class="accessibility-permission-status">
              {{ accessibilityPermissionStatus }}
            </div>
          </div>
          <div class="accessibility-permission-actions">
            <button
              class="accessibility-permission-btn accessibility-permission-btn-secondary"
              :disabled="accessibilityPermissionBusy"
              @click="refreshAccessibilityPermission"
            >
              Проверить
            </button>
            <button
              class="accessibility-permission-btn accessibility-permission-btn-secondary"
              :disabled="focusCopyHelperRevealBusy"
              @click="revealFocusCopyHelper"
            >
              {{ focusCopyHelperRevealBusy ? 'Открываю...' : 'Показать Telegram' }}
            </button>
            <button
              class="accessibility-permission-btn"
              :disabled="accessibilityPermissionBusy"
              @click="requestAccessibilityPermission"
            >
              {{ accessibilityPermissionButtonLabel }}
            </button>
          </div>
        </div>
      </transition>

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
          :assistant-streaming="chatStore.isHaikuStreaming"
          :empty-text="emptyFeedText"
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
          @assistant-candidate-select="chatStore.selectHaikuCandidate"
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

          <button
            v-if="store.canOpenSettingsForDevice"
            class="error-action-button no-drag"
            @click="openSettings"
          >
            {{ t('errors.actions.openSettingsForDevice') }}
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
          <v-tooltip :text="webSearchToggleTooltip" location="top">
            <template #activator="{ props: tp }">
              <button
                v-bind="tp"
                class="web-search-toggle-button no-drag"
                :class="{ active: chatStore.openaiResponsesWebSearchEnabled }"
                :aria-pressed="chatStore.openaiResponsesWebSearchEnabled"
                @click="onWebSearchToggleClick"
              >
                <span class="mdi mdi-web"></span>
              </button>
            </template>
          </v-tooltip>
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
          <div class="haiku-control-group">
            <span v-if="haikuRequestPending || chatStore.isHaikuStreaming" class="haiku-wait-label">
              {{ haikuRequestPending ? 'Отправляю…' : `AI отвечает · ${haikuWaitSeconds} с` }}
            </span>
            <v-tooltip :text="chatStore.isHaikuStreaming ? 'Генерация ответа...' : 'Отправить в AI'" location="top">
              <template #activator="{ props: tp }">
                <button
                  v-bind="tp"
                  class="haiku-button no-drag"
                  data-testid="haiku-generate-button"
                  :class="{ loading: chatStore.isHaikuStreaming }"
                  :disabled="!chatStore.canRequestHaiku && !chatStore.isHaikuStreaming"
                  @pointerenter="onHaikuPointerEnter"
                  @pointerleave="onHaikuPointerLeave"
                  @mouseenter="onHaikuPointerEnter"
                  @mouseleave="onHaikuPointerLeave"
                  @mousemove="onHaikuPointerEnter"
                >
                  <span v-if="chatStore.isHaikuStreaming" class="haiku-spinner" />
                  <span v-else class="mdi mdi-robot haiku-icon" />
                </button>
              </template>
            </v-tooltip>
            <v-tooltip v-if="chatStore.isHaikuStreaming" text="Наведи, чтобы остановить ответ" location="top">
              <template #activator="{ props: tp }">
                <button
                  v-bind="tp"
                  class="haiku-stop-button no-drag"
                  data-testid="haiku-stop-button"
                  :disabled="haikuStopInFlight"
                  @pointerenter="onHaikuStopHover"
                  @mouseenter="onHaikuStopHover"
                  @click.stop="onHaikuStopClick"
                >
                  <span class="mdi mdi-stop"></span>
                </button>
              </template>
            </v-tooltip>
          </div>
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
  inset: 64px 0 0;
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

.theme-light .permission-warning-card {
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(0, 0, 0, 0.12);
}

.permission-warning-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text);
}

.permission-warning-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.permission-warning-minimize {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
}

.permission-warning-minimize:hover {
  background: rgba(128, 128, 128, 0.2);
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

.theme-light .permission-warning-item {
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

.theme-light .popover-container {
  background: transparent;
}

.theme-light .popover {
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
  --chat-sticky-footer-bottom: 30px;

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

.theme-light .header {
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.accessibility-permission-banner {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  grid-template-areas:
    "icon copy"
    "icon actions";
  align-items: start;
  column-gap: 10px;
  row-gap: 8px;
  margin: 0 var(--spacing-sm) var(--spacing-sm);
  padding: 10px;
  border: 1px solid rgba(245, 158, 11, 0.38);
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.12);
  color: var(--color-text);
}

.theme-light .accessibility-permission-banner {
  background: rgba(245, 158, 11, 0.14);
  border-color: rgba(180, 83, 9, 0.28);
}

.accessibility-permission-icon {
  grid-area: icon;
  flex: 0 0 auto;
  font-size: 20px;
  color: rgba(245, 158, 11, 0.95);
  margin-top: 1px;
}

.accessibility-permission-copy {
  grid-area: copy;
  min-width: 0;
}

.accessibility-permission-title {
  font-size: 13px;
  line-height: 1.25;
  font-weight: 700;
}

.accessibility-permission-text {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.32;
  opacity: 0.78;
}

.accessibility-permission-path {
  margin-top: 6px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  line-height: 1.3;
  opacity: 0.72;
}

.accessibility-permission-status {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.25;
  opacity: 0.74;
}

.accessibility-permission-actions {
  grid-area: actions;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.accessibility-permission-btn {
  min-width: 96px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid rgba(245, 158, 11, 0.62);
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.94);
  color: #111827;
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.accessibility-permission-btn:hover:not(:disabled) {
  background: rgba(245, 158, 11, 1);
}

.accessibility-permission-btn:disabled {
  cursor: default;
  opacity: 0.58;
}

.accessibility-permission-btn-secondary {
  min-width: 74px;
  background: transparent;
  color: var(--color-text);
}

.accessibility-permission-btn-secondary:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.12);
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

.haiku-control-group {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.haiku-wait-label {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  padding: 3px 7px;
  border-radius: 6px;
  background: rgba(20, 20, 24, 0.9);
  color: #fff;
  font-size: 11px;
  pointer-events: none;
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

.haiku-stop-button {
  position: absolute;
  left: calc(100% + 5px);
  top: 50%;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 8px;
  border: 1px solid rgba(244, 67, 54, 0.62);
  background: rgba(244, 67, 54, 0.94);
  color: rgba(255, 255, 255, 0.96);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  opacity: 0.94;
  transform: translateY(-50%);
  transition: opacity 0.12s ease, transform 0.12s ease, background 0.12s ease;
  z-index: 3;
}

.haiku-stop-button:hover:not(:disabled) {
  opacity: 1;
  background: rgba(220, 38, 38, 1);
  transform: translateY(-50%) scale(1.08);
}

.haiku-stop-button:disabled {
  opacity: 0.45;
  cursor: default;
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

.web-search-toggle-button {
  width: 48px;
  height: 48px;
  padding: 0;
  border-radius: 12px;
  border: 1px solid rgba(20, 184, 166, 0.28);
  background: rgba(20, 184, 166, 0.1);
  color: rgba(255, 255, 255, 0.72);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  opacity: 0.9;
  transition: all 0.15s ease;
}

.web-search-toggle-button:hover {
  opacity: 1;
  transform: scale(1.05);
}

.web-search-toggle-button.active {
  background: rgba(20, 184, 166, 0.22);
  border-color: rgba(45, 212, 191, 0.55);
  color: rgba(240, 253, 250, 0.98);
  box-shadow: 0 0 0 1px rgba(45, 212, 191, 0.2), 0 0 16px rgba(20, 184, 166, 0.22);
}

.test-interviewer-button {
  position: relative;
  color: rgba(45, 212, 191, 0.95);
}

.test-interviewer-button:disabled {
  cursor: progress;
  opacity: 0.6;
}

.test-interviewer-counter {
  position: absolute;
  right: 2px;
  bottom: 1px;
  font-size: 10px;
  line-height: 1;
  color: rgba(240, 253, 250, 0.95);
}

@keyframes haiku-spin {
  to {
    transform: rotate(360deg);
  }
}

.minimize-button,
.companion-button,
.accessibility-button,
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
.accessibility-button:hover,
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

.accessibility-button.active {
  opacity: 1;
  background: rgba(245, 158, 11, 0.18);
  color: rgba(245, 158, 11, 0.95);
}


.theme-light .minimize-button:hover,
.theme-light .companion-button:hover,
.theme-light .accessibility-button:hover,
.theme-light .settings-button:hover,
.theme-light .profile-button:hover {
  background: rgba(0, 0, 0, 0.06);
}

.theme-light .minimize-button {
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
:global(.os-windows) .accessibility-button,
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

.system-prompt-card {
  width: min(520px, calc(100vw - 24px));
  min-width: min(420px, calc(100vw - 24px));
  max-width: calc(100vw - 24px);
}

.system-prompt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px 12px;
}

.system-prompt-actions :deep(.v-btn) {
  margin-inline-start: 0;
  min-width: 0;
  flex: 0 1 auto;
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

.companion-desktop-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.companion-desktop-control-copy {
  min-width: 0;
}

.companion-desktop-control-title {
  color: var(--color-text);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.3;
}

.companion-desktop-control-status {
  margin-top: 2px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.35;
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

.theme-light .footer {
  position: relative;
  border-top: none;
}

.theme-light .footer::before {
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
  .web-search-toggle-button,
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

  .haiku-stop-button {
    left: calc(100% + 4px);
    width: 22px;
    height: 22px;
    border-radius: 7px;
    font-size: 13px;
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

  .system-prompt-card {
    width: calc(100vw - 16px);
    min-width: 0;
    max-width: calc(100vw - 16px);
  }

  .system-prompt-actions {
    gap: 6px;
    padding: 8px;
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
  .web-search-toggle-button,
  .controls-right .selection-clear-button,
  .controls-right .context-clear-button,
  .controls-right .history-clear-button {
    width: 38px;
    height: 38px;
    border-radius: 10px;
    font-size: 17px;
  }

  .haiku-stop-button {
    left: calc(100% + 3px);
    width: 20px;
    height: 20px;
    border-radius: 7px;
    font-size: 12px;
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

.theme-light .prompt-button:hover,
.theme-light .context-clear-button:hover {
  background: rgba(0, 0, 0, 0.06);
}
</style>

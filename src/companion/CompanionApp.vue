<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import ConversationFeed from '@/presentation/components/ConversationFeed.vue';
import type { ConversationFeedMessage } from '@/presentation/conversationFeed';
import { buildCompanionConversationFeedMessages } from '@/presentation/companionFeed';
import { createPromptImageDraft, type PromptImageDraft } from '@/utils/promptImages';
import {
  canRetryCompanionAction,
  classifyCompanionFailureMessage,
  connectionTextForCompanionFailure,
  normalizeCompanionRequestError,
  shouldRecoverCompanionConnection,
  toneForCompanionFailure,
} from './connectionErrors';
import { isCompanionPageVisible } from './pageVisibility';
import { createCompanionReconnectScheduler, createCompanionStreamWatchdog } from './reconnectScheduler';
import { isCompanionSnapshotEnvelope, shouldApplyCompanionSnapshot } from './snapshotEpoch';
import {
  companionInstallHint,
  createCompanionRequestId,
  detectCompanionInstallPlatform,
  isCompanionStandalone,
  validateCompanionManifest,
} from './pwa';
import { abortCompanionRequests, wasCompanionRequestHiddenAborted } from './requestAbortState';
import {
  isCompanionMessageSelectable,
  normalizeCompanionSelectedIds,
  toggleCompanionSelectedId,
} from './selection';
import type {
  CompanionActionResponse,
  CompanionRecordingStatus,
  CompanionSnapshotData,
  TauriSnapshotEnvelope,
} from '@/windowing/stateSync';

type StatusTone = '' | 'ok' | 'warn' | 'error' | 'pending';
type ConnectionState = 'idle' | 'connected' | 'reconnecting' | 'disconnected';
type PwaDiagnosticStatus = 'ok' | 'warn' | 'error' | 'pending';
type PwaDiagnosticItem = {
  id: string;
  label: string;
  status: PwaDiagnosticStatus;
  message: string;
};

const token = new URLSearchParams(window.location.search).get('token')?.trim() ?? '';
const companionAvailable = token.length > 0;
const REQUEST_TIMEOUT_MS = 9000;
const ACTION_REQUEST_TIMEOUT_MS = 30000;
const PWA_CHECK_TIMEOUT_MS = 4500;
const PWA_INSTALL_HINT_DISMISSED_KEY = 'companionPwaInstallHintDismissed';
const OPENAI_RESPONSES_WEB_SEARCH_STORAGE_KEY = 'openaiResponsesWebSearchEnabled';
const UNCONFIRMED_ACTION_WARNING = 'Не удалось подтвердить отправку. После восстановления связи проверь ленту перед повтором.';

const companionFeedRef = ref<{ scrollEl: HTMLElement | null } | null>(null);
const snapshot = ref<TauriSnapshotEnvelope<CompanionSnapshotData> | null>(null);
const connectionState = ref<ConnectionState>(companionAvailable ? 'idle' : 'disconnected');
const connectionText = ref(companionAvailable ? 'Подключаюсь к компьютеру...' : 'Ссылка не содержит token');
const actionStatusText = ref('');
const actionStatusTone = ref<StatusTone>('');
const currentRevision = ref(0);
const currentInstanceId = ref<string | null>(null);
const actionInFlight = ref(false);
const syncInFlight = ref(false);
const aiQuestion = ref('');
const aiComposerOpen = ref(false);
const openaiResponsesWebSearchEnabled = ref(readStoredBoolean(OPENAI_RESPONSES_WEB_SEARCH_STORAGE_KEY, true));
const promptImages = ref<PromptImageDraft[]>([]);
const promptFileInputRef = ref<HTMLInputElement | null>(null);
const pwaStandalone = ref(false);
const pwaDiagnosticItems = ref<PwaDiagnosticItem[]>([]);
const pwaDiagnosticChecking = ref(false);
const pwaDiagnosticExpanded = ref(false);
const pwaInstallHintDismissed = ref(
  typeof localStorage !== 'undefined' && localStorage.getItem(PWA_INSTALL_HINT_DISMISSED_KEY) === '1',
);
const feedScrolledDown = ref(false);
const selectedMessageIds = ref<string[]>([]);

let eventSource: EventSource | null = null;
let displayModeMediaQuery: MediaQueryList | null = null;
let displayModeChangeHandler: (() => void) | null = null;
let statusTimer: number | null = null;
let resyncPromise: Promise<void> | null = null;
const requestControllers = new Set<AbortController>();
let componentUnmounted = false;
// A timed-out POST may have succeeded. Keep the notice visible after SSE
// recovers, until a subsequent user action deliberately replaces it.
let unconfirmedActionWarning = false;
const reconnectScheduler = createCompanionReconnectScheduler(
  () => {
    void resyncConnection({ reconnect: true }).catch((error) => {
      handleResyncFailure(error, 'Пытаюсь восстановить связь с компьютером...');
    });
  },
  () => (
    !componentUnmounted
    && companionAvailable
    && connectionState.value !== 'disconnected'
    && pageVisible()
    // navigator.onLine describes WAN connectivity, not reachability of our
    // local Wi-Fi host. Retry LAN HTTP even without Internet access.
  ),
);
const streamWatchdog = createCompanionStreamWatchdog(() => {
  if (!eventSource || componentUnmounted || !pageVisible()) return;
  disposeEventSource();
  setPwaLiveDiagnostic('warn', 'SSE heartbeat не поступал, восстанавливаю соединение');
  setConnection('reconnecting', 'Поток обновлений перестал отвечать, переподключаюсь...');
  reconnectScheduler.schedule();
});

const feedMessages = computed(() => buildCompanionConversationFeedMessages(snapshot.value?.data));
const selectedMessageIdSet = computed(() => new Set(selectedMessageIds.value));
const selectedMessageCount = computed(() => selectedMessageIds.value.length);
const hasSelectedMessages = computed(() => selectedMessageCount.value > 0);
const snapshotData = computed<CompanionSnapshotData | null>(() => snapshot.value?.data ?? null);
const scrollEl = computed(() => companionFeedRef.value?.scrollEl ?? null);
const snapshotReady = computed(() => snapshotData.value !== null);
const connectionReady = computed(() => connectionState.value === 'connected');

const authRequired = computed(() => !!snapshotData.value?.authRequired);
const topConnectionText = computed(() => actionStatusText.value || connectionText.value);
const showTopConnectionStatus = computed(() => (
  actionStatusText.value.length > 0
  || connectionState.value !== 'connected'
));
const topStackVisible = computed(() => showTopConnectionStatus.value || pwaNoticeVisible.value);
const emptyFeedText = computed(() => {
  if (!companionAvailable) return 'Некорректная companion-ссылка. Открой QR из окна приложения заново.';
  if (authRequired.value) return 'Сначала авторизуйся в приложении на компьютере.';
  return 'Сообщений пока нет. Запусти запись на компьютере и список появится здесь.';
});

const recordingStatus = computed<CompanionRecordingStatus>(() => snapshotData.value?.recording.status ?? 'Idle');
const canStop = computed(() => recordingStatus.value === 'Recording' || recordingStatus.value === 'Starting');
const appMicrophoneMuted = computed(() => !!snapshotData.value?.microphone.appMuted);
const recordButtonTitle = computed(() => (canStop.value ? 'Остановить запись' : 'Начать запись'));
const appMicrophoneToggleTitle = computed(() => (
  appMicrophoneMuted.value ? 'Включить микрофон в приложении' : 'Замьютить микрофон только в приложении'
));
const aiButtonTitle = computed(() => 'Сгенерировать ответ');
const promptComposerTitle = computed(() => (aiComposerOpen.value ? 'Скрыть сообщение в AI' : 'Открыть сообщение в AI'));
const webSearchToggleTitle = computed(() => (
  openaiResponsesWebSearchEnabled.value ? 'Web search для OpenAI включён' : 'Web search для OpenAI выключен'
));
const canSendPrompt = computed(() => aiQuestion.value.trim().length > 0 || promptImages.value.length > 0);
const pwaInstallPlatform = computed(() => detectCompanionInstallPlatform(
  typeof navigator === 'undefined' ? null : navigator,
));
const pwaInstallText = computed(() => companionInstallHint(pwaInstallPlatform.value));
const showPwaInstallHint = computed(() => (
  companionAvailable
  && !pwaStandalone.value
  && !pwaInstallHintDismissed.value
));
const pwaDiagnosticProblems = computed(() => pwaDiagnosticItems.value.filter((item) => item.status === 'warn' || item.status === 'error'));
const pwaDiagnosticHasError = computed(() => pwaDiagnosticItems.value.some((item) => item.status === 'error'));
const pwaNoticeVisible = computed(() => (
  showPwaInstallHint.value
  || pwaDiagnosticChecking.value
  || pwaDiagnosticProblems.value.length > 0
  || pwaDiagnosticExpanded.value
));
const pwaNoticeTone = computed<StatusTone>(() => {
  if (pwaDiagnosticHasError.value) return 'error';
  if (pwaDiagnosticProblems.value.length > 0 || showPwaInstallHint.value) return 'warn';
  if (pwaDiagnosticChecking.value) return 'pending';
  return 'ok';
});
const pwaNoticeText = computed(() => {
  if (showPwaInstallHint.value) return pwaInstallText.value;
  if (pwaDiagnosticChecking.value) return 'Проверяю PWA и локальный companion...';
  const problem = pwaDiagnosticProblems.value[0];
  if (problem) return problem.message;
  return 'PWA проверка прошла успешно';
});
const actionsDisabled = computed(() => (
  !companionAvailable
  || !snapshotReady.value
  || !connectionReady.value
  || actionInFlight.value
  || syncInFlight.value
  || authRequired.value
));
const recordActionBlocked = computed(() => actionInFlight.value || recordingStatus.value === 'Processing');
const recordButtonClass = computed(() => ({
  starting: recordingStatus.value === 'Starting',
  recording: recordingStatus.value === 'Recording',
  processing: recordingStatus.value === 'Processing',
}));
const recordButtonIconClass = computed(() => {
  if (recordingStatus.value === 'Starting' || recordingStatus.value === 'Processing') {
    return 'mdi mdi-loading dock-icon-spin';
  }
  if (recordingStatus.value === 'Recording') {
    return 'mdi mdi-stop';
  }
  return 'mdi mdi-record-circle-outline';
});

function statusRevision(next: TauriSnapshotEnvelope<CompanionSnapshotData>): number {
  const value = Number(next?.revision || '0');
  return Number.isFinite(value) ? value : 0;
}

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

function setOpenAiResponsesWebSearchEnabled(enabled: boolean): void {
  openaiResponsesWebSearchEnabled.value = !!enabled;
  try {
    localStorage.setItem(OPENAI_RESPONSES_WEB_SEARCH_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

function toggleOpenAiResponsesWebSearch(): void {
  setOpenAiResponsesWebSearchEnabled(!openaiResponsesWebSearchEnabled.value);
}

function selectedMessageIdsPayload(): string[] | undefined {
  const normalized = normalizeCompanionSelectedIds(selectedMessageIds.value, feedMessages.value);
  if (normalized.length !== selectedMessageIds.value.length) {
    selectedMessageIds.value = normalized;
  }
  return normalized.length > 0 ? normalized : undefined;
}

function clearSelectedMessages(): void {
  selectedMessageIds.value = [];
}

function isFeedMessageSelected(id: string): boolean {
  return selectedMessageIdSet.value.has(id);
}

function isAdditiveSelection(event: MouseEvent): boolean {
  if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '')) {
    return event.metaKey;
  }
  return event.ctrlKey || event.metaKey;
}

function hasActiveTextSelection(): boolean {
  const selection = typeof window === 'undefined' ? null : window.getSelection?.();
  return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
}

function onFeedMessageClick(event: MouseEvent, message: ConversationFeedMessage): void {
  if (!isCompanionMessageSelectable(message)) return;
  if (hasActiveTextSelection()) return;

  if (hasSelectedMessages.value || isAdditiveSelection(event)) {
    selectedMessageIds.value = toggleCompanionSelectedId(
      selectedMessageIds.value,
      message,
      feedMessages.value,
    );
    return;
  }

  selectedMessageIds.value = normalizeCompanionSelectedIds([message.id], feedMessages.value);
}

function isNearBottom(): boolean {
  const element = scrollEl.value;
  if (!element) return true;
  const remaining = element.scrollHeight - (element.scrollTop + element.clientHeight);
  return remaining < 88;
}

async function stickToBottomIfNeeded(): Promise<void> {
  await nextTick();
  const element = scrollEl.value;
  if (!element) return;
  element.scrollTop = element.scrollHeight;
}

async function applySnapshot(next: TauriSnapshotEnvelope<CompanionSnapshotData>): Promise<void> {
  const nextRevision = statusRevision(next);
  if (!shouldApplyCompanionSnapshot(next, currentRevision.value, currentInstanceId.value)) {
    return;
  }

  const shouldStickBottom = isNearBottom();
  const nextInstanceId = next.data?.controls?.instanceId ?? null;
  const epochChanged = !!currentInstanceId.value && !!nextInstanceId
    && currentInstanceId.value !== nextInstanceId;
  const revisionAdvanced = epochChanged || nextRevision > currentRevision.value;
  snapshot.value = next;
  currentRevision.value = nextRevision;
  currentInstanceId.value = nextInstanceId;
  if (epochChanged) {
    // IDs and sequence numbers can be reused by the new desktop process.
    // Never send an old selection as context for an unrelated new message.
    selectedMessageIds.value = [];
  }

  if (shouldStickBottom && revisionAdvanced) {
    await stickToBottomIfNeeded();
  }
}

function clearStatusTimer(): void {
  if (statusTimer !== null) {
    window.clearTimeout(statusTimer);
    statusTimer = null;
  }
}

function setStatus(text: string, tone: StatusTone = ''): void {
  // A later transient reconnect error must not hide an ambiguous POST result.
  // Explicit fatal errors can still replace it (e.g. an expired token).
  if (unconfirmedActionWarning && text !== UNCONFIRMED_ACTION_WARNING && tone !== 'error') return;
  clearStatusTimer();
  actionStatusText.value = text;
  actionStatusTone.value = tone;
}

function setTemporaryStatus(text: string, tone: StatusTone = '', timeoutMs = 2600): void {
  setStatus(text, tone);
  if (!text) return;
  statusTimer = window.setTimeout(() => {
    statusTimer = null;
    setStatus('');
  }, timeoutMs);
}

function setConnection(state: ConnectionState, text: string): void {
  connectionState.value = state;
  connectionText.value = text;
}

function describeActionResult(actionResult?: string | null): string {
  switch (actionResult) {
    case 'started':
      return 'Запись запущена';
    case 'stopped':
      return 'Запись остановлена';
    case 'muted':
      return 'Микрофон выключен';
    case 'unmuted':
      return 'Микрофон включён';
    case 'desktop_blackout_enabled':
      return 'Окно приложения затемнено';
    case 'desktop_blackout_disabled':
      return 'Окно приложения снова видно';
    case 'cleared_context':
      return 'AI контекст очищен';
    case 'cleared_history':
      return 'История очищена';
    case 'started_ai':
      return 'Генерирую ответ';
    case 'started_prompt':
      return 'Сообщение отправлено';
    case 'busy_transition':
      return 'Подожди, предыдущее действие ещё выполняется';
    case 'rejected_auth':
      return 'Авторизуйся на компьютере и открой ссылку заново';
    case 'noop':
      return 'Состояние уже актуально';
    case undefined:
    case null:
    case '':
      return 'Без действий';
    default:
      return actionResult;
  }
}

function pageVisible(): boolean {
  return isCompanionPageVisible(typeof document === 'undefined' ? null : document);
}

function updateFeedScrolledState(): void {
  const element = scrollEl.value;
  feedScrolledDown.value = !!element && element.scrollTop > 8;
}

function refreshPwaStandaloneState(): void {
  pwaStandalone.value = isCompanionStandalone(typeof window === 'undefined' ? null : window);
}

function setPwaDiagnosticItem(item: PwaDiagnosticItem): void {
  const nextItems = pwaDiagnosticItems.value.slice();
  const index = nextItems.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) {
    nextItems[index] = item;
  } else {
    nextItems.push(item);
  }
  pwaDiagnosticItems.value = nextItems;
}

function dismissPwaInstallHint(): void {
  pwaInstallHintDismissed.value = true;
  try {
    localStorage.setItem(PWA_INSTALL_HINT_DISMISSED_KEY, '1');
  } catch {
    // ignore storage failures in private browsing modes
  }
}

async function fetchPwaCheck(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), PWA_CHECK_TIMEOUT_MS);
  try {
    return await fetch(path, {
      cache: 'no-store',
      ...init,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function pwaCheckErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'PWA проверка не дождалась ответа от локального companion';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function checkPwaManifest(): Promise<void> {
  try {
    const response = await fetchPwaCheck(`/manifest.webmanifest?token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      setPwaDiagnosticItem({
        id: 'manifest',
        label: 'Manifest',
        status: 'error',
        message: `PWA manifest не открылся: ${response.status}`,
      });
      return;
    }

    const manifest = await response.json() as unknown;
    const validation = validateCompanionManifest(manifest);
    setPwaDiagnosticItem({
      id: 'manifest',
      label: 'Manifest',
      status: validation.ok ? 'ok' : 'error',
      message: validation.ok
        ? 'PWA manifest доступен'
        : validation.problems[0] || 'PWA manifest неполный',
    });
  } catch (error) {
    setPwaDiagnosticItem({
      id: 'manifest',
      label: 'Manifest',
      status: 'error',
      message: pwaCheckErrorMessage(error),
    });
  }
}

async function checkPwaIcon(): Promise<void> {
  try {
    const response = await fetchPwaCheck('/companion-icon-512.png', { method: 'HEAD' });
    setPwaDiagnosticItem({
      id: 'icon',
      label: 'Icon',
      status: response.ok ? 'ok' : 'warn',
      message: response.ok ? 'PWA icon доступна' : `PWA icon не открылась: ${response.status}`,
    });
  } catch (error) {
    setPwaDiagnosticItem({
      id: 'icon',
      label: 'Icon',
      status: 'warn',
      message: pwaCheckErrorMessage(error),
    });
  }
}

async function checkPwaStateApi(): Promise<void> {
  try {
    const response = await fetchPwaCheck(`/api/state?token=${encodeURIComponent(token)}`);
    setPwaDiagnosticItem({
      id: 'api',
      label: 'API',
      status: response.ok ? 'ok' : 'error',
      message: response.ok ? 'Локальный API отвечает' : `Локальный API вернул ${response.status}`,
    });
  } catch (error) {
    setPwaDiagnosticItem({
      id: 'api',
      label: 'API',
      status: 'error',
      message: pwaCheckErrorMessage(error),
    });
  }
}

async function runPwaDiagnostics(): Promise<void> {
  if (!companionAvailable) return;
  pwaDiagnosticChecking.value = true;
  refreshPwaStandaloneState();
  try {
    await Promise.all([
      checkPwaManifest(),
      checkPwaIcon(),
      checkPwaStateApi(),
    ]);
  } finally {
    pwaDiagnosticChecking.value = false;
  }
}

function setPwaLiveDiagnostic(status: PwaDiagnosticStatus, message: string): void {
  setPwaDiagnosticItem({
    id: 'live',
    label: 'Live',
    status,
    message,
  });
}

function extractErrorMessage(status: number, payload: CompanionActionResponse | null, raw: string): string {
  if (payload?.actionResult) {
    return describeActionResult(payload.actionResult);
  }
  if (status === 401 || status === 403) {
    return 'Ссылка устарела или companion перезапустился. Открой QR из окна приложения заново.';
  }
  return compactResponseError(raw, `Запрос завершился ошибкой: ${status}`);
}

function compactResponseError(raw: string, fallback: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return fallback;
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return fallback;
  }
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
}

function handleResyncFailure(error: unknown, fallbackText: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const kind = classifyCompanionFailureMessage(message);
  if (kind === 'hidden') {
    // A rapid hidden → visible transition may reuse an aborted in-flight GET.
    reconnectScheduler.schedule();
    return;
  }
  if (kind === 'expired') {
    disposeEventSource();
    reconnectScheduler.cancel();
  }
  setConnection(
    kind === 'expired' ? 'disconnected' : 'reconnecting',
    connectionTextForCompanionFailure(kind, fallbackText),
  );
  setStatus(message, toneForCompanionFailure(kind));
  if (kind !== 'expired') {
    reconnectScheduler.schedule();
  }
}

function abortForHiddenLifecycle(): void {
  abortCompanionRequests(requestControllers, 'hidden');
  requestControllers.clear();
}

function disposeEventSource(): void {
  streamWatchdog.stop();
  const source = eventSource;
  eventSource = null;
  if (!source) return;
  source.onopen = null;
  source.onerror = null;
  source.close();
}

async function requestJson<T>(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{
  response: Response;
  json: T | null;
  raw: string;
}> {
  // navigator.onLine may be false while the desktop on the same LAN is
  // still reachable. Let the actual HTTP request and timeout decide.
  const controller = new AbortController();
  requestControllers.add(controller);
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(path, {
      cache: 'no-store',
      ...init,
      signal: controller.signal,
    });
    const raw = await response.text();
    let json: T | null = null;
    try {
      json = raw ? JSON.parse(raw) as T : null;
    } catch {
      json = null;
    }
    return { response, json, raw };
  } catch (error) {
    throw normalizeCompanionRequestError(error, {
      aborted: controller.signal.aborted,
      offline: typeof navigator !== 'undefined' && 'onLine' in navigator && navigator.onLine === false,
      hidden: wasCompanionRequestHiddenAborted(
        controller,
        typeof document === 'undefined' ? null : document
      ),
    });
  } finally {
    window.clearTimeout(timeoutId);
    requestControllers.delete(controller);
  }
}

async function refreshSnapshot(): Promise<void> {
  if (!companionAvailable) return;
  const { response, json, raw } =
    await requestJson<TauriSnapshotEnvelope<CompanionSnapshotData>>(`/api/state?token=${encodeURIComponent(token)}`);

  if (response.status === 401 || response.status === 403) {
    throw new Error('Ссылка устарела или companion перезапустился. Открой QR из окна приложения заново.');
  }
  if (!response.ok || !isCompanionSnapshotEnvelope(json)) {
    throw new Error(compactResponseError(raw, `Не удалось получить корректное состояние Companion: ${response.status}`));
  }

  await applySnapshot(json);
}

async function resyncConnection(options: {
  reconnect?: boolean;
  successStatusText?: string;
} = {}): Promise<void> {
  if (resyncPromise) {
    return resyncPromise;
  }

  const task = (async () => {
    syncInFlight.value = true;
    try {
      await refreshSnapshot();

      if (componentUnmounted || !pageVisible()) {
        return;
      }

      if (options.reconnect || !eventSource || connectionState.value !== 'connected') {
        connectEvents();
      }

      setConnection('connected', options.successStatusText || 'Связь с компьютером активна');
      if (!actionInFlight.value) {
        setStatus('');
      }
    } finally {
      syncInFlight.value = false;
    }
  })();

  resyncPromise = task;
  // .finally() returns a *new* rejected promise when GET fails; attaching
  // both outcomes keeps cleanup from generating an unhandled rejection.
  void task.then(
    () => {
      if (resyncPromise === task) resyncPromise = null;
    },
    () => {
      if (resyncPromise === task) resyncPromise = null;
    },
  );

  return task;
}

type SendActionOptions = {
  requestId?: string;
  retryOnRecoverable?: boolean;
};

async function sendAction(
  path: string,
  body: Record<string, unknown> = {},
  options: SendActionOptions = {},
): Promise<boolean> {
  if (
    actionInFlight.value
    || syncInFlight.value
    || !companionAvailable
    || !snapshotReady.value
    || !connectionReady.value
    || authRequired.value
  ) {
    return false;
  }

  const requestId = options.requestId ?? createCompanionRequestId();
  // Request-id de-duplication is in memory and resets with the desktop.
  // A lost reply must never replay recording, history clearing or AI prompts.
  const retryOnRecoverable = options.retryOnRecoverable ?? canRetryCompanionAction(path);
  let retryAfterRecover = false;
  let originalError: unknown = null;

  actionInFlight.value = true;
  unconfirmedActionWarning = false;
  setStatus('Выполняю действие...', 'pending');

  try {
    const { response, json, raw } = await requestJson<CompanionActionResponse>(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Companion-Token': token,
        'X-Companion-Request-Id': requestId,
      },
      body: JSON.stringify(body),
    }, ACTION_REQUEST_TIMEOUT_MS);

    if (response.status === 401 || response.status === 403) {
      disposeEventSource();
      setConnection('disconnected', 'Ссылка устарела. Открой её из окна приложения заново.');
      throw new Error(extractErrorMessage(response.status, json, raw));
    }

    if (json?.snapshot) {
      if (!isCompanionSnapshotEnvelope(json.snapshot)) {
        throw new Error('Companion вернул некорректное состояние после команды');
      }
      await applySnapshot(json.snapshot);
    }

    if (response.status === 409 || json?.actionResult === 'busy_transition') {
      setTemporaryStatus(describeActionResult('busy_transition'), 'warn', 3200);
      return false;
    }

    if (!response.ok) {
      throw new Error(extractErrorMessage(response.status, json, raw));
    }

    setTemporaryStatus(describeActionResult(json?.actionResult), 'ok');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = classifyCompanionFailureMessage(message);

    if (kind === 'hidden') {
      // Backgrounding aborts the response, not necessarily the desktop action.
      // Never make a non-idempotent POST look safely unsent after wake.
      if (!retryOnRecoverable) {
        unconfirmedActionWarning = true;
        setStatus(UNCONFIRMED_ACTION_WARNING, 'warn');
      } else {
        setStatus('');
      }
      return false;
    }

    if (shouldRecoverCompanionConnection(kind)) {
      disposeEventSource();
      setConnection('reconnecting', connectionTextForCompanionFailure(kind, 'Пытаюсь восстановить связь с компьютером...'));
      if (!retryOnRecoverable) {
        reconnectScheduler.schedule();
      }
    }

    if (!retryOnRecoverable && shouldRecoverCompanionConnection(kind)) {
      unconfirmedActionWarning = true;
    }
    setStatus(
      !retryOnRecoverable && shouldRecoverCompanionConnection(kind)
        ? UNCONFIRMED_ACTION_WARNING
        : message,
      toneForCompanionFailure(kind),
    );

    if (
      shouldRecoverCompanionConnection(kind)
      && typeof document !== 'undefined'
      && document.visibilityState === 'visible'
      && retryOnRecoverable
    ) {
      retryAfterRecover = true;
      originalError = error;
    } else {
      throw error;
    }
  } finally {
    actionInFlight.value = false;
  }

  if (retryAfterRecover) {
    try {
      await resyncConnection({ reconnect: true });
    } catch (resyncError) {
      handleResyncFailure(resyncError, 'Пытаюсь восстановить связь с компьютером...');
      throw originalError ?? resyncError;
    }
    return sendAction(path, body, { requestId, retryOnRecoverable: false });
  }

  return false;
}

async function onRecordClick(): Promise<void> {
  if (canStop.value) {
    await sendAction('/api/record/stop');
    return;
  }
  await sendAction('/api/record/start');
}

async function requestAiReply(): Promise<void> {
  const selectedIds = selectedMessageIdsPayload();
  const body: Record<string, unknown> = {
    text: '',
    openaiResponsesWebSearch: openaiResponsesWebSearchEnabled.value,
  };
  if (selectedIds) {
    body.selectedMessageIds = selectedIds;
  }
  const applied = await sendAction('/api/ai/request', body);
  if (applied && selectedIds) {
    clearSelectedMessages();
  }
}

async function sendPromptDraft(): Promise<void> {
  const text = aiQuestion.value.trim();
  if (!canSendPrompt.value) {
    setTemporaryStatus('Добавь текст или фото для отправки', 'warn', 2600);
    return;
  }
  const selectedIds = selectedMessageIdsPayload();
  const body: Record<string, unknown> = {
    text,
    openaiResponsesWebSearch: openaiResponsesWebSearchEnabled.value,
    images: promptImages.value.map((img) => ({
      mediaType: img.mime,
      dataBase64: img.dataBase64,
    })),
  };
  if (selectedIds) {
    body.selectedMessageIds = selectedIds;
  }
  const applied = await sendAction('/api/prompt/send', body);
  if (!applied) {
    return;
  }
  if (selectedIds) {
    clearSelectedMessages();
  }
  aiQuestion.value = '';
  promptImages.value = [];
  aiComposerOpen.value = false;
}

function onAiKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    void sendPromptDraft().catch(() => {});
  }
}

function openPromptFilePicker(): void {
  if (actionsDisabled.value) return;
  promptFileInputRef.value?.click();
}

function removePromptImage(id: string): void {
  promptImages.value = promptImages.value.filter((img) => img.id !== id);
}

async function onPromptFilesSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null;
  const files = Array.from(input?.files ?? []);
  if (input) {
    input.value = '';
  }
  if (files.length === 0) return;

  let added = 0;
  let lastError = '';
  for (const file of files) {
    try {
      const nextImage = await createPromptImageDraft(file, { prefix: 'img' });
      if (!nextImage) continue;
      promptImages.value.push(nextImage);
      added += 1;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Не удалось подготовить фото к отправке.';
    }
  }

  if (added === 0) {
    setTemporaryStatus(
      lastError || 'Не удалось добавить фото. Проверь формат и размер изображения.',
      'warn',
      4200,
    );
    return;
  }

  if (lastError) {
    setTemporaryStatus(lastError, 'warn', 4200);
  }

  aiComposerOpen.value = true;
  await nextTick();
}

function connectEvents(): void {
  if (!companionAvailable || !pageVisible()) return;

  disposeEventSource();
  setPwaLiveDiagnostic('pending', 'Live updates подключаются');
  const source = new EventSource(`/events?token=${encodeURIComponent(token)}`);
  eventSource = source;
  streamWatchdog.start();

  source.addEventListener('heartbeat', () => {
    if (eventSource !== source) return;
    streamWatchdog.heartbeat();
  });

  source.onopen = () => {
    if (eventSource !== source) return;
    streamWatchdog.heartbeat();
    reconnectScheduler.reset();
    setPwaLiveDiagnostic('ok', 'Live updates активны');
    setConnection('connected', 'Связь с компьютером активна');
    if (!actionInFlight.value) {
      setStatus('');
    }
  };

  source.addEventListener('snapshot', (event) => {
    if (eventSource !== source) return;
    void (async () => {
      try {
        const next: unknown = JSON.parse(event.data);
        if (!isCompanionSnapshotEnvelope(next)) {
          throw new Error('Companion прислал некорректный SSE snapshot');
        }
        await applySnapshot(next);
        if (eventSource !== source) return;
        streamWatchdog.heartbeat();
        reconnectScheduler.reset();
        setConnection('connected', 'Связь с компьютером активна');
        if (!actionInFlight.value) {
          setStatus('');
        }
      } catch (error) {
        if (eventSource !== source || !pageVisible()) {
          return;
        }
        disposeEventSource();
        setPwaLiveDiagnostic('warn', 'Live updates повредились, пробую восстановить поток');
        setConnection('reconnecting', 'Поток обновлений прервался, обновляю состояние с компьютера...');
        setStatus('Live update повредился, пробую восстановить состояние...', 'warn');
        void resyncConnection({ reconnect: true }).catch((resyncError) => {
          handleResyncFailure(resyncError, 'Не удалось восстановить поток обновлений с компьютера');
        });
      }
    })();
  });

  source.onerror = () => {
    if (eventSource !== source) return;
    if (!pageVisible()) {
      disposeEventSource();
      return;
    }
    // Close the browser's own EventSource retry loop: a single bounded
    // scheduler owns reconnects, including first load and malformed frames.
    disposeEventSource();
    setPwaLiveDiagnostic('warn', 'Live updates временно недоступны');
    setConnection('reconnecting', 'Пытаюсь переподключиться к компьютеру...');
    reconnectScheduler.schedule();
  };
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    reconnectScheduler.cancel();
    abortForHiddenLifecycle();
    disposeEventSource();
    return;
  }

  if (document.visibilityState === 'visible') {
    reconnectScheduler.cancel();
    void resyncConnection({ reconnect: true }).catch((error) => {
      handleResyncFailure(error, 'Связь с компьютером временно потеряна');
    });
  }
}

function onOnline(): void {
  if (!pageVisible()) {
    return;
  }
  reconnectScheduler.cancel();
  void resyncConnection({ reconnect: true }).catch((error) => {
    handleResyncFailure(error, 'Пытаюсь восстановить связь с компьютером...');
  });
}

function onOffline(): void {
  // Browser "offline" may mean no public Internet while Wi-Fi/LAN still
  // works. Do not abort a working stream or an in-flight local POST.
  if (!pageVisible() || connectionState.value === 'connected') return;
  setConnection('reconnecting', 'Проверяю связь с компьютером по локальной сети...');
  reconnectScheduler.schedule();
}

function onPageShow(): void {
  if (!pageVisible()) {
    return;
  }
  reconnectScheduler.cancel();
  void resyncConnection({ reconnect: true }).catch((error) => {
    handleResyncFailure(error, 'Обновляю состояние после возврата на страницу');
  });
}

function onPageHide(): void {
  reconnectScheduler.cancel();
  abortForHiddenLifecycle();
  disposeEventSource();
}

function setupPwaDisplayModeListener(): void {
  refreshPwaStandaloneState();
  if (typeof window === 'undefined' || !window.matchMedia) return;

  displayModeMediaQuery = window.matchMedia('(display-mode: standalone)');
  displayModeChangeHandler = () => refreshPwaStandaloneState();
  displayModeMediaQuery.addEventListener('change', displayModeChangeHandler);
}

function cleanupPwaDisplayModeListener(): void {
  if (!displayModeMediaQuery || !displayModeChangeHandler) return;

  displayModeMediaQuery.removeEventListener('change', displayModeChangeHandler);

  displayModeMediaQuery = null;
  displayModeChangeHandler = null;
}

async function bootstrap(): Promise<void> {
  if (!companionAvailable) {
    setConnection('disconnected', 'Companion ссылка некорректна');
    setStatus('Ссылка не содержит token. Открой QR из окна приложения заново.', 'error');
    return;
  }

  if (!pageVisible()) {
    setConnection('idle', 'Страница скрыта. Подключусь к компьютеру после открытия.');
    return;
  }

  // The computer can be reachable over local Wi-Fi even without WAN.
  try {
    await resyncConnection({ reconnect: true, successStatusText: 'Связь с компьютером активна' });
  } catch (error) {
    handleResyncFailure(error, 'Не удалось подключиться к компьютеру');
  }
}

onMounted(() => {
  setupPwaDisplayModeListener();
  void bootstrap().finally(() => {
    void runPwaDiagnostics();
  });
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('pagehide', onPageHide);
});

watch(
  scrollEl,
  (element, previous) => {
    previous?.removeEventListener('scroll', updateFeedScrolledState);
    element?.addEventListener('scroll', updateFeedScrolledState, { passive: true });
    updateFeedScrolledState();
  },
  { immediate: true },
);

watch(
  feedMessages,
  (messages) => {
    const normalized = normalizeCompanionSelectedIds(selectedMessageIds.value, messages);
    if (
      normalized.length !== selectedMessageIds.value.length
      || normalized.some((id, index) => id !== selectedMessageIds.value[index])
    ) {
      selectedMessageIds.value = normalized;
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  componentUnmounted = true;
  reconnectScheduler.cancel();
  clearStatusTimer();
  cleanupPwaDisplayModeListener();
  scrollEl.value?.removeEventListener('scroll', updateFeedScrolledState);
  abortForHiddenLifecycle();
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOffline);
  window.removeEventListener('pageshow', onPageShow);
  window.removeEventListener('pagehide', onPageHide);
  disposeEventSource();
});
</script>

<template>
  <main class="companion-page">
    <section class="companion-shell" :class="{ 'feed-scrolled': feedScrolledDown }">
      <div v-if="topStackVisible" class="top-stack">
        <div
          v-if="showTopConnectionStatus"
          class="top-connection-status"
          :class="[connectionState, actionStatusTone && `tone-${actionStatusTone}`]"
        >
          {{ topConnectionText }}
        </div>

        <section v-if="pwaNoticeVisible" class="pwa-notice" :class="[`tone-${pwaNoticeTone}`]">
          <div class="pwa-notice-main">
            <span class="pwa-notice-icon" :class="pwaDiagnosticChecking ? 'mdi mdi-loading pwa-icon-spin' : 'mdi mdi-cellphone-link'" />
            <div class="pwa-notice-copy">
              <div class="pwa-notice-title">
                {{ pwaStandalone ? 'PWA companion' : 'Открыто как вкладка' }}
              </div>
              <div class="pwa-notice-text">{{ pwaNoticeText }}</div>
            </div>
          </div>

          <div class="pwa-notice-actions">
            <button
              class="pwa-notice-button"
              :disabled="pwaDiagnosticChecking"
              @click="runPwaDiagnostics().catch(() => {})"
            >
              Проверить
            </button>
            <button
              v-if="pwaDiagnosticItems.length > 0"
              class="pwa-notice-icon-button"
              :title="pwaDiagnosticExpanded ? 'Скрыть детали' : 'Показать детали'"
              @click="pwaDiagnosticExpanded = !pwaDiagnosticExpanded"
            >
              <span :class="pwaDiagnosticExpanded ? 'mdi mdi-chevron-up' : 'mdi mdi-chevron-down'" />
            </button>
            <button
              v-if="showPwaInstallHint"
              class="pwa-notice-icon-button"
              title="Скрыть"
              @click="dismissPwaInstallHint"
            >
              <span class="mdi mdi-close" />
            </button>
          </div>

          <div v-if="pwaDiagnosticExpanded && pwaDiagnosticItems.length > 0" class="pwa-diagnostics">
            <div
              v-for="item in pwaDiagnosticItems"
              :key="item.id"
              class="pwa-diagnostic-row"
              :class="`status-${item.status}`"
            >
              <span class="pwa-diagnostic-dot" />
              <span class="pwa-diagnostic-label">{{ item.label }}</span>
              <span class="pwa-diagnostic-message">{{ item.message }}</span>
            </div>
          </div>
        </section>
      </div>

      <section class="feed-card">
        <ConversationFeed
          ref="companionFeedRef"
          :messages="feedMessages"
          :empty-text="emptyFeedText"
          :messages-clickable="true"
          :is-selected="isFeedMessageSelected"
          @message-click="onFeedMessageClick"
        />
      </section>

      <transition name="ask-slide">
        <section v-if="aiComposerOpen" class="ask-card">
          <div class="ask-card-header">
            <div class="summary-label">Сообщение в AI</div>
            <div class="ask-card-header-actions">
              <button
                class="ask-icon-button"
                title="Сфоткать или выбрать фото"
                :disabled="actionsDisabled"
                @click="openPromptFilePicker"
              >
                <span class="mdi mdi-camera-outline" />
              </button>
              <button class="ask-close-button" title="Скрыть" @click="aiComposerOpen = false">
                <span class="mdi mdi-close" />
              </button>
            </div>
          </div>

          <input
            ref="promptFileInputRef"
            class="prompt-file-input"
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            @change="onPromptFilesSelected"
          />

          <textarea
            v-model="aiQuestion"
            class="ask-textarea"
            placeholder="Напиши сообщение или прикрепи фото. Можно оставить пустым и отправить только фото."
            :disabled="actionsDisabled"
            @keydown="onAiKeydown"
          />

          <div v-if="promptImages.length > 0" class="prompt-attachments">
            <div v-for="img in promptImages" :key="img.id" class="prompt-attachment">
              <img class="prompt-attachment-image" :src="img.dataUrl" alt="Вложенное фото" />
              <button
                class="prompt-attachment-remove"
                title="Удалить фото"
                :disabled="actionsDisabled"
                @click="removePromptImage(img.id)"
              >
                <span class="mdi mdi-close" />
              </button>
            </div>
          </div>

          <div class="ask-footer">
            <div class="ask-hint">
              Текст и фото уходят через тот же backend prompt path, что и desktop companion.
            </div>
            <button
              class="send-button"
              :disabled="actionsDisabled || !canSendPrompt"
              @click="sendPromptDraft().catch(() => {})"
            >
              Отправить
            </button>
          </div>
        </section>
      </transition>

      <section class="controls-dock">
        <div class="controls-side">
          <button
            v-if="hasSelectedMessages"
            class="dock-square-button selection-clear"
            title="Снять выделение"
            @click="clearSelectedMessages"
          >
            <span class="mdi mdi-close-circle-outline" />
            <span class="selection-badge">{{ selectedMessageCount }}</span>
          </button>
          <button
            class="dock-square-button"
            title="Очистить AI контекст"
            :disabled="actionsDisabled"
            @click="sendAction('/api/context/clear').catch(() => {})"
          >
            <span class="mdi mdi-broom" />
          </button>
          <button
            class="dock-square-button danger"
            title="Очистить историю"
            :disabled="actionsDisabled"
            @click="sendAction('/api/history/clear').catch(() => {})"
          >
            <span class="mdi mdi-trash-can-outline" />
          </button>
        </div>

        <div class="controls-center">
          <div class="microphone-toggle-group" aria-label="Управление микрофоном">
            <button
              class="dock-microphone-button app"
              :class="{ active: appMicrophoneMuted }"
              :title="appMicrophoneToggleTitle"
              :disabled="actionsDisabled"
              @click="sendAction(appMicrophoneMuted ? '/api/microphone/app/unmute' : '/api/microphone/app/mute').catch(() => {})"
            >
              <span :class="appMicrophoneMuted ? 'mdi mdi-microphone-off' : 'mdi mdi-microphone'" />
            </button>
          </div>

          <button
            class="dock-circle-button web-search"
            :class="{ active: openaiResponsesWebSearchEnabled }"
            :title="webSearchToggleTitle"
            :aria-pressed="openaiResponsesWebSearchEnabled"
            :disabled="actionsDisabled"
            @click="toggleOpenAiResponsesWebSearch"
          >
            <span class="mdi mdi-web" />
          </button>

          <button
            class="dock-record-button"
            :class="recordButtonClass"
            :title="recordButtonTitle"
            :disabled="actionsDisabled || recordActionBlocked"
            @click="onRecordClick().catch(() => {})"
          >
            <span :class="recordButtonIconClass" />
          </button>

          <button
            class="dock-circle-button"
            :title="aiButtonTitle"
            :disabled="actionsDisabled"
            @click="requestAiReply().catch(() => {})"
          >
            <span class="mdi mdi-robot-outline" />
          </button>

          <button
            class="dock-circle-button"
            :class="{ active: aiComposerOpen }"
            :title="promptComposerTitle"
            :disabled="actionsDisabled"
            @click="aiComposerOpen = !aiComposerOpen"
          >
            <span :class="aiComposerOpen ? 'mdi mdi-close' : 'mdi mdi-message-text-outline'" />
          </button>
        </div>
      </section>
    </section>
  </main>
</template>

<style scoped>
.companion-page {
  height: 100vh;
  height: 100dvh;
  min-height: 100vh;
  min-height: 100dvh;
  overflow: hidden;
  background:
    radial-gradient(circle at top, rgba(74, 158, 255, 0.16), transparent 34%),
    var(--color-bg);
  color: var(--color-text);
}

.companion-shell {
  width: min(940px, 100%);
  height: 100vh;
  height: 100dvh;
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0 auto;
  padding:
    calc(10px + env(safe-area-inset-top, 0px))
    calc(12px + env(safe-area-inset-right, 0px))
    calc(10px + env(safe-area-inset-bottom, 0px))
    calc(12px + env(safe-area-inset-left, 0px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 8px;
  box-sizing: border-box;
  overflow: hidden;
}

.companion-shell.feed-scrolled {
  padding-top: 2px;
}

.companion-shell > * {
  min-width: 0;
  min-height: 0;
}

.top-stack {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.ask-card {
  border-radius: 20px;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.24);
}

.ask-card {
  padding: 14px;
  min-width: 0;
}

.top-connection-status {
  min-height: 16px;
  padding: 0 2px;
  color: rgba(255, 255, 255, 0.58);
  font-size: 12px;
  line-height: 1.35;
  letter-spacing: 0.01em;
}

.top-connection-status.reconnecting,
.top-connection-status.tone-warn {
  color: #f4c95d;
}

.top-connection-status.disconnected,
.top-connection-status.tone-error {
  color: #ff9a8f;
}

.top-connection-status.tone-ok {
  color: #8ee0a1;
}

.top-connection-status.tone-pending {
  color: #9cc6ff;
}

.pwa-notice {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  background: rgba(17, 21, 29, 0.84);
}

.pwa-notice.tone-warn {
  border-color: rgba(244, 201, 93, 0.22);
  background: rgba(53, 43, 20, 0.68);
}

.pwa-notice.tone-error {
  border-color: rgba(255, 154, 143, 0.28);
  background: rgba(56, 22, 22, 0.7);
}

.pwa-notice.tone-pending {
  border-color: rgba(156, 198, 255, 0.2);
}

.pwa-notice-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.pwa-notice-icon {
  flex: 0 0 auto;
  color: #9cc6ff;
  font-size: 20px;
}

.pwa-notice-copy {
  min-width: 0;
}

.pwa-notice-title {
  color: var(--color-text);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.25;
}

.pwa-notice-text {
  margin-top: 2px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.35;
}

.pwa-notice-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pwa-notice-button,
.pwa-notice-icon-button {
  border: none;
  color: var(--color-text);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.pwa-notice-button {
  min-height: 34px;
  padding: 0 12px;
  border-radius: 10px;
  background: rgba(59, 130, 246, 0.22);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}

.pwa-notice-button:disabled {
  opacity: 0.55;
  cursor: default;
}

.pwa-notice-icon-button {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 18px;
}

.pwa-diagnostics {
  grid-column: 1 / -1;
  display: grid;
  gap: 6px;
  padding-top: 2px;
}

.pwa-diagnostic-row {
  display: grid;
  grid-template-columns: 8px minmax(58px, auto) minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.3;
}

.pwa-diagnostic-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #9cc6ff;
}

.pwa-diagnostic-row.status-ok .pwa-diagnostic-dot {
  background: #8ee0a1;
}

.pwa-diagnostic-row.status-warn .pwa-diagnostic-dot,
.pwa-diagnostic-row.status-pending .pwa-diagnostic-dot {
  background: #f4c95d;
}

.pwa-diagnostic-row.status-error .pwa-diagnostic-dot {
  background: #ff9a8f;
}

.pwa-diagnostic-label {
  color: rgba(255, 255, 255, 0.74);
  font-weight: 700;
}

.pwa-diagnostic-message {
  min-width: 0;
  overflow-wrap: anywhere;
}

.pwa-icon-spin {
  display: inline-block;
  animation: dock-spin 1s linear infinite;
}

.summary-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-secondary);
}

.feed-card {
  --chat-empty-font-size: 14px;
  --chat-message-font-size: 14px;
  --chat-message-line-height: 1.44;
  --chat-code-font-size: 11.5px;
  --chat-code-line-height: 1.42;
  --chat-inline-code-font-size: 0.9em;
  --chat-sticky-footer-bottom: calc(126px + env(safe-area-inset-bottom, 0px));
  --chat-scroll-padding: 12px 6px 0 2px;
  --chat-scroll-mobile-padding: 12px 4px 0 2px;
  --chat-scroll-narrow-padding: 12px 2px 0 0;
  --chat-scroll-end-space: calc(148px + env(safe-area-inset-bottom, 0px));

  display: flex;
  min-width: 0;
  min-height: 340px;
  overflow: hidden;
}

.feed-card :deep(.chat-area) {
  min-height: 0;
  min-width: 0;
  flex: 1;
}

.feed-card :deep(.chat-row.incoming .chat-bubble) {
  padding: 10px 12px;
  font-size: 15px;
  line-height: 1.45;
}

.feed-card :deep(.chat-row.focus-copy .chat-bubble) {
  font-size: 15px;
}

.feed-card :deep(.chat-scroll) {
  min-height: 0;
  min-width: 0;
  height: 100%;
  max-height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  touch-action: pan-y;
  -webkit-overflow-scrolling: touch;
}

.feed-card :deep(.scroll-to-bottom-button) {
  bottom: calc(126px + env(safe-area-inset-bottom, 0px));
}

.feed-card :deep(.chat-markdown .code-block pre),
.feed-card :deep(.chat-markdown .code-block pre code),
.feed-card :deep(.chat-text-highlighted .shiki),
.feed-card :deep(.chat-text-highlighted .shiki code),
.feed-card :deep(.chat-text-highlighted .shiki span) {
  font-size: var(--chat-code-font-size);
  line-height: var(--chat-code-line-height);
}

.feed-card :deep(.chat-row.focus-copy .chat-text-highlighted .code-block[data-lang="plaintext"] .shiki),
.feed-card :deep(.chat-row.focus-copy .chat-text-highlighted .code-block[data-lang="plaintext"] .shiki code),
.feed-card :deep(.chat-row.focus-copy .chat-text-highlighted .code-block[data-lang="plaintext"] .shiki span) {
  min-width: 0;
  font-family: inherit;
  font-size: 15px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.feed-card :deep(.chat-row.focus-copy .chat-text-highlighted .code-block[data-lang="plaintext"] .shiki) {
  overflow-x: hidden;
}

.ask-card {
  display: grid;
  gap: 10px;
  margin-bottom: calc(122px + env(safe-area-inset-bottom, 0px));
}

.ask-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ask-card-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ask-close-button {
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-text);
  cursor: pointer;
  font-size: 18px;
}

.ask-icon-button {
  width: 38px;
  height: 38px;
  border: none;
  border-radius: 12px;
  background: rgba(59, 130, 246, 0.16);
  color: var(--color-text);
  cursor: pointer;
  font-size: 20px;
}

.ask-icon-button:disabled,
.ask-close-button:disabled {
  opacity: 0.45;
  cursor: default;
}

.prompt-file-input {
  display: none;
}

.ask-textarea {
  width: 100%;
  min-height: 92px;
  resize: vertical;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid var(--field-border);
  font: inherit;
  font-size: 16px;
  line-height: 1.45;
  color: var(--color-text);
  background: rgba(0, 0, 0, 0.18);
}

.ask-textarea:focus {
  outline: none;
  border-color: var(--field-border-focus);
}

.ask-textarea:disabled {
  opacity: 0.55;
}

.prompt-attachments {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: 10px;
}

.prompt-attachment {
  position: relative;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--glass-border);
  background: rgba(0, 0, 0, 0.2);
  aspect-ratio: 1 / 1;
}

.prompt-attachment-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.prompt-attachment-remove {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.76);
  color: #fff;
  cursor: pointer;
}

.prompt-attachment-remove:disabled {
  opacity: 0.45;
  cursor: default;
}

.ask-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ask-hint {
  color: var(--color-text-secondary);
  line-height: 1.45;
  font-size: 13px;
}

.send-button {
  border: none;
  border-radius: 14px;
  padding: 12px 16px;
  background: rgba(74, 158, 255, 0.9);
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
}

.send-button:disabled {
  opacity: 0.45;
  cursor: default;
}

.controls-dock {
  position: fixed;
  left: 50%;
  bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  width: min(680px, calc(100vw - 20px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  z-index: 40;
  pointer-events: none;
}

.controls-side,
.controls-center {
  pointer-events: auto;
}

.controls-side {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-radius: 18px;
  background: rgba(17, 21, 29, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.28);
}

.controls-center {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 24px;
  background: rgba(17, 21, 29, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.28);
}

.dock-square-button,
.dock-circle-button,
.dock-microphone-button,
.dock-record-button,
.ask-close-button,
.send-button {
  border: none;
  color: var(--color-text);
  cursor: pointer;
  transition: transform 0.12s ease, background 0.12s ease, opacity 0.12s ease, box-shadow 0.12s ease;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.dock-square-button:disabled,
.dock-circle-button:disabled,
.dock-microphone-button:disabled,
.dock-record-button:disabled {
  opacity: 0.42;
  cursor: default;
  transform: none;
  box-shadow: none;
}

.dock-square-button {
  position: relative;
  width: 46px;
  height: 46px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 20px;
}

.dock-square-button.selection-clear {
  background: rgba(80, 145, 255, 0.2);
  box-shadow: inset 0 0 0 1px rgba(130, 185, 255, 0.22);
}

.selection-badge {
  position: absolute;
  right: -5px;
  top: -6px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: #4f8cff;
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  line-height: 18px;
  box-shadow: 0 0 0 2px rgba(17, 21, 29, 0.92);
}

.dock-square-button.danger {
  background: rgba(244, 67, 54, 0.18);
}

.dock-square-button.active {
  background: rgba(255, 255, 255, 0.2);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
}

.dock-square-button:hover:not(:disabled),
.dock-circle-button:hover:not(:disabled),
.dock-microphone-button:hover:not(:disabled),
.dock-record-button:hover:not(:disabled) {
  transform: translateY(-1px) scale(1.02);
}

.dock-circle-button {
  width: 54px;
  height: 54px;
  border-radius: 18px;
  background: rgba(59, 130, 246, 0.16);
  font-size: 24px;
}

.dock-circle-button.active {
  background: rgba(59, 130, 246, 0.34);
}

.dock-circle-button.web-search.active {
  background: rgba(76, 175, 80, 0.28);
  color: #b8f5c3;
  box-shadow: inset 0 0 0 1px rgba(184, 245, 195, 0.18);
}

.microphone-toggle-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dock-microphone-button {
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 20px;
}

.dock-microphone-button.app {
  background: rgba(59, 130, 246, 0.16);
}

.dock-microphone-button.active {
  background: rgba(244, 67, 54, 0.24);
  color: #ffb4ad;
  box-shadow: inset 0 0 0 1px rgba(255, 154, 143, 0.18);
}

.dock-record-button {
  width: 68px;
  height: 68px;
  border-radius: 999px;
  background: var(--color-accent);
  color: #fff;
  font-size: 30px;
  box-shadow: 0 14px 30px rgba(74, 158, 255, 0.25);
}

.dock-record-button.recording {
  background: var(--color-error);
  box-shadow: 0 14px 30px rgba(244, 67, 54, 0.25);
}

.dock-record-button.starting,
.dock-record-button.processing {
  background: var(--color-warning);
}

.dock-icon-spin {
  display: inline-block;
  animation: dock-spin 1s linear infinite;
}

@keyframes dock-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.ask-slide-enter-active,
.ask-slide-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.ask-slide-enter-from,
.ask-slide-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

@media (max-width: 720px) {
  .companion-shell {
    padding:
      calc(12px + env(safe-area-inset-top, 0px))
      calc(10px + env(safe-area-inset-right, 0px))
      calc(10px + env(safe-area-inset-bottom, 0px))
      calc(10px + env(safe-area-inset-left, 0px));
  }

  .feed-card {
    min-height: 0;
  }

  .feed-card :deep(.chat-scroll) {
    max-height: none;
  }

  .ask-card {
    position: fixed;
    left: calc(10px + env(safe-area-inset-left, 0px));
    right: calc(10px + env(safe-area-inset-right, 0px));
    bottom: calc(110px + env(safe-area-inset-bottom, 0px));
    max-height: calc(100vh - 132px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
    max-height: calc(100dvh - 132px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
    margin-bottom: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    z-index: 35;
    -webkit-overflow-scrolling: touch;
  }

  .ask-footer {
    justify-content: flex-end;
  }

  .ask-hint {
    display: none;
  }
}

@media (max-width: 520px) {
  .pwa-notice {
    grid-template-columns: minmax(0, 1fr);
  }

  .pwa-notice-actions {
    justify-content: flex-end;
  }

  .pwa-diagnostic-row {
    grid-template-columns: 8px minmax(48px, auto) minmax(0, 1fr);
  }

  .controls-dock {
    width: calc(100vw - 16px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
    gap: 14px;
  }

  .ask-card {
    left: calc(8px + env(safe-area-inset-left, 0px));
    right: calc(8px + env(safe-area-inset-right, 0px));
    bottom: calc(134px + env(safe-area-inset-bottom, 0px));
    max-height: calc(100vh - 156px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
    max-height: calc(100dvh - 156px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  }

  .controls-side {
    flex-direction: column;
    gap: 12px;
    padding: 8px;
  }

  .controls-center {
    gap: 20px;
    padding: 8px 10px;
  }

  .dock-square-button {
    width: 42px;
    height: 42px;
    border-radius: 12px;
    font-size: 18px;
  }

  .dock-circle-button {
    width: 48px;
    height: 48px;
    border-radius: 16px;
    font-size: 22px;
  }

  .dock-microphone-button {
    width: 38px;
    height: 38px;
    border-radius: 13px;
    font-size: 18px;
  }

  .dock-record-button {
    width: 60px;
    height: 60px;
    font-size: 26px;
  }
}

@media (max-width: 360px) {
  .controls-dock {
    gap: 8px;
  }

  .ask-card {
    bottom: calc(126px + env(safe-area-inset-bottom, 0px));
    max-height: calc(100vh - 148px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
    max-height: calc(100dvh - 148px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  }

  .controls-side {
    gap: 10px;
    padding: 7px;
  }

  /* Keep every fixed-dock action reachable in the 320px native WebKit window. */
  .controls-center {
    gap: 4px;
    padding: 4px;
  }

  .dock-square-button {
    width: 40px;
    height: 40px;
  }

  .dock-circle-button {
    width: 42px;
    height: 42px;
  }

  .dock-microphone-button {
    width: 36px;
    height: 36px;
    border-radius: 12px;
    font-size: 17px;
  }

  .dock-record-button {
    width: 52px;
    height: 52px;
  }
}
</style>

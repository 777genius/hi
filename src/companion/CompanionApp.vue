<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import ConversationFeed from '@/presentation/components/ConversationFeed.vue';
import { buildCompanionConversationFeedMessages } from '@/presentation/companionFeed';
import { createPromptImageDraft, type PromptImageDraft } from '@/utils/promptImages';
import {
  classifyCompanionFailureMessage,
  connectionTextForCompanionFailure,
  normalizeCompanionRequestError,
  shouldRecoverCompanionConnection,
  toneForCompanionFailure,
} from './connectionErrors';
import { isCompanionPageVisible } from './pageVisibility';
import { abortCompanionRequests, wasCompanionRequestHiddenAborted } from './requestAbortState';
import type {
  CompanionActionResponse,
  CompanionRecordingStatus,
  CompanionSnapshotData,
  TauriSnapshotEnvelope,
} from '@/windowing/stateSync';

type StatusTone = '' | 'ok' | 'warn' | 'error' | 'pending';
type ConnectionState = 'idle' | 'connected' | 'reconnecting' | 'disconnected';

const token = new URLSearchParams(window.location.search).get('token')?.trim() ?? '';
const companionAvailable = token.length > 0;

const companionFeedRef = ref<{ scrollEl: HTMLElement | null } | null>(null);
const snapshot = ref<TauriSnapshotEnvelope<CompanionSnapshotData> | null>(null);
const connectionState = ref<ConnectionState>(companionAvailable ? 'idle' : 'disconnected');
const connectionText = ref(companionAvailable ? 'Подключаюсь к Mac...' : 'Ссылка не содержит token');
const actionStatusText = ref('');
const actionStatusTone = ref<StatusTone>('');
const currentRevision = ref(0);
const actionInFlight = ref(false);
const syncInFlight = ref(false);
const aiQuestion = ref('');
const aiComposerOpen = ref(false);
const promptImages = ref<PromptImageDraft[]>([]);
const promptFileInputRef = ref<HTMLInputElement | null>(null);

let eventSource: EventSource | null = null;
let statusTimer: number | null = null;
let resyncPromise: Promise<void> | null = null;
const requestControllers = new Set<AbortController>();

const feedMessages = computed(() => buildCompanionConversationFeedMessages(snapshot.value?.data));
const snapshotData = computed<CompanionSnapshotData | null>(() => snapshot.value?.data ?? null);
const scrollEl = computed(() => companionFeedRef.value?.scrollEl ?? null);
const snapshotReady = computed(() => snapshotData.value !== null);
const connectionReady = computed(() => connectionState.value === 'connected');

const authRequired = computed(() => !!snapshotData.value?.authRequired);
const topConnectionText = computed(() => actionStatusText.value || connectionText.value);
const emptyFeedText = computed(() => {
  if (!companionAvailable) return 'Некорректная companion-ссылка. Открой QR из окна на Mac заново.';
  if (authRequired.value) return 'Сначала авторизуйся в приложении на Mac.';
  return 'Сообщений пока нет. Запусти запись на Mac и список появится здесь.';
});

const recordingStatus = computed<CompanionRecordingStatus>(() => snapshotData.value?.recording.status ?? 'Idle');
const canStop = computed(() => recordingStatus.value === 'Recording' || recordingStatus.value === 'Starting');
const microphoneSupported = computed(() => !!snapshotData.value?.microphone.supported);
const microphoneMuted = computed(() => !!snapshotData.value?.microphone.muted);
const recordButtonTitle = computed(() => (canStop.value ? 'Остановить запись' : 'Начать запись'));
const microphoneToggleTitle = computed(() => (microphoneMuted.value ? 'Включить микрофон' : 'Выключить микрофон'));
const aiButtonTitle = computed(() => 'Сгенерировать ответ');
const promptComposerTitle = computed(() => (aiComposerOpen.value ? 'Скрыть сообщение в AI' : 'Открыть сообщение в AI'));
const canSendPrompt = computed(() => aiQuestion.value.trim().length > 0 || promptImages.value.length > 0);
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
  if (nextRevision < currentRevision.value) {
    return;
  }

  const shouldStickBottom = isNearBottom();
  const revisionAdvanced = nextRevision > currentRevision.value;
  snapshot.value = next;
  currentRevision.value = nextRevision;

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
      return 'Авторизуйся на Mac и открой ссылку заново';
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

function extractErrorMessage(status: number, payload: CompanionActionResponse | null, raw: string): string {
  if (payload?.actionResult) {
    return describeActionResult(payload.actionResult);
  }
  if (status === 401 || status === 403) {
    return 'Ссылка устарела или companion перезапустился. Открой QR из окна на Mac заново.';
  }
  return raw || `Запрос завершился ошибкой: ${status}`;
}

function handleResyncFailure(error: unknown, fallbackText: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const kind = classifyCompanionFailureMessage(message);
  if (kind === 'hidden') {
    return;
  }
  if (kind === 'expired') {
    disposeEventSource();
  }
  setConnection(
    kind === 'expired' ? 'disconnected' : 'reconnecting',
    connectionTextForCompanionFailure(kind, fallbackText),
  );
  setStatus(message, toneForCompanionFailure(kind));
}

function abortInFlightRequests(): void {
  abortCompanionRequests(requestControllers);
  requestControllers.clear();
}

function abortForHiddenLifecycle(): void {
  abortCompanionRequests(requestControllers, 'hidden');
  requestControllers.clear();
}

function disposeEventSource(): void {
  const source = eventSource;
  eventSource = null;
  if (!source) return;
  source.onopen = null;
  source.onerror = null;
  source.close();
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<{
  response: Response;
  json: T | null;
  raw: string;
}> {
  if (typeof navigator !== 'undefined' && 'onLine' in navigator && navigator.onLine === false) {
    throw new Error('Телефон офлайн');
  }

  const controller = new AbortController();
  requestControllers.add(controller);
  const timeoutId = window.setTimeout(() => controller.abort(), 9000);

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
    throw new Error('Ссылка устарела или companion перезапустился. Открой QR из окна на Mac заново.');
  }
  if (!response.ok || !json) {
    throw new Error(raw || `Не удалось получить состояние: ${response.status}`);
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

      if (!pageVisible()) {
        return;
      }

      if (options.reconnect || !eventSource || connectionState.value !== 'connected') {
        connectEvents();
      }

      setConnection('connected', options.successStatusText || 'Связь с Mac активна');
      if (!actionInFlight.value) {
        setStatus('');
      }
    } finally {
      syncInFlight.value = false;
    }
  })();

  resyncPromise = task;
  void task.finally(() => {
    if (resyncPromise === task) {
      resyncPromise = null;
    }
  });

  return task;
}

async function sendAction(path: string, body: Record<string, unknown> = {}): Promise<boolean> {
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

  actionInFlight.value = true;
  setStatus('Выполняю действие...', 'pending');

  try {
    const { response, json, raw } = await requestJson<CompanionActionResponse>(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Companion-Token': token,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 401 || response.status === 403) {
      disposeEventSource();
      setConnection('disconnected', 'Ссылка устарела. Открой её из окна на Mac заново.');
      throw new Error(extractErrorMessage(response.status, json, raw));
    }

    if (json?.snapshot) {
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
      setStatus('');
      return false;
    }

    if (shouldRecoverCompanionConnection(kind)) {
      disposeEventSource();
      setConnection('reconnecting', connectionTextForCompanionFailure(kind, 'Пытаюсь восстановить связь с Mac...'));
    }

    setStatus(message, toneForCompanionFailure(kind));

    if (
      shouldRecoverCompanionConnection(kind)
      && typeof document !== 'undefined'
      && document.visibilityState === 'visible'
    ) {
      void resyncConnection({ reconnect: true }).catch((resyncError) => {
        handleResyncFailure(resyncError, 'Пытаюсь восстановить связь с Mac...');
      });
    }

    throw error;
  } finally {
    actionInFlight.value = false;
  }
}

async function onRecordClick(): Promise<void> {
  if (canStop.value) {
    await sendAction('/api/record/stop');
    return;
  }
  await sendAction('/api/record/start');
}

async function requestAiReply(): Promise<void> {
  await sendAction('/api/ai/request', { text: '' });
}

async function sendPromptDraft(): Promise<void> {
  const text = aiQuestion.value.trim();
  if (!canSendPrompt.value) {
    setTemporaryStatus('Добавь текст или фото для отправки', 'warn', 2600);
    return;
  }
  const applied = await sendAction('/api/prompt/send', {
    text,
    images: promptImages.value.map((img) => ({
      mediaType: img.mime,
      dataBase64: img.dataBase64,
    })),
  });
  if (!applied) {
    return;
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
  const source = new EventSource(`/events?token=${encodeURIComponent(token)}`);
  eventSource = source;

  source.onopen = () => {
    if (eventSource !== source) return;
    setConnection('connected', 'Связь с Mac активна');
    if (!actionInFlight.value) {
      setStatus('');
    }
  };

  source.addEventListener('snapshot', (event) => {
    if (eventSource !== source) return;
    void (async () => {
      try {
        const next = JSON.parse(event.data) as TauriSnapshotEnvelope<CompanionSnapshotData>;
        await applySnapshot(next);
        if (eventSource !== source) return;
        setConnection('connected', 'Связь с Mac активна');
        if (!actionInFlight.value) {
          setStatus('');
        }
      } catch (error) {
        if (eventSource !== source || !pageVisible()) {
          return;
        }
        disposeEventSource();
        setConnection('reconnecting', 'Поток обновлений прервался, обновляю состояние с Mac...');
        setStatus('Live update повредился, пробую восстановить состояние...', 'warn');
        void resyncConnection({ reconnect: true }).catch((resyncError) => {
          handleResyncFailure(resyncError, 'Не удалось восстановить поток обновлений с Mac');
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
    void (async () => {
      setConnection('reconnecting', 'Пытаюсь переподключиться к Mac...');
      try {
        await resyncConnection({ reconnect: true });
      } catch (error) {
        handleResyncFailure(error, 'Пытаюсь переподключиться к Mac...');
      }
    })();
  };
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    abortForHiddenLifecycle();
    disposeEventSource();
    return;
  }

  if (document.visibilityState === 'visible') {
    void resyncConnection({ reconnect: true }).catch((error) => {
      handleResyncFailure(error, 'Связь с Mac временно потеряна');
    });
  }
}

function onOnline(): void {
  if (!pageVisible()) {
    return;
  }
  void resyncConnection({ reconnect: true }).catch((error) => {
    handleResyncFailure(error, 'Пытаюсь восстановить связь с Mac...');
  });
}

function onOffline(): void {
  abortInFlightRequests();
  disposeEventSource();
  if (!pageVisible()) {
    return;
  }
  setConnection('reconnecting', 'Сеть пропала. Жду восстановления...');
  if (!actionInFlight.value) {
    setStatus('Похоже, телефон временно офлайн. После возврата сети состояние обновится автоматически.', 'warn');
  }
}

function onPageShow(): void {
  if (!pageVisible()) {
    return;
  }
  void resyncConnection({ reconnect: true }).catch((error) => {
    handleResyncFailure(error, 'Обновляю состояние после возврата на страницу');
  });
}

function onPageHide(): void {
  abortForHiddenLifecycle();
  disposeEventSource();
}

async function bootstrap(): Promise<void> {
  if (!companionAvailable) {
    setConnection('disconnected', 'Companion ссылка некорректна');
    setStatus('Ссылка не содержит token. Открой QR из окна на Mac заново.', 'error');
    return;
  }

  if (!pageVisible()) {
    setConnection('idle', 'Страница скрыта. Подключусь к Mac после открытия.');
    return;
  }

  if (typeof navigator !== 'undefined' && 'onLine' in navigator && navigator.onLine === false) {
    setConnection('reconnecting', 'Телефон офлайн. Жду восстановления сети...');
    setStatus('Подключи телефон к сети, и companion попробует восстановиться автоматически.', 'warn');
    return;
  }

  try {
    await resyncConnection({ reconnect: true, successStatusText: 'Связь с Mac активна' });
  } catch (error) {
    handleResyncFailure(error, 'Не удалось подключиться к Mac');
  }
}

onMounted(() => {
  void bootstrap();
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('pagehide', onPageHide);
});

onUnmounted(() => {
  clearStatusTimer();
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
    <section class="companion-shell">
      <div class="top-connection-status" :class="[connectionState, actionStatusTone && `tone-${actionStatusTone}`]">
        {{ topConnectionText }}
      </div>

      <section class="feed-card">
        <ConversationFeed
          ref="companionFeedRef"
          :messages="feedMessages"
          :empty-text="emptyFeedText"
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
          <button
            class="dock-circle-button"
            :title="microphoneToggleTitle"
            :disabled="actionsDisabled || !microphoneSupported"
            @click="sendAction(microphoneMuted ? '/api/microphone/unmute' : '/api/microphone/mute').catch(() => {})"
          >
            <span :class="microphoneMuted ? 'mdi mdi-microphone-off' : 'mdi mdi-microphone'" />
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
  min-height: 100vh;
  min-height: 100dvh;
  background:
    radial-gradient(circle at top, rgba(74, 158, 255, 0.16), transparent 34%),
    var(--color-bg);
  color: var(--color-text);
}

.companion-shell {
  width: min(940px, 100%);
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0 auto;
  padding:
    calc(10px + env(safe-area-inset-top, 0px))
    calc(12px + env(safe-area-inset-right, 0px))
    calc(132px + env(safe-area-inset-bottom, 0px))
    calc(12px + env(safe-area-inset-left, 0px));
  display: grid;
  gap: 10px;
}

.companion-shell > * {
  min-width: 0;
}

.feed-card,
.ask-card {
  border-radius: 20px;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.24);
}

.feed-card,
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

.summary-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-secondary);
}

.feed-card {
  display: flex;
  min-height: 340px;
}

.feed-card :deep(.chat-area) {
  min-height: 0;
  min-width: 0;
  flex: 1;
}

.feed-card :deep(.chat-scroll) {
  min-height: 0;
  min-width: 0;
  max-height: min(58vh, 760px);
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.ask-card {
  display: grid;
  gap: 10px;
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
  gap: 12px;
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
.dock-record-button:disabled {
  opacity: 0.42;
  cursor: default;
  transform: none;
  box-shadow: none;
}

.dock-square-button {
  width: 46px;
  height: 46px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 20px;
}

.dock-square-button.danger {
  background: rgba(244, 67, 54, 0.18);
}

.dock-square-button:hover:not(:disabled),
.dock-circle-button:hover:not(:disabled),
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
      calc(148px + env(safe-area-inset-bottom, 0px))
      calc(10px + env(safe-area-inset-left, 0px));
  }

  .feed-card :deep(.chat-scroll) {
    max-height: none;
  }
}

@media (max-width: 520px) {
  .controls-dock {
    width: calc(100vw - 16px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
    gap: 8px;
  }

  .controls-side {
    flex-direction: column;
    gap: 8px;
    padding: 8px;
  }

  .controls-center {
    gap: 10px;
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

  .dock-record-button {
    width: 60px;
    height: 60px;
    font-size: 26px;
  }
}
</style>

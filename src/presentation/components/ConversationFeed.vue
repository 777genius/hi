<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, useSlots, watch } from 'vue';
import type { ConversationFeedMessage } from '../conversationFeed';
import { renderMarkdownToSafeHtml } from '@/utils/markdown';
import { highlightMessage, highlightRawCodeBlock, messageHasCode } from '@/utils/codeHighlight';
import { isCodeBlockExpandedFromTarget, toggleCodeBlockCollapseFromTarget } from '../feedCodeBlocks';
import { DEFAULT_SCROLL_BOTTOM_THRESHOLD_PX, isNearScrollBottom, scrollBottomRemaining, scrollElementToBottom } from '../feedScroll';

type HighlightEntry = { sourceText: string; html: string; expanded: boolean };
type HighlightCandidate = { id: string; text: string; forceCode: boolean; expanded: boolean };
const COLLAPSIBLE_MESSAGE_MAX_VISIBLE_LINES = 5;
const COLLAPSIBLE_MESSAGE_ESTIMATED_CHARS_PER_LINE = 64;

const props = withDefaults(defineProps<{
  messages: ConversationFeedMessage[];
  emptyText: string;
  selecting?: boolean;
  editingMessageId?: string | null;
  anchorMode?: 'tail' | 'fixed';
  anchorSttIndex?: number;
  messagesClickable?: boolean;
  assistantStreaming?: boolean;
  isSelected?: (id: string) => boolean;
  isOutOfContext?: (message: ConversationFeedMessage) => boolean;
}>(), {
  selecting: false,
  editingMessageId: null,
  anchorMode: 'tail',
  anchorSttIndex: 0,
  messagesClickable: false,
  assistantStreaming: false,
  isSelected: () => false,
  isOutOfContext: () => false,
});

const emit = defineEmits<{
  (e: 'scroll-mousedown', event: MouseEvent): void;
  (e: 'scroll-click-capture', event: MouseEvent): void;
  (e: 'row-mousemove', event: MouseEvent, message: ConversationFeedMessage): void;
  (e: 'message-click', event: MouseEvent, message: ConversationFeedMessage): void;
  (e: 'inline-edit-keydown', event: KeyboardEvent, message: ConversationFeedMessage): void;
  (e: 'assistant-candidate-select', messageId: string, candidateId: string): void;
}>();

const slots = useSlots();
const scrollEl = ref<HTMLElement | null>(null);
const highlightedById = reactive<Record<string, HighlightEntry>>({});
const showScrollToBottom = ref(false);
const expandedMessageIds = reactive(new Set<string>());
const collapsedMessageIds = reactive(new Set<string>());
const activeCandidateByMessageId = reactive<Record<string, string>>({});
let scrollStateFrame: number | null = null;
let shouldStickToBottomAfterRender = false;
let stickToBottomScheduled = false;
let resumeAfterUserScroll = false;
let frozenScrollTop: number | null = null;
let userScrollIntent = false;
let lastScrollTop = 0;
let wasNearBottom = true;

defineExpose({
  scrollEl,
  scrollToBottom,
});

const hasActionsSlot = computed(() => !!slots.actions);

// Companion не передаёт assistantStreaming, поэтому стриминг определяем и по самим сообщениям.
const isAssistantStreaming = computed(
  () =>
    props.assistantStreaming ||
    props.messages.some((message) => message.kind === 'haiku' && !message.deleted && message.status === 'streaming')
);

const latestAssistantMessageId = computed(() => {
  for (let index = props.messages.length - 1; index >= 0; index -= 1) {
    const message = props.messages[index];
    if (message.kind === 'haiku' && !message.deleted) {
      return message.id;
    }
  }
  return null;
});

const highlightCandidates = computed(() => {
  return props.messages
    .filter((message) => {
      if (message.kind === 'haiku' || !message.text) return false;
      return isFocusCopyMessage(message) || messageHasCode(message.text);
    })
    .map((message): HighlightCandidate => ({
      id: message.id,
      text: message.text,
      forceCode: isFocusCopyMessage(message),
      expanded: isMessageExpanded(message),
    }));
});

function hasCurrentHighlightCandidate(id: string, text: string): boolean {
  return highlightCandidates.value.some((item) => item.id === id && item.text === text);
}

watch(
  () => highlightCandidates.value,
  (items) => {
    const activeIds = new Set(items.map((item) => item.id));
    for (const existingId of Object.keys(highlightedById)) {
      if (!activeIds.has(existingId)) {
        delete highlightedById[existingId];
      }
    }

    for (const item of items) {
      const existing = highlightedById[item.id];
      if (existing?.sourceText === item.text && existing.expanded === item.expanded) continue;
      const highlighted = item.forceCode
        ? highlightRawCodeBlock(item.text, { compact: true, collapsed: !item.expanded })
        : highlightMessage(item.text);
      void highlighted
        .then((html) => {
          if (!hasCurrentHighlightCandidate(item.id, item.text)) return;
          rememberStickToBottomIfCurrentlyPinned();
          highlightedById[item.id] = { sourceText: item.text, html, expanded: item.expanded };
          void nextTick(() => {
            scheduleScrollStateUpdate();
          });
        })
        .catch(() => {});
    }
  },
  { immediate: true }
);

function getHighlightedHtml(message: ConversationFeedMessage): string | null {
  if (!message.text || (!isFocusCopyMessage(message) && !messageHasCode(message.text))) return null;
  const entry = highlightedById[message.id];
  if (!entry || entry.sourceText !== message.text) return null;
  return entry.html;
}

function isFocusCopyMessage(message: ConversationFeedMessage): boolean {
  return message.id.startsWith('focus-copy:');
}

function hasCollapsibleTextContent(text: string): boolean {
  const normalized = String(text ?? '').trim();
  if (!normalized) return false;

  const estimatedLines = normalized.split('\n').reduce((total, line) => {
    return total + Math.max(1, Math.ceil(line.length / COLLAPSIBLE_MESSAGE_ESTIMATED_CHARS_PER_LINE));
  }, 0);

  return estimatedLines > COLLAPSIBLE_MESSAGE_MAX_VISIBLE_LINES;
}

function isCollapsibleMessage(message: ConversationFeedMessage): boolean {
  return (isFocusCopyMessage(message) || message.kind === 'haiku') && hasCollapsibleTextContent(message.text);
}

function isMessageExpanded(message: ConversationFeedMessage): boolean {
  if (!isCollapsibleMessage(message)) return true;
  if (expandedMessageIds.has(message.id)) return true;
  if (collapsedMessageIds.has(message.id)) return false;
  return message.kind === 'haiku' && message.id === latestAssistantMessageId.value;
}

function isMessageCollapsed(message: ConversationFeedMessage): boolean {
  return isCollapsibleMessage(message) && !isMessageExpanded(message);
}

function toggleMessageCollapse(message: ConversationFeedMessage): void {
  if (!isCollapsibleMessage(message)) return;
  if (isMessageExpanded(message)) {
    expandedMessageIds.delete(message.id);
    collapsedMessageIds.add(message.id);
  } else {
    collapsedMessageIds.delete(message.id);
    expandedMessageIds.add(message.id);
  }
  void nextTick(() => {
    scheduleScrollStateUpdate();
  });
}

function expandMessage(message: ConversationFeedMessage): void {
  collapsedMessageIds.delete(message.id);
  expandedMessageIds.add(message.id);
  void nextTick(() => {
    scheduleScrollStateUpdate();
  });
}

function expandCollapsedMessage(message: ConversationFeedMessage, event: MouseEvent): void {
  if (!isMessageCollapsed(message)) return;

  event.preventDefault();
  event.stopPropagation();
  expandMessage(message);
}

function renderHaikuMarkdown(text: string): string {
  const answer = String(text ?? '').trim();
  const singleBullet = answer.match(/^[-*•]\s+([^\n]+)$/);
  return renderMarkdownToSafeHtml(singleBullet ? singleBullet[1] : answer);
}

function candidateList(message: ConversationFeedMessage) {
  return message.kind === 'haiku' ? (message.candidates ?? []) : [];
}

function primaryCandidate(message: ConversationFeedMessage) {
  const candidates = candidateList(message);
  return candidates.find((candidate) => candidate.id === 'anthropic') ?? candidates[0] ?? null;
}

function activeCandidateId(message: ConversationFeedMessage): string | null {
  return (
    activeCandidateByMessageId[message.id] ??
    message.activeCandidateId ??
    primaryCandidate(message)?.id ??
    null
  );
}

function activeCandidate(message: ConversationFeedMessage) {
  const candidates = candidateList(message);
  const activeId = activeCandidateId(message);
  return candidates.find((candidate) => candidate.id === activeId) ?? primaryCandidate(message);
}

function visibleAssistantText(message: ConversationFeedMessage): string {
  if (message.kind !== 'haiku') return message.text;
  return activeCandidate(message)?.text ?? message.text;
}

function visibleMessageStatus(message: ConversationFeedMessage): ConversationFeedMessage['status'] {
  if (message.kind !== 'haiku') return message.status;
  return activeCandidate(message)?.status ?? message.status;
}

function selectAssistantCandidate(message: ConversationFeedMessage, candidateId: string): void {
  if (!candidateId) return;
  activeCandidateByMessageId[message.id] = candidateId;
  emit('assistant-candidate-select', message.id, candidateId);
  void nextTick(() => {
    scheduleScrollStateUpdate();
  });
}

function rowClasses(message: ConversationFeedMessage): Record<string, boolean> {
  const status = visibleMessageStatus(message);
  return {
    incoming: message.role === 'incoming',
    outgoing: message.role === 'outgoing',
    'assistant-response': message.kind === 'haiku',
    partial: status === 'streaming',
    prompt: message.kind === 'prompt',
    signal: message.kind === 'signal',
    anchor:
      props.anchorMode === 'fixed' &&
      message.kind === 'stt' &&
      message.sttIndex === props.anchorSttIndex,
    selected: props.isSelected(message.id),
    'out-of-context': props.isOutOfContext(message),
    error: status === 'error',
    'focus-copy': isFocusCopyMessage(message),
    collapsed: isMessageCollapsed(message),
  };
}

function isMessageClickable(message: ConversationFeedMessage): boolean {
  return props.messagesClickable && message.kind !== 'haiku' && !message.deleted && message.status === 'final';
}

function onMessageClick(event: MouseEvent, message: ConversationFeedMessage): void {
  if (!isMessageClickable(message)) return;
  emit('message-click', event, message);
}

function elementFromTarget(target: EventTarget | null): Element | null {
  const value = target as (Element & { parentElement?: Element | null }) | null;
  if (!value) return null;
  if (value.nodeType === 1 && typeof value.closest === 'function') return value;
  return value.parentElement ?? null;
}

function messageFromTarget(target: EventTarget | null): ConversationFeedMessage | null {
  const element = elementFromTarget(target);
  const row = element?.closest?.('.chat-row');
  const messageId = row?.getAttribute('data-msg-id');
  return props.messages.find((message) => message.id === messageId) ?? null;
}

function onScrollClickCapture(event: MouseEvent): void {
  const element = elementFromTarget(event.target);
  if (element?.closest?.('.code-block-toggle')) {
    const message = messageFromTarget(event.target);
    if (message && isFocusCopyMessage(message)) {
      toggleMessageCollapse(message);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }

  const message = messageFromTarget(event.target);
  if (message && isFocusCopyMessage(message) && isMessageCollapsed(message)) {
    event.preventDefault();
    event.stopPropagation();
    expandMessage(message);
    return;
  }

  if (toggleCodeBlockCollapseFromTarget(event.target)) {
    const message = messageFromTarget(event.target);
    if (message && isCodeBlockExpandedFromTarget(event.target)) {
      expandMessage(message);
    }
    event.preventDefault();
    event.stopPropagation();
    void nextTick(() => {
      scheduleScrollStateUpdate();
    });
    return;
  }
  emit('scroll-click-capture', event);
}

function isNearBottom(element: HTMLElement): boolean {
  return isNearScrollBottom(element, DEFAULT_SCROLL_BOTTOM_THRESHOLD_PX);
}

function updateScrollToBottomVisibility(): void {
  const element = scrollEl.value;
  if (!element) {
    showScrollToBottom.value = false;
    return;
  }

  const hasOverflow = (element.scrollHeight - element.clientHeight) > 24;
  showScrollToBottom.value = hasOverflow && !isNearBottom(element);
}

function cancelScrollStateFrame(): void {
  if (scrollStateFrame === null || typeof window === 'undefined') {
    return;
  }

  window.cancelAnimationFrame(scrollStateFrame);
  scrollStateFrame = null;
}

function scheduleScrollStateUpdate(): void {
  if (typeof window === 'undefined') {
    updateScrollToBottomVisibility();
    return;
  }

  cancelScrollStateFrame();
  scrollStateFrame = window.requestAnimationFrame(() => {
    scrollStateFrame = null;
    updateScrollToBottomVisibility();
  });
}

function onScroll(): void {
  const element = scrollEl.value;
  if (element && !shouldStickToBottomAfterRender && !isAssistantStreaming.value) {
    wasNearBottom = isNearBottom(element);
  }
  if (isAssistantStreaming.value && userScrollIntent && element && !resumeAfterUserScroll) {
    frozenScrollTop = element.scrollTop;
  }
  if (isAssistantStreaming.value && userScrollIntent && element && !resumeAfterUserScroll &&
      scrollBottomRemaining(element) <= 2) {
    resumeAfterUserScroll = true;
    frozenScrollTop = null;
    wasNearBottom = true;
  }
  // Пользователь прокрутил вверх, пока лента "прилипла" к низу: отпускаем и фиксируем позицию,
  // иначе автоскролл возвращает его вниз и выйти из конца ленты невозможно.
  if (element && isAssistantStreaming.value && userScrollIntent && resumeAfterUserScroll &&
      element.scrollTop < lastScrollTop - 2 && scrollBottomRemaining(element) > 8) {
    resumeAfterUserScroll = false;
    shouldStickToBottomAfterRender = false;
    frozenScrollTop = element.scrollTop;
    wasNearBottom = false;
  }
  if (element) lastScrollTop = element.scrollTop;
  updateScrollToBottomVisibility();
}

function onUserScrollIntent(): void {
  userScrollIntent = true;
}

function scrollToBottom(behavior: ScrollBehavior = 'smooth'): void {
  const element = scrollEl.value;
  if (!element) return;

  element.scrollTo({
    top: element.scrollHeight,
    behavior,
  });
  wasNearBottom = true;
  if (isAssistantStreaming.value) {
    resumeAfterUserScroll = true;
    frozenScrollTop = null;
  }
  scheduleScrollStateUpdate();
}

function rememberStickToBottomIfCurrentlyPinned(): void {
  if (isAssistantStreaming.value && !resumeAfterUserScroll) return;
  if (isAssistantStreaming.value && resumeAfterUserScroll) {
    shouldStickToBottomAfterRender = true;
    scheduleStickToBottomAfterRender();
    return;
  }
  if (!scrollEl.value || !wasNearBottom) return;
  shouldStickToBottomAfterRender = true;
  scheduleStickToBottomAfterRender();
}

watch(isAssistantStreaming, (streaming) => {
  resumeAfterUserScroll = false;
  userScrollIntent = false;
  frozenScrollTop = streaming ? (scrollEl.value?.scrollTop ?? null) : null;
  shouldStickToBottomAfterRender = false;
  if (streaming) wasNearBottom = false;
}, { flush: 'sync' });

function scheduleStickToBottomAfterRender(): void {
  if (stickToBottomScheduled) return;
  stickToBottomScheduled = true;
  void nextTick(() => {
    stickToBottomScheduled = false;
    if (!shouldStickToBottomAfterRender) return;
    shouldStickToBottomAfterRender = false;

    const element = scrollEl.value;
    if (!element) return;
    scrollElementToBottom(element);
    wasNearBottom = true;
    scheduleScrollStateUpdate();
  });
}

watch(
  scrollEl,
  (element, previous) => {
    previous?.removeEventListener('scroll', onScroll);
    element?.addEventListener('scroll', onScroll, { passive: true });
    if (element) wasNearBottom = isNearBottom(element);
    scheduleScrollStateUpdate();
  },
  { immediate: true }
);

watch(
  () => [props.messages, props.emptyText],
  () => {
    rememberStickToBottomIfCurrentlyPinned();
    if (isAssistantStreaming.value && !resumeAfterUserScroll && frozenScrollTop !== null) {
      void nextTick(() => {
        if (isAssistantStreaming.value && !resumeAfterUserScroll && scrollEl.value) {
          scrollEl.value.scrollTop = frozenScrollTop!;
        }
      });
    }
  },
  { deep: true, flush: 'pre' }
);

watch(
  () => props.messages,
  () => {
    const liveIds = new Set(props.messages.map((message) => message.id));
    for (const id of Array.from(expandedMessageIds)) {
      if (!liveIds.has(id)) expandedMessageIds.delete(id);
    }
    for (const id of Array.from(collapsedMessageIds)) {
      if (!liveIds.has(id)) collapsedMessageIds.delete(id);
    }
    for (const id of Object.keys(activeCandidateByMessageId)) {
      if (!liveIds.has(id)) delete activeCandidateByMessageId[id];
    }
    void nextTick(() => {
      scheduleScrollStateUpdate();
    });
  },
  { deep: true, flush: 'post' }
);

onMounted(() => {
  scheduleScrollStateUpdate();
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', scheduleScrollStateUpdate);
  }
});

onUnmounted(() => {
  scrollEl.value?.removeEventListener('scroll', onScroll);
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', scheduleScrollStateUpdate);
  }
  cancelScrollStateFrame();
});
</script>

<template>
  <div class="chat-area">
    <div
      ref="scrollEl"
      class="chat-scroll"
      :class="{ 'scroll-frozen': assistantStreaming && !resumeAfterUserScroll, selecting }"
      @mousedown="emit('scroll-mousedown', $event)"
      @wheel.passive="onUserScrollIntent"
      @touchmove.passive="onUserScrollIntent"
      @keydown="onUserScrollIntent"
      @click.capture="onScrollClickCapture"
    >
      <slot name="overlay" />

      <div v-if="messages.length === 0" class="chat-empty">
        {{ emptyText }}
      </div>

      <div
        v-for="msg in messages"
        :key="msg.id"
        class="chat-row"
        :data-msg-id="msg.id"
        :class="rowClasses(msg)"
        @mousemove="emit('row-mousemove', $event, msg)"
      >
        <div
          class="chat-bubble"
          :class="{ clickable: isMessageClickable(msg), deleted: msg.deleted }"
          @click="onMessageClick($event, msg)"
        >
          <template v-if="msg.deleted">
            <span class="chat-text chat-text-deleted">{{ msg.text }}</span>
          </template>
          <template v-else>
            <span v-if="msg.kind === 'mic'" class="chat-icon mdi mdi-microphone" />
            <span v-if="msg.kind === 'signal'" class="chat-icon mdi mdi-message-text-outline" />

            <template v-if="editingMessageId === msg.id">
              <span
                class="chat-text chat-text-editable"
                :data-edit-id="msg.id"
                contenteditable="true"
                spellcheck="false"
                @click.stop
                @keydown="emit('inline-edit-keydown', $event, msg)"
              >{{ msg.text }}</span>
            </template>
            <template v-else>
              <template v-if="msg.kind === 'haiku'">
                <div
                  v-if="candidateList(msg).length > 1"
                  class="assistant-candidate-tabs no-drag"
                  @click.stop
                >
                  <button
                    v-for="candidate in candidateList(msg)"
                    :key="candidate.id"
                    type="button"
                    class="assistant-candidate-tab"
                    :class="{
                      active: activeCandidateId(msg) === candidate.id,
                      streaming: candidate.status === 'streaming',
                      error: candidate.status === 'error',
                    }"
                    :title="[candidate.label, candidate.model].filter(Boolean).join(' · ')"
                    @click.stop="selectAssistantCandidate(msg, candidate.id)"
                  >
                    <span class="assistant-candidate-label">{{ candidate.label }}</span>
                    <span v-if="candidate.status === 'streaming'" class="assistant-candidate-dot" />
                  </button>
                </div>
                <div
                  v-if="isCollapsibleMessage(msg)"
                  class="chat-collapsible-message"
                  :class="{ collapsed: isMessageCollapsed(msg) }"
                  @click="expandCollapsedMessage(msg, $event)"
                >
                  <div class="chat-collapsible-content chat-markdown" v-html="renderHaikuMarkdown(visibleAssistantText(msg))" />
                  <button
                    type="button"
                    class="chat-collapse-toggle no-drag"
                    @click.stop="toggleMessageCollapse(msg)"
                  >
                    {{ isMessageCollapsed(msg) ? 'More' : 'Hide' }}
                  </button>
                </div>
                <div v-else class="chat-markdown" v-html="renderHaikuMarkdown(visibleAssistantText(msg))" />
              </template>
              <div
                v-else-if="getHighlightedHtml(msg)"
                class="chat-text chat-text-highlighted"
                v-html="getHighlightedHtml(msg)"
              />
              <span v-else class="chat-text">{{ msg.text }}</span>
            </template>

            <div v-if="msg.kind === 'prompt' && msg.attachments?.length" class="chat-attachments">
              <div v-for="att in msg.attachments" :key="att.id" class="chat-attachment">
                <img v-if="att.kind === 'image'" class="chat-attachment-img" :src="att.dataUrl" alt="Вложение" />
              </div>
            </div>

            <span v-if="visibleMessageStatus(msg) === 'streaming'" class="chat-cursor">▍</span>
          </template>
        </div>

        <div v-if="!msg.deleted && hasActionsSlot" class="chat-actions no-drag" @click.stop>
          <slot name="actions" :msg="msg" />
        </div>
      </div>
    </div>

    <button
      v-show="showScrollToBottom"
      type="button"
      class="scroll-to-bottom-button no-drag"
      title="Прокрутить в самый низ"
      aria-label="Прокрутить в самый низ"
      @mousedown.stop.prevent
      @click.stop="scrollToBottom()"
    >
      <span class="mdi mdi-chevron-double-down" />
    </button>
  </div>
</template>

<style scoped>
.chat-area {
  --chat-sticky-footer-bottom: 30px;

  min-height: 60px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
  box-sizing: border-box;
  overflow: hidden;
  flex: 1;
  position: relative;
}

.chat-scroll {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  overflow-y: auto;
  padding: var(--chat-scroll-padding, var(--spacing-sm));
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  position: relative;
}

.chat-scroll.scroll-frozen {
  overflow-anchor: none;
}

.chat-scroll::after {
  content: '';
  display: block;
  flex: 0 0 var(--chat-scroll-end-space, 0px);
}

.chat-scroll.selecting {
  user-select: none;
}

.scroll-to-bottom-button {
  position: absolute;
  right: 14px;
  bottom: 14px;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(17, 21, 29, 0.88);
  color: rgba(255, 255, 255, 0.94);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(12px);
  cursor: pointer;
  z-index: 6;
  transition: transform 0.12s ease, background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}

.scroll-to-bottom-button:hover {
  transform: translateY(-1px);
  background: rgba(59, 130, 246, 0.22);
  border-color: rgba(59, 130, 246, 0.4);
}

.scroll-to-bottom-button:active {
  transform: translateY(0);
}

.scroll-to-bottom-button .mdi {
  font-size: 20px;
}

.theme-light .scroll-to-bottom-button {
  background: rgba(255, 255, 255, 0.95);
  color: rgba(15, 23, 42, 0.92);
  border-color: rgba(15, 23, 42, 0.08);
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
}

:slotted(.lasso-rect) {
  position: absolute;
  z-index: 5;
  pointer-events: none;
  border: 1px solid rgba(76, 175, 80, 0.55);
  background: rgba(76, 175, 80, 0.12);
  border-radius: 6px;
}

.chat-empty {
  width: 100%;
  color: var(--color-text);
  opacity: 0.85;
  font-size: var(--chat-empty-font-size, 16px);
  line-height: 1.45;
  white-space: pre-wrap;
}

.chat-row {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  position: relative;
}

.chat-row.incoming {
  justify-content: flex-start;
}

.chat-row.outgoing {
  justify-content: flex-end;
}

.chat-bubble {
  box-sizing: border-box;
  max-width: calc((92% - 40px) * var(--chat-bubble-width-scale, 1));
  min-width: 0;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text);
  font-size: var(--chat-message-font-size, inherit);
  line-height: var(--chat-message-line-height, 1.45);
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: anywhere;
  position: relative;
}

.chat-actions {
  display: flex;
  flex-direction: row;
  gap: 6px;
  align-self: center;
  opacity: 0;
  transition: opacity 0.12s ease;
  z-index: 2;
}

.chat-row.outgoing .chat-actions {
  position: absolute;
  right: calc(92% - 34px);
  top: var(--actions-y, 0px);
  align-self: auto;
}

.chat-row:hover .chat-actions,
.chat-row:focus-within .chat-actions {
  opacity: 1;
}

.chat-text-editable {
  outline: none;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-text-editable:focus {
  outline: 2px solid rgba(59, 130, 246, 0.35);
  outline-offset: 2px;
  border-radius: 8px;
}

.chat-row.incoming .chat-bubble {
  color: var(--color-accent);
}

.chat-row.outgoing .chat-bubble {
  width: calc((92% - 40px) * var(--chat-bubble-width-scale, 1));
  background: rgba(59, 130, 246, 0.16);
  border-color: rgba(59, 130, 246, 0.25);
  color: var(--color-text);
}

.chat-row.assistant-response .chat-bubble {
  width: calc((100% - 18px) * var(--chat-bubble-width-scale, 1));
  max-width: calc((100% - 18px) * var(--chat-bubble-width-scale, 1));
}

.chat-row.focus-copy .chat-bubble {
  width: calc((100% - 18px) * var(--chat-bubble-width-scale, 1));
  max-width: calc((100% - 18px) * var(--chat-bubble-width-scale, 1));
  color: var(--color-text);
}

.chat-row.assistant-response .chat-actions {
  right: 10px;
}

.chat-row.outgoing.prompt .chat-bubble {
  background: rgba(168, 85, 247, 0.16);
  border-color: rgba(168, 85, 247, 0.28);
}

.chat-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.chat-attachment {
  position: relative;
  width: 96px;
  height: 64px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.18);
}

.chat-attachment-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.chat-bubble.clickable {
  cursor: pointer;
}

.chat-bubble.clickable:hover {
  background: rgba(255, 255, 255, 0.1);
}

.chat-row.anchor .chat-bubble {
  outline: 2px solid rgba(244, 67, 54, 0.55);
  outline-offset: 1px;
}

.chat-row.selected .chat-bubble {
  outline: 2px solid rgba(76, 175, 80, 0.7);
  outline-offset: 1px;
}

.chat-row.out-of-context .chat-bubble {
  border-color: rgba(244, 67, 54, 0.25);
}

.chat-row.partial .chat-bubble {
  opacity: 0.85;
}

.chat-row.error .chat-bubble {
  border-color: rgba(244, 67, 54, 0.35);
  background: rgba(244, 67, 54, 0.12);
}

.chat-icon {
  font-size: 16px;
  opacity: 0.9;
  margin-right: 6px;
}

.chat-text {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.chat-text-deleted {
  font-style: italic;
  color: rgba(255, 255, 255, 0.35);
}

.theme-light .chat-text-deleted {
  color: rgba(0, 0, 0, 0.35);
}

.chat-bubble.deleted {
  background: transparent;
  border-color: transparent;
  cursor: default;
}

.chat-text-highlighted {
  white-space: pre-wrap;
  display: block;
  max-width: 100%;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.chat-row.focus-copy .chat-text-highlighted {
  white-space: normal;
}

.chat-collapsible-message {
  display: block;
  max-width: 100%;
  min-width: 0;
  position: relative;
  overscroll-behavior: contain;
}

.chat-collapsible-message:not(.collapsed) {
  overflow: visible;
}

.chat-collapsible-message.collapsed .chat-collapsible-content {
  max-height: 100px;
  overflow: hidden;
}

.chat-collapsible-message.collapsed {
  cursor: pointer;
}

.assistant-candidate-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
  white-space: normal;
}

.assistant-candidate-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  max-width: 160px;
  padding: 3px 9px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.72);
  font: inherit;
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
}

.assistant-candidate-tab.active {
  border-color: rgba(59, 130, 246, 0.48);
  background: rgba(59, 130, 246, 0.18);
  color: rgba(255, 255, 255, 0.95);
}

.assistant-candidate-tab.error {
  border-color: rgba(244, 67, 54, 0.38);
}

.assistant-candidate-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assistant-candidate-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex: 0 0 auto;
  background: rgba(59, 130, 246, 0.95);
}

.theme-light .assistant-candidate-tab {
  border-color: rgba(15, 23, 42, 0.12);
  background: rgba(15, 23, 42, 0.04);
  color: rgba(15, 23, 42, 0.68);
}

.theme-light .assistant-candidate-tab.active {
  border-color: rgba(37, 99, 235, 0.45);
  background: rgba(37, 99, 235, 0.12);
  color: rgba(15, 23, 42, 0.92);
}

.chat-collapse-toggle {
  position: sticky;
  bottom: var(--chat-sticky-footer-bottom);
  left: 0;
  z-index: 2;
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  min-height: 32px;
  padding: 6px 0;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 0 0 8px 8px;
  background: rgba(31, 35, 42, 0.94);
  color: rgba(255, 255, 255, 0.62);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.chat-collapsible-message:not(.collapsed) .chat-collapse-toggle {
  width: 42px;
  height: 42px;
  min-height: 42px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
  font-size: 0;
}

.chat-collapsible-message:not(.collapsed) .chat-collapse-toggle::before {
  content: 'Hide';
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

.chat-collapsible-message.collapsed .chat-collapse-toggle {
  position: static;
  bottom: auto;
  left: auto;
}

.chat-collapse-toggle:hover {
  color: rgba(255, 255, 255, 0.88);
  background: rgba(43, 48, 57, 0.96);
}

.theme-light .chat-collapse-toggle {
  background: rgba(248, 250, 252, 0.94);
  color: rgba(15, 23, 42, 0.62);
  border-top-color: rgba(15, 23, 42, 0.08);
}

.theme-light .chat-collapse-toggle:hover {
  color: rgba(15, 23, 42, 0.88);
  background: rgba(241, 245, 249, 0.96);
}

.theme-light .chat-collapsible-message:not(.collapsed) .chat-collapse-toggle {
  border-color: rgba(15, 23, 42, 0.14);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.16);
}

.chat-markdown {
  display: block;
  max-width: 100%;
  min-width: 0;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.chat-markdown :deep(p) {
  margin: 4px 0;
}

.chat-markdown :deep(h1),
.chat-markdown :deep(h2),
.chat-markdown :deep(h3),
.chat-markdown :deep(h4),
.chat-markdown :deep(h5),
.chat-markdown :deep(h6) {
  font-weight: 700;
  margin: 6px 0 4px;
  line-height: 1.25;
}

.chat-markdown :deep(p),
.chat-markdown :deep(li),
.chat-markdown :deep(blockquote),
.chat-markdown :deep(h1),
.chat-markdown :deep(h2),
.chat-markdown :deep(h3),
.chat-markdown :deep(h4),
.chat-markdown :deep(h5),
.chat-markdown :deep(h6),
.chat-markdown :deep(a) {
  word-break: break-word;
  overflow-wrap: anywhere;
}

.chat-markdown :deep(h1) {
  font-size: 1.05em;
}

.chat-markdown :deep(h2) {
  font-size: 1.02em;
}

.chat-markdown :deep(h3),
.chat-markdown :deep(h4),
.chat-markdown :deep(h5),
.chat-markdown :deep(h6) {
  font-size: 0.98em;
}

.chat-markdown :deep(ul),
.chat-markdown :deep(ol) {
  margin: 6px 0 10px;
  padding-left: 18px;
}

.chat-markdown :deep(li) {
  margin: 2px 0;
}

.chat-markdown :deep(.code-block) {
  display: block;
  max-width: 100%;
  margin: 6px 0;
  border-radius: 8px;
  overflow: hidden;
  position: relative;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.32);
}

.chat-markdown :deep(.code-block:last-child) {
  margin-bottom: 0;
}

.chat-markdown :deep(.code-block pre) {
  margin: 0;
  max-width: 100%;
  padding: 12px 14px;
  overflow-x: auto;
  background: transparent;
  font-size: var(--chat-code-font-size, 12.5px);
  line-height: var(--chat-code-line-height, 1.5);
  box-sizing: border-box;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
}

.chat-markdown :deep(.code-block pre code) {
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', Menlo, Monaco, Consolas, monospace;
  font-size: var(--chat-code-font-size, 12.5px);
  line-height: var(--chat-code-line-height, 1.5);
  background: transparent;
  padding: 0;
  border-radius: 0;
  display: block;
  min-width: max-content;
  white-space: pre;
  word-break: normal;
  overflow-wrap: normal;
}

.chat-markdown :deep(.code-block-collapsible pre) {
  transition: max-height 0.3s ease;
}

.chat-markdown :deep(.code-block-collapsible.collapsed pre) {
  max-height: 100px;
  overflow: hidden;
}

.chat-markdown :deep(.code-block-collapsible),
.chat-text-highlighted :deep(.code-block-collapsible) {
  max-height: min(70vh, 720px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.chat-markdown :deep(.code-block-collapsible:not(.collapsed)),
.chat-text-highlighted :deep(.code-block-collapsible:not(.collapsed)) {
  max-height: none;
  overflow: visible;
}

.chat-markdown :deep(.code-block-collapsible pre),
.chat-text-highlighted :deep(.code-block-collapsible .shiki) {
  padding-bottom: 44px;
}

.chat-markdown :deep(.code-block-toggle) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 6px 0;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(31, 35, 42, 0.94);
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  font-family: inherit;
  position: sticky;
  bottom: 0;
  z-index: 2;
}

.chat-markdown :deep(.code-block-collapsible:not(.collapsed) .code-block-toggle) {
  bottom: var(--chat-sticky-footer-bottom);
}

.chat-markdown :deep(.code-block-toggle:hover) {
  background: rgba(43, 48, 57, 0.96);
  color: rgba(255, 255, 255, 0.85);
}

.chat-markdown :deep(.collapsed .code-block-toggle::before) {
  content: 'More';
}

.chat-markdown :deep(.code-block-collapsible:not(.collapsed) .code-block-toggle::before) {
  content: 'Hide';
}

.chat-markdown :deep(code) {
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', Menlo, Monaco, Consolas, monospace;
  font-size: var(--chat-inline-code-font-size, 0.92em);
  padding: 1px 5px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  white-space: break-spaces;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.chat-markdown :deep(a) {
  color: var(--color-accent);
  text-decoration: none;
}

.chat-markdown :deep(a:hover) {
  text-decoration: underline;
}

.chat-text-highlighted :deep(.code-block) {
  display: block;
  max-width: 100%;
  margin: 6px 0;
  border-radius: 8px;
  overflow: hidden;
  position: relative;
}

.chat-row.focus-copy .chat-text-highlighted :deep(.code-block) {
  overflow: visible;
}

.chat-text-highlighted :deep(.code-block:last-child) {
  margin-bottom: 0;
}

.chat-text-highlighted :deep(.code-block-collapsible .shiki) {
  transition: max-height 0.3s ease;
}

.chat-text-highlighted :deep(.code-block-collapsible.collapsed .shiki) {
  max-height: 360px;
  overflow: hidden;
}

.chat-text-highlighted :deep(.code-block-compact.code-block-collapsible.collapsed .shiki) {
  max-height: 100px;
}

.chat-row.focus-copy .chat-text-highlighted :deep(.code-block-collapsible:not(.collapsed)) {
  max-height: none;
  overflow: visible;
}

.chat-row.focus-copy .chat-text-highlighted :deep(.code-block-collapsible:not(.collapsed) .shiki) {
  max-height: none;
}

.chat-text-highlighted :deep(.code-block-toggle) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 6px 0;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(31, 35, 42, 0.94);
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  font-family: inherit;
  position: sticky;
  bottom: 0;
  z-index: 2;
}

.chat-text-highlighted :deep(.code-block-collapsible:not(.collapsed) .code-block-toggle) {
  bottom: var(--chat-sticky-footer-bottom);
}

.chat-row.focus-copy .chat-text-highlighted :deep(.code-block-collapsible.collapsed .code-block-toggle) {
  position: static;
  bottom: auto;
  left: auto;
}

.chat-text-highlighted :deep(.code-block-toggle:hover) {
  background: rgba(43, 48, 57, 0.96);
  color: rgba(255, 255, 255, 0.85);
}

.theme-light .chat-markdown :deep(.code-block-toggle),
.theme-light .chat-text-highlighted :deep(.code-block-toggle) {
  background: rgba(248, 250, 252, 0.94);
  color: rgba(15, 23, 42, 0.62);
  border-top-color: rgba(15, 23, 42, 0.08);
}

.theme-light .chat-markdown :deep(.code-block-toggle:hover),
.theme-light .chat-text-highlighted :deep(.code-block-toggle:hover) {
  background: rgba(241, 245, 249, 0.96);
  color: rgba(15, 23, 42, 0.88);
}

.chat-text-highlighted :deep(.collapsed .code-block-toggle::before) {
  content: 'More';
}

.chat-text-highlighted :deep(.code-block-collapsible:not(.collapsed) .code-block-toggle::before) {
  content: 'Hide';
}

.chat-text-highlighted :deep(.shiki) {
  margin: 0;
  max-width: 100%;
  padding: 12px 14px;
  border-radius: 8px 8px 0 0;
  font-size: var(--chat-code-font-size, 12.5px);
  line-height: var(--chat-code-line-height, 1.5);
  overflow-x: auto;
  tab-size: 2;
  box-sizing: border-box;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
}

.chat-text-highlighted :deep(.code-block:not(.code-block-collapsible) .shiki) {
  border-radius: 8px;
}

.chat-text-highlighted :deep(.shiki code) {
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', Menlo, Monaco, Consolas, monospace;
  font-size: var(--chat-code-font-size, 12.5px);
  line-height: var(--chat-code-line-height, 1.5);
  display: block;
  min-width: max-content;
  white-space: pre;
  word-break: normal;
  overflow-wrap: normal;
}

.chat-cursor {
  display: inline-block;
  margin-left: 2px;
  opacity: 0.9;
  animation: chat-cursor-blink 1s steps(2, end) infinite;
}

@keyframes chat-cursor-blink {
  50% {
    opacity: 0.25;
  }
}

@media (max-width: 560px) {
  .scroll-to-bottom-button {
    right: 10px;
    bottom: 10px;
    width: 36px;
    height: 36px;
  }

  .chat-scroll {
    padding: var(--chat-scroll-mobile-padding, 6px 4px 8px 2px);
    gap: 6px;
  }

  .chat-row {
    gap: 4px;
  }

  .chat-bubble {
    padding: 8px 9px 8px 8px;
  }

  .chat-row.outgoing .chat-bubble {
    width: calc((100% - 16px) * var(--chat-bubble-width-scale, 1));
  }

  .chat-row.assistant-response .chat-bubble {
    width: calc((100% - 6px) * var(--chat-bubble-width-scale, 1));
    max-width: calc((100% - 6px) * var(--chat-bubble-width-scale, 1));
  }

  .chat-row.outgoing .chat-actions {
    right: calc(100% - 10px);
  }

  .chat-row.assistant-response .chat-actions {
    right: 6px;
  }

  .chat-markdown :deep(ul),
  .chat-markdown :deep(ol) {
    padding-left: 16px;
  }

  .chat-markdown :deep(.code-block pre),
  .chat-text-highlighted :deep(.shiki) {
    padding: 10px 12px;
  }
}

@media (max-width: 420px) {
  .chat-scroll {
    padding: var(--chat-scroll-narrow-padding, 4px 2px 8px 0);
  }

  .chat-bubble {
    padding: 8px;
    border-radius: 10px;
  }

  .chat-row.assistant-response .chat-bubble {
    width: calc((100% - 2px) * var(--chat-bubble-width-scale, 1));
    max-width: calc((100% - 2px) * var(--chat-bubble-width-scale, 1));
  }
}
</style>

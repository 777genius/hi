<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, useSlots, watch } from 'vue';
import type { ConversationFeedMessage } from '../conversationFeed';
import { renderMarkdownToSafeHtml } from '@/utils/markdown';
import { highlightMessage, messageHasCode } from '@/utils/codeHighlight';
import { toggleCodeBlockCollapseFromTarget } from '../feedCodeBlocks';

type HighlightEntry = { sourceText: string; html: string };
const SCROLL_BOTTOM_THRESHOLD_PX = 72;

const props = withDefaults(defineProps<{
  messages: ConversationFeedMessage[];
  emptyText: string;
  selecting?: boolean;
  editingMessageId?: string | null;
  anchorMode?: 'tail' | 'fixed';
  anchorSttIndex?: number;
  messagesClickable?: boolean;
  isSelected?: (id: string) => boolean;
  isOutOfContext?: (message: ConversationFeedMessage) => boolean;
}>(), {
  selecting: false,
  editingMessageId: null,
  anchorMode: 'tail',
  anchorSttIndex: 0,
  messagesClickable: false,
  isSelected: () => false,
  isOutOfContext: () => false,
});

const emit = defineEmits<{
  (e: 'scroll-mousedown', event: MouseEvent): void;
  (e: 'scroll-click-capture', event: MouseEvent): void;
  (e: 'row-mousemove', event: MouseEvent, message: ConversationFeedMessage): void;
  (e: 'message-click', event: MouseEvent, message: ConversationFeedMessage): void;
  (e: 'inline-edit-keydown', event: KeyboardEvent, message: ConversationFeedMessage): void;
}>();

const slots = useSlots();
const scrollEl = ref<HTMLElement | null>(null);
const highlightedById = reactive<Record<string, HighlightEntry>>({});
const showScrollToBottom = ref(false);
let scrollStateFrame: number | null = null;

defineExpose({
  scrollEl,
  scrollToBottom,
});

const hasActionsSlot = computed(() => !!slots.actions);

const highlightCandidates = computed(() => {
  return props.messages
    .filter((message) => message.kind !== 'haiku' && !!message.text && messageHasCode(message.text))
    .map((message) => ({ id: message.id, text: message.text }));
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
      if (existing?.sourceText === item.text) continue;
      void highlightMessage(item.text)
        .then((html) => {
          if (!hasCurrentHighlightCandidate(item.id, item.text)) return;
          highlightedById[item.id] = { sourceText: item.text, html };
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
  if (!message.text || !messageHasCode(message.text)) return null;
  const entry = highlightedById[message.id];
  if (!entry || entry.sourceText !== message.text) return null;
  return entry.html;
}

function renderHaikuMarkdown(text: string): string {
  return renderMarkdownToSafeHtml(String(text ?? ''));
}

function rowClasses(message: ConversationFeedMessage): Record<string, boolean> {
  return {
    incoming: message.role === 'incoming',
    outgoing: message.role === 'outgoing',
    'assistant-response': message.kind === 'haiku',
    partial: message.status === 'streaming',
    prompt: message.kind === 'prompt',
    anchor:
      props.anchorMode === 'fixed' &&
      message.kind === 'stt' &&
      message.sttIndex === props.anchorSttIndex,
    selected: props.isSelected(message.id),
    'out-of-context': props.isOutOfContext(message),
    error: message.status === 'error',
  };
}

function isMessageClickable(message: ConversationFeedMessage): boolean {
  return props.messagesClickable && message.kind !== 'haiku' && !message.deleted && message.status === 'final';
}

function onMessageClick(event: MouseEvent, message: ConversationFeedMessage): void {
  if (!isMessageClickable(message)) return;
  emit('message-click', event, message);
}

function onScrollClickCapture(event: MouseEvent): void {
  if (toggleCodeBlockCollapseFromTarget(event.target)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  emit('scroll-click-capture', event);
}

function isNearBottom(element: HTMLElement): boolean {
  const remaining = element.scrollHeight - (element.scrollTop + element.clientHeight);
  return remaining <= SCROLL_BOTTOM_THRESHOLD_PX;
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
  updateScrollToBottomVisibility();
}

function scrollToBottom(behavior: ScrollBehavior = 'smooth'): void {
  const element = scrollEl.value;
  if (!element) return;

  element.scrollTo({
    top: element.scrollHeight,
    behavior,
  });
  scheduleScrollStateUpdate();
}

watch(
  scrollEl,
  (element, previous) => {
    previous?.removeEventListener('scroll', onScroll);
    element?.addEventListener('scroll', onScroll, { passive: true });
    scheduleScrollStateUpdate();
  },
  { immediate: true }
);

watch(
  () => props.messages,
  () => {
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
      :class="{ selecting }"
      @mousedown="emit('scroll-mousedown', $event)"
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
              <div v-if="msg.kind === 'haiku'" class="chat-markdown" v-html="renderHaikuMarkdown(msg.text)" />
              <span
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

            <span v-if="msg.status === 'streaming'" class="chat-cursor">▍</span>
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
  padding: var(--spacing-sm);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  position: relative;
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

:global(.theme-light) .scroll-to-bottom-button {
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
  font-size: 16px;
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
  max-width: calc(92% - 40px);
  min-width: 0;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text);
  line-height: 1.45;
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
  width: calc(92% - 40px);
  background: rgba(59, 130, 246, 0.16);
  border-color: rgba(59, 130, 246, 0.25);
  color: var(--color-text);
}

.chat-row.assistant-response .chat-bubble {
  width: calc(100% - 18px);
  max-width: calc(100% - 18px);
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

:global(.theme-light) .chat-text-deleted {
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

.chat-markdown :deep(.code-block::before) {
  content: attr(data-lang);
  position: absolute;
  top: 6px;
  right: 10px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
  text-transform: uppercase;
  pointer-events: none;
  font-family: inherit;
  z-index: 1;
}

.chat-markdown :deep(.code-block pre) {
  margin: 0;
  max-width: 100%;
  padding: 12px 14px;
  overflow-x: auto;
  background: transparent;
  font-size: 12.5px;
  line-height: 1.5;
  box-sizing: border-box;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
}

.chat-markdown :deep(.code-block pre code) {
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', Menlo, Monaco, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.5;
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
  max-height: calc(37.5em + 24px);
  overflow: hidden;
}

.chat-markdown :deep(.code-block-collapsible.collapsed::after) {
  content: '';
  position: absolute;
  bottom: 36px;
  left: 0;
  right: 0;
  height: 88px;
  background: linear-gradient(to bottom, transparent, rgba(0, 0, 0, 0.65));
  pointer-events: none;
}

.chat-markdown :deep(.code-block-toggle) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 6px 0;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  font-family: inherit;
}

.chat-markdown :deep(.code-block-toggle:hover) {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.85);
}

.chat-markdown :deep(.collapsed .code-block-toggle::before) {
  content: 'Показать полностью ▾';
}

.chat-markdown :deep(.code-block-collapsible:not(.collapsed) .code-block-toggle::before) {
  content: 'Свернуть ▴';
}

.chat-markdown :deep(code) {
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', Menlo, Monaco, Consolas, monospace;
  font-size: 0.92em;
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

.chat-text-highlighted :deep(.code-block:last-child) {
  margin-bottom: 0;
}

.chat-text-highlighted :deep(.code-block::before) {
  content: attr(data-lang);
  position: absolute;
  top: 6px;
  right: 10px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
  text-transform: uppercase;
  pointer-events: none;
  font-family: inherit;
  z-index: 1;
}

.chat-text-highlighted :deep(.code-block-collapsible .shiki) {
  transition: max-height 0.3s ease;
}

.chat-text-highlighted :deep(.code-block-collapsible.collapsed .shiki) {
  max-height: 360px;
  overflow: hidden;
}

.chat-text-highlighted :deep(.code-block-collapsible.collapsed::after) {
  content: '';
  position: absolute;
  bottom: 36px;
  left: 0;
  right: 0;
  height: 80px;
  background: linear-gradient(to bottom, transparent, #24292e);
  pointer-events: none;
  border-radius: 0 0 8px 8px;
}

.chat-text-highlighted :deep(.code-block-toggle) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 6px 0;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  font-family: inherit;
}

.chat-text-highlighted :deep(.code-block-toggle:hover) {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.85);
}

.chat-text-highlighted :deep(.collapsed .code-block-toggle::before) {
  content: 'Показать полностью ▾';
}

.chat-text-highlighted :deep(.code-block-collapsible:not(.collapsed) .code-block-toggle::before) {
  content: 'Свернуть ▴';
}

.chat-text-highlighted :deep(.shiki) {
  margin: 0;
  max-width: 100%;
  padding: 12px 14px;
  border-radius: 8px 8px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
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
    padding: 6px 4px 8px 2px;
    gap: 6px;
  }

  .chat-row {
    gap: 4px;
  }

  .chat-bubble {
    padding: 8px 9px 8px 8px;
  }

  .chat-row.outgoing .chat-bubble {
    width: calc(100% - 16px);
  }

  .chat-row.assistant-response .chat-bubble {
    width: calc(100% - 6px);
    max-width: calc(100% - 6px);
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
    padding: 4px 2px 8px 0;
  }

  .chat-bubble {
    padding: 8px;
    border-radius: 10px;
  }

  .chat-row.assistant-response .chat-bubble {
    width: calc(100% - 2px);
    max-width: calc(100% - 2px);
  }
}
</style>

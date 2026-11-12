import { describe, expect, it } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import ConversationFeed from './ConversationFeed.vue';
import type { ConversationFeedMessage } from '../conversationFeed';

describe('ConversationFeed assistant scrolling', () => {
  it('shows a single assistant bullet as a plain sentence', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({ render: () => h(ConversationFeed, {
      messages: [{ id: 'answer', kind: 'haiku', role: 'incoming', status: 'final',
        text: '- Я бы разделил сервисы по бизнес-границам.', createdAtMs: 1, seq: 1 }],
      emptyText: '',
    }) });
    app.mount(host);
    await nextTick();
    expect(host.querySelector('.chat-markdown')?.textContent).toContain('Я бы разделил сервисы');
    expect(host.querySelector('.chat-markdown ul')).toBeNull();
    app.unmount();
    host.remove();
  });

  it('follows new messages when the user was already at the bottom', async () => {
    const state = reactive({ messages: [{
      id: 'first', kind: 'stt', role: 'incoming', status: 'final',
      text: 'First question', createdAtMs: 1, seq: 1,
    }] as ConversationFeedMessage[] });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({ render: () => h(ConversationFeed, {
      messages: state.messages, emptyText: '',
    }) });
    app.mount(host);
    await nextTick();
    const scroll = host.querySelector('.chat-scroll') as HTMLElement;
    let contentHeight = 1000;
    Object.defineProperty(scroll, 'scrollHeight', { get: () => contentHeight });
    Object.defineProperty(scroll, 'clientHeight', { get: () => 500 });
    scroll.scrollTop = 500;
    scroll.dispatchEvent(new Event('scroll'));

    contentHeight = 1200;
    state.messages.push({
      id: 'second', kind: 'stt', role: 'incoming', status: 'final',
      text: 'Second question', createdAtMs: 2, seq: 2,
    });
    await nextTick();
    await nextTick();
    await nextTick();
    expect(scroll.scrollTop).toBe(1200);

    scroll.scrollTop = 100;
    scroll.dispatchEvent(new Event('scroll'));
    contentHeight = 1400;
    state.messages.push({
      id: 'third', kind: 'stt', role: 'incoming', status: 'final',
      text: 'Third question', createdAtMs: 3, seq: 3,
    });
    await nextTick();
    await nextTick();
    expect(scroll.scrollTop).toBe(100);
    app.unmount();
    host.remove();
  });

  it('holds position during streaming until the user reaches the end', async () => {
    const state = reactive({
      streaming: false,
      messages: [{
        id: 'answer', kind: 'haiku', role: 'incoming', status: 'streaming',
        text: 'First part', createdAtMs: 1, seq: 1,
      }] as ConversationFeedMessage[],
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({
      render: () => h(ConversationFeed, {
        messages: state.messages,
        emptyText: '',
        assistantStreaming: state.streaming,
      }),
    });
    app.mount(host);
    const scroll = host.querySelector('.chat-scroll') as HTMLElement;
    let contentHeight = 1000;
    Object.defineProperty(scroll, 'scrollHeight', { get: () => contentHeight });
    Object.defineProperty(scroll, 'clientHeight', { get: () => 500 });
    scroll.scrollTop = 500;

    state.streaming = true;
    await nextTick();
    contentHeight = 1500;
    state.messages[0].text = 'First part and another part';
    await nextTick();
    await nextTick();
    expect(scroll.scrollTop).toBe(500);

    scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    scroll.scrollTop = 1000;
    scroll.dispatchEvent(new Event('scroll'));
    contentHeight = 2000;
    state.messages[0].text += ' and the last part';
    await nextTick();
    await nextTick();
    expect(scroll.scrollTop).toBe(2000);

    app.unmount();
    host.remove();
  });

  it('keeps a long conversation readable through streaming and a network error', async () => {
    const state = reactive({
      streaming: false,
      messages: Array.from({ length: 300 }, (_, index): ConversationFeedMessage => ({
        id: `message-${index}`, kind: index % 2 ? 'haiku' : 'prompt',
        role: index % 2 ? 'incoming' : 'outgoing', status: 'final',
        text: `Turn ${index}: clean architecture and SOLID`,
        createdAtMs: index, seq: index + 1,
      })),
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({ render: () => h(ConversationFeed, {
      messages: state.messages, emptyText: '', assistantStreaming: state.streaming,
    }) });
    app.mount(host);
    const scroll = host.querySelector('.chat-scroll') as HTMLElement;
    Object.defineProperty(scroll, 'scrollHeight', { get: () => 30000 });
    Object.defineProperty(scroll, 'clientHeight', { get: () => 500 });
    scroll.scrollTop = 12000;
    expect(host.querySelectorAll('.chat-row')).toHaveLength(300);

    state.messages.push({
      id: 'latest', kind: 'haiku', role: 'incoming', status: 'streaming',
      text: 'Partial', createdAtMs: 301, seq: 301,
    });
    state.streaming = true;
    await nextTick();
    for (let index = 0; index < 20; index += 1) {
      state.messages[300].text += ` ${index}`;
      await nextTick();
    }
    expect(scroll.scrollTop).toBe(12000);
    expect(host.querySelectorAll('.chat-row')).toHaveLength(301);

    state.messages[300].status = 'error';
    state.messages[300].text = 'Сервер временно недоступен';
    state.streaming = false;
    await nextTick();
    expect(host.querySelector('[data-msg-id="latest"]')?.classList.contains('error')).toBe(true);
    expect(host.textContent).toContain('Сервер временно недоступен');
    app.unmount();
    host.remove();
  });
});

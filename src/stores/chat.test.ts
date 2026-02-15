import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useChatStore } from './chat';
import { reactive } from 'vue';

const DEFAULT_PROMPT = `Ты — ассистент на техническом собеседовании. Отвечай по-русски.

Контекст ниже — транскрипция, возможны ошибки распознавания. В нём есть строки:
- "ОС:" — то, что я слышу (обычно реплики собеседника/вопросы).
- "МИКРОФОН:" — то, что говорю я (мои ответы/мысли/иногда могу повторить вопрос).
- "ПОМОЩНИК:" — предыдущие ответы ассистента (можно использовать как контекст).

Твоя задача:
1) Найти последний явный или неявный вопрос/задачу: в первую очередь из строк "ОС:". Если строк "ОС:" нет — используй строки "МИКРОФОН:".
2) Дать лучший краткий ответ по делу (без воды), можно с короткими примерами/шагами.
3) Если вопрос неясен из-за распознавания — задай 1 уточняющий вопрос и предложи 1-2 вероятные интерпретации.
4) Возможно в вопросах не будет "?". Ты должен понимать где вопросы.

Формат ответа:
- Сначала 3–7 буллетов с ответом (каждый пункт начинай с "- ").
- Затем (если нужно) короткий пример кода.
- Не пересказывай весь контекст и не цитируй теги "ОС:"/"МИКРОФОН:"/"ПОМОЩНИК:".

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

const invokeMock = vi.fn();
const listenMock = vi.fn();

const transcriptionState = {
  finalUtterances: [] as Array<{ id: string; sessionId: number; text: string; timestamp: number }>,
  accumulatedText: '',
  partialText: '',
  editFinalUtterance: () => {},
  deleteFinalUtterance: () => {},
};

let transcriptionProxy: any = null;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => listenMock(...args),
}));

vi.mock('../utils/tauri', () => ({
  isTauriAvailable: () => true,
}));

vi.mock('./transcription', () => ({
  useTranscriptionStore: () => transcriptionProxy,
}));

describe('chat store (selection + context)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});

    transcriptionState.finalUtterances.splice(0, transcriptionState.finalUtterances.length);
    transcriptionState.accumulatedText = '';
    transcriptionState.partialText = '';
    transcriptionProxy = reactive(transcriptionState);

    try {
      localStorage.removeItem('llmSystemPrompt');
      localStorage.removeItem('anthropicSystemPrompt');
    } catch {
      // ignore
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-14T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tail anchor uses all utterances after context clear + partial', async () => {
    transcriptionProxy.finalUtterances.push(
      { id: 'stt:1:1:a', sessionId: 1, text: 'one', timestamp: 1 },
      { id: 'stt:1:2:b', sessionId: 1, text: 'two', timestamp: 2 },
      { id: 'stt:1:3:c', sessionId: 1, text: 'three', timestamp: 3 }
    );
    transcriptionProxy.partialText = 'partial';

    invokeMock.mockResolvedValue('r1');

    const store = useChatStore();
    expect(store.anchorMode).toBe('tail');
    expect(store.anchorSttIndex).toBe(2);

    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenCalledWith('start_haiku_stream', {
      text: ['ОС: one', 'ОС: two', 'ОС: three', 'ОС: partial'].join('\n'),
      system_prompt: DEFAULT_PROMPT,
    });
  });

  it('clearLlmContext resets tail context floor', async () => {
    transcriptionProxy.finalUtterances.push(
      { id: 'stt:1:1:old1', sessionId: 1, text: 'old1', timestamp: 1 },
      { id: 'stt:1:2:old2', sessionId: 1, text: 'old2', timestamp: 2 }
    );
    transcriptionProxy.partialText = '';
    invokeMock.mockResolvedValue('r5');

    const store = useChatStore();
    store.clearLlmContext();

    transcriptionProxy.finalUtterances.push({ id: 'stt:1:3:new1', sessionId: 1, text: 'new1', timestamp: 3 });

    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenCalledWith('start_haiku_stream', {
      text: 'ОС: new1',
      system_prompt: DEFAULT_PROMPT,
    });
  });

  it('selection uses only selected messages in chat order', async () => {
    transcriptionProxy.finalUtterances.push(
      { id: 'stt:1:1:a', sessionId: 1, text: 'a', timestamp: 1 },
      { id: 'stt:1:2:b', sessionId: 1, text: 'b', timestamp: 2 },
      { id: 'stt:1:3:c', sessionId: 1, text: 'c', timestamp: 3 }
    );
    transcriptionProxy.partialText = '';
    invokeMock.mockResolvedValue('r2');

    const store = useChatStore();
    store.setSelection(['stt:1:3:c', 'stt:1:1:a'], false);

    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenCalledWith('start_haiku_stream', {
      text: ['ОС: a', 'ОС: c'].join('\n'),
      system_prompt: DEFAULT_PROMPT,
    });
  });

  it('selection sets insertAfterId to last selected message', async () => {
    transcriptionProxy.finalUtterances.push(
      { id: 'stt:1:1:a', sessionId: 1, text: 'a', timestamp: 1 },
      { id: 'stt:1:2:b', sessionId: 1, text: 'b', timestamp: 2 },
      { id: 'stt:1:3:c', sessionId: 1, text: 'c', timestamp: 3 }
    );
    invokeMock.mockResolvedValue('r3');

    const store = useChatStore();
    store.setSelection(['stt:1:1:a', 'stt:1:3:c'], false);

    await store.requestHaikuFromAnchor();

    expect(store.haikuMessages[0]?.insertAfterId).toBe('stt:1:3:c');
  });

  it('saved system prompt is used for new requests', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:1:1:hi', sessionId: 1, text: 'hi', timestamp: 1 });
    invokeMock.mockResolvedValue('r4');

    const store = useChatStore();
    store.saveSystemPrompt(' custom ');

    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenCalledWith('start_haiku_stream', {
      text: 'ОС: hi',
      system_prompt: 'custom',
    });
  });

  it('manual prompt sends context + question to LLM and anchors response after prompt', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:1:1:a', sessionId: 1, text: 'one', timestamp: 1 });
    transcriptionProxy.partialText = 'partial';
    invokeMock.mockResolvedValue('r100');

    const store = useChatStore();
    await store.sendPromptToLlm({ text: 'hello', images: [] });

    expect(invokeMock).toHaveBeenCalledWith('start_haiku_chat_stream', {
      contextText: ['ОС: one', 'ОС: partial'].join('\n'),
      questionText: 'hello',
      images: [],
      systemPrompt: DEFAULT_PROMPT,
    });

    const promptMsg = store.messages.find((m) => m.kind === 'prompt');
    expect(promptMsg?.text).toBe('hello');
    expect(store.haikuMessages[0]?.insertAfterId).toBe(promptMsg?.id);
  });

  it('includes final assistant replies in subsequent context', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:1:1:a', sessionId: 1, text: 'hello', timestamp: 1 });
    transcriptionProxy.partialText = '';

    invokeMock.mockResolvedValueOnce('r10');
    const store = useChatStore();

    await store.requestHaikuFromAnchor();
    expect(invokeMock).toHaveBeenCalledWith('start_haiku_stream', {
      text: 'ОС: hello',
      system_prompt: DEFAULT_PROMPT,
    });

    // Симулируем завершённый ответ ассистента, чтобы он попал в контекст следующего запроса.
    expect(store.haikuMessages.length).toBe(1);
    store.haikuMessages[0] = { ...store.haikuMessages[0], status: 'final', text: 'answer' };

    // Второй запрос не должен быть заглушён throttle-ом hover триггера.
    vi.advanceTimersByTime(900);

    invokeMock.mockResolvedValueOnce('r11');
    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenLastCalledWith('start_haiku_stream', {
      text: ['ОС: hello', 'ПОМОЩНИК: answer'].join('\n'),
      system_prompt: DEFAULT_PROMPT,
    });
  });

  it('replyToMessageWithAi sends full history (ignores selection) and anchors response after target message', async () => {
    transcriptionProxy.finalUtterances.push(
      { id: 'stt:1:1:a', sessionId: 1, text: 'first', timestamp: 1 },
      { id: 'stt:1:2:b', sessionId: 1, text: 'second', timestamp: 2 }
    );
    transcriptionProxy.partialText = '';

    invokeMock.mockResolvedValue('r200');
    const store = useChatStore();

    // Выделение не должно влиять: для ответа на конкретное сообщение всегда передаём всю историю.
    store.setSelection(['stt:1:1:a'], false);

    await store.replyToMessageWithAi('stt:1:2:b');

    expect(invokeMock).toHaveBeenCalledWith('start_haiku_chat_stream', {
      contextText: ['ОС: first', 'ОС: second'].join('\n'),
      questionText: 'second',
      images: [],
      systemPrompt: DEFAULT_PROMPT,
    });

    expect(store.haikuMessages[0]?.insertAfterId).toBe('stt:1:2:b');
  });
});


import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useChatStore } from './chat';
import { reactive } from 'vue';
import type { CompanionSnapshotData } from '@/windowing/stateSync';

const DEFAULT_PROMPT = `Ты — ассистент на техническом собеседовании. Всегда отвечай по-русски, даже если вопрос задан на украинском или английском. Технические термины оставляй на английском.

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

const invokeMock = vi.fn();
const listenMock = vi.fn();

const transcriptionState = {
  finalUtterances: [] as Array<{ id: string; sessionId: number; text: string; timestamp: number }>,
  accumulatedText: '',
  partialText: '',
  isRecording: true,
  isStarting: false,
  isProcessing: false,
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

function companionSnapshot(timeline: CompanionSnapshotData['timeline'] = []): CompanionSnapshotData {
  return {
    authRequired: false,
    recording: {
      status: 'Idle',
      activeSessionId: 0,
    },
    microphone: {
      muted: false,
      enabled: true,
      supported: true,
      source: 'combined',
      systemMuted: false,
      systemSupported: true,
      systemSource: 'combined',
      appMuted: false,
      appEnabled: true,
    },
    controls: {
      historyFloorSeq: 0,
      contextFloorSeq: 0,
      conversationGeneration: 0,
      companionModeEnabled: true,
      desktopBlackoutEnabled: false,
      lastAction: null,
    },
    live: {},
    timeline,
  };
}

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
      localStorage.removeItem('openaiResponsesWebSearchEnabled');
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

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        text: ['ОС: one', 'ОС: two', 'ОС: three', 'ОС: partial'].join('\n'),
        system_prompt: DEFAULT_PROMPT,
        companionMeta: expect.objectContaining({
          insertAfterId: 'stt:live',
          createdAtMs: expect.any(Number),
        }),
      })
    );
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

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        text: 'ОС: new1',
        system_prompt: DEFAULT_PROMPT,
        companionMeta: expect.objectContaining({
          insertAfterId: 'stt:1:3:new1',
          createdAtMs: expect.any(Number),
        }),
      })
    );
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

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        text: ['ОС: a', 'ОС: c'].join('\n'),
        system_prompt: DEFAULT_PROMPT,
        companionMeta: expect.objectContaining({
          insertAfterId: 'stt:1:3:c',
          createdAtMs: expect.any(Number),
        }),
      })
    );
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

  it('keeps an assistant response before speech recorded after the response began', () => {
    const store = useChatStore();
    transcriptionProxy.finalUtterances.push({ id: 'question', sessionId: 1, text: 'Question', timestamp: 100 });
    store.hydrateFromCompanionSnapshot(companionSnapshot([{
      id: 'answer', kind: 'haiku', role: 'incoming', status: 'final', text: 'Answer',
      createdAtMs: 200, seq: 1, insertAfterId: 'question',
    }, {
      id: 'later-speech', kind: 'mic', role: 'outgoing', status: 'final', text: 'Later speech',
      createdAtMs: 300, seq: 2,
    }]));

    expect(store.messages.map((message) => message.id)).toEqual(['question', 'answer', 'later-speech']);
  });

  it('selection ignores non-final and assistant messages', () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:1:1:a', sessionId: 1, text: 'alpha', timestamp: 1 });
    transcriptionProxy.partialText = 'live alpha';

    const store = useChatStore();
    store.haikuMessages.push({
      id: 'haiku:1',
      kind: 'haiku',
      role: 'outgoing',
      status: 'final',
      text: 'answer',
      createdAtMs: 2,
      seq: 2,
    });

    store.setSelection(['stt:live', 'haiku:1', 'stt:1:1:a'], false);
    expect(store.selectedMessageIds).toEqual(['stt:1:1:a']);

    store.toggleSelection('haiku:1');
    expect(store.selectedMessageIds).toEqual(['stt:1:1:a']);

    store.toggleSelection('stt:live');
    expect(store.selectedMessageIds).toEqual(['stt:1:1:a']);

    store.selectOnly('stt:live');
    expect(store.selectedMessageIds).toEqual([]);
  });

  it('companion snapshot keeps valid local selection in companion mode', () => {
    transcriptionProxy.finalUtterances.push(
      { id: 'stt:1:1:a', sessionId: 1, text: 'first', timestamp: 1 },
      { id: 'stt:1:2:b', sessionId: 1, text: 'second', timestamp: 2 }
    );

    const store = useChatStore();
    store.setSelection(['stt:1:2:b'], false);

    store.hydrateFromCompanionSnapshot(
      companionSnapshot([
        {
          id: 'prompt:1',
          kind: 'prompt',
          role: 'outgoing',
          status: 'final',
          text: 'hello',
          createdAtMs: 3,
          seq: 3,
          attachments: [],
        },
      ])
    );

    expect(store.companionModeEnabled).toBe(true);
    expect(store.selectedMessageIds).toEqual(['stt:1:2:b']);
  });

  it('saved system prompt is used for new requests', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:1:1:hi', sessionId: 1, text: 'hi', timestamp: 1 });
    invokeMock.mockResolvedValue('r4');

    const store = useChatStore();
    store.saveSystemPrompt(' custom ');

    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        text: 'ОС: hi',
        system_prompt: 'custom',
        companionMeta: expect.objectContaining({
          insertAfterId: 'stt:1:1:hi',
          createdAtMs: expect.any(Number),
        }),
      })
    );
  });

  it('Signal messages are treated as incoming interviewer context', async () => {
    invokeMock.mockResolvedValue(undefined);

    const store = useChatStore();
    await store.initialize();

    const signalCb = listenMock.mock.calls.find((call) => call[0] === 'signal:message')?.[1] as
      | ((event: any) => void)
      | undefined;

    signalCb?.({
      payload: {
        id: 'signal:abc',
        platform: 'signal',
        sender: '+111',
        conversationId: '+111',
        text: 'Signal question',
        timestamp: 1_234,
      },
    });

    invokeMock.mockReset();
    invokeMock.mockResolvedValue('r-signal');

    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        text: 'ОС: Signal question',
        companionMeta: expect.objectContaining({
          insertAfterId: 'signal:abc',
        }),
        memoryContextEvidence: expect.objectContaining({
          recentTimeline: [
            expect.objectContaining({
              id: 'signal:abc',
              label: 'signal',
              text: 'Signal question',
            }),
          ],
        }),
      })
    );
  });

  it('forwards OpenAI Responses web search toggle to assistant requests', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:1:1:hi', sessionId: 1, text: 'hi', timestamp: 1 });
    invokeMock.mockResolvedValueOnce('r-web-1').mockResolvedValueOnce('r-web-2');

    const store = useChatStore();
    expect(store.openaiResponsesWebSearchEnabled).toBe(false);

    await store.requestHaikuFromAnchor();
    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        openaiResponsesWebSearch: false,
      })
    );

    store.toggleOpenAiResponsesWebSearch();
    expect(store.openaiResponsesWebSearchEnabled).toBe(true);

    await store.sendPromptToLlm({ text: 'fresh docs?', images: [] });
    expect(invokeMock).toHaveBeenLastCalledWith(
      'start_haiku_chat_stream',
      expect.objectContaining({
        questionText: 'fresh docs?',
        openaiResponsesWebSearch: true,
      })
    );
  });

  it('manual prompt sends context + question to LLM and anchors response after prompt', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:1:1:a', sessionId: 1, text: 'one', timestamp: 1 });
    transcriptionProxy.partialText = 'partial';
    invokeMock.mockResolvedValue('r100');

    const store = useChatStore();
    await store.sendPromptToLlm({ text: 'hello', images: [] });

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_chat_stream',
      expect.objectContaining({
        contextText: ['ОС: one', 'ОС: partial'].join('\n'),
        questionText: 'hello',
        images: [],
        systemPrompt: DEFAULT_PROMPT,
        companionMeta: expect.objectContaining({
          promptMessageId: expect.any(String),
          promptCreatedAtMs: expect.any(Number),
          createdAtMs: expect.any(Number),
        }),
      })
    );

    const promptMsg = store.messages.find((m) => m.kind === 'prompt');
    expect(promptMsg?.text).toBe('hello');
    expect(store.haikuMessages[0]?.insertAfterId).toBe(promptMsg?.id);
  });

  it('manual prompt keeps prior prompt + assistant history in context', async () => {
    transcriptionProxy.finalUtterances.push(
      { id: 'stt:1:1:a', sessionId: 1, text: 'first setup', timestamp: 1 },
      { id: 'stt:1:2:b', sessionId: 1, text: 'second setup', timestamp: 2 }
    );
    transcriptionProxy.partialText = '';

    invokeMock.mockResolvedValueOnce('r101');
    const store = useChatStore();

    await store.sendPromptToLlm({ text: 'previous manual question', images: [] });
    expect(store.haikuMessages.length).toBe(1);
    store.haikuMessages[0] = {
      ...store.haikuMessages[0],
      status: 'final',
      text: 'previous assistant answer',
    };

    invokeMock.mockResolvedValueOnce('r102');
    await store.sendPromptToLlm({ text: 'current manual question', images: [] });

    expect(invokeMock).toHaveBeenLastCalledWith(
      'start_haiku_chat_stream',
      expect.objectContaining({
        contextText: [
          'ОС: first setup',
          'ОС: second setup',
          'ЗАПРОС: previous manual question',
          'ПОМОЩНИК: previous assistant answer',
        ].join('\n'),
        questionText: 'current manual question',
        images: [],
        systemPrompt: DEFAULT_PROMPT,
      })
    );
  });

  it('manual prompt context respects clearLlmContext for old transcript, mic, prompt and assistant messages', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:old', sessionId: 1, text: 'old transcript', timestamp: 1 });

    const store = useChatStore();
    store.hydrateFromCompanionSnapshot(
      companionSnapshot([
        {
          id: 'mic:old',
          kind: 'mic',
          role: 'outgoing',
          status: 'final',
          text: 'old mic',
          createdAtMs: 2,
          seq: 2,
          attachments: [],
        },
        {
          id: 'prompt:old',
          kind: 'prompt',
          role: 'outgoing',
          status: 'final',
          text: 'old prompt',
          createdAtMs: 3,
          seq: 3,
          attachments: [],
        },
        {
          id: 'haiku:old',
          kind: 'haiku',
          role: 'outgoing',
          status: 'final',
          text: 'old answer',
          createdAtMs: 4,
          seq: 4,
          insertAfterId: 'prompt:old',
          attachments: [],
        },
      ])
    );

    store.clearLlmContext();
    transcriptionProxy.finalUtterances.push({ id: 'stt:new', sessionId: 1, text: 'new transcript', timestamp: 5 });
    invokeMock.mockResolvedValue('r103');

    await store.sendPromptToLlm({ text: 'new manual question', images: [] });

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_chat_stream',
      expect.objectContaining({
        contextText: 'ОС: new transcript',
        questionText: 'new manual question',
      })
    );
  });

  it('manual prompt forwards image payload and stores local image attachment', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:1:1:a', sessionId: 1, text: 'look at this', timestamp: 1 });
    invokeMock.mockResolvedValue('r104');

    const store = useChatStore();
    await store.sendPromptToLlm({
      text: 'what is on image?',
      images: [
        {
          id: 'img:1',
          mime: 'image/png',
          dataUrl: 'data:image/png;base64,AAA=',
          dataBase64: 'AAA=',
        },
      ],
    });

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_chat_stream',
      expect.objectContaining({
        contextText: 'ОС: look at this',
        questionText: 'what is on image?',
        images: [{ mediaType: 'image/png', dataBase64: 'AAA=' }],
      })
    );

    const promptMsg = store.messages.find((m) => m.kind === 'prompt');
    expect(promptMsg?.attachments).toEqual([
      {
        id: 'img:1',
        kind: 'image',
        mime: 'image/png',
        dataUrl: 'data:image/png;base64,AAA=',
      },
    ]);
  });

  it('groups candidate-aware haiku events into one assistant message', async () => {
    const store = useChatStore();
    await store.initialize();

    const startCb = listenMock.mock.calls.find((call) => call[0] === 'haiku:candidate-start')?.[1] as
      | ((event: any) => void)
      | undefined;
    const deltaCb = listenMock.mock.calls.find((call) => call[0] === 'haiku:delta')?.[1] as
      | ((event: any) => void)
      | undefined;
    const doneCb = listenMock.mock.calls.find((call) => call[0] === 'haiku:done')?.[1] as
      | ((event: any) => void)
      | undefined;

    startCb?.({
      payload: {
        request_id: 'haiku:parallel',
        candidate_id: 'anthropic',
        candidate_label: 'Anthropic',
        provider: 'anthropic',
        model: 'claude-test',
      },
    });
    startCb?.({
      payload: {
        request_id: 'haiku:parallel',
        candidate_id: 'openai_responses',
        candidate_label: 'OpenAI',
        provider: 'openai_responses',
        model: 'gpt-5.4-mini',
      },
    });

    deltaCb?.({
      payload: {
        request_id: 'haiku:parallel',
        candidate_id: 'anthropic',
        candidate_label: 'Anthropic',
        provider: 'anthropic',
        model: 'claude-test',
        delta: 'primary',
      },
    });
    deltaCb?.({
      payload: {
        request_id: 'haiku:parallel',
        candidate_id: 'openai_responses',
        candidate_label: 'OpenAI',
        provider: 'openai_responses',
        model: 'gpt-5.4-mini',
        delta: 'secondary',
      },
    });

    expect(store.haikuMessages).toHaveLength(1);
    expect(store.haikuMessages[0]).toMatchObject({
      id: 'haiku:parallel',
      status: 'streaming',
      text: 'primary',
      activeCandidateId: 'anthropic',
    });
    expect(store.haikuMessages[0]?.candidates).toMatchObject([
      { id: 'anthropic', label: 'Anthropic', status: 'streaming', text: 'primary' },
      { id: 'openai_responses', label: 'OpenAI', status: 'streaming', text: 'secondary' },
    ]);

    doneCb?.({ payload: { request_id: 'haiku:parallel', candidate_id: 'openai_responses' } });
    expect(store.haikuMessages[0]?.status).toBe('streaming');
    expect(store.haikuMessages[0]?.candidates?.[1]?.status).toBe('final');

    doneCb?.({ payload: { request_id: 'haiku:parallel', candidate_id: 'anthropic' } });
    doneCb?.({ payload: { request_id: 'haiku:parallel' } });
    expect(store.haikuMessages[0]?.status).toBe('final');
    expect(store.isHaikuStreaming).toBe(false);
  });

  it('group done settles candidates even if candidate done events arrive late', async () => {
    const store = useChatStore();
    await store.initialize();

    const startCb = listenMock.mock.calls.find((call) => call[0] === 'haiku:candidate-start')?.[1] as
      | ((event: any) => void)
      | undefined;
    const deltaCb = listenMock.mock.calls.find((call) => call[0] === 'haiku:delta')?.[1] as
      | ((event: any) => void)
      | undefined;
    const doneCb = listenMock.mock.calls.find((call) => call[0] === 'haiku:done')?.[1] as
      | ((event: any) => void)
      | undefined;

    for (const candidate of [
      ['anthropic', 'Anthropic'],
      ['openai_responses', 'OpenAI'],
    ] as const) {
      startCb?.({
        payload: {
          request_id: 'haiku:out-of-order',
          candidate_id: candidate[0],
          candidate_label: candidate[1],
          provider: candidate[0],
          model: `${candidate[0]}-model`,
        },
      });
    }

    deltaCb?.({ payload: { request_id: 'haiku:out-of-order', candidate_id: 'anthropic', delta: 'a' } });
    deltaCb?.({ payload: { request_id: 'haiku:out-of-order', candidate_id: 'openai_responses', delta: 'b' } });
    doneCb?.({ payload: { request_id: 'haiku:out-of-order' } });

    expect(store.haikuMessages[0]?.status).toBe('final');
    expect(store.haikuMessages[0]?.candidates?.map((candidate) => candidate.status)).toEqual([
      'final',
      'final',
    ]);
    expect(store.isHaikuStreaming).toBe(false);

    doneCb?.({ payload: { request_id: 'haiku:out-of-order', candidate_id: 'openai_responses' } });
    expect(store.haikuMessages[0]?.status).toBe('final');
  });

  it('keeps legacy single-provider haiku events working without candidate metadata', async () => {
    const store = useChatStore();
    await store.initialize();

    const deltaCb = listenMock.mock.calls.find((call) => call[0] === 'haiku:delta')?.[1] as
      | ((event: any) => void)
      | undefined;
    const doneCb = listenMock.mock.calls.find((call) => call[0] === 'haiku:done')?.[1] as
      | ((event: any) => void)
      | undefined;

    deltaCb?.({ payload: { request_id: 'haiku:legacy', delta: 'hello ' } });
    deltaCb?.({ payload: { request_id: 'haiku:legacy', delta: 'world' } });
    doneCb?.({ payload: { request_id: 'haiku:legacy' } });

    expect(store.haikuMessages[0]).toMatchObject({
      id: 'haiku:legacy',
      status: 'final',
      text: 'hello world',
    });
    expect(store.haikuMessages[0]?.candidates).toBeUndefined();
  });

  it('keeps cancelled haiku request ignored after companion snapshot hydration', async () => {
    const store = useChatStore();
    await store.initialize();

    const startCb = listenMock.mock.calls.find((call) => call[0] === 'haiku:candidate-start')?.[1] as
      | ((event: any) => void)
      | undefined;
    const deltaCb = listenMock.mock.calls.find((call) => call[0] === 'haiku:delta')?.[1] as
      | ((event: any) => void)
      | undefined;
    const doneCb = listenMock.mock.calls.find((call) => call[0] === 'haiku:done')?.[1] as
      | ((event: any) => void)
      | undefined;

    startCb?.({
      payload: {
        request_id: 'haiku:cancelled',
        candidate_id: 'openai_responses',
        candidate_label: 'OpenAI',
        provider: 'openai_responses',
        model: 'gpt-test',
      },
    });
    deltaCb?.({
      payload: {
        request_id: 'haiku:cancelled',
        candidate_id: 'openai_responses',
        delta: 'partial',
      },
    });
    expect(store.haikuMessages[0]?.text).toBe('partial');
    expect(store.isHaikuStreaming).toBe(true);

    store.cancelActiveHaikuStreams();
    store.hydrateFromCompanionSnapshot(companionSnapshot([]));

    deltaCb?.({
      payload: {
        request_id: 'haiku:cancelled',
        candidate_id: 'openai_responses',
        delta: ' late',
      },
    });
    doneCb?.({ payload: { request_id: 'haiku:cancelled', candidate_id: 'openai_responses' } });

    expect(store.haikuMessages).toHaveLength(0);
    expect(store.isHaikuStreaming).toBe(false);
  });

  it('uses selected assistant candidate text in subsequent context', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:1:1:a', sessionId: 1, text: 'base', timestamp: 1 });
    invokeMock.mockResolvedValue('r105');

    const store = useChatStore();
    store.haikuMessages.push({
      id: 'haiku:done',
      kind: 'haiku',
      role: 'outgoing',
      status: 'final',
      text: 'primary answer',
      createdAtMs: 2,
      seq: 2,
      activeCandidateId: 'anthropic',
      candidates: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          provider: 'anthropic',
          model: 'claude-test',
          status: 'final',
          text: 'primary answer',
        },
        {
          id: 'openai_responses',
          label: 'OpenAI 5.4 mini',
          provider: 'openai_responses',
          model: 'gpt-5.4-mini',
          status: 'final',
          text: 'mini answer',
        },
        {
          id: 'openai_responses_web',
          label: 'OpenAI 5.5 web',
          provider: 'openai_responses',
          model: 'gpt-5.5',
          status: 'final',
          text: 'web answer',
        },
      ],
    });

    store.selectHaikuCandidate('haiku:done', 'openai_responses_web');
    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        text: ['ОС: base', 'ПОМОЩНИК: web answer'].join('\n'),
      })
    );
  });

  it('includes final assistant replies in subsequent context', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:1:1:a', sessionId: 1, text: 'hello', timestamp: 1 });
    transcriptionProxy.partialText = '';

    invokeMock.mockResolvedValueOnce('r10');
    const store = useChatStore();

    await store.requestHaikuFromAnchor();
    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        text: 'ОС: hello',
        system_prompt: DEFAULT_PROMPT,
        companionMeta: expect.objectContaining({
          insertAfterId: 'stt:1:1:a',
          createdAtMs: expect.any(Number),
        }),
      })
    );

    // Симулируем завершённый ответ ассистента, чтобы он попал в контекст следующего запроса.
    expect(store.haikuMessages.length).toBe(1);
    store.haikuMessages[0] = { ...store.haikuMessages[0], status: 'final', text: 'answer' };

    // Второй запрос не должен быть заглушён throttle-ом hover триггера.
    vi.advanceTimersByTime(900);

    invokeMock.mockResolvedValueOnce('r11');
    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenLastCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        text: ['ОС: hello', 'ПОМОЩНИК: answer'].join('\n'),
        system_prompt: DEFAULT_PROMPT,
        companionMeta: expect.objectContaining({
          insertAfterId: 'stt:1:1:a',
          createdAtMs: expect.any(Number),
        }),
      })
    );
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

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_chat_stream',
      expect.objectContaining({
        contextText: ['ОС: first', 'ОС: second'].join('\n'),
        questionText: 'second',
        images: [],
        systemPrompt: DEFAULT_PROMPT,
        companionMeta: expect.objectContaining({
          insertAfterId: 'stt:1:2:b',
          createdAtMs: expect.any(Number),
        }),
      })
    );

    expect(store.haikuMessages[0]?.insertAfterId).toBe('stt:1:2:b');
  });

  it('replyToMessageWithAi sends full history even after context clear', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:old', sessionId: 1, text: 'old transcript', timestamp: 1 });

    const store = useChatStore();
    store.hydrateFromCompanionSnapshot(
      companionSnapshot([
        {
          id: 'mic:old',
          kind: 'mic',
          role: 'outgoing',
          status: 'final',
          text: 'old mic',
          createdAtMs: 2,
          seq: 2,
          attachments: [],
        },
        {
          id: 'prompt:old',
          kind: 'prompt',
          role: 'outgoing',
          status: 'final',
          text: 'old prompt',
          createdAtMs: 3,
          seq: 3,
          attachments: [],
        },
        {
          id: 'haiku:old',
          kind: 'haiku',
          role: 'outgoing',
          status: 'final',
          text: 'old answer',
          createdAtMs: 4,
          seq: 4,
          insertAfterId: 'prompt:old',
          attachments: [],
        },
      ])
    );
    store.clearLlmContext();
    invokeMock.mockResolvedValue('r201');

    await store.replyToMessageWithAi('prompt:old');

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_chat_stream',
      expect.objectContaining({
        contextText: [
          'ОС: old transcript',
          'МИКРОФОН: old mic',
          'ЗАПРОС: old prompt',
          'ПОМОЩНИК: old answer',
        ].join('\n'),
        questionText: 'old prompt',
        images: [],
        companionMeta: expect.objectContaining({
          insertAfterId: 'prompt:old',
        }),
      })
    );
  });

  it('selection can answer against selected transcript + manual prompt only', async () => {
    transcriptionProxy.finalUtterances.push(
      { id: 'stt:1:1:a', sessionId: 1, text: 'selected transcript', timestamp: 1 },
      { id: 'stt:1:2:b', sessionId: 1, text: 'unselected transcript', timestamp: 2 }
    );
    transcriptionProxy.partialText = '';

    invokeMock.mockResolvedValueOnce('r210');
    const store = useChatStore();
    await store.sendPromptToLlm({ text: 'selected manual note', images: [] });

    const promptMsg = store.messages.find((m) => m.kind === 'prompt');
    expect(promptMsg?.id).toBeTruthy();

    invokeMock.mockClear();
    invokeMock.mockResolvedValueOnce('r211');
    store.setSelection([promptMsg!.id, 'stt:1:1:a'], false);

    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        text: [
          'ОС: selected transcript',
          'ЗАПРОС: selected manual note',
        ].join('\n'),
        memoryContextEvidence: expect.objectContaining({
          selectedMessages: [
            expect.objectContaining({
              id: 'stt:1:1:a',
              label: 'system_audio',
              text: 'selected transcript',
            }),
            expect.objectContaining({
              id: promptMsg!.id,
              label: 'manual_prompt',
              text: 'selected manual note',
            }),
          ],
          currentCode: [],
        }),
        system_prompt: DEFAULT_PROMPT,
        companionMeta: expect.objectContaining({
          insertAfterId: promptMsg!.id,
          createdAtMs: expect.any(Number),
        }),
      })
    );
  });

  it('passes focus-copy code as currentCode memory evidence', async () => {
    transcriptionProxy.finalUtterances.push(
      {
        id: 'focus-copy:code',
        sessionId: 1,
        text: [
          'CODE_CTX_ALPHA',
          '```ts',
          'function processQueue(items: string[]) {',
          '  return items.shift();',
          '}',
          '```',
        ].join('\n'),
        timestamp: 1,
      },
      {
        id: 'stt:question',
        sessionId: 1,
        text: 'почему тут очередь, а не стек?',
        timestamp: 2,
      }
    );
    invokeMock.mockResolvedValue('r-code');
    const store = useChatStore();

    await store.sendPromptToLlm({ text: 'ответь как на интервью', images: [] });

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_chat_stream',
      expect.objectContaining({
        memoryContextEvidence: expect.objectContaining({
          currentCode: [
            expect.objectContaining({
              id: 'focus-copy:code',
              label: 'current_code',
              text: expect.stringContaining('processQueue'),
            }),
          ],
          recentTimeline: [
            expect.objectContaining({
              label: 'system_audio',
              text: 'почему тут очередь, а не стек?',
            }),
          ],
        }),
      })
    );
  });

  it('keeps plain class discussion in recentTimeline memory evidence', async () => {
    transcriptionProxy.finalUtterances.push({
      id: 'stt:class-discussion',
      sessionId: 1,
      text: 'объясни разницу class component и function component',
      timestamp: 1,
    });
    invokeMock.mockResolvedValue('r-class');
    const store = useChatStore();

    await store.sendPromptToLlm({ text: 'ответь кратко', images: [] });

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_chat_stream',
      expect.objectContaining({
        memoryContextEvidence: expect.objectContaining({
          currentCode: [],
          recentTimeline: [
            expect.objectContaining({
              label: 'system_audio',
              text: 'объясни разницу class component и function component',
            }),
          ],
        }),
      })
    );
  });

  it('selection can explicitly use an old message after clearLlmContext', async () => {
    transcriptionProxy.finalUtterances.push(
      { id: 'stt:old', sessionId: 1, text: 'old selected question', timestamp: 1 },
      { id: 'stt:new', sessionId: 1, text: 'new unselected question', timestamp: 2 }
    );
    invokeMock.mockResolvedValue('r212');

    const store = useChatStore();
    store.clearLlmContext();
    store.setSelection(['stt:old'], false);

    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        text: 'ОС: old selected question',
        companionMeta: expect.objectContaining({
          insertAfterId: 'stt:old',
        }),
      })
    );
  });

  it('does not include unfinished, errored or deleted assistant messages in context', async () => {
    transcriptionProxy.finalUtterances.push({ id: 'stt:1:1:a', sessionId: 1, text: 'base question', timestamp: 1 });
    invokeMock.mockResolvedValue('r213');

    const store = useChatStore();
    store.haikuMessages.push(
      {
        id: 'haiku:streaming',
        kind: 'haiku',
        role: 'outgoing',
        status: 'streaming',
        text: 'unfinished answer',
        createdAtMs: 2,
        seq: 2,
      },
      {
        id: 'haiku:error',
        kind: 'haiku',
        role: 'outgoing',
        status: 'error',
        text: 'failed answer',
        createdAtMs: 3,
        seq: 3,
      },
      {
        id: 'haiku:deleted',
        kind: 'haiku',
        role: 'outgoing',
        status: 'final',
        text: 'deleted answer',
        createdAtMs: 4,
        seq: 4,
        deleted: true,
      },
      {
        id: 'haiku:final',
        kind: 'haiku',
        role: 'outgoing',
        status: 'final',
        text: 'usable answer',
        createdAtMs: 5,
        seq: 5,
      }
    );

    await store.requestHaikuFromAnchor();

    expect(invokeMock).toHaveBeenCalledWith(
      'start_haiku_stream',
      expect.objectContaining({
        text: ['ОС: base question', 'ПОМОЩНИК: usable answer'].join('\n'),
      })
    );
  });

  it('caps large transcript context without dropping the newest utterance', async () => {
    for (let i = 0; i < 450; i++) {
      transcriptionProxy.finalUtterances.push({
        id: `stt:bulk:${i}`,
        sessionId: 1,
        text: `bulk-${String(i).padStart(3, '0')} ${'long context chunk '.repeat(4)}`,
        timestamp: i + 1,
      });
    }
    transcriptionProxy.partialText = '';
    invokeMock.mockResolvedValue('r300');

    const store = useChatStore();
    await store.requestHaikuFromAnchor();

    const payload = invokeMock.mock.calls[0]?.[1] as { text?: string } | undefined;
    expect(payload?.text).toBeTypeOf('string');
    expect(payload!.text!.length).toBeLessThanOrEqual(48_000);
    expect(payload!.text).toMatch(/^ОС: bulk-\d{3}/);
    expect(payload!.text).toContain('ОС: bulk-449');
    expect(store.haikuMessages[0]?.insertAfterId).toBe('stt:bulk:449');
  });

  it('keeps early code marker in the default long interview context budget', async () => {
    transcriptionProxy.finalUtterances.push({
      id: 'stt:code:early',
      sessionId: 1,
      text: `CODE-JS-ORDER-MAP-001\nfunction totals(orders) {}\n${'x'.repeat(2_000)}`,
      timestamp: 1,
    });

    for (let i = 0; i < 320; i++) {
      transcriptionProxy.finalUtterances.push({
        id: `stt:follow:${i}`,
        sessionId: 1,
        text: `FOLLOW-UP-${String(i).padStart(3, '0')} ${'long context chunk '.repeat(10)}`,
        timestamp: i + 2,
      });
    }
    transcriptionProxy.partialText = '';
    invokeMock.mockResolvedValue('r301');

    const store = useChatStore();
    await store.requestHaikuFromAnchor();

    const payload = invokeMock.mock.calls[0]?.[1] as { text?: string } | undefined;
    expect(payload?.text).toBeTypeOf('string');
    expect(payload!.text!.length).toBeLessThanOrEqual(48_000);
    expect(payload!.text).toContain('CODE-JS-ORDER-MAP-001');
    expect(payload!.text).toContain('FOLLOW-UP-319');
    expect(payload!.text).not.toContain('FOLLOW-UP-000');

    const evidence = (invokeMock.mock.calls[0]?.[1] as any)?.memoryContextEvidence;
    const evidenceText = [
      ...(evidence?.selectedMessages ?? []),
      ...(evidence?.currentCode ?? []),
      ...(evidence?.recentTimeline ?? []),
    ]
      .map((item: { text?: string }) => item.text ?? '')
      .join('\n');
    expect(evidenceText).toContain('CODE-JS-ORDER-MAP-001');
    expect(evidenceText).toContain('FOLLOW-UP-319');
    expect(evidenceText).not.toContain('FOLLOW-UP-000');
  });

  it('filters system STT utterance when it duplicates microphone utterance', async () => {
    const store = useChatStore();
    await store.initialize();

    const micLevelCb = listenMock.mock.calls.find((c) => c[0] === 'microphone:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const sysLevelCb = listenMock.mock.calls.find((c) => c[0] === 'audio:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const finalCb = listenMock.mock.calls.find((c) => c[0] === 'transcription:final')?.[1] as
      | ((e: any) => void)
      | undefined;

    expect(micLevelCb).toBeTypeOf('function');
    expect(sysLevelCb).toBeTypeOf('function');
    expect(finalCb).toBeTypeOf('function');

    // Микрофон явно доминирует (иначе микрофонные события не попадут в чат).
    sysLevelCb?.({ payload: { level: 0 } });
    micLevelCb?.({ payload: { level: 0.6 } });

    const t0 = Date.now();
    finalCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: 'привет мир',
        timestamp: t0,
      },
    });

    // Почти сразу приходит тот же текст по системному каналу (типичный симптом "микрофон попал в системный звук").
    transcriptionProxy.finalUtterances.push({
      id: 'stt:1:1:x',
      sessionId: 1,
      text: 'привет мир',
      timestamp: t0 + 300,
    });

    expect(store.sttMessages.length).toBe(0);
    const hasMicFinal = store.messages.some((m) => m.kind === 'mic' && m.status === 'final' && m.text === 'привет мир');
    const hasSttFinal = store.messages.some((m) => m.kind === 'stt' && m.status === 'final');
    expect(hasMicFinal).toBe(true);
    expect(hasSttFinal).toBe(false);
  });

  it('merges overlapping microphone live text and empty final fallback', async () => {
    const store = useChatStore();
    await store.initialize();

    const micLevelCb = listenMock.mock.calls.find((c) => c[0] === 'microphone:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const sysLevelCb = listenMock.mock.calls.find((c) => c[0] === 'audio:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const partialCb = listenMock.mock.calls.find((c) => c[0] === 'transcription:partial')?.[1] as
      | ((e: any) => void)
      | undefined;
    const finalCb = listenMock.mock.calls.find((c) => c[0] === 'transcription:final')?.[1] as
      | ((e: any) => void)
      | undefined;

    sysLevelCb?.({ payload: { level: 0 } });
    micLevelCb?.({ payload: { level: 0.6 } });

    partialCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: 'Ты слышишь, что я говорю?',
        timestamp: Date.now(),
        is_segment_final: true,
        start: 0,
        duration: 2.3,
      },
    });
    partialCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: 'Ты слышишь, что',
        timestamp: Date.now() + 50,
        is_segment_final: false,
        start: 0,
        duration: 1.1,
      },
    });

    expect(store.messages.find((m) => m.id === 'mic:live')?.text).toBe('Ты слышишь, что я говорю?');

    finalCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: '',
        timestamp: Date.now() + 100,
      },
    });

    const micFinal = store.messages.find((m) => m.kind === 'mic' && m.status === 'final');
    expect(micFinal?.text).toBe('Ты слышишь, что я говорю?');
  });

  it('appends finalized microphone chunks without removing repeated boundary words', async () => {
    const store = useChatStore();
    await store.initialize();

    const micLevelCb = listenMock.mock.calls.find((c) => c[0] === 'microphone:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const sysLevelCb = listenMock.mock.calls.find((c) => c[0] === 'audio:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const partialCb = listenMock.mock.calls.find((c) => c[0] === 'transcription:partial')?.[1] as
      | ((e: any) => void)
      | undefined;
    const finalCb = listenMock.mock.calls.find((c) => c[0] === 'transcription:final')?.[1] as
      | ((e: any) => void)
      | undefined;

    sysLevelCb?.({ payload: { level: 0 } });
    micLevelCb?.({ payload: { level: 0.6 } });

    partialCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: 'my number is two two',
        timestamp: Date.now(),
        is_segment_final: true,
        start: 0,
        duration: 3.26,
      },
    });
    finalCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: 'two two three',
        timestamp: Date.now() + 100,
      },
    });

    const micFinal = store.messages.find((m) => m.kind === 'mic' && m.status === 'final');
    expect(micFinal?.text).toBe('my number is two two two two three');
  });

  it('does not finalize microphone text before speech_final when Deepgram segment start changes', async () => {
    const store = useChatStore();
    await store.initialize();

    const micLevelCb = listenMock.mock.calls.find((c) => c[0] === 'microphone:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const sysLevelCb = listenMock.mock.calls.find((c) => c[0] === 'audio:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const partialCb = listenMock.mock.calls.find((c) => c[0] === 'transcription:partial')?.[1] as
      | ((e: any) => void)
      | undefined;
    const finalCb = listenMock.mock.calls.find((c) => c[0] === 'transcription:final')?.[1] as
      | ((e: any) => void)
      | undefined;

    sysLevelCb?.({ payload: { level: 0 } });
    micLevelCb?.({ payload: { level: 0.6 } });

    partialCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: 'my number is two two',
        timestamp: Date.now(),
        is_segment_final: true,
        start: 0,
        duration: 3.26,
      },
    });
    partialCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: 'two two three',
        timestamp: Date.now() + 50,
        is_segment_final: false,
        start: 3.26,
        duration: 1.74,
      },
    });

    expect(store.messages.some((m) => m.kind === 'mic' && m.status === 'final')).toBe(false);
    expect(store.messages.find((m) => m.id === 'mic:live')?.text).toBe('my number is two two three');

    finalCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: 'two two three',
        timestamp: Date.now() + 100,
        start: 3.26,
        duration: 1.74,
      },
    });

    const micFinal = store.messages.find((m) => m.kind === 'mic' && m.status === 'final');
    expect(micFinal?.text).toBe('my number is two two two two three');
  });

  it('does not duplicate microphone final when it repeats the last finalized range', async () => {
    const store = useChatStore();
    await store.initialize();

    const micLevelCb = listenMock.mock.calls.find((c) => c[0] === 'microphone:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const sysLevelCb = listenMock.mock.calls.find((c) => c[0] === 'audio:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const partialCb = listenMock.mock.calls.find((c) => c[0] === 'transcription:partial')?.[1] as
      | ((e: any) => void)
      | undefined;
    const finalCb = listenMock.mock.calls.find((c) => c[0] === 'transcription:final')?.[1] as
      | ((e: any) => void)
      | undefined;

    sysLevelCb?.({ payload: { level: 0 } });
    micLevelCb?.({ payload: { level: 0.6 } });

    partialCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: 'hello world',
        timestamp: Date.now(),
        is_segment_final: true,
        start: 0,
        duration: 1.5,
      },
    });
    finalCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: 'hello world',
        timestamp: Date.now() + 100,
        start: 0,
        duration: 1.5,
      },
    });

    const micFinal = store.messages.find((m) => m.kind === 'mic' && m.status === 'final');
    expect(micFinal?.text).toBe('hello world');
  });

  it('keeps repeated short microphone segment finals', async () => {
    const store = useChatStore();
    await store.initialize();

    const micLevelCb = listenMock.mock.calls.find((c) => c[0] === 'microphone:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const sysLevelCb = listenMock.mock.calls.find((c) => c[0] === 'audio:level')?.[1] as
      | ((e: any) => void)
      | undefined;
    const partialCb = listenMock.mock.calls.find((c) => c[0] === 'transcription:partial')?.[1] as
      | ((e: any) => void)
      | undefined;
    const finalCb = listenMock.mock.calls.find((c) => c[0] === 'transcription:final')?.[1] as
      | ((e: any) => void)
      | undefined;

    sysLevelCb?.({ payload: { level: 0 } });
    micLevelCb?.({ payload: { level: 0.6 } });

    for (const start of [0, 1]) {
      partialCb?.({
        payload: {
          session_id: 1,
          source: 'microphone',
          text: 'да',
          timestamp: Date.now(),
          is_segment_final: true,
          start,
          duration: 0.4,
        },
      });
    }

    finalCb?.({
      payload: {
        session_id: 1,
        source: 'microphone',
        text: '',
        timestamp: Date.now() + 100,
      },
    });

    const micFinal = store.messages.find((m) => m.kind === 'mic' && m.status === 'final');
    expect(micFinal?.text).toBe('да да');
  });
});

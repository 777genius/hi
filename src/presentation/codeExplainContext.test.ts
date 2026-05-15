import { describe, expect, it } from 'vitest';
import { buildCodeExplainContextUpToMessageId } from './codeExplainContext';
import type { ChatMessage } from '@/stores/chat';

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'kind' | 'text'>): ChatMessage {
  return {
    role: overrides.kind === 'stt' ? 'incoming' : 'outgoing',
    status: 'final',
    createdAtMs: 0,
    seq: 0,
    ...overrides,
  };
}

describe('buildCodeExplainContextUpToMessageId', () => {
  it('labels transcript, microphone, prompt and assistant lines up to the selected message', () => {
    const context = buildCodeExplainContextUpToMessageId([
      message({ id: 'stt:1', kind: 'stt', text: 'вопрос собеседника' }),
      message({ id: 'mic:1', kind: 'mic', text: 'моя мысль' }),
      message({ id: 'prompt:1', kind: 'prompt', text: 'ответь кратко' }),
      message({ id: 'haiku:1', kind: 'haiku', text: 'готовый ответ' }),
      message({ id: 'stt:2', kind: 'stt', text: 'после выделения' }),
    ], 'haiku:1');

    expect(context).toBe([
      'ОС: вопрос собеседника',
      'МИКРОФОН: моя мысль',
      'ЗАПРОС: ответь кратко',
      'ПОМОЩНИК: готовый ответ',
    ].join('\n'));
  });

  it('skips deleted and unfinished assistant messages so stale text is not sent', () => {
    const context = buildCodeExplainContextUpToMessageId([
      message({ id: 'stt:1', kind: 'stt', text: 'живой контекст' }),
      message({ id: 'haiku:draft', kind: 'haiku', status: 'streaming', text: 'черновик' }),
      message({ id: 'haiku:error', kind: 'haiku', status: 'error', text: 'ошибка' }),
      message({ id: 'mic:deleted', kind: 'mic', text: 'удалено', deleted: true }),
      message({ id: 'prompt:target', kind: 'prompt', text: 'выбранный запрос' }),
    ], 'prompt:target');

    expect(context).toBe([
      'ОС: живой контекст',
      'ЗАПРОС: выбранный запрос',
    ].join('\n'));
  });

  it('caps large context on a line boundary and keeps the newest selected context', () => {
    const messages = Array.from({ length: 80 }, (_, index) => message({
      id: `stt:${index}`,
      kind: 'stt',
      text: `строка ${String(index).padStart(2, '0')} ${'ж'.repeat(32)}`,
    }));

    const context = buildCodeExplainContextUpToMessageId(messages, 'stt:79', 800);

    expect(context.length).toBeLessThanOrEqual(800);
    expect(context.startsWith('ОС: строка')).toBe(true);
    expect(context).toContain('ОС: строка 79');
    expect(context).not.toContain('ОС: строка 00');
  });

  it('keeps early code marker in the default long interview context budget', () => {
    const messages = [
      message({
        id: 'code:early',
        kind: 'stt',
        text: `CODE-EXPLAIN-EARLY-001\nfunction totals(orders) {}\n${'x'.repeat(2_000)}`,
      }),
      ...Array.from({ length: 120 }, (_, index) =>
        message({
          id: `stt:${index}`,
          kind: 'stt',
          text: `FOLLOW-UP-${String(index).padStart(3, '0')} ${'ж'.repeat(180)}`,
        })
      ),
    ];

    const context = buildCodeExplainContextUpToMessageId(messages, 'stt:119');

    expect(context.length).toBeLessThanOrEqual(48_000);
    expect(context).toContain('CODE-EXPLAIN-EARLY-001');
    expect(context).toContain('FOLLOW-UP-119');
  });
});

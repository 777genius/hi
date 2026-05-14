import { describe, expect, it } from 'vitest';
import { appendTranscriptText, mergeTranscriptText } from './transcriptionText';

describe('mergeTranscriptText', () => {
  it('returns next when base is empty', () => {
    expect(mergeTranscriptText('', 'hello')).toBe('hello');
    expect(mergeTranscriptText('   ', 'hello')).toBe('hello');
  });

  it('returns base when next is empty', () => {
    expect(mergeTranscriptText('hello', '')).toBe('hello');
    expect(mergeTranscriptText('hello', '   ')).toBe('hello');
  });

  it('prefers cumulative next that contains base', () => {
    const base = 'Как в JavaScript сделать';
    const next = 'Как в JavaScript сделать чистую архитектуру?';
    expect(mergeTranscriptText(base, next)).toBe(next);
  });

  it('keeps base when it contains next (repeated shorter chunk)', () => {
    const base = 'Как в JavaScript сделать чистую архитектуру?';
    const next = 'Как в JavaScript сделать';
    expect(mergeTranscriptText(base, next)).toBe(base);
  });

  it('merges when next repeats the last long word of base', () => {
    const base = 'Как в JavaScript сделать';
    const next = 'сделать чистую архитектуру';
    expect(mergeTranscriptText(base, next)).toBe('Как в JavaScript сделать чистую архитектуру');
  });

  it('merges when there is multi-word overlap', () => {
    const base = 'я думаю что';
    const next = 'думаю что да';
    expect(mergeTranscriptText(base, next)).toBe('я думаю что да');
  });

  it('appends finalized chunks without overlap removal', () => {
    expect(appendTranscriptText('my number is two two', 'two two three')).toBe(
      'my number is two two two two three'
    );
  });

  it('still merges overlapping live interim text', () => {
    expect(mergeTranscriptText('Ты слышишь, что я говорю?', 'Ты слышишь, что')).toBe(
      'Ты слышишь, что я говорю?'
    );
  });
});

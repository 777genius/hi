import { describe, expect, it } from 'vitest';
import { textLooksLikeCurrentCode } from './currentCodeDetection';

describe('textLooksLikeCurrentCode', () => {
  it('does not classify plain component discussion as code', () => {
    expect(textLooksLikeCurrentCode('explain class component vs function component')).toBe(false);
  });

  it('classifies fenced code and declarations as code', () => {
    expect(textLooksLikeCurrentCode('```ts\nfunction solve() { return 1; }\n```')).toBe(true);
    expect(textLooksLikeCurrentCode('const value = queue.shift();')).toBe(true);
  });

  it('classifies SQL select-from snippets as code', () => {
    expect(textLooksLikeCurrentCode('select id, name from users where active = true')).toBe(true);
  });
});

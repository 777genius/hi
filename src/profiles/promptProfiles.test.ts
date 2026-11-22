import { describe, expect, it } from 'vitest';
import { preferTextAnswers } from './promptProfiles';

describe('saved interview prompt style', () => {
  it('replaces the saved speaking style without duplicating it', () => {
    const saved = 'Candidate resume stays here.\n<interview-speaking-style-v1>Only 3–4 sentences.</interview-speaking-style-v1>';
    const updated = preferTextAnswers(saved);
    expect(updated).toContain('Candidate resume stays here.');
    expect(updated).not.toContain('Only 3–4 sentences.');
    expect(updated).toContain('Фиксированного лимита предложений нет');
    expect(preferTextAnswers(updated)).toBe(updated);
    expect(updated.match(/<interview-speaking-style-v1>/g)).toHaveLength(1);
  });
});

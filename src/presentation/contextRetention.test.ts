import { describe, expect, it } from 'vitest';
import { trimContextParts, type ContextRetentionPart } from './contextRetention';

function stt(line: string): ContextRetentionPart {
  return { kind: 'stt', line };
}

function haiku(line: string): ContextRetentionPart {
  return { kind: 'haiku', line };
}

function prompt(line: string): ContextRetentionPart {
  return { kind: 'prompt', line };
}

describe('trimContextParts', () => {
  it('keeps recent interview context and older important code anchors without old assistant noise', () => {
    const parts: ContextRetentionPart[] = [
      stt(`CODE-EARLY-ANCHOR-001 function earlyTotals() { return 1; } ${'a'.repeat(1_200)}`),
      haiku(`ASSISTANT-OLD-NOISE-001 ${'b'.repeat(12_000)}`),
      ...Array.from({ length: 120 }, (_, index) =>
        stt(`old filler ${String(index).padStart(3, '0')} ${'c'.repeat(220)}`)
      ),
      stt(`CODE-MID-ANCHOR-002 select * from invoices where status = 'open'; ${'d'.repeat(1_200)}`),
      ...Array.from({ length: 180 }, (_, index) =>
        stt(`middle filler ${String(index).padStart(3, '0')} ${'e'.repeat(220)}`)
      ),
      prompt(`PROMPT-ANCHOR-003 explain the current tradeoff ${'f'.repeat(1_200)}`),
      ...Array.from({ length: 180 }, (_, index) =>
        stt(`RECENT-TAIL-${String(index).padStart(3, '0')} ${'g'.repeat(220)}`)
      ),
    ];

    const context = trimContextParts(parts);

    expect(context.length).toBeLessThanOrEqual(48_000);
    expect(context).toContain('CODE-EARLY-ANCHOR-001');
    expect(context).toContain('CODE-MID-ANCHOR-002');
    expect(context).toContain('PROMPT-ANCHOR-003');
    expect(context).toContain('RECENT-TAIL-179');
    expect(context).not.toContain('ASSISTANT-OLD-NOISE-001');
    expect(context).not.toContain('old filler 000');
  });

  it('keeps the first old anchor and the freshest old anchors when old code exceeds the anchor budget', () => {
    const oldAnchors = Array.from({ length: 24 }, (_, index) =>
      stt(`CODE-OLD-${String(index).padStart(2, '0')} function sample${index}() { return ${index}; } ${'x'.repeat(1_200)}`)
    );
    const recentTail = Array.from({ length: 180 }, (_, index) =>
      stt(`RECENT-HOUR-${String(index).padStart(3, '0')} ${'y'.repeat(220)}`)
    );

    const context = trimContextParts([...oldAnchors, ...recentTail]);

    expect(context.length).toBeLessThanOrEqual(48_000);
    expect(context).toContain('CODE-OLD-00');
    expect(context).toContain('CODE-OLD-23');
    expect(context).toContain('RECENT-HOUR-179');
  });
});

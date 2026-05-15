import { describe, expect, it } from 'vitest';
import { createPromptImageDraft } from './promptImages';

describe('createPromptImageDraft', () => {
  it('rejects HEIC files with an actionable message', async () => {
    const file = new File(['heic'], 'photo.heic', { type: 'image/heic' });

    await expect(createPromptImageDraft(file)).rejects.toThrow(/HEIC\/HEIF/);
    await expect(createPromptImageDraft(file)).rejects.toThrow(/JPEG\/Most Compatible/);
  });

  it('detects HEIF by filename when the browser omits the MIME type', async () => {
    const file = new File(['heif'], 'photo.HEIF', { type: '' });

    await expect(createPromptImageDraft(file)).rejects.toThrow(/HEIC\/HEIF/);
  });

  it('ignores files that are not images', async () => {
    const file = new File(['text'], 'note.txt', { type: 'text/plain' });

    await expect(createPromptImageDraft(file)).resolves.toBeNull();
  });
});

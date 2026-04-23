import { describe, expect, it } from 'vitest';
import { highlightMessage } from './codeHighlight';

describe('highlightMessage', () => {
  it('renders collapsible code blocks without inline onclick handlers', async () => {
    const lines = Array.from({ length: 21 }, (_value, index) => `const v${index} = ${index};`).join('\n');
    const source = `Before\n\`\`\`ts\n${lines}\n\`\`\`\nAfter`;

    const html = await highlightMessage(source);

    expect(html).toContain('code-block-collapsible');
    expect(html).toContain('code-block-toggle');
    expect(html).toContain('aria-label="Показать или свернуть код"');
    expect(html).not.toContain('onclick=');
  });
});

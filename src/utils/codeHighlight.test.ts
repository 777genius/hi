import { describe, expect, it } from 'vitest';
import { highlightMessage, highlightRawCodeBlock } from './codeHighlight';

describe('highlightMessage', () => {
  it('renders collapsible code blocks without inline onclick handlers', async () => {
    const lines = Array.from({ length: 21 }, (_value, index) => `const v${index} = ${index};`).join('\n');
    const source = `Before\n\`\`\`ts\n${lines}\n\`\`\`\nAfter`;

    const html = await highlightMessage(source);

    expect(html).toContain('code-block-collapsible');
    expect(html).toContain('code-block-toggle');
    expect(html).toContain('aria-label="Показать или свернуть код"');
    expect(html).not.toContain('onclick=');
  }, 15_000);

  it('renders raw captured code as compact collapsed code block', async () => {
    const html = await highlightRawCodeBlock('function test() {\n  return 1;\n}', { compact: true });

    expect(html).toContain('code-block-collapsible');
    expect(html).toContain('code-block-compact');
    expect(html).toContain('collapsed');
    expect(html).toContain('data-lang="typescript"');
    expect(html).toContain('data-lines="3"');
    expect(html).toContain('code-block-toggle');
  }, 15_000);

  it('can render raw captured code expanded', async () => {
    const html = await highlightRawCodeBlock('const value = 1;', { collapsed: false });

    expect(html).toContain('code-block-collapsible');
    expect(html).not.toContain(' collapsed"');
    expect(html).toContain('data-lang="typescript"');
  }, 15_000);
});

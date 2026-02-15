import { describe, expect, it } from 'vitest';
import { renderMarkdownToSafeHtml } from './markdown';

describe('renderMarkdownToSafeHtml', () => {
  it('escapes HTML and renders basic markdown', () => {
    const md = `
# Заголовок 1
## Заголовок 2
### Добавлено
- **Жирный** и \`код\`
- [Link](https://example.com)

<script>alert(1)</script>
`.trim();

    const html = renderMarkdownToSafeHtml(md);
    expect(html).toContain('<h1');
    expect(html).toContain('<h2');
    expect(html).toContain('<h3');
    expect(html).toContain('<strong>Жирный</strong>');
    expect(html).toContain('<code>код</code>');
    expect(html).toContain('href="https://example.com/');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('<script');
  });

  it('renders fenced code blocks and escapes HTML inside', () => {
    const md = `
\`\`\`dart
void main() {
  print("<x>");
}
\`\`\`
`.trim();
    const html = renderMarkdownToSafeHtml(md);
    expect(html).toContain('class="code-block');
    expect(html).toContain('<pre');
    expect(html).toContain('<code');
    expect(html).toContain('language-dart');
    expect(html).toContain('hljs');
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<x>');
  });

  it('collapses long fenced code blocks (max 25 lines)', () => {
    const lines = Array.from({ length: 26 }, (_v, i) => `print(${i});`).join('\n');
    const md = `\`\`\`dart\n${lines}\n\`\`\``;
    const html = renderMarkdownToSafeHtml(md);
    expect(html).toContain('code-block-collapsible');
    expect(html).toContain('data-max-lines="25"');
    expect(html).toContain('code-block-toggle');
  });

  it('does not collapse fenced code blocks with exactly 25 lines', () => {
    const lines = Array.from({ length: 25 }, (_v, i) => `print(${i});`).join('\n');
    const md = `\`\`\`dart\n${lines}\n\`\`\``;
    const html = renderMarkdownToSafeHtml(md);
    expect(html).toContain('class="code-block"');
    expect(html).not.toContain('code-block-collapsible');
    expect(html).not.toContain('code-block-toggle');
  });

  it('does not allow javascript: links', () => {
    const md = `- [X](javascript:alert(1))`;
    const html = renderMarkdownToSafeHtml(md);
    expect(html).not.toContain('href="javascript:');
  });
});


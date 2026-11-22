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

  it('separates assistant sentences while preserving markup, numbers and code', () => {
    const html = renderMarkdownToSafeHtml(
      'Первое **важное** предложение. Второе с `value.test` и 3.14. Третье!\n\n```dart\nprint("One. Two.");\n```',
      { answerSentences: true },
    );
    const root = document.createElement('div');
    root.innerHTML = html;
    const sentences = Array.from(root.querySelectorAll('.answer-sentence'));
    expect(sentences.map((node) => node.textContent?.trim())).toEqual([
      'Первое важное предложение.', 'Второе с value.test и 3.14.', 'Третье!',
    ]);
    expect(sentences[0].querySelector('strong')?.textContent).toBe('важное');
    expect(sentences[1].querySelector('code')?.textContent).toBe('value.test');
    expect(root.querySelector('pre')?.textContent).toContain('One. Two.');
    expect(root.querySelector('pre .answer-sentence')).toBeNull();
  });

  it.each([
    ['`value.test`', 'code', 'value.test'],
    ['[Read more](https://example.com)', 'a', 'Read more'],
    ['**Important answer.**', 'strong', 'Important answer.'],
    ['**[Read more](https://example.com)**', 'strong > a', 'Read more'],
  ])('preserves a sentence entirely inside inline markup: %s', (markdown, selector, text) => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdownToSafeHtml(markdown, { answerSentences: true });
    const sentence = root.querySelector('.answer-sentence');
    expect(sentence?.querySelector(selector)?.textContent).toBe(text);
    expect(root.querySelectorAll('.answer-sentence')).toHaveLength(1);
    expect(root.querySelectorAll('code, a, strong')).toHaveLength(selector === 'strong > a' ? 2 : 1);
    if (selector.includes('a')) {
      expect(sentence?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/');
      expect(sentence?.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('keeps shared inline ancestors once per sentence across mixed markup', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdownToSafeHtml(
      '**First [link](https://example.com). Second `code`.** Plain ending.',
      { answerSentences: true },
    );
    const sentences = Array.from(root.querySelectorAll('.answer-sentence'));
    expect(sentences.map((node) => node.textContent?.trim())).toEqual([
      'First link.', 'Second code.', 'Plain ending.',
    ]);
    expect(sentences[0].querySelector('strong > a')?.textContent).toBe('link');
    expect(sentences[1].querySelector('strong > code')?.textContent).toBe('code');
    expect(sentences[2].querySelector('strong')).toBeNull();
    expect(root.querySelector('strong strong, a a, code code')).toBeNull();
    expect(root.querySelectorAll('strong')).toHaveLength(2);
  });

  it('keeps sentence formatting restricted to sanitized inline markup', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdownToSafeHtml(
      '<strong onclick="alert(1)"><a href="javascript:alert(1)">Unsafe link.</a></strong>',
      { answerSentences: true },
    );
    expect(root.querySelector('.answer-sentence strong > a')?.textContent).toBe('Unsafe link.');
    expect(root.querySelector('[onclick], [href], script')).toBeNull();
  });

  it('preserves links, nested lists, images and explicit line breaks', () => {
    const html = renderMarkdownToSafeHtml(
      '- First sentence. Second [link](https://example.com).\n- Parent\n  - Child one. Child two.\n\n![alt](https://example.com/image.png)\n\nLine one.  \nLine two.',
      { answerSentences: true },
    );
    const root = document.createElement('div');
    root.innerHTML = html;
    expect(root.querySelectorAll('li')).toHaveLength(3);
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com/');
    expect(root.querySelector('img')).not.toBeNull();
    expect(root.querySelector('br')).not.toBeNull();
    expect(root.textContent).toContain('Child one. Child two.');
  });
});


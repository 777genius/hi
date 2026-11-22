import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

const MAX_CODE_LINES = 25;

function escapeHtmlAttr(input: string): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getSafeUrl(href: string): string | null {
  const v = String(href ?? '').trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function createMarked(enableCodeCollapse: boolean): Marked {
  const md = new Marked();

  // В marked v17+ удобнее конфигурировать через use().
  md.use({
    gfm: true,
    breaks: true,
    silent: true,
  });

  md.use({
    renderer: {
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const safeHref = getSafeUrl(String(href ?? ''));
        if (!safeHref) return text;

        let out = `<a href="${escapeHtmlAttr(safeHref)}" target="_blank" rel="noopener noreferrer"`;
        if (title) out += ` title="${escapeHtmlAttr(String(title))}"`;
        out += `>${text}</a>`;
        return out;
      },
    },
  });

  md.use(
    markedHighlight({
      langPrefix: 'hljs language-',
      emptyLangClass: 'hljs',
      highlight(code, lang) {
        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
        return hljs.highlight(code, { language }).value;
      },
    })
  );

  if (enableCodeCollapse) {
    md.use({
      hooks: {
        postprocess(html) {
          // Оборачиваем fenced code blocks в контейнер, чтобы:
          // - ограничивать высоту (макс 25 строк)
          // - показывать кнопку "развернуть/свернуть"
          //
          // Важно: это работает и с marked-highlight, потому что внутри <code> сохраняются "\n".
          return String(html ?? '').replace(
            /<pre><code class="([^"]*)">([\s\S]*?)<\/code><\/pre>/g,
            (_m, cls: string, inner: string) => {
              const classes = String(cls ?? '');
              const content = String(inner ?? '');
              // Для корректного подсчёта строк игнорируем одиночный trailing newline.
              const forCount = content.endsWith('\n') ? content.slice(0, -1) : content;
              const lineCount = Math.max(1, forCount.split('\n').length);
              const langMatch = classes.match(/\blanguage-([a-z0-9_+#.-]+)\b/i);
              const lang = langMatch?.[1] ? String(langMatch[1]).toLowerCase() : 'plaintext';
              const safeLang = escapeHtmlAttr(lang);
              const safeLines = escapeHtmlAttr(String(lineCount));
              const safeMax = escapeHtmlAttr(String(MAX_CODE_LINES));

              const pre = `<pre><code class="${escapeHtmlAttr(classes)}">${content}</code></pre>`;
              if (lineCount <= MAX_CODE_LINES) {
                return `<div class="code-block" data-lang="${safeLang}" data-lines="${safeLines}">${pre}</div>`;
              }

              return `<div class="code-block code-block-collapsible collapsed" data-lang="${safeLang}" data-lines="${safeLines}" data-max-lines="${safeMax}">${pre}<button class="code-block-toggle" type="button" aria-label="Показать или свернуть код"></button></div>`;
            }
          );
        },
      },
    });
  }

  return md;
}

const mdWithCodeCollapse = createMarked(true);
const mdWithoutCodeCollapse = createMarked(false);

/** Apply only to assistant prose; preserve inline markup, code blocks and lists. */
function formatAnswerSentences(html: string): string {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale?: string, options?: { granularity: 'sentence' }) => {
      segment(text: string): Iterable<{ segment: string; index: number }>;
    };
  }).Segmenter;
  if (!Segmenter || typeof document === 'undefined') return html;

  const template = document.createElement('template');
  template.innerHTML = html;
  const segmenter = new Segmenter(undefined, { granularity: 'sentence' });
  const blocks = template.content.querySelectorAll('p, li');
  for (const block of blocks) {
    // Keep explicit line breaks and non-text content intact. Nested lists and
    // paragraphs are formatted independently instead of moving their children.
    if (block.querySelector('br, img, video, audio') ||
        (block.tagName === 'LI' && block.querySelector('p, ul, ol, pre'))) continue;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const text = nodes.map((node) => node.data).join('');
    if (!text.trim()) continue;

    const locate = (offset: number): [Text, number] => {
      let remaining = offset;
      for (const node of nodes) {
        if (remaining <= node.length) return [node, remaining];
        remaining -= node.length;
      }
      const last = nodes[nodes.length - 1];
      return [last, last.length];
    };
    const ends = Array.from(segmenter.segment(text), ({ segment, index }) => index + segment.length);
    const fragment = document.createDocumentFragment();
    let start = 0;
    for (const end of ends) {
      if (end < text.length) {
        const [boundary] = locate(Math.max(start, end - 1));
        if (boundary.parentElement?.closest('code, a')) continue;
      }
      const [startNode, startOffset] = locate(start);
      const [endNode, endOffset] = locate(end);
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const sentence = document.createElement('span');
      sentence.className = 'answer-sentence';
      let contents: Node = range.cloneContents();
      // cloneContents includes descendants of the common ancestor, but omits
      // that ancestor and its parents. Restore only the missing sanitized
      // inline chain when the entire range sits inside formatted content.
      let ancestor = range.commonAncestorContainer;
      if (ancestor.nodeType !== Node.ELEMENT_NODE) ancestor = ancestor.parentNode!;
      while (ancestor !== block) {
        const wrapper = ancestor.cloneNode(false);
        wrapper.appendChild(contents);
        contents = wrapper;
        ancestor = ancestor.parentNode!;
      }
      sentence.append(contents);
      fragment.append(sentence);
      start = end;
    }
    block.replaceChildren(fragment);
  }
  return template.innerHTML;
}

export function renderMarkdownToSafeHtml(
  markdown: string,
  options?: { codeCollapse?: boolean; answerSentences?: boolean }
): string {
  const source = String(markdown ?? '');
  if (!source.trim()) return '';

  const enableCollapse = options?.codeCollapse !== false;
  const rendered = (enableCollapse ? mdWithCodeCollapse : mdWithoutCodeCollapse).parse(source);
  if (typeof rendered !== 'string') return '';

  const safeHtml = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['button'],
    ADD_ATTR: [
      'target',
      'rel',
      'type',
      'aria-label',
      'data-lang',
      'data-lines',
      'data-max-lines',
    ],
  });
  return options?.answerSentences ? formatAnswerSentences(safeHtml) : safeHtml;
}


import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';

let highlighterInstance: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

const PRELOADED_LANGS: BundledLanguage[] = [
  'javascript',
  'typescript',
  'python',
  'dart',
  'html',
  'css',
  'json',
  'bash',
  'sql',
  'java',
  'kotlin',
  'swift',
  'go',
  'rust',
  'cpp',
  'c',
  'csharp',
  'ruby',
  'php',
  'yaml',
  'xml',
  'markdown',
  'jsx',
  'tsx',
  'vue',
  'shell',
];

async function getHighlighter(): Promise<Highlighter> {
  if (highlighterInstance) return highlighterInstance;

  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: PRELOADED_LANGS,
    });
  }

  highlighterInstance = await highlighterPromise;
  return highlighterInstance;
}

async function ensureLanguage(
  highlighter: Highlighter,
  lang: string,
): Promise<BundledLanguage | 'plaintext'> {
  const loaded = highlighter.getLoadedLanguages();
  if (loaded.includes(lang as BundledLanguage)) {
    return lang as BundledLanguage;
  }

  try {
    await highlighter.loadLanguage(lang as BundledLanguage);
    return lang as BundledLanguage;
  } catch {
    return 'plaintext';
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

interface TextSegment {
  type: 'text';
  content: string;
}

interface CodeSegment {
  type: 'code';
  lang: string;
  content: string;
}

type Segment = TextSegment | CodeSegment;

const CODE_BLOCK_RE = /```(\w+)?\n([\s\S]*?)```/g;
const COLLAPSE_THRESHOLD = 20;

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(CODE_BLOCK_RE)) {
    const matchStart = match.index;

    if (matchStart > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, matchStart) });
    }

    segments.push({
      type: 'code',
      lang: (match[1] ?? 'plaintext').toLowerCase(),
      content: match[2].replace(/\n$/, ''),
    });

    lastIndex = matchStart + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

function hasCodeBlocks(text: string): boolean {
  return CODE_BLOCK_RE.test(text);
}

export async function highlightMessage(text: string): Promise<string> {
  CODE_BLOCK_RE.lastIndex = 0;
  if (!hasCodeBlocks(text)) {
    return escapeHtml(text);
  }

  CODE_BLOCK_RE.lastIndex = 0;
  const segments = parseSegments(text);
  const highlighter = await getHighlighter();
  const parts: string[] = [];

  for (const seg of segments) {
    if (seg.type === 'text') {
      parts.push(escapeHtml(seg.content));
    } else {
      const resolvedLang = await ensureLanguage(highlighter, seg.lang);
      const html = highlighter.codeToHtml(seg.content, {
        lang: resolvedLang,
        theme: 'github-dark',
      });
      const lineCount = seg.content.split('\n').length;
      const collapsible = lineCount > COLLAPSE_THRESHOLD;
      const cls = collapsible ? 'code-block code-block-collapsible collapsed' : 'code-block';
      const toggleBtn = collapsible
        ? '<button class="code-block-toggle" type="button" aria-label="Показать или свернуть код"></button>'
        : '';
      parts.push(`<div class="${cls}" data-lang="${escapeHtml(seg.lang)}" data-lines="${lineCount}">${html}${toggleBtn}</div>`);
    }
  }

  return parts.join('');
}

export function messageHasCode(text: string): boolean {
  CODE_BLOCK_RE.lastIndex = 0;
  return hasCodeBlocks(text);
}

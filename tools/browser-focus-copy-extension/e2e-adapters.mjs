import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const PAGE_BRIDGE_PATH = path.join(ROOT, 'tools/browser-focus-copy-extension/page-bridge.js');
const CONTENT_PATH = path.join(ROOT, 'tools/browser-focus-copy-extension/content.js');

const TEST_CASES = [
  'textarea',
  'input',
  'monaco-a',
  'monaco-b',
  'codemirror5',
  'codemirror6',
  'ace',
  'quill',
  'tinymce',
  'prosemirror',
  'slate',
  'lexical',
  'draftjs',
  'codejar',
];

const NEGATIVE_CASES = [
  'password',
  'checkbox',
  'no-editor',
];

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`${message.error.message || 'CDP error'} (${message.error.code ?? 'unknown'})`));
      } else {
        entry.resolve(message.result ?? {});
      }
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CdpClient(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`Failed to connect CDP websocket: ${url}`)), { once: true });
    });
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  close() {
    this.ws.close();
  }
}

function findBrowserBinary() {
  const candidates = [
    process.env.FOCUS_COPY_E2E_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`No Chromium browser found. Set FOCUS_COPY_E2E_BROWSER=/path/to/chrome.`);
  }
  return found;
}

async function waitForDevToolsPort(userDataDir, browserProcess) {
  const activePortPath = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (browserProcess.exitCode !== null) {
      throw new Error(`Browser exited early with code ${browserProcess.exitCode}`);
    }

    try {
      const [port, wsPath] = (await readFile(activePortPath, 'utf8')).trim().split('\n');
      if (port && wsPath) {
        return `ws://127.0.0.1:${port}${wsPath}`;
      }
    } catch {
      // File is created asynchronously by Chrome.
    }
    await sleep(50);
  }
  throw new Error('Timed out waiting for DevToolsActivePort');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopBrowser(browserProcess) {
  if (browserProcess.exitCode !== null) {
    return;
  }

  browserProcess.kill('SIGTERM');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (browserProcess.exitCode !== null) {
      return;
    }
    await sleep(50);
  }

  browserProcess.kill('SIGKILL');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (browserProcess.exitCode !== null) {
      return;
    }
    await sleep(50);
  }
}

async function rmRetry(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await sleep(100);
    }
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);

  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Runtime.evaluate failed';
    throw new Error(text);
  }

  return result.result?.value;
}

function fixtureSetupSource() {
  return String.raw`
    (async () => {
      const root = document.getElementById('fixtures');
      const cases = new Map();
      const texts = {
        textarea: 'textarea line 1\ntextarea line 2\ntextarea line 3',
        input: 'single line input value',
        monacoA: 'namespace Alpha {\n  export const hidden = 1;\n  export const last = hidden + 1;\n}',
        monacoB: 'namespace Beta {\n  export class Cell {\n    row = 1;\n    col = 2;\n  }\n}\n// offscreen tail',
        codemirror5: 'cm5 first\ncm5 middle\ncm5 offscreen final',
        codemirror6: 'cm6 first\ncm6 second\ncm6 third\ncm6 fourth',
        ace: 'ace first\nace second\nace third',
        quill: 'quill heading\nquill paragraph\nquill final',
        tinymce: 'tiny first\ntiny second\ntiny final',
        prosemirror: 'pm first\npm second\npm final',
        slate: 'slate alpha\nslate beta\nslate gamma',
        lexical: 'lexical alpha\nlexical beta\nlexical gamma',
        draftjs: 'draft alpha\ndraft beta\ndraft gamma',
        codejar: 'function codejar() {\n  return 42;\n}\n',
      };

      document.body.style.fontFamily = 'system-ui, sans-serif';
      root.innerHTML = '';

      function addCase(name, element, expected, extra = {}) {
        const section = document.createElement('section');
        section.dataset.case = name;
        const title = document.createElement('h2');
        title.textContent = name;
        section.append(title, element);
        root.append(section);
        cases.set(name, { element, expected, ...extra });
        return element;
      }

      function makeFocusableDiv(className, visibleText = 'visible line only') {
        const element = document.createElement('div');
        element.className = className;
        element.tabIndex = 0;
        element.textContent = visibleText;
        element.style.cssText = 'min-height:40px;border:1px solid #ccc;margin:8px;padding:4px;';
        return element;
      }

      const textarea = document.createElement('textarea');
      textarea.value = texts.textarea;
      addCase('textarea', textarea, texts.textarea);

      const input = document.createElement('input');
      input.type = 'text';
      input.value = texts.input;
      addCase('input', input, texts.input);

      const password = document.createElement('input');
      password.type = 'password';
      password.value = 'secret-password';
      addCase('password', password, null);

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      addCase('checkbox', checkbox, null);

      const noEditor = document.createElement('button');
      noEditor.textContent = 'ordinary button';
      addCase('no-editor', noEditor, null);

      globalThis.monaco = {
        editor: {
          _editors: [],
          create(container, options = {}) {
            const text = String(options.value ?? '');
            const model = { getValue: () => text };
            const editor = {
              getModel: () => model,
              getValue: () => text,
              getContainerDomNode: () => container,
              hasTextFocus: () => document.activeElement === container,
              hasWidgetFocus: () => false,
              getSelections: () => [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }],
              setSelections: () => {},
              focus: () => container.focus(),
              onDidFocusEditorText: (callback) => {
                container.addEventListener('focusin', callback, true);
                return { dispose() {} };
              },
              onDidFocusEditorWidget: (callback) => {
                container.addEventListener('focusin', callback, true);
                return { dispose() {} };
              },
              onDidChangeModelContent: () => ({ dispose() {} }),
              onDidDispose: () => ({ dispose() {} }),
              isDisposed: () => false,
            };
            this._editors.push(editor);
            return editor;
          },
          getModels() {
            return this._editors.map((editor) => editor.getModel());
          },
          getEditors() {
            return this._editors.slice();
          },
          getDiffEditors() {
            return [];
          },
        },
      };
      await new Promise((resolve) => setTimeout(resolve, 0));

      const monacoA = makeFocusableDiv('monaco-editor', 'visible monaco A only');
      globalThis.monaco.editor.create(monacoA, { value: texts.monacoA });
      addCase('monaco-a', monacoA, texts.monacoA);

      const monacoB = makeFocusableDiv('monaco-editor', 'visible monaco B only');
      globalThis.monaco.editor.create(monacoB, { value: texts.monacoB });
      addCase('monaco-b', monacoB, texts.monacoB);

      const cm5 = makeFocusableDiv('CodeMirror', 'cm5 visible first line only');
      cm5.CodeMirror = {
        getValue: () => texts.codemirror5,
        listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }],
        setSelections: () => {},
        focus: () => cm5.focus(),
      };
      addCase('codemirror5', cm5, texts.codemirror5);

      const cm6 = makeFocusableDiv('cm-editor', 'cm6 visible first line only');
      const cm6Content = document.createElement('div');
      cm6Content.className = 'cm-content';
      cm6Content.tabIndex = 0;
      cm6Content.cmView = {
        view: {
          state: {
            doc: { toString: () => texts.codemirror6 },
            selection: { ranges: [{ anchor: 0, head: 0 }], mainIndex: 0 },
          },
          focus: () => cm6Content.focus(),
          dispatch: () => {},
        },
      };
      cm6.append(cm6Content);
      addCase('codemirror6', cm6Content, texts.codemirror6);

      const ace = makeFocusableDiv('ace_editor', 'ace visible first line only');
      ace.env = {
        editor: {
          getValue: () => texts.ace,
          focus: () => ace.focus(),
          selection: {
            getRange: () => ({ start: { row: 0, column: 0 }, end: { row: 0, column: 0 } }),
            setSelectionRange: () => {},
          },
        },
      };
      addCase('ace', ace, texts.ace);

      const quillRoot = makeFocusableDiv('ql-editor', texts.quill);
      globalThis.Quill = {
        find: () => ({ getText: () => texts.quill + '\n' }),
      };
      addCase('quill', quillRoot, texts.quill);

      const tinyBody = makeFocusableDiv('tiny-body', 'tiny visible only');
      tinyBody.contentEditable = 'true';
      globalThis.tinymce = {
        activeEditor: {
          initialized: true,
          getBody: () => tinyBody,
          getContent: () => texts.tinymce,
        },
      };
      addCase('tinymce', tinyBody, texts.tinymce);

      const pm = makeFocusableDiv('ProseMirror', 'pm visible only');
      pm.pmViewDesc = {
        docView: {
          view: {
            state: {
              doc: {
                content: { size: texts.prosemirror.length },
                textBetween: () => texts.prosemirror,
              },
            },
          },
        },
      };
      addCase('prosemirror', pm, texts.prosemirror);

      const slate = makeFocusableDiv('', texts.slate);
      slate.setAttribute('data-slate-editor', 'true');
      addCase('slate', slate, texts.slate);

      const lexical = makeFocusableDiv('', texts.lexical);
      lexical.setAttribute('data-lexical-editor', 'true');
      addCase('lexical', lexical, texts.lexical);

      const draft = makeFocusableDiv('public-DraftEditor-content', texts.draftjs);
      addCase('draftjs', draft, texts.draftjs);

      const codejar = makeFocusableDiv('codejar', texts.codejar);
      addCase('codejar', codejar, texts.codejar);

      async function rpcReadEditor() {
        const requestId = 'adapter-e2e:' + Math.random().toString(16).slice(2);
        return await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            window.removeEventListener('message', onMessage, true);
            resolve({ ok: false, error: 'rpc-timeout' });
          }, 1000);

          function onMessage(event) {
            if (
              event.source !== window ||
              event.data?.source !== 'hackinterview-focus-copy-page-bridge' ||
              event.data?.payload?.type !== 'focus-copy-page-bridge-rpc-response' ||
              event.data?.payload?.requestId !== requestId
            ) {
              return;
            }
            clearTimeout(timeout);
            window.removeEventListener('message', onMessage, true);
            resolve(event.data.payload);
          }

          window.addEventListener('message', onMessage, true);
          window.postMessage({
            source: 'hackinterview-focus-copy-content',
            payload: {
              type: 'focus-copy-page-bridge-rpc',
              requestId,
              action: 'read-editor',
            },
          }, '*');
        });
      }

      async function contentReadEditor() {
        const listeners = window.__focusCopyRuntimeOnMessageListeners || [];
        const listener = listeners[listeners.length - 1];
        if (!listener) {
          return { ok: false, error: 'content-listener-missing' };
        }

        const requestId = 'adapter-e2e-content:' + Math.random().toString(16).slice(2);
        return await new Promise((resolve) => {
          const timeout = setTimeout(() => resolve({ ok: false, error: 'content-response-timeout' }), 1000);
          const returned = listener({ type: 'focus-copy-editor-api-read', requestId }, {}, (response) => {
            clearTimeout(timeout);
            resolve(response);
          });
          if (returned !== true) {
            clearTimeout(timeout);
            resolve({ ok: false, error: 'content-listener-did-not-keep-channel-open' });
          }
        });
      }

      function focusCase(item) {
        const element = item.element;
        element.focus?.();
        element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

        const selection = window.getSelection?.();
        selection?.removeAllRanges?.();
        if (element.tagName !== 'INPUT' && element.tagName !== 'TEXTAREA') {
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(true);
          selection?.addRange?.(range);
        } else if (typeof element.setSelectionRange === 'function') {
          try {
            element.setSelectionRange(0, 0);
          } catch {
            // Non-text inputs such as checkbox are valid negative fixtures.
          }
        }
      }

      async function runCase(name, read) {
        const item = cases.get(name);
        if (!item) {
          return { name, ok: false, error: 'unknown-case' };
        }
        focusCase(item);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const result = await read();
        return {
          name,
          ok: result.ok === true && result.text === item.expected,
          expected: item.expected,
          actual: result.text,
          kind: result.kind,
          tagName: result.tagName,
          error: result.error || null,
          expectedLength: item.expected.length,
          actualLength: typeof result.text === 'string' ? result.text.length : null,
        };
      }

      async function runNegativeCase(name, read) {
        const item = cases.get(name);
        if (!item) {
          return { name, ok: false, error: 'unknown-case' };
        }
        focusCase(item);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const result = await read();
        return {
          name,
          ok: result.ok === false,
          actualOk: result.ok,
          actual: result.text,
          kind: result.kind,
          tagName: result.tagName,
          error: result.error || null,
        };
      }

      window.__adapterE2ERun = (name) => runCase(name, rpcReadEditor);
      window.__adapterE2ERunContent = (name) => runCase(name, contentReadEditor);
      window.__adapterE2ERunNegative = (name) => runNegativeCase(name, rpcReadEditor);
      window.__adapterE2ERunContentNegative = (name) => runNegativeCase(name, contentReadEditor);

      return true;
    })()
  `;
}

function contentHarnessSource() {
  return `
    (() => {
      window.__focusCopyRuntimeMessages = [];
      window.__focusCopyRuntimeOnMessageListeners = [];
      globalThis.chrome = {
        runtime: {
          id: 'adapter-e2e',
          sendMessage(message) {
            window.__focusCopyRuntimeMessages.push(message);
            return Promise.resolve({ ok: true });
          },
          onMessage: {
            addListener(listener) {
              window.__focusCopyRuntimeOnMessageListeners.push(listener);
            },
          },
        },
      };
    })();
  `;
}

async function main() {
  const browserBinary = findBrowserBinary();
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'focus-copy-adapter-e2e-'));
  const browserProcess = spawn(browserBinary, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  browserProcess.stderr.on('data', (chunk) => {
    const line = String(chunk).trim();
    if (line && process.env.FOCUS_COPY_E2E_VERBOSE === '1') {
      console.error(line);
    }
  });

  let cdp;
  try {
    const browserWsUrl = await waitForDevToolsPort(userDataDir, browserProcess);
    cdp = await CdpClient.connect(browserWsUrl);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    const pageBridgeSource = await readFile(PAGE_BRIDGE_PATH, 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `${pageBridgeSource}\n//# sourceURL=focus-copy-page-bridge-under-test.js`,
    }, sessionId);

    const html = '<!doctype html><meta charset="utf-8"><title>Focus Copy Adapter E2E</title><main id="fixtures"></main>';
    await cdp.send('Page.navigate', {
      url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    }, sessionId);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const readyState = await evaluate(cdp, sessionId, 'document.readyState');
      if (readyState === 'complete') break;
      await sleep(50);
    }

    await evaluate(cdp, sessionId, fixtureSetupSource());
    await evaluate(cdp, sessionId, contentHarnessSource());
    const contentSource = await readFile(CONTENT_PATH, 'utf8');
    await evaluate(cdp, sessionId, `${contentSource}\n//# sourceURL=focus-copy-content-under-test.js`);

    const failures = [];
    for (const name of TEST_CASES) {
      const result = await evaluate(cdp, sessionId, `window.__adapterE2ERun(${JSON.stringify(name)})`);
      reportResult('page-bridge', result, failures);
    }

    for (const name of TEST_CASES) {
      const result = await evaluate(cdp, sessionId, `window.__adapterE2ERunContent(${JSON.stringify(name)})`);
      reportResult('content-rpc', result, failures);
    }

    for (const name of NEGATIVE_CASES) {
      const result = await evaluate(cdp, sessionId, `window.__adapterE2ERunNegative(${JSON.stringify(name)})`);
      reportResult('page-bridge-negative', result, failures);
    }

    for (const name of NEGATIVE_CASES) {
      const result = await evaluate(cdp, sessionId, `window.__adapterE2ERunContentNegative(${JSON.stringify(name)})`);
      reportResult('content-rpc-negative', result, failures);
    }

    if (failures.length > 0) {
      throw new Error(`${failures.length} adapter e2e case(s) failed`);
    }
  } finally {
    cdp?.close();
    await stopBrowser(browserProcess);
    await rmRetry(userDataDir);
  }
}

function reportResult(layer, result, failures) {
  const status = result.ok ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${layer}:${result.name} kind=${result.kind ?? 'nil'} chars=${result.actualLength ?? 'nil'}`);
  if (!result.ok) {
    failures.push({ layer, ...result });
    if ('expected' in result) {
      if (!result.ok) {
        console.log(`  expected (${result.expectedLength}): ${JSON.stringify(result.expected)}`);
        console.log(`  actual   (${result.actualLength}): ${JSON.stringify(result.actual)}`);
      }
    }
    if (result.error) {
      console.log(`  error: ${result.error}`);
    }
  }
}

main().catch((error) => {
  console.error(`[adapter-e2e] ${error.stack || error.message || error}`);
  process.exit(1);
});

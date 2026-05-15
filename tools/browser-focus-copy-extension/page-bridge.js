(() => {
  const SOURCE = 'hackinterview-focus-copy-page-bridge';
  const BRIDGE_INSTANCE_KEY = '__hackInterviewFocusCopyPageBridgeLoaded';
  const MONACO_TRACKER_KEY = '__hackInterviewFocusCopyMonacoTracker';
  const MONACO_PATCHED_KEY = '__hackInterviewFocusCopyPatched';
  if (globalThis[BRIDGE_INSTANCE_KEY]) {
    return;
  }
  try {
    Object.defineProperty(globalThis, BRIDGE_INSTANCE_KEY, {
      value: true,
      configurable: false,
      enumerable: false,
    });
  } catch {
    globalThis[BRIDGE_INSTANCE_KEY] = true;
  }

  let lastSignature = '';
  let selectionSnapshotSeq = 0;
  const selectionSnapshots = new Map();

  function tagName(element) {
    return element?.tagName ? element.tagName.toLowerCase() : '';
  }

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  function domPlainText(root) {
    const textContent = normalizeText(root?.textContent ?? '');
    const innerText = normalizeText(root?.innerText ?? '');

    if (textContent.includes('\n') && !innerText.includes('\n')) {
      return textContent;
    }

    return innerText || textContent;
  }

  function closestEditor(node) {
    let element = node?.nodeType === Node.ELEMENT_NODE
      ? node
      : node?.parentElement;

    while (element) {
      const editor = element.closest?.([
        'textarea',
        'input',
        '[contenteditable=""]',
        '[contenteditable="true"]',
        '[contenteditable="plaintext-only"]',
        '[role="textbox"]',
        '[role="searchbox"]',
        '.cm-content',
        '.cm-editor',
        '.CodeMirror',
        '.ace_editor',
        '.monaco-editor',
        '.ql-editor',
        '.ProseMirror',
        '[data-slate-editor="true"]',
        '[data-lexical-editor="true"]',
        '.public-DraftEditor-content',
        '.codejar',
      ].join(','));

      if (editor) {
        return editor;
      }

      element = element.parentElement || element.getRootNode()?.host || null;
    }

    return null;
  }

  function activeEditor() {
    const selection = window.getSelection?.();
    if (selection?.anchorNode) {
      const selectedEditor = closestEditor(selection.anchorNode);
      if (selectedEditor) {
        return selectedEditor;
      }
    }

    let active = document.activeElement;
    const seen = new Set();
    while (active && !seen.has(active)) {
      seen.add(active);
      if (active.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
        continue;
      }
      return closestEditor(active);
    }

    return null;
  }

  function ensureMonacoTracker() {
    if (globalThis[MONACO_TRACKER_KEY]) {
      return globalThis[MONACO_TRACKER_KEY];
    }

    const tracker = {
      editors: [],
      diffEditors: [],
      seenEditors: new WeakSet(),
      seenDiffEditors: new WeakSet(),
      lastActiveEditor: null,
    };

    try {
      Object.defineProperty(globalThis, MONACO_TRACKER_KEY, {
        value: tracker,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    } catch {
      globalThis[MONACO_TRACKER_KEY] = tracker;
    }

    return tracker;
  }

  function rememberMonacoEditor(editor) {
    if (!editor || typeof editor.getModel !== 'function') {
      return null;
    }

    const tracker = ensureMonacoTracker();
    if (tracker.seenEditors.has(editor)) {
      return editor;
    }

    tracker.seenEditors.add(editor);
    tracker.editors.push(editor);

    const markActive = () => {
      tracker.lastActiveEditor = editor;
    };

    try {
      editor.onDidFocusEditorText?.(markActive);
      editor.onDidFocusEditorWidget?.(markActive);
      editor.onDidChangeModelContent?.(() => {
        markActive();
        window.setTimeout(() => publish('monaco-model-change'), 0);
      });
      editor.onDidDispose?.(() => {
        tracker.editors = tracker.editors.filter((item) => item !== editor);
        if (tracker.lastActiveEditor === editor) {
          tracker.lastActiveEditor = null;
        }
      });
    } catch {
      // Editor lifecycle hooks are best effort across Monaco builds.
    }

    const container = editor.getContainerDomNode?.();
    if (container?.addEventListener) {
      container.addEventListener('focusin', markActive, true);
      container.addEventListener('pointerdown', markActive, true);
      container.addEventListener('keydown', markActive, true);
    }

    return editor;
  }

  function rememberMonacoDiffEditor(diffEditor) {
    if (!diffEditor || typeof diffEditor.getModifiedEditor !== 'function') {
      return null;
    }

    const tracker = ensureMonacoTracker();
    if (!tracker.seenDiffEditors.has(diffEditor)) {
      tracker.seenDiffEditors.add(diffEditor);
      tracker.diffEditors.push(diffEditor);
    }

    rememberMonacoEditor(diffEditor.getOriginalEditor?.());
    rememberMonacoEditor(diffEditor.getModifiedEditor?.());
    return diffEditor;
  }

  function patchMonacoEditorApi() {
    const editorApi = globalThis.monaco?.editor;
    if (!editorApi || editorApi[MONACO_PATCHED_KEY]) {
      return;
    }

    if (typeof editorApi.create === 'function') {
      const originalCreate = editorApi.create.bind(editorApi);
      editorApi.create = (...args) => rememberMonacoEditor(originalCreate(...args));
    }

    if (typeof editorApi.createDiffEditor === 'function') {
      const originalCreateDiffEditor = editorApi.createDiffEditor.bind(editorApi);
      editorApi.createDiffEditor = (...args) => rememberMonacoDiffEditor(originalCreateDiffEditor(...args));
    }

    try {
      for (const editor of editorApi.getEditors?.() ?? []) {
        rememberMonacoEditor(editor);
      }
      for (const diffEditor of editorApi.getDiffEditors?.() ?? []) {
        rememberMonacoDiffEditor(diffEditor);
      }
    } catch {
      // getEditors/getDiffEditors are not available in every Monaco build.
    }

    try {
      Object.defineProperty(editorApi, MONACO_PATCHED_KEY, {
        value: true,
        configurable: false,
        enumerable: false,
      });
    } catch {
      editorApi[MONACO_PATCHED_KEY] = true;
    }
  }

  function installMonacoGlobalHook() {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'monaco');
    if (descriptor?.configurable === false) {
      patchMonacoEditorApi();
      return;
    }

    let current = globalThis.monaco;
    try {
      Object.defineProperty(globalThis, 'monaco', {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() {
          return descriptor?.get ? descriptor.get.call(globalThis) : current;
        },
        set(value) {
          if (descriptor?.set) {
            descriptor.set.call(globalThis, value);
          } else {
            current = value;
          }
          queueMicrotask(patchMonacoEditorApi);
        },
      });
    } catch {
      // Polling below still covers the common async-loader path.
    }

    patchMonacoEditorApi();
  }

  function monacoEditorsForElement(monacoElement) {
    patchMonacoEditorApi();
    const tracker = ensureMonacoTracker();
    const editors = tracker.editors.filter((editor) => {
      const container = editor?.getContainerDomNode?.();
      return container && (!monacoElement || container === monacoElement || container.contains(monacoElement) || monacoElement.contains(container));
    });

    return editors.filter((editor) => {
      try {
        return !editor.isDisposed?.();
      } catch {
        return true;
      }
    });
  }

  function activeMonacoEditor(monacoElement) {
    const editors = monacoEditorsForElement(monacoElement);
    if (editors.length === 0) {
      return null;
    }

    const tracker = ensureMonacoTracker();
    if (tracker.lastActiveEditor && editors.includes(tracker.lastActiveEditor)) {
      return tracker.lastActiveEditor;
    }

    const focusedEditor = editors.find((editor) => {
      try {
        return editor.hasTextFocus?.() || editor.hasWidgetFocus?.();
      } catch {
        return false;
      }
    });
    return focusedEditor || editors[editors.length - 1];
  }

  function readMonacoEditor(monacoElement) {
    const editor = activeMonacoEditor(monacoElement);
    const model = editor?.getModel?.();
    const editorText = model?.getValue?.() ?? editor?.getValue?.();
    if (typeof editorText === 'string') {
      return {
        kind: 'monaco-api',
        tagName: tagName(monacoElement),
        text: editorText,
      };
    }

    const monacoModels = globalThis.monaco?.editor?.getModels?.();
    if (Array.isArray(monacoModels) && monacoModels.length === 1) {
      const modelText = monacoModels[0]?.getValue?.();
      if (typeof modelText === 'string') {
        return {
          kind: 'monaco-api-single-model',
          tagName: tagName(monacoElement),
          text: modelText,
        };
      }
    }

    return null;
  }

  function codeMirror6Text(editor) {
    let node = editor;
    while (node && node !== document) {
      const view = node.cmView?.view || node.cmView?.rootView?.view;
      const text = view?.state?.doc?.toString?.();
      if (typeof text === 'string') {
        return text;
      }
      node = node.parentElement;
    }

    for (const child of editor.querySelectorAll?.('*') ?? []) {
      const view = child.cmView?.view || child.cmView?.rootView?.view;
      const text = view?.state?.doc?.toString?.();
      if (typeof text === 'string') {
        return text;
      }
    }

    return null;
  }

  function codeMirror6View(editor) {
    let node = editor;
    while (node && node !== document) {
      const view = node.cmView?.view || node.cmView?.rootView?.view;
      if (view?.state?.doc) {
        return view;
      }
      node = node.parentElement;
    }

    for (const child of editor.querySelectorAll?.('*') ?? []) {
      const view = child.cmView?.view || child.cmView?.rootView?.view;
      if (view?.state?.doc) {
        return view;
      }
    }

    return null;
  }

  function snapshotEditorSelection(editor) {
    const codeMirror5 = editor.closest?.('.CodeMirror');
    const codeMirror5Api = codeMirror5?.CodeMirror;
    if (codeMirror5Api && typeof codeMirror5Api.listSelections === 'function') {
      return {
        kind: 'codemirror5',
        selections: codeMirror5Api.listSelections().map((range) => ({
          anchor: range.anchor,
          head: range.head,
        })),
      };
    }

    const codeMirror6 = editor.closest?.('.cm-editor') || editor.closest?.('.cm-content');
    if (codeMirror6) {
      const view = codeMirror6View(codeMirror6);
      const ranges = view?.state?.selection?.ranges;
      if (view && Array.isArray(ranges) && ranges.length > 0) {
        return {
          kind: 'codemirror6',
          ranges: ranges.map((range) => ({
            anchor: range.anchor,
            head: range.head,
          })),
          mainIndex: view.state.selection.mainIndex || 0,
        };
      }
    }

    const ace = editor.closest?.('.ace_editor');
    const aceEditor = ace?.env?.editor;
    if (aceEditor?.selection?.getRange) {
      const range = aceEditor.selection.getRange();
      return {
        kind: 'ace',
        range: {
          start: range.start,
          end: range.end,
        },
      };
    }

    const monaco = editor.closest?.('.monaco-editor');
    const monacoEditor = monaco ? activeMonacoEditor(monaco) : null;
    const monacoSelections = monacoEditor?.getSelections?.();
    if (Array.isArray(monacoSelections) && monacoSelections.length > 0) {
      return {
        kind: 'monaco',
        selections: monacoSelections,
      };
    }

    return null;
  }

  function restoreEditorSelection(editor, snapshot) {
    if (!snapshot) {
      return false;
    }

    if (snapshot.kind === 'codemirror5') {
      const codeMirror5 = editor.closest?.('.CodeMirror');
      const codeMirror5Api = codeMirror5?.CodeMirror;
      if (codeMirror5Api && typeof codeMirror5Api.setSelections === 'function') {
        codeMirror5Api.focus?.();
        codeMirror5Api.setSelections(snapshot.selections);
        return true;
      }
    }

    if (snapshot.kind === 'codemirror6') {
      const codeMirror6 = editor.closest?.('.cm-editor') || editor.closest?.('.cm-content');
      const view = codeMirror6 ? codeMirror6View(codeMirror6) : null;
      const main = snapshot.ranges?.[snapshot.mainIndex || 0] || snapshot.ranges?.[0];
      if (view && main) {
        view.focus?.();
        view.dispatch({
          selection: {
            anchor: main.anchor,
            head: main.head,
          },
          scrollIntoView: false,
        });
        return true;
      }
    }

    if (snapshot.kind === 'ace') {
      const ace = editor.closest?.('.ace_editor');
      const aceEditor = ace?.env?.editor;
      if (aceEditor?.selection?.setSelectionRange && snapshot.range) {
        aceEditor.focus?.();
        aceEditor.selection.setSelectionRange(snapshot.range, false);
        return true;
      }
    }

    if (snapshot.kind === 'monaco') {
      const monaco = editor.closest?.('.monaco-editor');
      const monacoEditor = monaco ? activeMonacoEditor(monaco) : null;
      if (monacoEditor?.setSelections && snapshot.selections) {
        monacoEditor.focus?.();
        monacoEditor.setSelections(snapshot.selections);
        return true;
      }
    }

    return false;
  }

  function readEditor(editor) {
    if (!editor) {
      return null;
    }

    const tag = tagName(editor);
    if (tag === 'textarea') {
      return {
        kind: 'textarea-api',
        tagName: tag,
        text: editor.value ?? '',
      };
    }

    if (tag === 'input') {
      const type = (editor.getAttribute('type') || 'text').toLowerCase();
      const supported = ['', 'email', 'number', 'search', 'tel', 'text', 'url'];
      if (type === 'password' || !supported.includes(type)) {
        return null;
      }
      return {
        kind: `input-${type || 'text'}-api`,
        tagName: tag,
        text: editor.value ?? '',
      };
    }

    const codeMirror5 = editor.closest?.('.CodeMirror');
    const codeMirror5Api = codeMirror5?.CodeMirror;
    if (codeMirror5Api && typeof codeMirror5Api.getValue === 'function') {
      return {
        kind: 'codemirror5-api',
        tagName: tagName(codeMirror5),
        text: codeMirror5Api.getValue(),
      };
    }

    const codeMirror6 = editor.closest?.('.cm-editor') || editor.closest?.('.cm-content');
    if (codeMirror6) {
      const text = codeMirror6Text(codeMirror6);
      if (typeof text === 'string') {
        return {
          kind: 'codemirror6-api',
          tagName: tagName(codeMirror6),
          text,
        };
      }
    }

    const ace = editor.closest?.('.ace_editor');
    const aceEditor = ace?.env?.editor;
    if (aceEditor && typeof aceEditor.getValue === 'function') {
      return {
        kind: 'ace-api',
        tagName: tagName(ace),
        text: aceEditor.getValue(),
      };
    }

    const monaco = editor.closest?.('.monaco-editor');
    if (monaco) {
      const result = readMonacoEditor(monaco);
      if (result) {
        return result;
      }
    }

    const quill = readQuillEditor(editor);
    if (quill) {
      return quill;
    }

    const tinyMce = readTinyMceEditor(editor);
    if (tinyMce) {
      return tinyMce;
    }

    const proseMirror = readProseMirrorEditor(editor);
    if (proseMirror) {
      return proseMirror;
    }

    const richText = readKnownContentEditableEditor(editor);
    if (richText) {
      return richText;
    }

    return null;
  }

  function readQuillEditor(editor) {
    const quillRoot = editor.closest?.('.ql-editor');
    if (!quillRoot) {
      return null;
    }

    try {
      const container = quillRoot.closest?.('.ql-container') || quillRoot;
      const quill = globalThis.Quill?.find?.(container) || globalThis.Quill?.find?.(quillRoot);
      const text = quill?.getText?.();
      if (typeof text === 'string') {
        return {
          kind: 'quill-api',
          tagName: tagName(quillRoot),
          text: text.replace(/\n$/, ''),
        };
      }
    } catch {
      // Quill.find is optional. DOM fallback below still returns visible editor text.
    }

    return {
      kind: 'quill-dom',
      tagName: tagName(quillRoot),
      text: domPlainText(quillRoot),
    };
  }

  function readTinyMceEditor(editor) {
    const active = globalThis.tinymce?.activeEditor;
    if (active && active.initialized !== false) {
      try {
        const body = active.getBody?.();
        if (!body || body === editor || body.contains?.(editor) || editor.contains?.(body)) {
          const text = active.getContent?.({ format: 'text' });
          if (typeof text === 'string') {
            return {
              kind: 'tinymce-api',
              tagName: tagName(editor),
              text,
            };
          }
        }
      } catch {
        // TinyMCE can throw while initializing or across iframe boundaries.
      }
    }

    return null;
  }

  function readProseMirrorEditor(editor) {
    const proseMirror = editor.closest?.('.ProseMirror');
    if (!proseMirror) {
      return null;
    }

    try {
      const view = proseMirror.pmViewDesc?.docView?.view || proseMirror.pmViewDesc?.view;
      const doc = view?.state?.doc;
      const size = doc?.content?.size ?? doc?.nodeSize;
      const text = typeof doc?.textBetween === 'function'
        ? doc.textBetween(0, size, '\n')
        : null;
      if (typeof text === 'string') {
        return {
          kind: 'prosemirror-api',
          tagName: tagName(proseMirror),
          text,
        };
      }
    } catch {
      // Many ProseMirror integrations do not expose the view on DOM nodes.
    }

    return {
      kind: 'prosemirror-dom',
      tagName: tagName(proseMirror),
      text: domPlainText(proseMirror),
    };
  }

  function readKnownContentEditableEditor(editor) {
    const known = [
      ['[data-slate-editor="true"]', 'slate-dom'],
      ['[data-lexical-editor="true"]', 'lexical-dom'],
      ['.public-DraftEditor-content', 'draftjs-dom'],
      ['.codejar', 'codejar-dom'],
    ];

    for (const [selector, kind] of known) {
      const root = editor.matches?.(selector) ? editor : editor.closest?.(selector);
      if (root) {
        return {
          kind,
          tagName: tagName(root),
          text: domPlainText(root),
        };
      }
    }

    if (editor.isContentEditable || editor.getAttribute?.('role')) {
      return {
        kind: editor.isContentEditable ? 'contenteditable-dom' : `role-${editor.getAttribute('role')}-dom`,
        tagName: tagName(editor),
        text: domPlainText(editor),
      };
    }

    return null;
  }

  function publish(reason) {
    const editor = activeEditor();
    const result = readEditor(editor);
    if (!result) {
      return;
    }

    const text = normalizeText(result.text);
    const signature = JSON.stringify([result.kind, location.href, text]);
    if (signature === lastSignature && reason !== 'heartbeat') {
      return;
    }
    lastSignature = signature;

    window.postMessage({
      source: SOURCE,
      payload: {
        type: 'focus-copy-page-editor-snapshot',
        reason,
        url: location.href,
        title: document.title,
        frameUrl: location.href,
        timestampMs: Date.now(),
        text,
        kind: result.kind,
        tagName: result.tagName,
        isPassword: false,
        selectionStart: null,
        selectionEnd: null,
        textLength: text.length,
      },
    }, '*');
  }

  function handleRpc(payload) {
    const requestId = payload?.requestId;
    const action = payload?.action;
    if (!requestId || !action) {
      return;
    }

    const editor = activeEditor();
    let response;

    if (action === 'read-editor') {
      const result = readEditor(editor);
      if (result && typeof result.text === 'string') {
        const text = normalizeText(result.text);
        response = {
          ok: true,
          method: 'page-editor-api',
          url: location.href,
          title: document.title,
          frameUrl: location.href,
          text,
          kind: result.kind,
          tagName: result.tagName,
          textLength: text.length,
        };
      } else {
        response = {
          ok: false,
          error: 'focused-editor-api-unavailable',
        };
      }
    } else if (action === 'snapshot-selection') {
      const snapshot = snapshotEditorSelection(editor);
      if (snapshot) {
        const snapshotId = `selection:${Date.now()}:${++selectionSnapshotSeq}`;
        selectionSnapshots.set(snapshotId, snapshot);
        response = {
          ok: true,
          kind: snapshot.kind,
          snapshotId,
        };
      } else {
        response = {
          ok: false,
          error: 'editor-selection-unsupported',
        };
      }
    } else if (action === 'restore-selection') {
      const latestSnapshotId = Array.from(selectionSnapshots.keys()).pop();
      const snapshot = latestSnapshotId ? selectionSnapshots.get(latestSnapshotId) : null;
      const ok = restoreEditorSelection(editor, snapshot);
      response = {
        ok,
        kind: snapshot?.kind || null,
        error: ok ? null : 'editor-selection-restore-failed',
      };
    } else {
      response = {
        ok: false,
        error: 'unknown-action',
      };
    }

    window.postMessage({
      source: SOURCE,
      payload: {
        type: 'focus-copy-page-bridge-rpc-response',
        requestId,
        ...response,
      },
    }, '*');
  }

  installMonacoGlobalHook();
  setInterval(patchMonacoEditorApi, 250);
  document.addEventListener('focusin', () => publish('focusin'), true);
  document.addEventListener('input', () => publish('input'), true);
  document.addEventListener('keyup', () => publish('keyup'), true);
  document.addEventListener('mouseup', () => publish('mouseup'), true);
  document.addEventListener('selectionchange', () => publish('selectionchange'), true);
  window.addEventListener('pageshow', () => publish('pageshow'), true);
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'hackinterview-focus-copy-content') {
      return;
    }
    if (event.data?.payload?.type === 'focus-copy-page-bridge-rpc') {
      handleRpc(event.data.payload);
    }
  }, true);
  setInterval(() => publish('heartbeat'), 750);
})();

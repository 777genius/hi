(() => {
const CONTENT_INSTANCE_KEY = '__hackInterviewFocusCopyContentLoaded';
if (globalThis[CONTENT_INSTANCE_KEY]) {
  try {
    chrome.runtime?.sendMessage?.({ type: 'focus-copy-content-already-loaded' })?.catch?.(() => {});
  } catch {
    // The old extension context can be invalidated during reload.
  }
  return;
}
try {
  Object.defineProperty(globalThis, CONTENT_INSTANCE_KEY, {
    value: true,
    configurable: false,
    enumerable: false,
  });
} catch {
  globalThis[CONTENT_INSTANCE_KEY] = true;
}

const INPUT_TEXT_TYPES = new Set([
  '',
  'email',
  'number',
  'search',
  'tel',
  'text',
  'url',
]);

let lastSignature = '';
let lastFocusedEditable = null;
let lastPageEditorSnapshotAt = 0;
let lastSelectionSnapshot = null;
let pageBridgeRequestSeq = 0;
let extensionContextValid = true;
let heartbeatTimer = null;

function isExtensionInvalidatedError(error) {
  return String(error?.message || error || '').includes('Extension context invalidated');
}

function markExtensionContextInvalid() {
  extensionContextValid = false;
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function canUseExtensionRuntime() {
  return extensionContextValid
    && typeof chrome !== 'undefined'
    && !!chrome.runtime?.id
    && typeof chrome.runtime.sendMessage === 'function';
}

function sendRuntimeMessage(message) {
  if (!canUseExtensionRuntime()) {
    return Promise.resolve(false);
  }

  try {
    const result = chrome.runtime.sendMessage(message);
    if (!result || typeof result.then !== 'function') {
      return Promise.resolve(true);
    }
    return result.then(() => true)
      .catch((error) => {
        if (isExtensionInvalidatedError(error)) {
          markExtensionContextInvalid();
        }
        return false;
      });
  } catch (error) {
    if (isExtensionInvalidatedError(error)) {
      markExtensionContextInvalid();
      return Promise.resolve(false);
    }
    throw error;
  }
}

function tagName(element) {
  return element?.tagName ? element.tagName.toLowerCase() : '';
}

function isEditableElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }

  const tag = tagName(element);
  if (tag === 'textarea') {
    return true;
  }

  if (tag === 'input') {
    return true;
  }

  if (element.isContentEditable) {
    return true;
  }

  const role = (element.getAttribute('role') || '').toLowerCase();
  return role === 'textbox' || role === 'searchbox';
}

function deepActiveElement(root = document) {
  let active = root.activeElement;
  const seen = new Set();

  while (active && !seen.has(active)) {
    seen.add(active);
    if (active.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
      continue;
    }
    break;
  }

  return active;
}

function closestEditable(node) {
  let element = node?.nodeType === Node.ELEMENT_NODE
    ? node
    : node?.parentElement;

  while (element) {
    if (isEditableElement(element)) {
      return element;
    }

    const closest = element.closest?.([
      'textarea',
      'input',
      '[contenteditable=""]',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]',
      '[role="textbox"]',
      '[role="searchbox"]',
      '.cm-content',
      '.CodeMirror',
      '.ace_editor',
      '.monaco-editor',
    ].join(','));

    if (closest) {
      return closest;
    }

    element = element.parentElement || element.getRootNode()?.host || null;
  }

  return null;
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function pageBridgeRequest(action) {
  const requestId = `focus-copy:${Date.now()}:${++pageBridgeRequestSeq}`;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage, true);
      resolve(null);
    }, 80);

    function onMessage(event) {
      if (
        event.source !== window ||
        event.data?.source !== 'hackinterview-focus-copy-page-bridge' ||
        event.data?.payload?.type !== 'focus-copy-page-bridge-rpc-response' ||
        event.data?.payload?.requestId !== requestId
      ) {
        return;
      }

      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage, true);
      resolve(event.data.payload);
    }

    window.addEventListener('message', onMessage, true);
    window.postMessage({
      source: 'hackinterview-focus-copy-content',
      payload: {
        type: 'focus-copy-page-bridge-rpc',
        requestId,
        action,
      },
    }, '*');
  });
}

async function snapshotFocusedSelection(requestId) {
  const pageSnapshot = await pageBridgeRequest('snapshot-selection');
  if (pageSnapshot?.ok && pageSnapshot.snapshotId) {
    lastSelectionSnapshot = {
      requestId,
      kind: 'page-bridge',
      snapshotId: pageSnapshot.snapshotId,
    };
    return {
      ok: true,
      kind: pageSnapshot.kind || 'page-bridge',
      frameId: null,
    };
  }

  const active = deepActiveElement();
  const selection = window.getSelection?.();
  const selectedEditable = selection?.anchorNode ? closestEditable(selection.anchorNode) : null;
  const editable = selectedEditable || closestEditable(active);
  const tag = tagName(editable);

  if (tag === 'input' || tag === 'textarea') {
    lastSelectionSnapshot = {
      requestId,
      kind: 'text-control',
      element: editable,
      selectionStart: Number.isInteger(editable.selectionStart) ? editable.selectionStart : null,
      selectionEnd: Number.isInteger(editable.selectionEnd) ? editable.selectionEnd : null,
      selectionDirection: editable.selectionDirection || 'none',
    };
    return { ok: true, kind: lastSelectionSnapshot.kind, frameId: null };
  }

  if (selection?.rangeCount > 0) {
    lastSelectionSnapshot = {
      requestId,
      kind: 'dom-range',
      range: selection.getRangeAt(0).cloneRange(),
    };
    return { ok: true, kind: lastSelectionSnapshot.kind, frameId: null };
  }

  lastSelectionSnapshot = null;
  return { ok: false, error: 'no-selection-snapshot' };
}

async function restoreFocusedSelection(requestId) {
  const snapshot = lastSelectionSnapshot;
  if (!snapshot || snapshot.requestId !== requestId) {
    return { ok: false, error: 'snapshot-not-found' };
  }

  if (snapshot.kind === 'page-bridge') {
    const result = await pageBridgeRequest('restore-selection');
    return result?.ok ? { ok: true, kind: result.kind || snapshot.kind } : { ok: false, error: result?.error || 'page-bridge-restore-failed' };
  }

  if (snapshot.kind === 'text-control' && snapshot.element?.isConnected) {
    if (!Number.isInteger(snapshot.selectionStart) || !Number.isInteger(snapshot.selectionEnd)) {
      return { ok: false, error: 'text-control-selection-missing' };
    }
    try {
      snapshot.element.focus({ preventScroll: true });
      snapshot.element.setSelectionRange(
        snapshot.selectionStart,
        snapshot.selectionEnd,
        snapshot.selectionDirection
      );
      return { ok: true, kind: snapshot.kind };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (snapshot.kind === 'dom-range' && snapshot.range) {
    const selection = window.getSelection?.();
    if (!selection) {
      return { ok: false, error: 'selection-api-missing' };
    }
    selection.removeAllRanges();
    selection.addRange(snapshot.range);
    return { ok: true, kind: snapshot.kind };
  }

  return { ok: false, error: 'unsupported-snapshot' };
}

function cleanEditorLine(value) {
  return normalizeText(value).replace(/\n/g, '');
}

function collectLineText(root, selector) {
  const lines = Array.from(root.querySelectorAll?.(selector) ?? []);
  if (lines.length === 0) {
    return null;
  }

  return lines
    .map((line) => cleanEditorLine(line.textContent ?? ''))
    .join('\n');
}

function collectCodeMirror6Text(codeMirrorContent) {
  const directLines = Array.from(codeMirrorContent.children)
    .filter((child) => child.classList?.contains('cm-line'));

  if (directLines.length > 0) {
    return directLines
      .map((line) => cleanEditorLine(line.textContent ?? ''))
      .join('\n');
  }

  return collectLineText(codeMirrorContent, '.cm-line');
}

function textFromDomEditor(element) {
  const codeMirrorContent = element.closest?.('.cm-content');
  if (codeMirrorContent) {
    const text = collectCodeMirror6Text(codeMirrorContent);
    if (text !== null) {
      return {
        kind: 'codemirror6-dom-lines',
        text,
      };
    }

    return {
      kind: 'codemirror6-dom',
      text: codeMirrorContent.innerText ?? codeMirrorContent.textContent ?? '',
    };
  }

  const codeMirror5 = element.closest?.('.CodeMirror');
  if (codeMirror5) {
    const text = collectLineText(
      codeMirror5,
      '.CodeMirror-code pre.CodeMirror-line, .CodeMirror-code pre.CodeMirror-line-like, .CodeMirror-code div.CodeMirror-line'
    );
    if (text !== null) {
      return {
        kind: 'codemirror5-dom-lines',
        text,
      };
    }

    return {
      kind: 'codemirror5-dom',
      text: codeMirror5.innerText ?? codeMirror5.textContent ?? '',
    };
  }

  const ace = element.closest?.('.ace_editor');
  if (ace) {
    const text = collectLineText(ace, '.ace_text-layer .ace_line');
    if (text !== null) {
      return {
        kind: 'ace-dom-lines',
        text,
      };
    }

    return {
      kind: 'ace-dom',
      text: ace.innerText ?? ace.textContent ?? '',
    };
  }

  const monaco = element.closest?.('.monaco-editor');
  if (monaco) {
    return null;
  }

  return null;
}

function readEditable(element) {
  if (!element) {
    return null;
  }

  const tag = tagName(element);

  if (tag === 'input') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (type === 'password') {
      return {
        text: null,
        kind: 'password',
        tagName: tag,
        isPassword: true,
        selectionStart: null,
        selectionEnd: null,
        textLength: null,
      };
    }

    if (!INPUT_TEXT_TYPES.has(type)) {
      return null;
    }

    const text = normalizeText(element.value);
    return {
      text,
      kind: `input:${type || 'text'}`,
      tagName: tag,
      isPassword: false,
      selectionStart: Number.isInteger(element.selectionStart) ? element.selectionStart : null,
      selectionEnd: Number.isInteger(element.selectionEnd) ? element.selectionEnd : null,
      textLength: text.length,
    };
  }

  if (tag === 'textarea') {
    const text = normalizeText(element.value);
    return {
      text,
      kind: 'textarea',
      tagName: tag,
      isPassword: false,
      selectionStart: Number.isInteger(element.selectionStart) ? element.selectionStart : null,
      selectionEnd: Number.isInteger(element.selectionEnd) ? element.selectionEnd : null,
      textLength: text.length,
    };
  }

  const editorText = textFromDomEditor(element);
  if (editorText) {
    const text = normalizeText(editorText.text);
    return {
      text,
      kind: editorText.kind,
      tagName: tag,
      isPassword: false,
      selectionStart: null,
      selectionEnd: null,
      textLength: text.length,
    };
  }

  if (element.closest?.('.monaco-editor')) {
    return null;
  }

  if (element.isContentEditable || element.getAttribute('role')) {
    const text = normalizeText(element.innerText ?? element.textContent ?? '');
    return {
      text,
      kind: element.isContentEditable ? 'contenteditable' : `role:${element.getAttribute('role')}`,
      tagName: tag,
      isPassword: false,
      selectionStart: null,
      selectionEnd: null,
      textLength: text.length,
    };
  }

  return null;
}

function currentEditablePayload(reason) {
  const active = deepActiveElement();
  const selection = window.getSelection?.();
  const selectedEditable = selection?.anchorNode ? closestEditable(selection.anchorNode) : null;
  const editable = selectedEditable || closestEditable(active);
  const data = readEditable(editable);

  if (!data) {
    return null;
  }

  lastFocusedEditable = editable;
  return {
    type: 'focus-copy-cache-update',
    reason,
    url: location.href,
    title: document.title,
    frameUrl: location.href,
    timestampMs: Date.now(),
    ...data,
  };
}

function publishPageEditorSnapshot(payload) {
  if (!payload || payload.type !== 'focus-copy-page-editor-snapshot') {
    return;
  }

  lastPageEditorSnapshotAt = Date.now();
  const text = normalizeText(payload.text);
  sendRuntimeMessage({
    type: 'focus-copy-cache-update',
    reason: payload.reason,
    url: payload.url || location.href,
    title: payload.title || document.title,
    frameUrl: payload.frameUrl || location.href,
    timestampMs: payload.timestampMs || Date.now(),
    text,
    kind: payload.kind || 'page-editor-api',
    tagName: payload.tagName || null,
    isPassword: false,
    selectionStart: null,
    selectionEnd: null,
    textLength: text.length,
  });
}

function publish(reason, { force = false } = {}) {
  if (!document.hasFocus()) {
    return;
  }

  const payload = currentEditablePayload(reason);
  if (!payload) {
    return;
  }

  if (payload.kind?.endsWith('-dom-lines') && Date.now() - lastPageEditorSnapshotAt < 1000) {
    return;
  }

  const signature = JSON.stringify([
    payload.url,
    payload.frameUrl,
    payload.kind,
    payload.tagName,
    payload.isPassword,
    payload.text,
    payload.selectionStart,
    payload.selectionEnd,
  ]);

  if (!force && signature === lastSignature && reason !== 'heartbeat') {
    return;
  }

  lastSignature = signature;
  sendRuntimeMessage(payload);
}

function clearCache(reason) {
  if (!lastFocusedEditable) {
    return;
  }

  lastFocusedEditable = null;
  lastSignature = '';
  sendRuntimeMessage({
    type: 'focus-copy-cache-update',
    reason,
    url: location.href,
    title: document.title,
    frameUrl: location.href,
    text: null,
    kind: 'blur',
    tagName: null,
    isPassword: false,
    selectionStart: null,
    selectionEnd: null,
    textLength: null,
    timestampMs: Date.now(),
  });
}

document.addEventListener('focusin', () => publish('focusin', { force: true }), true);
document.addEventListener('input', () => publish('input', { force: true }), true);
document.addEventListener('keyup', () => publish('keyup'), true);
document.addEventListener('mouseup', () => publish('mouseup'), true);
document.addEventListener('selectionchange', () => publish('selectionchange'), true);
window.addEventListener('pageshow', () => publish('pageshow', { force: true }), true);
window.addEventListener('blur', () => clearCache('window-blur'), true);
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!closestEditable(deepActiveElement())) {
      clearCache('focusout');
    }
  }, 0);
}, true);

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'hackinterview-focus-copy-page-bridge') {
    return;
  }
  publishPageEditorSnapshot(event.data.payload);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'focus-copy-ping') {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'focus-copy-selection-snapshot') {
    snapshotFocusedSelection(message.requestId).then(sendResponse);
    return true;
  }

  if (message?.type === 'focus-copy-selection-restore') {
    restoreFocusedSelection(message.requestId).then(sendResponse);
    return true;
  }

  return false;
});

heartbeatTimer = window.setInterval(() => publish('heartbeat', { force: true }), 750);
})();

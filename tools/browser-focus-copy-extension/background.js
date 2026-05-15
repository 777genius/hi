const HOST_NAME = 'ai.hackinterview.focus_copy_browser_cache';
const SOURCE = 'hackinterview-browser-extension';
const CDP_PROTOCOL_VERSION = '1.3';
const MAC_COMMAND_MODIFIER = 4;
const EDITING_COMMAND_BY_KEY = {
  a: 'selectAll',
  c: 'Copy',
};

let nativePort = null;
let reconnectTimer = null;
let lastDisconnectAt = 0;
let latestFocus = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectNativeHost() {
  if (nativePort) {
    return nativePort;
  }

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    console.warn('[focus-copy] native host connect failed', error);
    scheduleReconnect();
    return null;
  }

  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    lastDisconnectAt = Date.now();
    nativePort = null;
    if (error) {
      console.warn('[focus-copy] native host disconnected', error);
    }
    scheduleReconnect();
  });

  nativePort.onMessage.addListener((message) => {
    if (message?.type === 'focus-copy-cdp-request') {
      void handleCdpCopyRequest(message);
      return;
    }

    if (message?.type === 'focus-copy-editor-api-request') {
      void handleEditorApiCopyRequest(message);
      return;
    }

    if (message && message.ok === false) {
      console.warn('[focus-copy] native host rejected message', message.error);
    }
  });

  nativePort.postMessage({
    type: 'focus-copy-extension-ready',
    source: SOURCE,
    supportsCdp: true,
  });
  void ensureActiveTabContentScripts();

  return nativePort;
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, 1000);
}

function postToNativeHost(message) {
  const port = connectNativeHost();
  if (!port) {
    return;
  }

  try {
    port.postMessage({
      ...message,
      source: SOURCE,
    });
  } catch (error) {
    console.warn('[focus-copy] native host post failed', error);
    nativePort = null;
    scheduleReconnect();
  }
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs?.[0] ?? null);
    });
  });
}

function sendFrameMessage(tabId, frameId, message) {
  return new Promise((resolve) => {
    const options = Number.isInteger(frameId) ? { frameId } : undefined;
    chrome.tabs.sendMessage(tabId, message, options, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve(null);
        return;
      }
      resolve(response ?? null);
    });
  });
}

function executeScript(tabId, files, world) {
  return new Promise((resolve) => {
    const details = {
      target: { tabId, allFrames: true },
      files,
    };
    if (world) {
      details.world = world;
    }

    chrome.scripting.executeScript(details, () => {
      const error = chrome.runtime.lastError;
      resolve(!error);
    });
  });
}

function isInjectableTabUrl(url) {
  return typeof url === 'string' && /^(https?|file):/i.test(url);
}

async function ensureContentScriptsForTab(tab) {
  if (!tab?.id || !isInjectableTabUrl(tab.url)) {
    return false;
  }

  const ping = await sendFrameMessage(tab.id, null, { type: 'focus-copy-ping' });
  if (ping?.ok) {
    return true;
  }

  await executeScript(tab.id, ['page-bridge.js'], 'MAIN');
  return executeScript(tab.id, ['content.js']);
}

async function ensureActiveTabContentScripts() {
  try {
    const tab = await queryActiveTab();
    await ensureContentScriptsForTab(tab);
  } catch {
    // Best effort only. Manifest content scripts still handle normal page loads.
  }
}

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, CDP_PROTOCOL_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      resolve();
    });
  });
}

function sendCdpCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result ?? null);
    });
  });
}

async function dispatchCommandShortcut(target, letter) {
  const upper = letter.toUpperCase();
  const lower = letter.toLowerCase();
  const keyCode = upper.charCodeAt(0);
  const common = {
    key: lower,
    code: `Key${upper}`,
    windowsVirtualKeyCode: keyCode,
    modifiers: MAC_COMMAND_MODIFIER,
  };
  const editingCommand = EDITING_COMMAND_BY_KEY[lower];

  await sendCdpCommand(target, 'Input.dispatchKeyEvent', {
    ...common,
    type: 'rawKeyDown',
    commands: editingCommand ? [editingCommand] : undefined,
  });
  await sendCdpCommand(target, 'Input.dispatchKeyEvent', {
    ...common,
    type: 'keyUp',
  });
}

function activeFrameIdForTab(tabId) {
  if (!latestFocus || latestFocus.tabId !== tabId) {
    return null;
  }
  if (Date.now() - latestFocus.updatedAt > 5000) {
    return null;
  }
  return Number.isInteger(latestFocus.frameId) ? latestFocus.frameId : null;
}

async function handleCdpCopyRequest(message) {
  const startedAt = Date.now();
  const requestId = String(message.requestId ?? '');
  if (!requestId) {
    return;
  }

  let target = null;
  let restoreSnapshot = null;
  let restored = false;
  let tab = null;

  try {
    tab = await queryActiveTab();
    if (!tab?.id) {
      throw new Error('active-tab-not-found');
    }

    const frameId = activeFrameIdForTab(tab.id);
    restoreSnapshot = await sendFrameMessage(tab.id, frameId, {
      type: 'focus-copy-selection-snapshot',
      requestId,
    });

    target = { tabId: tab.id };
    await debuggerAttach(target);
    await dispatchCommandShortcut(target, 'a');
    await sleep(8);
    await dispatchCommandShortcut(target, 'c');
    await sleep(16);
  } catch (error) {
    postToNativeHost({
      type: 'focus-copy-cdp-response',
      requestId,
      ok: false,
      method: 'cdp-keyboard',
      restored,
      error: error instanceof Error ? error.message : String(error),
      url: tab?.url ?? latestFocus?.url ?? null,
      elapsedMs: Date.now() - startedAt,
    });
    if (target) {
      await debuggerDetach(target);
    }
    return;
  }

  if (target) {
    await debuggerDetach(target);
  }

  try {
    if (tab?.id && restoreSnapshot?.ok) {
      const restoreResult = await sendFrameMessage(tab.id, restoreSnapshot.frameId ?? activeFrameIdForTab(tab.id), {
        type: 'focus-copy-selection-restore',
        requestId,
      });
      restored = !!restoreResult?.ok;
    }
  } catch {
    restored = false;
  }

  postToNativeHost({
    type: 'focus-copy-cdp-response',
    requestId,
    ok: true,
    method: 'cdp-keyboard',
    restored,
    error: null,
    url: tab?.url ?? latestFocus?.url ?? null,
    elapsedMs: Date.now() - startedAt,
  });
}

async function handleEditorApiCopyRequest(message) {
  const startedAt = Date.now();
  const requestId = String(message.requestId ?? '');
  if (!requestId) {
    return;
  }

  let tab = null;

  try {
    tab = await queryActiveTab();
    if (!tab?.id) {
      throw new Error('active-tab-not-found');
    }

    const scriptsReady = await ensureContentScriptsForTab(tab);
    if (!scriptsReady) {
      throw new Error('content-scripts-unavailable');
    }

    const frameId = activeFrameIdForTab(tab.id);
    const response = await sendFrameMessage(tab.id, frameId, {
      type: 'focus-copy-editor-api-read',
      requestId,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'editor-api-read-failed');
    }

    postToNativeHost({
      type: 'focus-copy-editor-api-response',
      requestId,
      ok: true,
      method: response.method || 'editor-api',
      restored: true,
      error: null,
      url: response.url || tab.url || latestFocus?.url || null,
      title: response.title || tab.title || null,
      frameUrl: response.frameUrl || response.url || tab.url || null,
      text: response.text ?? '',
      kind: response.kind || 'editor-api',
      tagName: response.tagName || null,
      textLength: Number.isInteger(response.textLength) ? response.textLength : String(response.text ?? '').length,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    postToNativeHost({
      type: 'focus-copy-editor-api-response',
      requestId,
      ok: false,
      method: 'editor-api',
      restored: false,
      error: error instanceof Error ? error.message : String(error),
      url: tab?.url ?? latestFocus?.url ?? null,
      title: tab?.title ?? null,
      frameUrl: latestFocus?.url ?? tab?.url ?? null,
      text: null,
      kind: null,
      tagName: null,
      textLength: null,
      elapsedMs: Date.now() - startedAt,
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  connectNativeHost();
  void ensureActiveTabContentScripts();
});

chrome.runtime.onStartup.addListener(() => {
  connectNativeHost();
  void ensureActiveTabContentScripts();
});

chrome.tabs.onActivated.addListener(() => {
  void ensureActiveTabContentScripts();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  void ensureActiveTabContentScripts();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== 'focus-copy-cache-update') {
    return false;
  }

  latestFocus = {
    tabId: sender.tab?.id ?? null,
    frameId: sender.frameId ?? null,
    documentId: sender.documentId ?? null,
    url: message.url ?? sender.tab?.url ?? null,
    updatedAt: Date.now(),
  };

  postToNativeHost({
    ...message,
    tabId: sender.tab?.id ?? null,
    frameId: sender.frameId ?? null,
    documentId: sender.documentId ?? null,
    extensionLastDisconnectAt: lastDisconnectAt,
  });
  return false;
});

connectNativeHost();

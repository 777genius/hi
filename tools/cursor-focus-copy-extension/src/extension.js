const vscode = require('vscode');
const {
  BackendHttpError,
  CompanionTokenNotFoundError,
  DEFAULT_BACKEND_URL,
  DEFAULT_TIMEOUT_MS,
  captureAndSendActiveEditor,
} = require('./client');

function readConfiguration() {
  const config = vscode.workspace.getConfiguration('clipboardTools');

  return {
    backendUrl: config.get('backendUrl', DEFAULT_BACKEND_URL),
    companionToken: config.get('accessToken', ''),
    autoDiscoverToken: config.get('autoDiscoverToken', true),
    copyToClipboard: config.get('copyToClipboard', true),
    requestTimeoutMs: config.get('requestTimeoutMs', DEFAULT_TIMEOUT_MS),
    debugNotifications: config.get('debugNotifications', false),
  };
}

function describeError(error) {
  if (error instanceof BackendHttpError) {
    const detail = error.responseText ? `: ${error.responseText}` : '';
    return `HTTP ${error.statusCode}${detail}`;
  }

  if (error instanceof CompanionTokenNotFoundError) {
    const paths = error.searchedPaths?.length
      ? ` searched=${error.searchedPaths.join(', ')}`
      : '';
    return `${error.message}${paths}`;
  }

  return error instanceof Error ? error.message : String(error);
}

function showDebugNotification(options, message) {
  if (options.debugNotifications) {
    vscode.window.showWarningMessage(message);
  }
}

async function sendActiveFile(context, output) {
  const editor = vscode.window.activeTextEditor;
  const options = readConfiguration();
  if (!editor) {
    output.appendLine('[clipboard] skipped active editor not found');
    showDebugNotification(options, 'Active editor not found');
    return;
  }

  const startedAt = Date.now();

  try {
    const result = await captureAndSendActiveEditor({
      editor,
      clipboard: vscode.env.clipboard,
      appName: vscode.env.appName || 'Cursor',
      extensionVersion: context.extension.packageJSON.version,
      backendUrl: options.backendUrl,
      companionToken: options.companionToken,
      autoDiscoverToken: options.autoDiscoverToken,
      copyToClipboard: options.copyToClipboard,
      requestTimeoutMs: options.requestTimeoutMs,
    });

    const elapsedMs = Date.now() - startedAt;
    output.appendLine(
      `[clipboard] sent chars=${result.payload.characterCount} tokenSource=${result.tokenSource || 'unknown'} file=${result.payload.filePath || result.payload.url || 'unknown'} elapsedMs=${elapsedMs}`
    );
  } catch (error) {
    const message = describeError(error);
    output.appendLine(`[clipboard] failed ${message}`);
    showDebugNotification(options, `Failed to send active file - ${message}`);
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Clipboard Tools');
  const command = vscode.commands.registerCommand(
    'clipboardTools.copyActiveFile',
    () => sendActiveFile(context, output)
  );

  context.subscriptions.push(command, output);
  output.appendLine('[clipboard] extension activated');
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};

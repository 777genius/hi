import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const extensionRoot = path.resolve(path.dirname(scriptPath), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
const cursorExtensionsDir = path.join(os.homedir(), '.cursor', 'extensions');
const legacyExtensionId = String.fromCharCode(
  104, 97, 99, 107, 105, 110, 116, 101, 114, 118, 105, 101, 119
) + '.focus-copy-cursor';
const staleExtensionIds = [legacyExtensionId, 'focuscopy.focus-copy-cursor'];
const targetPath = path.join(
  cursorExtensionsDir,
  `${packageJson.publisher}.${packageJson.name}-${packageJson.version}`
);
const vsixPath = path.join(extensionRoot, `${packageJson.name}-${packageJson.version}.vsix`);

fs.mkdirSync(cursorExtensionsDir, { recursive: true });
fs.rmSync(targetPath, { recursive: true, force: true });
for (const entry of fs.readdirSync(cursorExtensionsDir)) {
  if (
    entry.startsWith(`${packageJson.publisher}.${packageJson.name}-`) ||
    staleExtensionIds.some((extensionId) => entry.startsWith(`${extensionId}-`))
  ) {
    fs.rmSync(path.join(cursorExtensionsDir, entry), { recursive: true, force: true });
  }
}

console.log('Packaging Cursor extension with @vscode/vsce@3.9.1...');
execFileSync(
  'pnpm',
  ['dlx', '@vscode/vsce@3.9.1', 'package', '--allow-missing-repository', '--out', vsixPath],
  {
    cwd: extensionRoot,
    stdio: 'inherit',
  }
);

console.log(`Installing Cursor extension VSIX: ${vsixPath}`);
for (const extensionId of staleExtensionIds) {
  try {
    execFileSync('cursor', ['--uninstall-extension', extensionId], {
      stdio: 'inherit',
    });
  } catch (_uninstallError) {
    // Ignore missing stale extension ids.
  }
}

try {
  execFileSync('cursor', ['--install-extension', vsixPath, '--force'], {
    stdio: 'inherit',
  });
} catch (error) {
  console.warn('Direct reinstall failed. Trying uninstall/install fallback...');
  for (const extensionId of [`${packageJson.publisher}.${packageJson.name}`, ...staleExtensionIds]) {
    try {
      execFileSync('cursor', ['--uninstall-extension', extensionId], {
        stdio: 'inherit',
      });
    } catch (_uninstallError) {
      // Ignore missing extension ids.
    }
  }
  execFileSync('cursor', ['--install-extension', vsixPath, '--force'], {
    stdio: 'inherit',
  });
}

try {
  const list = execFileSync('cursor', ['--list-extensions', '--show-versions'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const extensionId = `${packageJson.publisher}.${packageJson.name}`;
  const installed = list
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith(`${extensionId}@`));
  console.log(installed ? `Cursor reports ${extensionId} installed.` : 'Cursor list did not report the extension yet. Restart Cursor if it is open.');
} catch (error) {
  console.warn(`Could not verify with cursor --list-extensions: ${error.message}`);
}

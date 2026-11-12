import { spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * Tauri WebDriver e2e:
 * - На macOS используем встроенный WebDriver сервер в debug сборке.
 * - На Linux/Windows — существующий tauri-driver.
 */

const args = ['wdio', 'run', 'e2e-tests/wdio.conf.mjs'];
if (process.platform === 'darwin' && process.env.E2E_ALL_SPECS !== '1') {
  args.push('--spec', 'e2e-tests/specs/desktopSmoke.e2e.mjs');
}
const result = spawnSync('pnpm', args, {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    // Включаем e2e hooks и упрощаем авторизацию в debug режиме.
    VITE_E2E: '1',
    VOICETEXT_E2E: '1',
  },
});

process.exit(result.status ?? 1);


import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
// Отдельный порт: не пересекается с dev-сервером приложения (1425) и companion-сервером desktop.
const port = Number(process.env.COMPANION_UI_PORT || 1491);
const baseURL = `http://127.0.0.1:${port}`;
const artifacts = `${repoRoot}.e2e-artifacts/companion-ui`;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: `${artifacts}/results`,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `${artifacts}/report` }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ru-RU',
    colorScheme: 'dark',
  },
  webServer: {
    command: `node_modules/.bin/vite --config e2e-tests/companion-ui/vite.config.ts --port ${port} --strictPort`,
    cwd: repoRoot,
    url: `${baseURL}/companion.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    {
      // Android Chrome: телефон 390x844.
      name: 'phone-android',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 },
        screen: { width: 390, height: 844 },
      },
    },
    {
      // iPhone 13 на движке WebKit, ближе всего к iOS Safari. 390x844 как у PWA без панелей браузера.
      name: 'phone-ios',
      use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } },
    },
    {
      // Планшет 820x1180 (iPad Air) с мобильной эмуляцией.
      name: 'tablet',
      use: {
        ...devices['iPad (gen 7)'],
        viewport: { width: 820, height: 1180 },
        screen: { width: 820, height: 1180 },
      },
    },
  ],
});

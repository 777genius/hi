import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// держим ссылку на tauri-driver процесс
let tauriDriver;
let exit = false;

function resolveAppBinaryPath() {
  if (process.env.TAURI_E2E_APP_PATH) return path.resolve(process.env.TAURI_E2E_APP_PATH);
  const base = path.resolve(__dirname, '../src-tauri/target/debug');
  // На Windows бинарь с .exe
  if (process.platform === 'win32') {
    return path.resolve(base, 'Telegram.exe');
  }
  return path.resolve(base, 'Telegram');
}

export const config = {
  hostname: '127.0.0.1',
  port: process.platform === 'darwin' ? 4445 : 4444,
  // undici 6 + Node 26 rejects the manually supplied Content-Length on POST.
  // The HTTP client computes it correctly when omitted.
  transformRequest: (request) => {
    request.headers?.delete('content-length');
    return request;
  },

  services: process.platform === 'darwin'
    ? [['tauri', {
      appBinaryPath: resolveAppBinaryPath(),
      driverProvider: 'embedded',
      embeddedPort: 4445,
      startTimeout: 90_000,
      windowLabel: 'main',
    }]]
    : [],

  specs: [path.resolve(__dirname, './specs/**/*.e2e.mjs')],

  maxInstances: 1,
  capabilities: [
    {
      // browserName нужен встроенному драйверу на macOS; tauri-driver на Linux/Windows с ним отклоняет сессию.
      ...(process.platform === 'darwin' ? { browserName: 'tauri' } : {}),
      maxInstances: 1,
      'tauri:options': {
        application: resolveAppBinaryPath(),
      },
    },
  ],

  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 120000,
  },

  onPrepare: () => {
    if (process.env.E2E_SKIP_BUILD === '1') return;
    // Собираем debug бинарь без бандла, чтобы путь был стабильным.
    const buildArgs = ['tauri', 'build', '--debug', '--no-bundle', '--ci'];
    if (process.platform === 'darwin') {
      buildArgs.push('--features', 'wdio', '--config', 'src-tauri/tauri.wdio.conf.json');
    }
    const res = spawnSync('pnpm', buildArgs, {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        VITE_E2E: '1',
        VOICETEXT_E2E: '1',
      },
    });
    if ((res.status ?? 1) !== 0) {
      throw new Error(`[e2e] failed to build tauri app (exit=${res.status})`);
    }
  },

  beforeSession: () => {
    if (process.platform === 'darwin') return;
    // Запускаем tauri-driver, который проксирует WebDriver запросы в нативный драйвер (WebKitWebDriver на Linux).
    const driverBin =
      process.env.TAURI_DRIVER_PATH ??
      path.resolve(os.homedir(), '.cargo', 'bin', 'tauri-driver');

    tauriDriver = spawn(driverBin, [], { stdio: [null, process.stdout, process.stderr] });

    tauriDriver.on('error', (error) => {
      console.error('[e2e] tauri-driver error:', error);
      process.exit(1);
    });

    tauriDriver.on('exit', (code) => {
      if (!exit) {
        console.error('[e2e] tauri-driver exited with code:', code);
        process.exit(1);
      }
    });
  },

  afterSession: () => {
    if (process.platform !== 'darwin') closeTauriDriver();
  },
};

function closeTauriDriver() {
  exit = true;
  tauriDriver?.kill();
}

function onShutdown(fn) {
  const cleanup = () => {
    try {
      fn();
    } finally {
      process.exit();
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);
  process.on('SIGBREAK', cleanup);
}

onShutdown(() => {
  closeTauriDriver();
});

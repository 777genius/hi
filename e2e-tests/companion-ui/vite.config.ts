import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../../vite.config';
import { companionMockServer } from './mockCompanionServer';

// Тот же Vite-конфиг приложения + мок companion API/SSE. Порт задаёт playwright.config.ts.
export default mergeConfig(baseConfig, defineConfig({
  plugins: [companionMockServer()],
  server: {
    host: '127.0.0.1',
    // Без HMR: правка файла во время прогона не должна перезагружать страницу посреди теста.
    hmr: false,
  },
}));

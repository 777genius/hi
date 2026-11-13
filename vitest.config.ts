import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

// Node 25+ включает собственный localStorage, который перекрывает jsdom и ломает тесты (localStorage undefined).
// Флаг есть не во всех версиях Node, поэтому передаём его только там, где встроенное хранилище включено.
const nodeMajor = Number(process.versions.node.split('.')[0]);
const disableNodeWebStorage = nodeMajor >= 25 ? ['--no-experimental-webstorage'] : [];

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    execArgv: disableNodeWebStorage,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/features/auth/**/*.ts'],
      exclude: ['**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});

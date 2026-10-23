/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Mesma origem para o navegador: cookie httpOnly e guarda de CSRF funcionam como em producao.
    proxy: { '/api': { target: API_TARGET, changeOrigin: false } },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Hash no nome do arquivo + cache imutavel no servidor (ver web-app.ts).
    assetsDir: 'assets',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.spec.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});

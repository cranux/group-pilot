import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_HTTP = 'http://localhost:3000';
const BACKEND_WS = 'ws://localhost:3000';

const proxy = {
  '/api': { target: BACKEND_HTTP, changeOrigin: true },
  '/ws': { target: BACKEND_WS, ws: true, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
});

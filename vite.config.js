import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite SPA —— 构建产物是纯静态文件，可直接部署到 Vercel
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: true },
});

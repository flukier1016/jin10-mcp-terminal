import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '');
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:8080';
  const devHost = env.VITE_DEV_HOST || '127.0.0.1';

  return {
    // npm workspace 从 web/ 启动 Vite；显式回到仓库根读取统一的 .env。
    envDir: '..',
    plugins: [react()],
    server: {
      host: devHost,
      port: 5173,
      proxy: {
        // SSE 必须关掉代理层缓冲，否则事件会被攒住
        '/api': { target: apiTarget, changeOrigin: true, ws: false },
      },
    },
    preview: { host: devHost, port: 4173 },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
  };
});

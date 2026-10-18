import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 开发时把 /api 代理到后端。生产环境由 Caddy 直接按路径分流，不走这里。
    proxy: {
      '/api': {
        target: process.env.WL_API_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    // 桌面外壳不做首屏代码分割之外的优化：它是"一次加载、长期驻留"的应用，
    // 把每个应用都拆成独立 chunk 反而会让打开窗口时有等待感。
    chunkSizeWarningLimit: 1200,
  },
})

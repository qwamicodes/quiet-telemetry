import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const server = process.env.QUIET_SERVER ?? 'http://127.0.0.1:7070'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // One self-hosted UI served from the binary: a single ~210 kB (gzip) bundle is fine.
  build: { chunkSizeWarningLimit: 800 },
  server: {
    proxy: {
      '/api/stream': { target: server.replace(/^http/, 'ws'), ws: true },
      '/api': server,
      '/ingest': server,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})

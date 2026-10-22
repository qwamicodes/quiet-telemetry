import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { z } from 'zod'

/** Dev-only env, checked up front so a typo fails here and not as a silent proxy miss. */
const env = z
  .object({ QUIET_SERVER: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:7070') })
  .parse(process.env)
const server = env.QUIET_SERVER

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

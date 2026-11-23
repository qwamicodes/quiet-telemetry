import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { z } from 'zod'

/** Dev-only env, checked up front so a typo fails here and not as a silent proxy miss. */
const env = z
  .object({
    QUIET_SERVER: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:7070'),
    /** Where Vite serves the UI (`make dev-history` uses 7070, the server moves to 7071). */
    QUIET_WEB_PORT: z.coerce.number().int().min(1).max(65535).default(5173),
  })
  .parse(process.env)
const server = env.QUIET_SERVER

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // One self-hosted UI served from the binary; /search is its own chunk.
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    host: '127.0.0.1',
    port: env.QUIET_WEB_PORT,
    strictPort: process.env.QUIET_WEB_PORT != null,
    proxy: {
      '/api/stream': { target: server.replace(/^http/, 'ws'), ws: true },
      '/api': server,
      '/ingest': server,
      '/v1': server,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})

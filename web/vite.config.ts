import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const server = process.env.QUIET_SERVER ?? 'http://127.0.0.1:7070'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/stream': { target: server.replace(/^http/, 'ws'), ws: true },
      '/api': server,
      '/ingest': server,
    },
  },
})

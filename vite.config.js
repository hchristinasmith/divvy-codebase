import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The server bundle is dist/server.js and serves static files from the
    // `public` folder beside it (server/server.ts), so the client goes there.
    outDir: 'dist/public',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3005',
    },
  },
})

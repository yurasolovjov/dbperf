import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies the JSON API to a locally running dbperf (HTTP listener :9091).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.DBPERF_API ?? 'http://localhost:9091', changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
})

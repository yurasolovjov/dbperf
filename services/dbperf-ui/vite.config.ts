import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies the JSON API to a locally running dbperf (HTTP listener :9091).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/v1/registry': { target: process.env.REGISTRY_API ?? 'http://localhost:9101', changeOrigin: true },
      '/api': { target: process.env.DBPERF_API ?? 'http://localhost:9091', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
})

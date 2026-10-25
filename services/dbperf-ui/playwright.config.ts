import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: {
    baseURL: process.env.DBPERF_UI_URL ?? 'http://127.0.0.1:5173',
    browserName: 'chromium',
    viewport: { width: 1366, height: 768 },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
  reporter: 'list',
})

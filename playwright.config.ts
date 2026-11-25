/** One Chromium worker; built assets are served locally for realistic browser acceptance. */
import { defineConfig } from '@playwright/test';
const externalServer = process.env.DARDANIA_PLAY_BASE_URL;
export default defineConfig({
  testDir: './tests/browser',
  outputDir: 'runs/playwright',
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'runs/browser-results.json' }]],
  use: {
    browserName: 'chromium',
    headless: true,
    actionTimeout: 5000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
    baseURL: externalServer ?? 'http://127.0.0.1:5178',
  },
  webServer: externalServer
    ? undefined
    : {
        command: 'npx vite preview --host 127.0.0.1 --port 5178 --strictPort',
        url: 'http://127.0.0.1:5178',
        reuseExistingServer: false,
      },
});

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:8888',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'chromium-small',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 500 },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:8888',
    reuseExistingServer: true,
    timeout: 30000,
  },
});

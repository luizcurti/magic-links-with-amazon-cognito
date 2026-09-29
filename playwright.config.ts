import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests: real frontend (Vite dev server with its /api proxy)
 * against the stack deployed on LocalStack. Prerequisites: make up && make infra
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev:frontend",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});

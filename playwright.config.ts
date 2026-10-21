import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E tests against the deployed stack (make up && make infra).
 * Starts the Vite dev server unless E2E_BASE_URL points elsewhere (make test-e2e-docker).
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev:frontend",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
      },
});

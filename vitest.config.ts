import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    restoreMocks: true,
    unstubGlobals: true,
    projects: [
      { extends: true, test: { name: "backend", environment: "node", include: ["tests/**/*.test.ts"] } },
      {
        extends: true,
        test: {
          name: "frontend",
          environment: "happy-dom",
          include: ["apps/frontend/src/**/*.test.tsx"],
          setupFiles: ["apps/frontend/vitest.setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["apps/api/src/**/*.ts", "apps/cognito/**/*.ts", "apps/frontend/src/**/*.{ts,tsx}"],
      // main.tsx only mounts <App />.
      exclude: ["apps/frontend/src/main.tsx", "**/*.test.tsx"],
      reporter: ["text", "html"],
      thresholds: { 100: true },
    },
  },
});

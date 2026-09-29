import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["apps/api/src/**/*.ts", "apps/cognito/**/*.ts"],
      reporter: ["text", "html"],
    },
  },
});

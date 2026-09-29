import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The browser talks to /api on the Vite dev server, which proxies to API
// Gateway on LocalStack. Same-origin requests mean no CORS setup is needed.
// `make infra` writes VITE_API_PROXY_TARGET into .env.local.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_PROXY_TARGET;

  if (!target) {
    console.warn("\n⚠ VITE_API_PROXY_TARGET is not set. Run `make infra` (or `make env`) first.\n");
  }

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: target
        ? {
            "/api": {
              target,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ""),
            },
          }
        : undefined,
    },
  };
});

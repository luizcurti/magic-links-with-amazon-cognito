import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// /api is proxied to API Gateway (VITE_API_PROXY_TARGET, written by `make infra`).
// No page may frame the app: the "Sign in" button could be clickjacked.
// The nginx image sends the same headers.
export const SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_PROXY_TARGET;

  if (!target) {
    console.warn("\n⚠ VITE_API_PROXY_TARGET is not set. Run `make infra` (or `make env`) first.\n");
  }

  return {
    plugins: [react()],
    preview: { headers: SECURITY_HEADERS },
    server: {
      port: 5173,
      strictPort: true,
      headers: SECURITY_HEADERS,
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

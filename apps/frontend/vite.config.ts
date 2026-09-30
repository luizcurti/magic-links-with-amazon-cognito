import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The browser talks to /api on the Vite dev server, which proxies to API
// Gateway on LocalStack. Same-origin requests mean no CORS setup is needed.
// `make infra` writes VITE_API_PROXY_TARGET into .env.local.
// The callback page has a "Sign in" button: a page that framed it could trick
// a visitor into clicking it with the framer's own link, signing them into the
// framer's account. No page may frame this app. A production host (CloudFront,
// S3 website, nginx…) must send the same headers.
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

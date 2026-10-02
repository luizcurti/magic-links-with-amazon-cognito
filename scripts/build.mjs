// Bundles each Lambda into dist/<name>/index.js, which Terraform zips.

import { rm } from "node:fs/promises";
import { build } from "esbuild";

const functions = {
  login: "apps/api/src/handlers/login.ts",
  "send-magic-link": "apps/api/src/handlers/send-magic-link.ts",
  "auth-callback": "apps/api/src/handlers/auth-callback.ts",
  me: "apps/api/src/handlers/me.ts",
  logout: "apps/api/src/handlers/logout.ts",
  refresh: "apps/api/src/handlers/refresh.ts",
  "define-auth-challenge": "apps/cognito/triggers/define-auth-challenge.ts",
  "create-auth-challenge": "apps/cognito/triggers/create-auth-challenge.ts",
  "verify-auth-challenge": "apps/cognito/triggers/verify-auth-challenge.ts",
};

await rm("dist", { recursive: true, force: true });

await Promise.all(
  Object.entries(functions).map(([name, entry]) =>
    build({
      entryPoints: [entry],
      outfile: `dist/${name}/index.js`,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      minify: true,
      sourcemap: false,
      legalComments: "none",
      logLevel: "warning",
    }),
  ),
);

console.log(`Built ${Object.keys(functions).length} Lambda bundles into dist/`);

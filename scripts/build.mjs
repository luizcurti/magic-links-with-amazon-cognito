// Bundles every Lambda into its own self-contained file: dist/<name>/index.js
// Terraform zips each folder, so each function ships only the code it uses.
import { build } from "esbuild";
import { rm } from "node:fs/promises";

const functions = {
  login: "apps/api/src/handlers/login.ts",
  "auth-callback": "apps/api/src/handlers/auth-callback.ts",
  me: "apps/api/src/handlers/me.ts",
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

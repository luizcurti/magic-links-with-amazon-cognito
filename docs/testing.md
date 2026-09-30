[← README](../README.md) · [Architecture](architecture.md) · [API](api.md) · [Security](security.md) · [Testing](testing.md) · [Deployment](deployment.md)

# Testing

| Command | What it runs | Needs |
|---|---|---|
| `npm run lint` | Biome lint + format check | — |
| `npm run typecheck` | `tsc --noEmit` for backend and frontend | — |
| `npm test` / `npm run test:coverage` | Unit tests, backend + frontend (coverage must stay at 100%) | — |
| `npm run build` | esbuild bundles in `dist/` | — |
| `npm run build -w apps/frontend` | Frontend production build | — |
| `npm run test:integration` | Integration tests against the deployed stack | `make up && make infra` |
| `npm run test:api` | Postman collection via newman | `make up && make infra` |
| `npm run test:e2e` | Browser E2E tests with Playwright (starts Vite itself) | `make up && make infra`, `npx playwright install chromium` |
| `make test-aws` | Smoke tests for what LocalStack does not enforce, against a real AWS deployment | `make aws-infra` (see [Deploying to real AWS](deployment.md#deploying-to-real-aws)) |
| `make demo` | Terminal smoke test of the whole flow | `make up && make infra` |
| `make check` | lint + typecheck + unit tests + `terraform fmt -check` / `validate` | Terraform |
| `make tf-scan` | tflint + Checkov | tflint, Checkov |

Every layer covers both the happy path and the failure cases:

| Layer | Happy path | Sad path |
|---|---|---|
| **Unit** (Vitest, 233 tests, 100% statements/branches/functions/lines) | token primitives, link issue/check/consume, the growing cooldown (`decideIssue`), API base URL, Cognito flow, triggers, handlers, SQS worker, refresh, sign-out, silent renewal (before expiry, after a 401, shared between concurrent callers), React pages, router, session | expiry boundary, reuse, races, cooldown, wrong email, malformed input, `415` for non-JSON bodies, SES failure → link dropped and message retried, SES and rollback failing together → the same message's retry still delivers, no second email after a crash following a send, malformed queue messages, unknown users get a decoy challenge, AWS throttling → 429, other AWS failures → 500 without leaking internals, stuck-user repair, incomplete Cognito responses, revoked/unknown refresh tokens, a 401 that persists after renewal, sign-out when revocation fails, late responses after unmount |
| **Integration** (Vitest against LocalStack, 51 tests) | login → email → JWT → `/me`, 15-minute tokens, refresh → new ID token works on `/me`, link in the URL fragment, user created `CONFIRMED` only on first sign-in, `email_verified`, stuck user repaired, only the hash stored, case-insensitive email, returning user, sign-out revokes the refresh token | reuse, 5 parallel clicks → exactly one 200, wrong token doesn't burn the real one, cross-account token, unknown email, expiry, rotation, email bombing → one email, cooldown grows to 120 s after an unused link, CORS preflight on every route, CORS on API Gateway's own errors (configuration), no enumeration, a bad link creates no user, 400s, `415` for `text/plain` (no email sent), app client cannot write `email`, challenge does not echo the email, `/me` without/forged/tampered/access token, no renewal after sign-out, forged refresh token, invalid sign-out/refresh bodies, 30-request burst absorbed, unknown routes |
| **API collection** (Postman, 32 requests / 60 assertions) | 202, 200 with 15-minute JWTs, `/me` 200, `/auth/refresh` 200 and the renewed token on `/me`, `/logout` 204 and the refresh token then rejected by Cognito and by the API | 415 (`text/plain` body), 400 (invalid JSON, missing/invalid/long email, `null`, array, bad token, missing refresh token), 401 (wrong token, unknown email, reuse, no/forged/access token, forged or revoked refresh token), 403 (wrong method), cooldown, repeated sign-out |
| **E2E** (Playwright, 11 tests) | sign in from the UI with the "Sign in as …" confirmation, profile, expired session renewed silently, sign out (refresh token verified revoked in Cognito), token gone from URL and history, `no-referrer` | session revoked from another device → back to login, a scanner opening the link does not use it, link opened twice, tampered token, incomplete link, invalid email blocked by the browser |

Emails are sent asynchronously, so tests that assert "no extra email" first wait until the login queue is drained (nothing waiting or in flight): SQS deletes a message only once the worker finished it, so a slow worker makes the test wait (or fail on timeout), never pass without having checked anything.

**Unit tests** need no Docker. AWS calls are mocked with `aws-sdk-client-mock`; the React components run in `happy-dom` with Testing Library.

When no stack is deployed, the integration suite is skipped, so `npm run test:integration` never fails spuriously. In CI it runs only when a `LOCALSTACK_AUTH_TOKEN` repository secret is configured.

`npm run test:api` downloads a pinned newman with `npx` instead of adding it as a dependency, because newman's dependency tree has open advisories.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to `main` and every pull request:

| Job | Steps |
|---|---|
| **quality** | `npm ci` → `npm audit --audit-level=high` → lint → typecheck → unit tests with coverage → Lambda build → frontend build |
| **terraform** | `fmt -check` → `init -backend=false` → `validate` → tflint → Checkov (skips are justified in [`.checkov.yaml`](../infrastructure/terraform/.checkov.yaml)) |
| **integration** | Docker Compose LocalStack → `make infra` (Terraform apply) → integration tests → Postman collection → Playwright browser E2E → `make demo` |

The integration job needs a `LOCALSTACK_AUTH_TOKEN` repository secret. Without it (for example on forks) the job is skipped rather than failed, since there is nothing to run against. The [AWS smoke tests](deployment.md#deploying-to-real-aws) (`make test-aws`) are not part of CI: they need a real AWS account, cost money, and block `POST /login` from the runner's IP for the WAF window.

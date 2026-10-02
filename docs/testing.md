[← README](../README.md) · [Architecture](architecture.md) · [API](api.md) · [Security](security.md) · [Testing](testing.md) · [Deployment](deployment.md)

# Testing

| Command | Runs | Needs |
|---|---|---|
| `npm run lint` | Biome lint + format check | — |
| `npm run typecheck` | `tsc --noEmit`, backend and frontend | — |
| `npm run test:coverage` | Unit tests, backend + frontend, 100% coverage required | — |
| `npm run build` / `npm run build -w apps/frontend` | Lambda bundles / frontend build | — |
| `npm run test:integration` | Integration tests against LocalStack | `make up && make infra` |
| `npm run test:api` | Postman collection via newman (pinned, through `npx`) | `make up && make infra` |
| `npm run test:e2e` | Playwright, against the Vite dev server it starts | `make up && make infra`, `npx playwright install chromium` |
| `make test-e2e-docker` | Playwright against the nginx frontend image | as above |
| `make demo` | The whole flow from the terminal | `make up && make infra` |
| `make test-aws` | Smoke tests of what LocalStack does not enforce | `make aws-infra` ([Deployment](deployment.md#real-aws)) |
| `make check` | lint, typecheck, unit tests, `terraform fmt -check`, `validate` | Terraform |
| `make tf-scan` | tflint + Checkov | tflint, Checkov |

## Layers

| Layer | Happy path | Sad path |
|---|---|---|
| **Unit** (Vitest; AWS mocked with `aws-sdk-client-mock`, React in `happy-dom`) | token primitives, link issue/check/consume, the growing cooldown, Cognito flow, triggers, handlers, SQS worker, log correlation, silent renewal, React pages, router, session | expiry, reuse, races, cooldown, wrong email, malformed input, `415`, SES failure and rollback failure, retries after a send, malformed queue messages, decoy challenge, throttling → `429`, other failures → `500` without internals, stuck users, revoked refresh tokens, late responses after unmount |
| **Integration** (Vitest against LocalStack) | login → email → JWT → `/me`, 15-minute tokens, refresh, link in the fragment, user created `CONFIRMED` on first sign-in, only the hash stored, case-insensitive email, sign-out revokes the refresh token | reuse, 5 parallel clicks → one `200`, wrong or cross-account token, expiry, rotation, email bombing → one email, growing cooldown, CORS, no enumeration, a bad link creates no user, `400`/`415`, forged and tampered JWTs, 30-request burst, unknown routes |
| **API collection** (Postman) | every route's success response and contract headers, renewal, sign-out | every `400`, `401` and `415`, `403` for wrong methods and routes, preflights, cooldown |
| **E2E** (Playwright) | sign in with the "Sign in as …?" step, profile, silent renewal, sign-out, token removed from URL and history, security headers | revoked session, link scanners, link opened twice, tampered, expired or incomplete links, API `4xx`/`5xx`/network errors on every page |
| **AWS smoke** (Vitest against AWS) | — | email change refused, decoy challenge, forged JWTs refused by the authorizer, WAF limit on `/login` variants, CORS on gateway errors |

## Route contract

Each layer has a contract suite for every route's inputs and outputs: [`tests/unit/routes.contract.test.ts`](../tests/unit/routes.contract.test.ts), [`tests/integration/routes.contract.test.ts`](../tests/integration/routes.contract.test.ts), the Postman collection and [`tests/e2e/routes.spec.ts`](../tests/e2e/routes.spec.ts). Each one asserts the exact status, the exact body (`{message, errors[{field, message}]}` for a `400`) and, for every response a Lambda produces, the headers (`Content-Type: application/json`, `Cache-Control: no-store`, `Access-Control-Allow-Origin`, `Retry-After` on a `429`).

| Route | Inputs covered | Outputs | Unit | Integration | Postman | E2E |
|---|---|---|:-:|:-:|:-:|:-:|
| every `POST` | no/`text/plain`/form/multipart/`application/jsonp` Content-Type; JSON Content-Type with a charset or in upper case; base64 body; empty body; invalid or truncated JSON; JSON `null`, array, string, number, boolean; unknown fields | `415`, `400`, success | ✓ | ✓ | ✓ | — |
| `POST /login` | email missing, `null`, number, object, array, empty, spaces, no `@`, no domain, no TLD, two `@`, inner space, CRLF header injection, 254 chars (accepted) / 255 (refused), mixed case and spaces (normalised), plus address | `202` generic body, `400`, `429`, `500` | ✓ | ✓ | ✓ | ✓ (`400`/`429`/`500`/`502` HTML/network error shown, button disabled in flight, empty email blocked) |
| `POST /auth/verify` | email/token missing, `null`, number; token empty, 63/65 chars, upper case, non-hex, spaces, newline; both invalid; unknown, used, expired, wrong-account link | `200` with exactly `idToken, accessToken, refreshToken, expiresIn, tokenType`; `400`; `401` with one message; `429` (DynamoDB or Cognito); `500` | ✓ | ✓ | ✓ | ✓ (query-string link, double click, spinner, expired, other address, `429`/`500` leave the link usable, incomplete links call nothing) |
| `GET /me` | no headers, no/empty `Authorization`, `Bearer` only, Basic, garbage, 2 or 4 segments, tampered payload, `alg=none`, no `kid`, empty signature, unknown `kid` (JWKS re-read), HS256 key confusion, non-JSON payload, expired, other audience/issuer, access token | `200` with exactly `sub, email, emailVerified, authTime, expiresAt` matching the token; `401`; `500` when the JWKS is unreachable | ✓ | ✓ | ✓ | ✓ (`401` → one silent renewal, `500` shown with the session kept) |
| `POST /auth/refresh` | `refreshToken` missing, `null`, empty, number, object, array, 8192 chars (accepted) / 8193 (refused); revoked, expired, forged, an ID token | `200` with exactly `idToken, accessToken, expiresIn, tokenType`; `400`; `401`; `429`; `500` | ✓ | ✓ | ✓ | ✓ (`500` shown with the session kept) |
| `POST /logout` | same `refreshToken` matrix; live, revoked, forged, ID/access token | `204` empty body in every case; `400`; `429`; `500` | ✓ | ✓ | ✓ | ✓ (body sent, `500` still signs out locally) |
| `OPTIONS` every route | frontend origin preflight | `200` with allow origin/methods/headers | — | ✓ | ✓ | — |
| wrong method / unknown route | `GET/PUT/DELETE /login`, `GET /auth/verify`, `GET /auth/refresh`, `GET /logout`, `POST/DELETE /me`, `/admin`, `/` | `403` from API Gateway | — | ✓ | ✓ | — |
| SQS worker | empty batch; messages with and without `requestedAt`; empty, `null`, array, bad `requestedAt` (string, 0, negative, fractional), too-long email | dropped, not retried; DynamoDB failure → retried; missing/invalid configuration → whole batch retried | ✓ | ✓ (late retry, cooldown) | ✓ (delivery, cooldown) | — |
| frontend routes | `/`, `/profile`, `/auth/callback`, unknown paths, corrupted session, reload | right page, redirect to login | ✓ | — | — | ✓ |

LocalStack's authorizer answers `500` instead of `401` for some malformed signatures (e.g. empty); the Lambda answers `401` (unit tests), as does AWS (`make test-aws`).

## Conventions

- Tests that assert "no extra email" wait until the login queue is drained, so a slow worker fails the test instead of passing it unchecked.
- Without a deployed stack, the integration suite is skipped.
- `npm run test:api` runs a pinned newman through `npx`, outside the dependency tree.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on pushes to `main` and on pull requests; any failing step fails the build.

| Job | Steps |
|---|---|
| **quality** | `npm ci`, `npm audit --audit-level=high`, lint, typecheck, unit tests with coverage, Lambda and frontend builds, `docker compose config`, frontend image build |
| **terraform** | `fmt -check`, `init -backend=false`, `validate`, tflint, Checkov ([skips](../infrastructure/terraform/.checkov.yaml)) |
| **integration** | LocalStack, `terraform plan` (job summary + `terraform-plan` artifact), apply to LocalStack, integration tests, Postman, Playwright against the frontend image, `make demo` |

The integration job runs only with a `LOCALSTACK_AUTH_TOKEN` repository secret. `make test-aws` is not part of CI: it needs an AWS account and blocks the runner's IP on `/login` for the WAF window. [Dependabot](../.github/dependabot.yml) opens weekly update PRs for npm, GitHub Actions, Terraform providers and Docker images.

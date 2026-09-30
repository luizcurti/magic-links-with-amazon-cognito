[← README](../README.md) · [Architecture](architecture.md) · [API](api.md) · [Security](security.md) · [Testing](testing.md) · [Deployment](deployment.md)

# Architecture

![AWS architecture](img/aws-architecture.svg)

- **A. Request a link.** `POST /login` only queues the email (and when it was asked) in SQS and answers `202`. The `send-magic-link` worker applies the cooldown, stores `sha256(token)` in DynamoDB and emails the link with SES.
- **B. Exchange the link.** The callback page asks "Sign in as …?", then posts `{email, token}` to `/auth/verify`. The Lambda checks the link in DynamoDB (read-only), creates the Cognito user on the first sign-in, and runs Cognito `CUSTOM_AUTH`; the `VerifyAuthChallengeResponse` trigger consumes the token atomically.
- **C. Use the JWT.** `GET /me` is protected by the API Gateway Cognito authorizer, and the Lambda verifies the ID token again (signature against the pool's JWKS, issuer, audience, expiry, `token_use`) with `aws-jwt-verify`, so every claim it returns is proven.
- **D. Session.** ID and access tokens live 15 minutes. The frontend renews them silently with `POST /auth/refresh` shortly before they expire, or once when an API call answers `401`. `POST /logout` revokes the refresh token in Cognito, so the session can't be renewed any more.
- **AWS WAF** sits in front of the API with per-IP rate limits (stricter on `/login`) and the AWS Common and Known Bad Inputs managed rule groups.

More diagrams (Mermaid sources in [`docs/mmd`](mmd), rendered to [`docs/img`](img)):

| Diagram | What it shows |
|---|---|
| [Components](img/architecture.svg) | Lambdas, Cognito triggers and the AWS services they use |
| [Sequence](img/magic-link-sequence.svg) | The full flow: request → email → JWT → `/me` → silent renewal → sign-out |
| [DefineAuthChallenge](img/define-auth-challenge.svg) | The custom-auth state machine (retries, failure, token issue) |
| [Token rules](img/verify-token-rules.svg) | Every check the verify trigger makes, in order |
| [Deployment](img/deployment.svg) | Docker Compose, LocalStack, Terraform and the test runners |

## The flow

![Sequence diagram](img/magic-link-sequence.svg)

Diagram sources live in [`mmd/`](mmd); after editing one, re-render it with [mermaid-cli](https://github.com/mermaid-js/mermaid-cli): `npx @mermaid-js/mermaid-cli -b white -i docs/mmd/<name>.mmd -o docs/img/<name>.svg`.

## How this differs from the article

The article stores the magic-link token in a Cognito **custom attribute**. As the author points out, that caps throughput at the `AdminUpdateUserAttributes` rate limit. It also makes the link carry KMS-encrypted state.

This project keeps the same Cognito trigger mechanics and changes where the state lives:

| | Article | This project |
|---|---|---|
| Token storage | Cognito custom attribute | DynamoDB, keyed by `EMAIL#<email>` |
| What is stored | Token (KMS-encrypted payload) | **SHA-256 hash only** |
| Throughput | Bounded by Cognito admin API limits | DynamoDB on-demand |
| Single use | Attribute overwritten after login | Atomic `ConditionExpression` (race-safe) |
| Cleanup | Manual | DynamoDB TTL on `expiresAt` |
| Cognito `Session` problem | Session must outlive the email | Auth starts **when the link is opened**, so no long-lived session |
| KMS | Encrypts the token payload | Customer-managed key for the table |

**Why SHA-256 and not bcrypt?** Password hashes are slow on purpose, because passwords have little entropy. These tokens are 256 bits from a CSPRNG, so brute-forcing a SHA-256 preimage is already infeasible. A fast hash is the right tool here.

## Data model

A single DynamoDB item per email. A new link replaces the old one, unless the old one is unused and younger than the cooldown (then nothing is written). A link whose email could not be sent is deleted again, so the retry is not blocked by the cooldown. A request that reaches the worker late (retry, duplicate delivery, backed-up queue) never replaces a link created after the user asked.

| Attribute | Example | Notes |
|---|---|---|
| `pk` | `EMAIL#luiz@example.com` | Partition key |
| `email` | `luiz@example.com` | Normalized (trimmed, lower-case) |
| `tokenHash` | `9f86d0…` | `SHA256(token)`, hex |
| `createdAt` | `1767268800` | Epoch seconds |
| `expiresAt` | `1767269400` | Epoch seconds; also the TTL attribute |
| `used` | `false` | Flipped atomically on first use |
| `usedAt` | `1767268900` | Set on consumption |

## Architectural decisions

- **DynamoDB instead of a Cognito custom attribute** for token state. See [How this differs from the article](#how-this-differs-from-the-article).
- **One Lambda per route and per trigger.** Each has its own IAM role with only the permissions it needs; bundles are tiny because esbuild tree-shakes per entry point.
- **`/auth/refresh` and `/logout` have no authorizer.** Holding the refresh token is the proof of ownership, and an expired ID token must never prevent someone from renewing the session or signing out.
- **A queue between `/login` and the email.** `POST /login` does no per-email work, so its response time reveals nothing, and SES failures are retried by SQS with a dead-letter queue instead of failing the request. Everything else stays synchronous (API Gateway or Cognito), with no Step Functions.
- **Plain classes, no DI framework.** Handlers wire their dependencies directly. `MagicLinkService` holds the rules and `evaluateMagicLink` is a pure function, so the core logic is tested without AWS mocks.
- **Small in-house JSON logger** instead of Powertools: three functions with masked emails are all the logging these Lambdas need.
- **Biome** for lint and format. The project uses TypeScript 7 (native compiler), which `typescript-eslint` does not support yet.

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict), Node.js 22 |
| Auth | Amazon Cognito User Pools, custom auth triggers |
| Compute | AWS Lambda (bundled with esbuild) |
| API | Amazon API Gateway (REST) with a Cognito authorizer, behind AWS WAF |
| Data | Amazon DynamoDB (TTL, conditional writes) |
| Email | Amazon SES, fed by an Amazon SQS queue (with a dead-letter queue) |
| Encryption | AWS KMS (customer-managed key) |
| IaC | Terraform |
| Local cloud | LocalStack in Docker Compose |
| Validation | Zod |
| Tests | Vitest, aws-sdk-client-mock, Testing Library + happy-dom, Postman/newman, Playwright |
| Lint / format | Biome |
| Observability | CloudWatch Logs, X-Ray |
| Frontend | React 19 + Vite |
| CI | GitHub Actions |

## Project structure

```
.
├── apps/
│   ├── api/src/
│   │   ├── handlers/
│   │   │   ├── login.ts                 # POST /login → queue the request
│   │   │   ├── send-magic-link.ts       # SQS worker: cooldown, store hash, send email
│   │   │   ├── auth-callback.ts         # POST /auth/verify → JWTs
│   │   │   ├── me.ts                    # GET /me (Cognito authorizer)
│   │   │   ├── refresh.ts               # POST /auth/refresh → new 15-minute tokens
│   │   │   └── logout.ts                # POST /logout → RevokeToken
│   │   ├── services/
│   │   │   ├── token.service.ts         # generate / hash / compare tokens
│   │   │   ├── magic-link.service.ts    # issue + check + consume links (core rules)
│   │   │   ├── login-queue.service.ts   # SQS producer for POST /login
│   │   │   ├── email.service.ts         # SES email + templates
│   │   │   └── cognito.service.ts       # user provisioning, CUSTOM_AUTH, refresh, revoke
│   │   ├── repositories/
│   │   │   └── magic-link.repository.ts # DynamoDB access
│   │   └── lib/                         # env, http, validation, logging, AWS clients
│   ├── cognito/triggers/
│   │   ├── define-auth-challenge.ts
│   │   ├── create-auth-challenge.ts
│   │   └── verify-auth-challenge.ts
│   └── frontend/                        # React + Vite (auth.ts: silent token renewal)
├── infrastructure/terraform/            # Cognito, Lambda, API GW, WAF, DynamoDB, SES, SQS, KMS, IAM, logs
├── api/                                 # Postman collection (API contract tests)
├── docs/                                # these guides; mmd/ holds the diagram sources, img/ the renders and the AWS overview
├── tests/
│   ├── unit/                            # backend (frontend tests live next to the components)
│   ├── integration/                     # runs against LocalStack
│   ├── e2e/                             # Playwright, real browser
│   └── aws/                             # smoke tests against a real AWS deployment
├── scripts/
│   ├── build.mjs                        # esbuild → dist/<function>/index.js
│   ├── emails.mjs                       # read emails captured by LocalStack SES
│   └── demo.sh                          # full flow from the terminal
├── biome.json                           # lint + format
├── docker-compose.yml
└── Makefile
```

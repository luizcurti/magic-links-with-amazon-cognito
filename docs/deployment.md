[← README](../README.md) · [Architecture](architecture.md) · [API](api.md) · [Security](security.md) · [Testing](testing.md) · [Deployment](deployment.md)

# Configuration and deployment

## Running locally

**Prerequisites**

- Docker, Node.js 22+, Terraform 1.6+
- `jq` (for the `make login` / `make verify` / `make demo` helpers)
- Optional: [tflint](https://github.com/terraform-linters/tflint) and [Checkov](https://www.checkov.io) for `make tf-scan`
- **A LocalStack auth token on a plan that includes Cognito.** Since LocalStack 2026.03 every image needs a token to start, and Cognito User Pools are not part of the free **Hobby** plan ([plan comparison](https://docs.localstack.cloud/aws/licensing/)). Get a token at [app.localstack.cloud](https://app.localstack.cloud/workspace/auth-token). Without one you can still run lint, typecheck, unit tests, builds and the Terraform checks.

**Deploy**

```bash
npm install
cp .env.example .env    # then set LOCALSTACK_AUTH_TOKEN
make up                 # start LocalStack and wait until it is healthy
make infra              # bundle the Lambdas, terraform apply, write apps/frontend/.env.local
```

```
✓ KMS key            ✓ DynamoDB table (TTL + CMK encryption)
✓ SES identity       ✓ IAM roles (one per Lambda)
✓ 9 Lambdas          ✓ Cognito user pool + client + triggers
✓ SQS queue + DLQ    ✓ API Gateway + Cognito authorizer + per-route throttling + CORS
✓ AWS WAF (per-IP rate limits, managed rules)
✓ CloudWatch log groups (14-day retention) + JSON access logs
```

**Try it step by step**

```bash
make login  EMAIL=luiz@example.com   # request a link
make emails                          # read the captured email
make verify EMAIL=luiz@example.com   # exchange the latest link for JWTs
make down                            # stop LocalStack, delete its data and the Terraform state
```

## Environment variables

**`.env`** (read by Docker Compose, copy from [`.env.example`](../.env.example)):

| Variable | Required | Description |
|---|---|---|
| `LOCALSTACK_AUTH_TOKEN` | yes | LocalStack license token (Cognito needs it) |
| `LOCALSTACK_IMAGE` | no | Override the pinned LocalStack image |
| `LOCALSTACK_DEBUG` | no | `1` for verbose LocalStack logs |
| `LAMBDA_CONCURRENCY` | no | Max concurrent Lambda containers in LocalStack (default `20`), like an account quota |

**Lambdas** (set by Terraform in [`lambda.tf`](../infrastructure/terraform/lambda.tf), never by hand):

| Variable | Used by | Description |
|---|---|---|
| `LOGIN_QUEUE_URL` | login | SQS queue the requests go to |
| `USER_POOL_ID`, `USER_POOL_CLIENT_ID` | auth-callback, refresh, logout | Cognito pool and public client |
| `MAGIC_LINKS_TABLE` | send-magic-link, auth-callback, verify trigger | DynamoDB table name |
| `SES_FROM_ADDRESS` | send-magic-link | Sender address |
| `MAGIC_LINK_CALLBACK_URL` | send-magic-link | Frontend route the link points to |
| `MAGIC_LINK_TTL_SECONDS` | send-magic-link | Link lifetime (default `600`) |
| `MAGIC_LINK_COOLDOWN_SECONDS` | send-magic-link | Minimum time between two links for one email (default `60`) |
| `MAGIC_LINK_MAX_COOLDOWN_SECONDS` | send-magic-link | Ceiling of the growing cooldown (default `900`) |
| `ID_TOKEN_ISSUER` | me | Issuer of the pool's ID tokens; the JWKS is fetched from `<issuer>/.well-known/jwks.json` |
| `CORS_ALLOWED_ORIGIN` | API Lambdas | Allowed origin (`frontend_origin`) |

Missing required variables fail the request with a `500` and a clear log line, instead of reaching AWS with `undefined`. There are no secrets: tokens are generated per request and only their hash is stored.

**Frontend:** `make infra` writes `VITE_API_PROXY_TARGET` (the API Gateway URL) to `apps/frontend/.env.local`; the Vite dev server proxies `/api` to it, so locally everything is same-origin. A build served from another origin sets `VITE_API_BASE_URL` to the API Gateway URL instead, and `frontend_origin` to that origin: the API answers its CORS preflights, and API Gateway's and the WAF's own errors carry the matching header.

**Terraform variables** ([`variables.tf`](../infrastructure/terraform/variables.tf)) cover names, URLs, the token lifetime (`token_validity_minutes`, default 15), the link TTL and cooldown (`magic_link_cooldown_seconds`, default 60, doubling up to `magic_link_max_cooldown_seconds`, default 900), log retention (`log_retention_days`, default 14), API throttling per route (`api_throttle_rate_limit` / `api_throttle_burst_limit`, default 100 rps / 200 burst; `POST /login` has its own `login_throttle_rate_limit` / `login_throttle_burst_limit`, 20 / 40, so a flood of link requests cannot block sign-in for users who already hold a link or a session), the worker's concurrency (`send_magic_link_max_concurrency`, default 5) and the WAF (`waf_login_rate_limit` 10 and `waf_api_rate_limit` 300 requests per IP per `waf_rate_window_seconds` 300).

## Terraform

```bash
make infra                                            # build + init + apply against LocalStack
terraform -chdir=infrastructure/terraform plan        # preview changes (after make build)
make destroy                                          # destroy the resources
make outputs                                          # api_url, user_pool_id, …
```

**State.** State is local (`infrastructure/terraform/terraform.tfstate`, git-ignored) because the stack only lives inside a disposable LocalStack container; `make down` deletes both. No bootstrap is needed.

**Providers** are pinned in `main.tf` (`aws ~> 5.0`, `archive ~> 2.4`) and locked in `.terraform.lock.hcl`.

## Deploying to real AWS

The code has no LocalStack-specific logic (the SDK picks up `AWS_ENDPOINT_URL` inside LocalStack). Terraform takes `target = "localstack"` (default) or `target = "aws"`; with `aws` it uses your default credential chain and real endpoints, and derives the Cognito issuer for the `/me` token check. The real deployment lives in its own Terraform workspace (`aws`), so it never mixes with the disposable LocalStack state.

```bash
make aws-infra        # terraform apply -var target=aws in workspace "aws" (AWS_TF_VARS="-var ..." to pass more)
make test-aws         # smoke tests for what LocalStack does not enforce
make aws-destroy      # tear it down
```

**It costs money and changes the account**: WAF web ACL and rules, a KMS key, API Gateway, Lambda, SQS, DynamoDB and Cognito are billed (small amounts for a short test, but WAF and KMS bill monthly until destroyed), and `aws_api_gateway_account` sets the account-wide CloudWatch role for API Gateway. `make test-aws` blocks `POST /login` from your IP for the WAF window (5 minutes), creates Cognito users named `smoke-…@example.com` and deletes them afterwards, and sends WAF-test emails only to the SES mailbox simulator.

For production, on top of that:

1. Bootstrap remote state once: an S3 bucket with versioning and encryption, then add a `backend "s3"` block with `use_lockfile = true` (Terraform ≥ 1.10), or a DynamoDB lock table for older versions.
2. Set `ses_from_address` to an address or domain you own, verify it (DKIM/SPF/DMARC), and move SES out of the sandbox.
3. Point `magic_link_callback_url` / `frontend_origin` at your deployed frontend (and build it with `VITE_API_BASE_URL` if it is not served from the API's origin), and serve it with the same security headers as the Vite server (`frame-ancestors 'none'`, `X-Frame-Options: DENY`).
4. Revisit the production items skipped in [`.checkov.yaml`](../infrastructure/terraform/.checkov.yaml) and the ones this local project leaves out: CloudWatch alarms with a notification target (5xx, WAF blocks, dead-letter queue depth, SES bounces), longer log retention, Lambda aliases for gradual rollout, refresh-token rotation.

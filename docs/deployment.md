[← README](../README.md) · [Architecture](architecture.md) · [API](api.md) · [Security](security.md) · [Testing](testing.md) · [Deployment](deployment.md)

# Deployment

## Local (LocalStack)

**Requirements:** Docker, Node.js 22+, Terraform 1.6+, `jq`; optionally [tflint](https://github.com/terraform-linters/tflint) and [Checkov](https://www.checkov.io) for `make tf-scan`. LocalStack needs an auth token on a plan that includes Cognito and WAF ([plans](https://docs.localstack.cloud/aws/licensing/), [token](https://app.localstack.cloud/workspace/auth-token)). Lint, typecheck, unit tests, builds and the Terraform checks need no token.

```bash
npm install
cp .env.example .env                 # set LOCALSTACK_AUTH_TOKEN
make up                              # start LocalStack, wait until healthy
make infra                           # build the Lambdas, terraform apply, write apps/frontend/.env.local
make login  EMAIL=luiz@example.com   # request a link
make emails                          # read the captured emails
make verify EMAIL=luiz@example.com   # exchange the latest link for JWTs
make down                            # stop LocalStack, delete its data and the Terraform state
```

`make infra` creates: a KMS key, the DynamoDB table (TTL, CMK encryption), the SES identity, one IAM role per Lambda, 9 Lambdas, the Cognito user pool, client and triggers, the SQS queue and DLQ, API Gateway (Cognito authorizer, per-route throttling, CORS), the WAF, CloudWatch log groups (14-day retention) with JSON access logs, and CloudWatch alarms with their SNS topic.

## Environment variables

**`.env`** (Docker Compose; see [`.env.example`](../.env.example)):

| Variable | Required | Description |
|---|---|---|
| `LOCALSTACK_AUTH_TOKEN` | yes | LocalStack license token |
| `LOCALSTACK_IMAGE` | no | LocalStack image (default pinned in `docker-compose.yml`) |
| `LOCALSTACK_DEBUG` | no | `1` for verbose LocalStack logs |
| `LAMBDA_CONCURRENCY` | no | Max concurrent Lambda containers (default `20`) |
| `FRONTEND_PORT` | no | Host port of the frontend container (default `8088`) |
| `API_PROXY_TARGET` | no | API base URL for the frontend container's `/api`; set by `make frontend-docker` |

**Lambdas** (set by Terraform in [`lambda.tf`](../infrastructure/terraform/lambda.tf)):

| Variable | Used by | Description |
|---|---|---|
| `LOGIN_QUEUE_URL` | login | SQS queue for login requests |
| `USER_POOL_ID` | auth-callback, refresh, logout | Cognito user pool |
| `USER_POOL_CLIENT_ID` | auth-callback, refresh, logout, me | Cognito public client |
| `MAGIC_LINKS_TABLE` | send-magic-link, auth-callback, verify trigger | DynamoDB table |
| `SES_FROM_ADDRESS` | send-magic-link | Sender address |
| `MAGIC_LINK_CALLBACK_URL` | send-magic-link | Frontend route of the link |
| `MAGIC_LINK_TTL_SECONDS` | send-magic-link | Link lifetime (default `600`) |
| `MAGIC_LINK_COOLDOWN_SECONDS` | send-magic-link | Base per-email cooldown (default `60`) |
| `MAGIC_LINK_MAX_COOLDOWN_SECONDS` | send-magic-link | Cooldown ceiling (default `900`) |
| `ID_TOKEN_ISSUER` | me | Issuer of the ID tokens; JWKS at `<issuer>/.well-known/jwks.json` |
| `CORS_ALLOWED_ORIGIN` | API Lambdas | Allowed origin (`frontend_origin`) |

A missing variable fails the request with a `500` and a log line. There are no secrets: tokens are generated per request and only their hash is stored.

**Frontend:** the Vite dev server proxies `/api` to `VITE_API_PROXY_TARGET` (written by `make infra` to `apps/frontend/.env.local`). A build served from another origin sets `VITE_API_BASE_URL` to the API Gateway URL, with `frontend_origin` set to that origin.

## Terraform

```bash
make plan       # build + plan against LocalStack
make infra      # build + apply
make outputs    # api_url, user_pool_id, …
make destroy    # destroy the LocalStack resources
```

[`variables.tf`](../infrastructure/terraform/variables.tf) configures names and URLs, token lifetime (`token_validity_minutes`, 15), link TTL and cooldown, log retention (`log_retention_days`, 14), API throttling (100 rps / 200 burst; `POST /login` 20 / 40), the worker's concurrency (5), the WAF limits (10 `POST /login` and 300 requests per IP per 300 s) and the alarms (`alarm_email`, unset; `api_4xx_rate_threshold`, 0.5).

- **State** is local and git-ignored: the LocalStack stack is disposable and `make down` deletes both, so there is no bootstrap.
- **Providers** are pinned (`aws ~> 5.100`, `archive ~> 2.8`) and locked in `.terraform.lock.hcl`.
- **CI** plans and applies against a fresh LocalStack on every pull request; it never applies to AWS.

## Docker

`docker-compose.yml` runs LocalStack and, under the `frontend` profile, the production frontend. [`apps/frontend/Dockerfile`](../apps/frontend/Dockerfile) builds the app and serves it with nginx as a non-root user: security headers, client-side routes, `/healthz`, and `/api` proxied to API Gateway.

```bash
make frontend-docker    # build and start it on http://localhost:8088 (after make infra)
make test-e2e-docker    # Playwright against it
```

## Real AWS

The code has no LocalStack-specific logic (inside LocalStack the SDK reads `AWS_ENDPOINT_URL`). `target = "aws"` uses the default credential chain and real endpoints, in the Terraform workspace `aws`, apart from the LocalStack state.

```bash
make aws-plan       # plan (AWS_TF_VARS="-var …" passes variables)
make aws-infra      # apply
make test-aws       # smoke tests
make aws-destroy    # tear down
```

- **Cost and account changes:** WAF, KMS, API Gateway, Lambda, SQS, DynamoDB and Cognito are billed (WAF and KMS monthly until destroyed); `aws_api_gateway_account` sets the account-wide CloudWatch role for API Gateway.
- **`make test-aws`** blocks `POST /login` from your IP for the WAF window (5 minutes), creates and deletes `smoke-…@example.com` users, and sends WAF-test emails to the SES mailbox simulator.
- **Production settings:** remote state needs an S3 bucket (versioning, encryption) and a `backend "s3"` block with `use_lockfile = true`. `ses_from_address` must be a verified address or domain (DKIM/SPF/DMARC) with SES out of the sandbox. `magic_link_callback_url` and `frontend_origin` point at the deployed frontend, which must send the same security headers as the nginx image. `alarm_email` subscribes an address to the alarms.
- **Not in this stack:** alarms on WAF blocks and SES bounces, a budget alarm, Lambda aliases, refresh-token rotation, log retention beyond the variable's default.

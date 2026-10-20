[← README](../README.md) · [Architecture](architecture.md) · [API](api.md) · [Security](security.md) · [Testing](testing.md) · [Deployment](deployment.md)

# Deployment

## Local (LocalStack)

**Requirements:** Docker, Node.js 22+, Terraform 1.10+, `jq`; optionally [tflint](https://github.com/terraform-linters/tflint) and [Checkov](https://www.checkov.io) for `make tf-scan`. LocalStack needs an auth token on a plan that includes Cognito and WAF ([plans](https://docs.localstack.cloud/aws/licensing/), [token](https://app.localstack.cloud/workspace/auth-token)). Lint, typecheck, unit tests, builds and the Terraform checks need no token.

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
- **CI** plans and applies against a fresh LocalStack on every pull request. Pushes to `main` also deploy to real AWS once configured: see [Real AWS via GitHub Actions](#real-aws-via-github-actions).

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
- **Production settings:** the GitHub Actions deploy below already uses remote S3 state (versioning, encryption, `use_lockfile`). `ses_from_address` must be a verified address or domain (DKIM/SPF/DMARC) with SES out of the sandbox. `magic_link_callback_url` and `frontend_origin` point at the deployed frontend, which must send the same security headers as the nginx image. `alarm_email` subscribes an address to the alarms.
- **Not in this stack:** alarms on WAF blocks and SES bounces, a budget alarm, Lambda aliases, refresh-token rotation, log retention beyond the variable's default.

## Real AWS via GitHub Actions

Pushes to `main` deploy to real AWS through the `deploy` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), after the lint/test and Terraform jobs pass (the LocalStack job may be skipped without a token). It authenticates with GitHub OIDC, so no AWS access keys are stored in GitHub. Until it is configured, the job skips the AWS steps and stays green.

No `backend` block is committed: the job writes `infrastructure/terraform/ci_backend.tf` with an S3 backend right before `terraform init`, using the bucket created by [`bootstrap/`](../bootstrap) with native S3 locking. Don't also `make aws-infra` against the same account: the two states would diverge.

One-time setup, with admin credentials for the target AWS account and `gh` logged in:

```bash
scripts/bootstrap.sh                 # asks for SES_FROM_ADDRESS
```

It applies [`bootstrap/`](../bootstrap) (remote-state bucket + the `magic-links-github-deploy` IAM role, which only the `production` environment of this repo can assume), then creates the `production` GitHub environment with `AWS_DEPLOY_ROLE_ARN`, `TF_STATE_BUCKET`, `AWS_REGION` and `SES_FROM_ADDRESS`. Extra arguments go to `terraform apply`: `-var="aws_region=…"` (default `eu-west-2`), `-var="create_oidc_provider=true"` on an account without the GitHub OIDC provider.

Optional variables in the `production` environment: `ALARM_EMAIL` (subscribes to the alarm topic), `MANAGE_API_GATEWAY_ACCOUNT=false` when another stack in the same account and region already sets API Gateway's CloudWatch role, and protection rules (required reviewers) to approve each deploy.

Then push to `main` (or `gh workflow run ci.yml --ref main`). The job builds the Lambdas, runs `terraform plan` + `apply` (`target = "aws"`, stage `prod`), runs the [`tests/aws`](../tests/aws/smoke.test.ts) smoke tests against the live stack, and prints the API URL and the SES sender's verification status in the job summary.

**SES sandbox:** on the first deploy AWS emails `SES_FROM_ADDRESS` a verification link; click it, or no magic link is sent. While the account is in the sandbox, SES also only delivers *to* verified addresses, so test the sign-in with that same address. To try the UI against the deployed API, run the frontend locally:

```bash
VITE_API_PROXY_TARGET=<api url from the job summary> npm run dev:frontend   # http://localhost:5173
```

`magic_link_callback_url` and `frontend_origin` keep their `http://localhost:5173` defaults, so the emailed link opens that local frontend.

### Tear down / recreate

Run **Actions → Destroy → Run workflow** on `main` and type `destroy`. It deletes every resource of the stack (the KMS key enters its 7-day deletion window); the `bootstrap/` resources are kept, so **Actions → CI → Run workflow** on `main` recreates it with no setup.

The deploy role's permissions ([`bootstrap/deploy_permissions.tf`](../bootstrap/deploy_permissions.tf)) are scoped by the `magic-links` name prefix or the `Project = magic-links` tag wherever AWS allows it; it can only attach the stack's three AWS-managed policies and can't modify itself.

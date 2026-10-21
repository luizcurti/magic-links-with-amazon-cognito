# Magic Links with Amazon Cognito

Passwordless sign-in with **magic links** on **Amazon Cognito custom authentication**: enter your email, click the link, get Cognito JWTs. The stack is provisioned with Terraform and runs locally on LocalStack or on a real AWS account.

Based on Yan Cui's article [Implementing Magic Links with Amazon Cognito](https://theburningmonk.com/2023/03/implementing-magic-links-with-amazon-cognito-a-step-by-step-guide/), with token state in DynamoDB ([comparison](docs/architecture.md#comparison-with-the-article)).

![AWS architecture](docs/img/aws-architecture.svg)

## Features

- Single-use 256-bit tokens, stored only as SHA-256 hashes, valid for 10 minutes.
- No user enumeration, scanner-safe links, a per-email cooldown, WAF per-IP limits.
- 15-minute JWTs renewed silently; sign-out revokes the refresh token.
- JSON logs correlated by request and X-Ray trace IDs, CloudWatch alarms to SNS.
- Unit (100% coverage), integration, Postman, Playwright E2E and AWS smoke tests.

## Quick start

Requires Docker, Node.js 22+, Terraform 1.6+, `jq`, and a LocalStack auth token on a plan that includes Cognito and WAF.

```bash
npm install
cp .env.example .env               # set LOCALSTACK_AUTH_TOKEN
make up                            # LocalStack
make infra                         # build the Lambdas + terraform apply
make demo EMAIL=you@example.com    # the whole flow from the terminal
make frontend                      # the app on http://localhost:5173
```

## Commands

| Command | Does |
|---|---|
| `make check` | lint, typecheck, unit tests, `terraform fmt`/`validate` |
| `npm run test:coverage` | unit tests (100% coverage required) |
| `npm run test:integration` / `test:api` / `test:e2e` | integration, Postman, Playwright (after `make infra`) |
| `make plan` / `make infra` | Terraform plan / apply against LocalStack |
| `make frontend-docker` | production frontend image on http://localhost:8088 |
| `make aws-infra` / `make test-aws` | deploy to / smoke-test a real AWS account |
| `make help` | every target |

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture.md) | Flow, diagrams, data model, decisions, tech stack, structure |
| [API](docs/api.md) | Endpoints, examples, errors, CORS, Postman collection |
| [Security](docs/security.md) | Protections and limitations |
| [Testing](docs/testing.md) | Test layers, route contract, CI |
| [Deployment](docs/deployment.md) | Environment variables, Terraform, Docker, real AWS |

## License

[MIT](LICENSE)

# Magic Links with Amazon Cognito

Passwordless authentication with **magic links** on **Amazon Cognito custom authentication**. The whole stack runs **100% locally** on LocalStack and is provisioned with Terraform.

Enter your email, click the link you receive, and you get Cognito JWTs. No passwords, and no AWS account needed.

> Based on Yan Cui's article [Implementing Magic Links with Amazon Cognito: A Step-by-Step Guide](https://theburningmonk.com/2023/03/implementing-magic-links-with-amazon-cognito-a-step-by-step-guide/), re-architected around DynamoDB and hashed single-use tokens ([what changed](docs/architecture.md#how-this-differs-from-the-article)).

![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Terraform](https://img.shields.io/badge/Terraform-IaC-7B42BC?logo=terraform&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-Cognito%20·%20Lambda%20·%20DynamoDB%20·%20SES%20·%20SQS%20·%20KMS%20·%20WAF-FF9900?logo=amazonaws&logoColor=white)
![LocalStack](https://img.shields.io/badge/LocalStack-local%20AWS-4D29B4)

## Highlights

- **Secure tokens:** 256-bit random, stored only as SHA-256 hashes, single use (atomic conditional write), 10-minute expiry.
- **No enumeration:** `/login` answers the same, in the same time, for every email; Cognito gives unknown users a decoy challenge.
- **Scanner-safe links:** parameters in the URL fragment, and nothing happens until the user clicks "Sign in as …?".
- **Abuse limits:** per-email cooldown, WAF per-IP limits and per-route throttling; emails go through SQS with retries and a dead-letter queue.
- **Real sessions:** 15-minute JWTs renewed silently, verified again in the Lambda, and a sign-out that revokes the refresh token.
- **Tested end to end:** 100% unit coverage, integration tests against LocalStack, a Postman collection, Playwright E2E, and AWS smoke tests.

Details: [Security](docs/security.md).

## Architecture

![AWS architecture](docs/img/aws-architecture.svg)

1. **Request a link.** `POST /login` queues the request; a worker applies the cooldown, stores the token hash in DynamoDB and emails the link with SES.
2. **Exchange the link.** The callback page posts `{email, token}` to `/auth/verify`, which checks the link and runs Cognito `CUSTOM_AUTH`; a trigger consumes the token atomically.
3. **Use the JWT.** `GET /me` is protected by the Cognito authorizer, and the Lambda verifies the token again.
4. **Session.** `POST /auth/refresh` renews the tokens; `POST /logout` revokes the refresh token.

Sequence diagram, data model and design decisions: [Architecture](docs/architecture.md).

## Quick start

You need Docker, Node.js 22+, Terraform 1.6+, `jq`, and a **LocalStack auth token on a plan that includes Cognito** (it is not part of the free Hobby plan; get one at [app.localstack.cloud](https://app.localstack.cloud/workspace/auth-token)). Without a token you can still run lint, typecheck, unit tests and the Terraform checks.

```bash
npm install
cp .env.example .env         # set LOCALSTACK_AUTH_TOKEN
make up                      # start LocalStack
make infra                   # build the Lambdas and terraform apply
make demo EMAIL=you@example.com
```

```
▶ 1. POST /login  (you@example.com)
▶ 2. Magic link captured by LocalStack SES (sent asynchronously by the SQS worker)
▶ 3. POST /auth/verify  (Cognito CUSTOM_AUTH)
▶ 4. GET /me  (JWT validated by the API Gateway Cognito authorizer)
▶ 5. Reusing the same link must fail
HTTP 401
```

**In the browser:** `make frontend` (http://localhost:5173), enter an email, run `make link EMAIL=<that email>`, open the printed URL and click **Sign in**.

`make emails` shows the captured emails, `make down` deletes everything, and `make help` lists every target. Configuration and deploying to a real AWS account: [Deployment](docs/deployment.md).

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/login` | none | Queues a magic link. Always `202` for a valid email. |
| `POST` | `/auth/verify` | none | Exchanges `{email, token}` for Cognito JWTs. |
| `GET` | `/me` | ID token | Returns the verified claims. |
| `POST` | `/auth/refresh` | refresh token | New ID and access tokens, or `401` once revoked. |
| `POST` | `/logout` | refresh token | Revokes the refresh token. Always `204`. |

Examples, error codes and the Postman collection: [API](docs/api.md).

## Testing

```bash
make check                   # lint, typecheck, unit tests, terraform fmt/validate
npm run test:coverage        # unit tests, 100% coverage required
npm run test:integration     # against LocalStack (after make infra)
npm run test:api             # Postman collection via newman
npm run test:e2e             # Playwright, real browser
```

What each layer covers, the AWS smoke tests and CI: [Testing](docs/testing.md).

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture.md) | Flow and diagrams, differences from the article, data model, decisions, tech stack, project structure |
| [API](docs/api.md) | Endpoints, examples, errors, Postman collection |
| [Security](docs/security.md) | What is protected and how, known limitations |
| [Testing](docs/testing.md) | Commands, coverage per layer, CI |
| [Deployment](docs/deployment.md) | Environment variables, Terraform, deploying to real AWS |

## Credits

- [Yan Cui (theburningmonk)](https://theburningmonk.com/2023/03/implementing-magic-links-with-amazon-cognito-a-step-by-step-guide/), for the original article and the Cognito custom-auth approach.
- [LocalStack](https://localstack.cloud), for making it possible to run all of this on a laptop.

## License

[MIT](LICENSE)

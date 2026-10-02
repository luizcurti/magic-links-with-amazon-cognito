[← README](../README.md) · [Architecture](architecture.md) · [API](api.md) · [Security](security.md) · [Testing](testing.md) · [Deployment](deployment.md)

# API

| Method | Path | Auth | Answers |
|---|---|---|---|
| `POST` | `/login` | none | `202` for every valid email; the link is sent asynchronously |
| `POST` | `/auth/verify` | none | `200` with Cognito JWTs, `401` for a bad link |
| `GET` | `/me` | ID token | `200` with the verified claims, `401` |
| `POST` | `/auth/refresh` | refresh token | `200` with new ID and access tokens, `401` once revoked or expired |
| `POST` | `/logout` | refresh token | `204`, also for unknown or revoked tokens |

Every route can also answer:

| Status | When | Body |
|---|---|---|
| `400` | Invalid input | `{"message": "Invalid request", "errors": [{"field", "message"}]}`, or `{"message"}` for an empty or non-JSON body |
| `403` | Unknown route or method (API Gateway) | `{"message"}` |
| `415` | Body not sent as `Content-Type: application/json` | `{"message": "Content-Type must be application/json"}` |
| `429` | WAF or AWS throttling, with `Retry-After` | `{"message"}` |
| `500` | Unexpected failure, without internals | `{"message": "Internal server error"}` |

Lambda responses carry `Content-Type: application/json`, `Cache-Control: no-store` and `Access-Control-Allow-Origin: <frontend_origin>`.

## Examples

```bash
API=$(terraform -chdir=infrastructure/terraform output -raw api_url)

curl -X POST "$API/login" -H 'Content-Type: application/json' \
  -d '{"email":"luiz@example.com"}'
# 202 {"message":"If the email address is valid, a magic link is on its way."}

curl -X POST "$API/auth/verify" -H 'Content-Type: application/json' \
  -d '{"email":"luiz@example.com","token":"<64 hex chars>"}'
# 200 {"idToken":"eyJ…","accessToken":"eyJ…","refreshToken":"…","expiresIn":900,"tokenType":"Bearer"}
# 401 {"message":"Invalid or expired magic link"}

curl "$API/me" -H "Authorization: <idToken>"
# 200 {"sub":"…","email":"luiz@example.com","emailVerified":true,"authTime":1767268800,"expiresAt":1767269700}

curl -X POST "$API/auth/refresh" -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<refreshToken>"}'
# 200 {"idToken":"eyJ…","accessToken":"eyJ…","expiresIn":900,"tokenType":"Bearer"}
# 401 {"message":"Session expired or revoked"}

curl -X POST "$API/logout" -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<refreshToken>"}'
# 204
```

## CORS

Every route answers the `OPTIONS` preflight for `frontend_origin`. API Gateway's own errors and the WAF's `429` carry `Access-Control-Allow-Origin` too. Locally, the Vite proxy and the nginx image make every call same-origin.

## Postman collection

[`api/magic-links.postman_collection.json`](../api/magic-links.postman_collection.json) covers every route, happy and sad paths, with exact bodies; it reads the magic link from LocalStack's SES mailbox and checks the contract headers on every Lambda response. Run it with `npm run test:api`, or import it into Postman and set `apiUrl`, `clientId` and `queueUrl` from the Terraform outputs.

The input × output matrix per route is in [Testing → Route contract](testing.md#route-contract).

[← README](../README.md) · [Architecture](architecture.md) · [API](api.md) · [Security](security.md) · [Testing](testing.md) · [Deployment](deployment.md)

# API

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/login` | none | Queues a magic link. Always returns `202` for a valid email. |
| `POST` | `/auth/verify` | none | Exchanges `{email, token}` for Cognito JWTs. |
| `GET` | `/me` | Cognito ID token | Returns the verified claims. |
| `POST` | `/auth/refresh` | none (the refresh token is the proof) | Exchanges `{refreshToken}` for new ID and access tokens (`200`), or `401` once it is revoked or expired. The refresh token itself is not rotated. |
| `POST` | `/logout` | none (the refresh token is the proof) | Revokes `{refreshToken}`. Always `204`, also for unknown or already revoked tokens. |

Every route can answer `429` with `Retry-After` when WAF or an AWS dependency throttles the request, `400` with `{message, errors[]}` for invalid input, and `415` when the body is not sent as `Content-Type: application/json`.

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

**CORS.** Every route answers an `OPTIONS` preflight for `frontend_origin`, and every response, including API Gateway's own errors and the WAF's `429`, carries `Access-Control-Allow-Origin: <frontend_origin>`. Locally the Vite proxy makes all calls same-origin; see [Deployment](deployment.md#environment-variables) for a frontend on another origin.

**Postman collection.** [`api/magic-links.postman_collection.json`](../api/magic-links.postman_collection.json) covers every endpoint, happy and sad paths: sign-in (it reads the magic link from LocalStack's SES mailbox), `/me`, token renewal and sign-out, plus `400` validation errors, `415` for a body not declared as JSON, `401` for wrong, reused, forged or revoked tokens, `403` for wrong methods and the cooldown. Import it into Postman and set `apiUrl` (`terraform output -raw api_url`) and `clientId` (`terraform output -raw user_pool_client_id`), or run it headless with `npm run test:api`.

The DynamoDB item behind these routes is described in [Architecture → Data model](architecture.md#data-model).

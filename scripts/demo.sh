#!/usr/bin/env bash
# The magic-link flow from the terminal.
set -euo pipefail

EMAIL="${1:-luiz@example.com}"
API_URL="$(terraform -chdir=infrastructure/terraform output -raw api_url)"

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

step "1. POST /login  ($EMAIL)"
curl -sf -X POST "$API_URL/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}" | jq .

step "2. Magic link captured by LocalStack SES (sent asynchronously by the SQS worker)"
for _ in $(seq 20); do
  LINK="$(node scripts/emails.mjs --link --to "$EMAIL" 2>/dev/null || true)"
  [ -n "$LINK" ] && break
  sleep 0.5
done
[ -n "$LINK" ] || { echo "No magic link arrived for $EMAIL" >&2; exit 1; }
echo "$LINK"
TOKEN="$(echo "$LINK" | sed -E 's/.*token=([0-9a-f]+).*/\1/')"

step "3. POST /auth/verify  (Cognito CUSTOM_AUTH)"
RESPONSE="$(curl -s -X POST "$API_URL/auth/verify" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"token\":\"$TOKEN\"}")"
echo "$RESPONSE" | jq '{tokenType, expiresIn, idToken: (.idToken[0:40] + "..."), accessToken: (.accessToken[0:40] + "...")}'
ID_TOKEN="$(echo "$RESPONSE" | jq -r .idToken)"

step "4. GET /me  (JWT validated by the API Gateway Cognito authorizer)"
curl -s "$API_URL/me" -H "Authorization: $ID_TOKEN" | jq .

step "5. Reusing the same link must fail"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST "$API_URL/auth/verify" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"token\":\"$TOKEN\"}"

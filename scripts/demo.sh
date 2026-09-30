#!/usr/bin/env bash
# End-to-end demo of the magic-link flow from the terminal (curl, jq and the SES mailbox reader).
set -euo pipefail

EMAIL="${1:-luiz@example.com}"
API_URL="$(terraform -chdir=infrastructure/terraform output -raw api_url)"

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

step "1. POST /login  ($EMAIL)"
curl -sf -X POST "$API_URL/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}" | jq .

step "2. Magic link captured by LocalStack SES"
sleep 1
LINK="$(node scripts/emails.mjs --link --to "$EMAIL")"
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

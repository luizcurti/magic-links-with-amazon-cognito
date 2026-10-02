[← README](../README.md) · [Architecture](architecture.md) · [API](api.md) · [Security](security.md) · [Testing](testing.md) · [Deployment](deployment.md)

# Security

## Protections

| Threat | Protection |
|---|---|
| Leaked database | Only SHA-256 hashes are stored; the table is encrypted with a KMS CMK. |
| Forged tokens | `/me` verifies the ID token itself (RS256 against the pool's JWKS, issuer, audience, expiry, `token_use = id`) on top of the authorizer. A JWKS outage answers `500`, so a valid session is never dropped. The JWKS is fetched over https (http only for local hosts). |
| Replay | `used` is set by a conditional write that re-checks hash, `used = false` and expiry; of two racing requests only one wins. |
| Stale links | A new link replaces the item, invalidating older links. |
| Cross-account use | The verify trigger reads the email from Cognito's user attributes, not from the client. |
| Email takeover | The app client cannot write `email` (`write_attributes`). Emails are `email_verified = true`, since tokens are only issued to whoever clicked a link sent there. Users are identified by `sub`. |
| Timing attacks | Hashes are compared with `crypto.timingSafeEqual`; `/login` does no per-email work. |
| Enumeration | `/login` answers the same `202` for every valid email. With `prevent_user_existence_errors`, Cognito runs the triggers for unknown users, who get the same decoy challenge and never tokens; challenges carry no parameters. |
| Log exposure | Tokens and JWTs are never logged; emails are masked (`l***@example.com`); the WAF redacts `Authorization`. |
| URL leakage | Email and token travel in the URL fragment, never sent to servers; the callback page removes them from the address bar and history; `no-referrer` keeps them out of `Referer`. |
| Link scanners, link injection | Nothing is verified until the user clicks "Sign in as …?". |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY`, sent by the Vite server and the nginx image. |
| Cross-site requests | Bodies must be `application/json` (`415` otherwise), which cross-site requires a CORS preflight that foreign origins fail. |
| Email bombing | Per-email cooldown, doubling with each unused link (60 s up to 15 min), reset by using a link or an hour without requests: about 7 emails in the first hour, then 4 an hour. Parallel requests issue at most one link. |
| Mass mailing from one client | WAF: 10 `POST /login` and 300 requests per IP per 5 minutes, `429 Retry-After` beyond. Paths are normalised, so `/login/`, `//login` and encoded spellings count. `/login` has its own throttling budget. |
| Email delivery failures | An undelivered link is deleted and SQS retries the message, then parks it in the DLQ (alarmed). If the delete fails too, the retry of the same message may replace its own undelivered link. A retry after a successful send sends nothing. |
| Cross-origin errors | Preflights for `frontend_origin` only; API Gateway's errors and the WAF's `429` carry `Access-Control-Allow-Origin`. |
| First sign-in | The Cognito user is created by `/auth/verify` after the link is checked, `CONFIRMED` with an unusable random password (the client only allows `CUSTOM_AUTH`). A user left in `FORCE_CHANGE_PASSWORD` is repaired on the next sign-in. |
| Stolen session | `POST /logout` revokes the refresh token and the access tokens issued from it. |
| AWS throttling | Clients get `429 Retry-After: 5`, not `500`. |

## Limitations

- **ID tokens outlive sign-out by up to 15 minutes.** API Gateway checks signature and expiry, not revocation.
- **No refresh-token rotation.** The 30-day refresh token is reused for every renewal.
- **The app client is public.** `InitiateAuth` and `RespondToAuthChallenge` are reachable outside the API's WAF; tokens still require a valid link.
- **Anonymous IPs are allowed.** `AWSManagedRulesAnonymousIpList` is off, so VPN users are not blocked.
- **Implicit sign-up.** Whoever clicks a link sent to their address gets a Cognito user.
- **Tokens in `sessionStorage`**, readable by any script on the page.
- **A link can be spent without a session.** The trigger consumes the link before Cognito issues tokens; if Cognito fails after that, the user requests a new link.
- **Others can raise the cooldown.** Flooding an address makes its owner wait up to 15 minutes for a fresh link; the last one sent still works.
- **Same device only.** A link signs in the browser that opens it.
- **LocalStack does not enforce** `write_attributes`, the WAF, API throttling, gateway-response headers, JWT signatures in the authorizer, or the triggers for unknown users. Integration tests check the configuration, unit tests the logic, and `make test-aws` the behaviour on AWS. API throttling is not load-tested.

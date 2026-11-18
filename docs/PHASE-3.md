# Phase 3: Auth and security — what you built and why

Every request now answers two questions before it touches data:

1. **Authentication: who are you?** `authenticate` middleware verifies the JWT access token.
2. **Authorization: may you do this?** `src/auth/policies.ts` checks role and ownership.

## The login flow

```
register / login ──► password OK? ──no──► 401 "Invalid email or password" (same for unknown email)
                         │yes
                         ▼
                   2FA enabled? ──yes──► { mfaToken } ──► POST /auth/2fa/verify { code } ─┐
                         │no                                                              │
                         ▼                                                                ▼
          { accessToken (15 min JWT), refreshToken (30 days, opaque, rotated) } ◄─────────┘

access token expires ──► POST /auth/refresh { refreshToken } ──► new pair, old refresh token dead
```

## Production criteria covered in this phase

| Concept | Where | What to say in an interview |
| --- | --- | --- |
| Authentication | `services/authService.ts`, `auth/passwords.ts` | bcrypt (cost 12, ~250 ms) so stolen hashes are slow to crack. Login runs bcrypt even for unknown emails and returns one generic message, so neither timing nor wording reveals who has an account. |
| Session management | `auth/tokens.ts`, `refresh_tokens` table | Short-lived stateless JWT access tokens (no DB hit per request, so instances stay stateless) + long-lived opaque refresh tokens stored only as SHA-256 hashes. Every refresh **rotates** the token; reusing an old one revokes the whole login family (stolen-token detection). Logout revokes the family. |
| JWT pitfalls | `verifyAccessToken` | Algorithm pinned to HS256 (blocks `alg: none` and algorithm-confusion attacks); `iss` and `aud` checked so an MFA token can't be used as an access token. Tested with forged, expired and `alg: none` tokens. |
| Two-factor auth | `auth/totp.ts` | TOTP (RFC 6238) implemented with Node's crypto and verified against the RFC's official test vectors. Secret encrypted at rest with AES-256-GCM; each code is single-use (last used time step stored atomically); ±30 s drift allowed; constant-time comparison. Enabling 2FA signs out other sessions. |
| Authorization (RBAC + ownership) | `auth/policies.ts` | Roles: customer, seller, admin. Ownership comes from the token, never the request body: a seller can't list for another seller, a customer can't order as someone else. |
| IDOR | `assertCanSeeCustomerResource` | Someone else's order returns **404, not 403**, so attackers can't confirm which IDs exist. List filters are forced to your own `customerId`. |
| Principle of least privilege | `scripts/least-privilege.sql` | Separate DB roles: a migrator that owns the schema, and an app role that can only read/write rows (no DROP/ALTER). Admins can't self-register; the first one is created from the CLI. |
| Secrets management | `config/env.ts`, `docker-compose.yml` | No secrets in git or in the image. Secrets come from env vars or `*_FILE` paths (Docker/Kubernetes secrets). In production the app **refuses to start** with the development defaults. |
| Rate limiting | `middleware/rateLimit.ts` | Global per-IP limit on the API, plus a strict limit on login/2FA/refresh that counts only *failures* (stops guessing without punishing real users) and one on sign-ups. Returns 429 with standard `RateLimit` headers. `trust proxy` makes `req.ip` the real client behind Nginx. In-memory for now; Redis in Phase 4 shares counts across instances. |
| XSS | `schemas/common.ts` `safeText`, helmet | JSON API with `nosniff` and a strict CSP; names and titles reject `<`, `>` and control characters as defence in depth. The frontend's output escaping is still the main defence. |
| CSRF | `auth/middleware.ts` | Tokens travel in the `Authorization` header, which browsers never attach automatically, so cross-site requests can't ride on a user's session. If you ever move tokens into cookies, add `SameSite=Strict` + CSRF tokens. |
| CORS | `app.ts` | Allow-list of browser origins (`CORS_ORIGINS`); default is none. CORS protects users' browsers, it is not server-side access control. |
| SQL injection | (Phase 2) + auth tests | Parameterized queries everywhere; injection payloads in login and names are tested. |
| File upload security | `routes/listings.ts`, `storage/imageStorage.ts` | Size limit enforced while streaming (413); file type detected from **magic bytes**, not the filename or Content-Type; random server-generated filenames (no path traversal or overwrites); stored outside any web root; served with the sniffed type, `nosniff` and a `sandbox` CSP; max 10 per listing; owner-only. |
| Dependency vulnerabilities | `.github/dependabot.yml`, CI | Dependabot opens PRs for vulnerable/outdated packages; CI fails on high-severity `npm audit` findings in production deps. We also replaced a TOTP library with ~60 audited lines to shrink the attack surface. |

## Try it

```bash
# register a seller and grab the token
curl -s -X POST localhost:3000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"shop@example.com","password":"correct horse battery staple","name":"My Shop","role":"seller"}'

# use it
curl -X POST localhost:3000/api/v1/listings -H "Authorization: Bearer <accessToken>" \
  -H 'content-type: application/json' -d '{"title":"Desk Lamp","priceCents":1500,"stock":3}'

# turn on 2FA: add the otpauthUri to Google Authenticator / 1Password, then enable with a code
curl -X POST localhost:3000/api/v1/auth/2fa/setup -H "Authorization: Bearer <accessToken>"
```

## Practice questions

1. Why are access tokens short-lived JWTs but refresh tokens opaque random strings in the DB?
   What can you do with one that you can't with the other?
2. Walk through refresh token rotation and what happens when a stolen token is replayed.
3. What is the `alg: none` attack and how does `algorithms: ['HS256']` stop it?
   When would you switch to RS256 (public/private keys)?
4. 401 vs 403 vs 404: which does each failure here return, and why return 404 for another
   customer's order?
5. Why does login run bcrypt even when the email doesn't exist?
6. How does TOTP work? Why store the last used time step?
7. Why isn't this API vulnerable to CSRF, and what would change if tokens lived in cookies?
8. Why is an in-memory rate limiter a problem with 3 API instances? How does Redis fix it?
9. List five ways a file upload can be attacked and how each is blocked here.
10. Why should the app's database user be unable to `DROP TABLE`?

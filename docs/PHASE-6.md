# Phase 6: The website — what you built and why

Phases 1 to 5 built and ran an API. Phase 6 puts a real website on top of it: a React +
TypeScript single-page app where shoppers browse, buy and cancel, and sellers manage
listings, photos and webhooks. It is served by the same Nginx, from the same origin as the
API, and tested in a real browser on every pull request.

## The shape

```
 browser ──HTTPS──► nginx :8443 ─┬─ /            → index.html (React app; no-cache)
                                 ├─ /assets/*    → hashed JS/CSS (cached 1 year, immutable)
                                 ├─ /api/v1/…    → api × 3 (as before)
                                 └─ /api/v1/listings/:id/images/:imageId → edge image cache

 web/src
   api/client.ts      fetch wrapper: access token in memory, refresh via cookie, retries 401 once
   api/endpoints.ts   one typed function per API call
   auth/              session provider (restore on load, login, 2FA, logout), route guard
   cart/              reducer + localStorage; prices re-checked live in the cart
   pages/             Shop, Product, Cart/Checkout, My orders, Login/2FA, Register, Account,
                      Seller dashboard, Listing editor (+ photos), Webhooks (+ delivery log)
```

Run it: `cd web && npm install && npm run dev` (http://localhost:5173, with `npm run dev`
for the API in another terminal), or the full stack at https://localhost:8443.

## Production criteria covered in this phase

| Concept | Where | What to say in an interview |
| --- | --- | --- |
| Token storage in the browser | `web/src/api/client.ts`, `src/auth/cookies.ts` | The 15-minute access token lives **in memory only**; the 30-day refresh token is in an **httpOnly** cookie JavaScript can't read. An XSS bug can use the session while the page is open, but can't steal a long-lived credential. `localStorage` holds only a "probably logged in" hint. |
| Cookie hardening | `setRefreshCookie` | `HttpOnly`, `Secure` (forced on in production by the config loader), `SameSite=Strict`, `Path=/api/v1/auth` so it's sent to the auth endpoints and nothing else. API clients opt out by not sending `X-Auth-Transport: cookie` and keep using the JSON body. |
| CSRF | `assertSameOrigin`, `cookieSessionPrecheck` | Bearer headers are CSRF-proof; cookies aren't, so cookie requests need three things: SameSite=Strict, a custom header (forms can't send one; cross-site fetch needs a preflight we refuse), and `Sec-Fetch-Site: same-origin` (set by the browser, unforgeable), falling back to an `Origin` check. |
| Silent refresh, safely | `refreshSession` | On a 401 the client refreshes **once** for all requests that failed together, then retries. Refresh tokens rotate and reuse is treated as theft (Phase 3), so two tabs refreshing at once would log you out: a **Web Lock** makes tabs take turns. |
| Rate limits vs. real users | `cookieSessionPrecheck` | A first-time visitor has no cookie; that 401 is answered **before** the failed-login limiter, so page loads can't lock anyone out of logging in. Caught by a test, not in production. |
| Idempotent checkout from the UI | `pages/CartPage.tsx` | A key per checkout attempt (`crypto.randomUUID`). If the outcome is unknown (network error, 5xx, 429, "in progress"), "Try again" reuses the **same key**, so the server replays the order instead of placing a second one. After a definite answer (201, out of stock), the next try gets a new key. |
| Server is the source of truth | Cart, `RequireAuth` | The cart's saved prices are display-only; the cart re-fetches live price and stock and the server prices the order. Route guards only hide pages; the API enforces every permission itself. |
| Avoiding N+1 from the browser | `primaryImageUrl` in `repositories/postgres/listings.ts` | Each listing now carries its first photo's URL (one indexed subquery), so a page of 12 cards is 1 request, not 13. Uploading a photo invalidates the cached listing so the thumbnail appears right away. |
| Server state vs. UI state | TanStack Query | Server data is cached by key, deduplicated, retried (5xx and network only, never 4xx), and invalidated after writes (`['listings']`, `['orders']`). Per-user queries are marked `private` and dropped on logout so the next user never sees them. |
| XSS | React, CSP in Nginx | React escapes everything it renders (no `dangerouslySetInnerHTML` anywhere). Nginx sends a strict CSP for the site: scripts, styles, fonts and API calls from our own origin only, no inline script, `frame-ancestors 'none'`. Fonts are self-hosted, which is what lets `font-src 'self'` stay strict. |
| Open redirect | `safeRedirect` | After login we return to the page you came from, but only same-site paths (`/orders`, not `//evil.example`). |
| Static hosting and caching | `deploy/nginx/templates/default.conf.template` | Vite puts a content hash in every asset name, so `/assets/*` is cached for a year (`immutable`); `index.html` is `no-cache` so a deploy shows up on the next visit. Unknown paths fall back to `index.html` (client-side routing); unknown assets are real 404s. |
| Same origin, no CORS | Vite proxy, Nginx | Site and API share an origin in dev (Vite proxy) and in production (Nginx), so no CORS rules and the SameSite cookie just works. |
| Build once, ship the image | `web/Dockerfile`, CI `publish` | Multi-stage: Node builds the site, the final image is Nginx plus the static files (no Node). CI publishes `ghcr.io/<owner>/marketplace-backend-web` next to the API image. |
| Performance | `App.tsx` | Route-level code splitting: shoppers never download the seller dashboard or the QR-code library. Placeholder data keeps the previous page on screen while the next loads. |
| Accessibility | throughout | Real labels on every input, a skip link, visible focus rings, `role="alert"` for errors, status text not conveyed by color alone, `prefers-reduced-motion` respected, dark mode via `prefers-color-scheme`. The tests find elements by role and label, the way assistive tech does. |
| Testing pyramid | `web/src/**/*.test.tsx`, `web/e2e/` | Vitest + Testing Library for logic and components (fetch mocked: refresh single-flight, idempotency-key reuse, 2FA step). One Playwright test drives a real browser through the deployed stack in CI: seller lists a product with a photo; customer buys, reloads (cookie session), cancels; stock comes back. |

## Design notes

The site is styled like a two-colour risograph flyer for a street market, not a template:

- **Palette:** newsprint paper, navy ink, and three flat spot colours (blue, pink, yellow).
- **Type:** one family, Archivo, at its extremes: wide and black for headlines, regular for
  reading, with JetBrains Mono for labels. Both are self-hosted.
- **Print details:** an off-register "second ink" shadow on headlines and on cards when you
  hover, halftone dots, paper grain, price stickers stuck on at slightly different angles,
  a rotating stamp with the live product count, and a till-receipt order summary.
- **Illustrations:** the demo products in `scripts/seed-assets/` are original drawings in
  the same inks (SVG sources next to the PNGs the seed script uploads). A product without
  a photo shows its initial on a halftone plate, tinted from its title so it's stable.
- **Care:** dark theme, reduced-motion support, visible focus rings, and the ticker and
  stamp are hidden from screen readers.

It is all hand-written CSS with tokens in `web/src/styles.css` (no framework).

## Try it

```bash
# Full stack (from the repo root; see Phase 5 for secrets and the certificate)
docker compose up -d --build
NODE_EXTRA_CA_CERTS=deploy/nginx/certs/tls.crt node scripts/seed-demo.mjs
open https://localhost:8443       # accept the self-signed certificate once
```

Then:

- Sign up as **Sell**, create a listing, add a photo. Open the shop in another window: it's there.
- Sign up as **Shop** (private window), add to cart, place the order, then cancel it from My orders.
- In DevTools → Application → Cookies: `mp_refresh` is HttpOnly, SameSite=Strict, path
  `/api/v1/auth`. Try `document.cookie` in the console: it isn't there.
- DevTools → Network → throttle to "Offline", click "Place order", go back online, click
  "Try again": one order, and the two requests share an `Idempotency-Key`.
- Turn on 2FA from Account, log out, log in again with the code.
- As a seller, add a webhook (needs a public HTTPS URL in the Docker stack; use
  `npm run dev` with `WEBHOOK_ALLOW_INSECURE=true` for a local receiver) and watch the
  delivery log update.
- Run the browser test yourself: `cd web && npx playwright install chromium && npx playwright test --headed`.

## Practice questions

1. Where would you store a JWT in a browser, and why not `localStorage`?
2. Why is a cookie vulnerable to CSRF but an `Authorization` header isn't? List three
   defences used here and what each one stops.
3. Refresh tokens rotate and reuse logs everyone out. What goes wrong with two open tabs,
   and how does the client prevent it?
4. A checkout request times out. When should the retry reuse the Idempotency-Key, and when
   must it use a new one?
5. Why does the cart re-fetch listings instead of trusting the prices it saved?
6. What does `Cache-Control: immutable` mean, and why is it safe for `/assets/*` but not
   for `index.html`?
7. Why does a single-page app need `try_files $uri /index.html`? What breaks without it?
8. What does the Content-Security-Policy here prevent if an attacker manages to inject
   HTML into a product description?
9. How does `primaryImageUrl` avoid an N+1 problem, and what had to change in the cache?
10. Unit test, component test, end-to-end test: what does each catch that the others miss?

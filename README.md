# render-html

Self-hosted clone of [htmlcsstoimage.com](https://htmlcsstoimage.com) on Cloudflare. One Worker serves a password-protected web UI, a JSON render API, and an OAuth-protected MCP server. Renders run on Cloudflare Browser Rendering; output files land in R2 and expire after 30 days.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | Web UI (admin password session) |
| `POST /api/render` | JSON render API — `{ html | url, format: png\|jpeg\|webp\|pdf, width, height, fullPage }` → `{ url, key, bytes }` |
| `GET /files/:key` | Download a generated file (unguessable UUID keys) |
| `POST /mcp` | MCP endpoint (OAuth 2.1 bearer) |
| `GET /authorize` | OAuth consent + password approval page |

## MCP tools

- `render_image` — HTML or URL → png/jpeg/webp, viewport + fullPage options
- `render_pdf` — HTML or URL → PDF, viewport options

## Deploy

```sh
npm install

# 1. R2 bucket + 30-day lifecycle rule
npx wrangler r2 bucket create render-html-files
npx wrangler r2 bucket lifecycle add render-html-files expire-30d renders/ --expire-days 30

# 2. KV namespace for OAuth state; paste the printed id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV

# 3. Secrets
openssl rand -hex 32  # use for COOKIE_ENCRYPTION_KEY
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put COOKIE_ENCRYPTION_KEY

# 4. Deploy
npx wrangler deploy
```

Connect an MCP client to `https://<worker>.workers.dev/mcp` — the OAuth flow opens the password approval page.

## OAuth lifetime and failure handling

- Access tokens last one hour. Refresh tokens expire after **30 days of inactivity**; each successful refresh starts a new 30-day window. Existing unexpired grants adopt this policy on their next successful refresh. Rotation, lost-response retry handling and revocation remain enforced by `@cloudflare/workers-oauth-provider`.
- Dynamic client registrations retain the provider's 90-day TTL and automatic renewal on successful token requests after half that lifetime. Public clients must register with `token_endpoint_auth_method: "none"` and use PKCE. Registrations omitting the method remain confidential (`client_secret_basic`, with the provider's legacy Basic/post compatibility); clients must retain their issued secret. Explicitly registered authentication methods are enforced.
- URL-based client IDs use Client ID Metadata Documents (CIMD), fetched and validated by the provider with its bounded cache and SSRF protection. In provider 1.2.3, a failed lookup (including an upstream outage) becomes `401 invalid_client` **before** the refresh token is checked. That incorrectly looks like permanently invalid credentials to MCP clients. The Worker instead returns `503 temporarily_unavailable`, `Retry-After: 30` and `Cache-Control: no-store`, without consuming or rotating the token. Clients should retry with the same credentials, not delete them or re-register.
- The provider does not expose a typed distinction between network failures and invalid CIMD documents. All metadata-resolution failures therefore fail closed as unavailable, including malformed/removed documents: no token is issued, and metadata must become valid before retry can succeed. The Worker does not trust stale metadata or weaken client authentication. Failed CIMD resolution during authorization also returns 503.
- Missing registrations, wrong/missing secrets and method mismatches still return `invalid_client`. Structured `oauth_error` logs record `category` and `reason`, never request bodies, tokens, secrets or full client metadata. Look for `metadata_resolution_failed`, `client_not_found`, `client_secret_mismatch` or `token_endpoint_auth_method_mismatch` to distinguish causes. An expired/revoked grant returns `invalid_grant`; already-expired/deleted records cannot be recovered safely and require one new authorization (and registration if missing). The admin session cookie is separate from refresh authentication.

These failure paths are reproduced in automated tests; confirming which one caused a particular production incident requires the corresponding Worker log. The error string `Token refresh failed: invalid_client` alone does not identify whether the client's registration, secret or metadata lookup failed.

## Validation

```sh
npm ci
npm run types
npm run check
npm test
npx wrangler deploy --dry-run
```

`npm test` runs the MCP-result tests and OAuth HTTP integration tests in local **workerd**, using the production Worker handlers and real OAuth provider. OAuth tests use an expiration-aware in-memory KV, a controllable clock and mocked CIMD responses; they never call production, Browser Rendering or R2. They cover password consent, PKCE, confidential/public clients, outages and recovery with the same refresh token, rotation/replay, rolling expiration beyond 90 days, idle expiration and revocation. `npm run check` type-checks both source and tests.

## Local dev

```sh
cp .dev.vars.example .dev.vars   # set ADMIN_PASSWORD + COOKIE_ENCRYPTION_KEY
npm run dev
```

The browser binding sets `remote: true` in `wrangler.jsonc` — required so `wrangler dev` renders on Cloudflare's Browser Rendering quota instead of spawning local Chrome. The flag only affects local dev; it has no effect on the deployed Worker.

## Notes

- Single user: web UI and OAuth approval both check `ADMIN_PASSWORD`.
- Rendered file URLs are unauthenticated but unguessable; they expire via the R2 lifecycle rule.
- Viewport is capped at 16–4000 px; HTML input capped at 2 MB. PDFs render at the viewport size.
- URL renders block private/loopback/link-local IP literals and local hostnames (`.localhost`, `.local`, `.internal`). Hostnames resolving to private IPs are not blocked — the browser sandbox is the last line.
- Login and OAuth password attempts are throttled: 5 failures per IP per 10 minutes, stored in `OAUTH_KV`.

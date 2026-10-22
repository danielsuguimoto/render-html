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

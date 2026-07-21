# EVE-Carbon presence worker

Counts how many copies of EVE-Carbon are running right now — anonymously.
Apps send a heartbeat every ~5 minutes containing only a random per-launch
session UUID; the worker keeps the IDs in memory for 7 minutes and answers
with the current count. Nothing is stored, logged, or identifying.

## Deploy (one time, free Cloudflare account)

```bash
cd infra/presence-worker
npx wrangler login          # opens browser, authorizes your CF account
npx wrangler deploy
```

Wrangler prints the worker URL, e.g.
`https://eve-carbon-presence.<your-subdomain>.workers.dev`.

## Point the app at it

The app reads `PRESENCE_URL` from `.env` (same file as `EVE_CLIENT_ID`):

```
PRESENCE_URL=https://eve-carbon-presence.<your-subdomain>.workers.dev/presence
```

- Local dev: add the line to your repo `.env`.
- Released builds: add a `PRESENCE_URL` repository secret on GitHub — the
  build workflow writes it into the packaged `.env`. If the secret is unset
  the feature is silently disabled (no pings, no counter shown).

## Behaviour / limits

- Count window: sessions seen in the last 7 minutes (heartbeat is 5 min ± jitter).
- Free tier: 100k requests/day ≈ ~340 users running 24/7 — real usage is far
  below that; the $5/mo Workers plan lifts it to 10M/month if ever needed.
- Always on when PRESENCE_URL is configured — no user-facing opt-out.

## Endpoint

- `POST /presence` body `{"id":"<uuid>"}` → `{"count":N}` (registers/refreshes the session)
- `GET  /presence` → `{"count":N}` (read-only)

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
  build workflow writes it into the packaged `.env`.

> **If the secret is unset the feature is silently disabled** — no pings, no
> counter. This is not hypothetical: every release up to and including v3.3.0
> shipped with `PRESENCE_URL=` because the secret had never been created, so the
> counter worked under `npm start` (which reads the repo `.env`) and never once
> in an installed build. The workflow does emit
> `::warning::PRESENCE_URL secret is empty`, which is easy to miss in a green
> run — if the counter is missing, check that warning in the build log first.

## Behaviour / limits

- Count window: sessions seen in the last 7 minutes (heartbeat is 5 min ± jitter).
- Free tier: 100k requests/day ≈ ~340 users running 24/7 — real usage is far
  below that; the $5/mo Workers plan lifts it to 10M/month if ever needed.
- Always on when PRESENCE_URL is configured — no user-facing opt-out.

## Endpoint

- `POST /presence` body `{"id":"<uuid>", "v":"3.3.0"}` → `{"count":N,"versions":{…}}`
  (registers/refreshes the session)
- `GET  /presence` → `{"count":N,"versions":{…}}` (read-only)

```json
{ "count": 61, "versions": { "4.0.0": 19, "3.7.0": 12, "3.3.0": 23, "unknown": 7 } }
```

### Version reporting is optional, on purpose

`v` may be omitted or malformed; the session is counted either way and lands in
the `unknown` bucket. That is what keeps the counter agnostic across releases —
a user who never upgrades past 3.3.0 stays in the total forever, and every
client built before version reporting existed keeps working untouched.

`count` is the number of live sessions, never the sum of the buckets, so a
rejected version string can never remove somebody from the headline figure.
Versions are validated against a strict `major.minor.patch` pattern before being
echoed back: the field is attacker-controlled and the response is public.

### Testing it by hand

`test/presence_worker.test.js` covers the logic offline. If you do probe the
live endpoint, **use a real UUID** — ids that are not UUID-shaped are rejected
by design, so a hand-written id like `probe-1` returns `{"count":0}` and looks
exactly like a broken worker:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"id\":\"$(uuidgen)\",\"v\":\"3.3.0\"}" \
  https://eve-carbon-presence.eve-carbon.workers.dev/presence
```

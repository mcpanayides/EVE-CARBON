# zkill-fanout

One consumer of zKillboard's R2Z2 feed instead of one per install.

## Why

The intel feed walks a sequence cursor. Done per-client, request volume scales
with **installs**: 100k clients at the feed's idle cadence is roughly 6,700
requests/second against a service whose operators describe their own scale as
"thousands of requests per minute". The client-side rate governor bounds one
install and cannot change that arithmetic — only fanning out can.

Every client walks the *same* cursor, so they all ask for the same URLs at the
same time. Caching by URL therefore collapses them onto one upstream fetch.

## What it serves

The upstream routes, unchanged, so the app needs no protocol change:

| route | cache | note |
|---|---|---|
| `GET /ephemeral/sequence.json` | 5s | the only moving part; this is what bounds upstream load |
| `GET /ephemeral/<id>.json` | 1h | a killmail never changes once published |
| `GET /health` | 60s | check a deploy without touching upstream |

Anything else 404s — it is not an open proxy onto the rest of zKillboard's API.

## Deploy

```bash
cd workers/zkill-fanout
npx wrangler deploy          # first run will prompt for a Cloudflare login
curl https://<your-worker>.workers.dev/health
```

## Point the app at it

Unset, the app talks to zKillboard directly exactly as before — deploying this
changes nothing until you opt in:

```bash
EVE_CARBON_ZKILL_BASE=https://<your-worker>.workers.dev
```

Once it has run under real traffic, make it the default in
`src/intel/zkill_stream.js` so it helps every user rather than only the ones who
set a variable. **Do that only after the Worker is deployed and verified** — a
default pointing at a Worker that does not exist takes the intel feed down for
everyone.

## Checking it works

`X-Fanout: eve-carbon` is on every response. Compare the Worker's request count
in the Cloudflare dashboard against the number of clients: fan-out is working
when upstream requests stay flat as clients are added.

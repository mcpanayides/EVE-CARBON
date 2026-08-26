# zkill-fanout

Collapses many clients' zKillboard polling onto a shared cache, so upstream load
stops scaling with installs.

## Why

The intel feed walks zKillboard's R2Z2 sequence cursor. Done per-client, request
volume scales with **installs**: at the growth target that is thousands of
requests per second against a service whose operators describe their own scale
as "thousands of requests per *minute*". The client-side rate governor bounds one
install and cannot change that arithmetic — only sharing can.

It works because every client walks the *same* cursor, so they ask for identical
URLs at the same moment and the cache collapses them.

**How much sharing, precisely.** Cloudflare's cache is **per data centre**, not
global, so upstream sees roughly one fetch per cached object *per colo with
active clients* — not one worldwide. Against 100k direct clients that is still
around a hundredfold reduction, but "one consumer instead of 100,000" (as an
earlier draft of this file claimed) is wrong. Turning on **Tiered Cache** funnels
colos through an upper tier and gets close to the original claim.

## Two protocols

Both are served. The mirror is for a first, reversible deploy; the batched feed
is what makes the running cost sane.

### v1 — mirror (deploy this first)

The upstream routes, unchanged, so the app needs no protocol change and can be
pointed back by unsetting one variable:

| route | cache | note |
|---|---|---|
| `GET /ephemeral/sequence.json` | 5s | the only moving part upstream |
| `GET /ephemeral/<id>.json` | 1h | a killmail never changes once published |

Correct, but **one request per killmail**. On `workers.dev` every one of those
is a billed invocation *even on a cache hit*, because the Worker still runs — so
this relieves zKillboard while moving the cost to us.

### v2 — batched feed

Same cursor, quantised into fixed blocks of 50 (`bucket.js`):

| route | cache | note |
|---|---|---|
| `GET /feed/sequence.json` | 5s | newest sequence, plus its block |
| `GET /feed/<bucket>.json` | 24h complete / 15s filling | up to 50 killmails in one response |

Two properties do the work, and `test/zkill_bucket.test.js` pins both:

- **Block boundaries are fixed**, not derived from each client's cursor, so
  every client asks for the *same* URLs. A `?since=N` endpoint would give each
  client a distinct URL and a distinct cache miss — barely better than no
  batching.
- **A finished block is immutable**, so it can be cached for a day. Only the
  newest, still-filling block is volatile — caching *that* hard would freeze the
  feed for everyone at once.

Cost per client drops from ~32 requests/minute to ~4.5, and the block fetches
are shared rather than per-client.

Anything else 404s — it is not an open proxy onto the rest of zKillboard's API.

## What it will actually cost

From the presence Worker's own numbers (926 invocations/day at one beat per
5 minutes ≈ **77 instance-hours/day**, ~3.2 average concurrent):

| | requests/day | plan |
|---|---|---|
| v1 mirror | ~146,000 | over the 100k/day free tier; fits the $5 plan at ~44% |
| v2 batched | ~21,000 | comfortable |

The v1 headroom is only about **2.3× current usage** before the $5 plan's 10M
requests/month is gone. That is ~7 concurrent users, not 700 — which is why the
batched feed exists now rather than "at scale".

### The custom-domain trick

On `workers.dev`, **every request invokes the Worker and is billed, cache hit or
not**. Cloudflare's edge cache can only serve a request *without* running the
Worker when it is on a zone with Cache Rules — i.e. a custom domain.

Given every client requests identical block URLs, that turns nearly all of those
invocations into plain CDN hits:

1. Add the domain to Cloudflare, then bind it under the Worker's **Domains &
   Routes**.
2. **Rules → Cache Rules**, matching `http.request.uri.path contains "/feed/"`:
   *Eligible for cache*, Edge TTL **respect origin** (the Worker already sends
   `Cache-Control`), Browser TTL respect origin.
3. Confirm with `curl -sI https://<domain>/feed/<bucket>.json | grep -i cf-cache-status`
   — it should read `HIT` on the second request.

Leave `/feed/sequence.json` out of the long-cache rule; its 5s TTL is what keeps
the feed live.

## Deploy

```bash
cd workers/zkill-fanout
npx wrangler deploy          # first run prompts for a Cloudflare login
curl https://<your-worker>.workers.dev/health
```

Then point the app at it — unset, it talks to zKillboard exactly as before, so
deploying changes nothing until you opt in:

```bash
EVE_CARBON_ZKILL_BASE=https://<your-worker>.workers.dev
```

Once it has run under real traffic, make it the default in `resolveZkillBase()`
(`src/intel/zkill_stream.js`) so it helps every user rather than only those who
set a variable. **Only after it is deployed and verified** — a default pointing
at a Worker that does not exist takes the intel feed down for everyone.

## Client migration to the batched feed

Not done: the client still speaks v1. `bucket.js` is written so both sides can
share it. The change in `src/intel/zkill_stream.js` is to poll
`/feed/sequence.json`, call `bucketsToFetch(cursor, newest)`, fetch those blocks
and feed each `kills[]` entry through the existing `onKillmail` path. The cap in
`bucketsToFetch` replaces `MAX_CATCHUP`; `STEP_MS` becomes unnecessary, since a
block is one request rather than fifty.

## Checking it works

`X-Fanout: eve-carbon` is on every response. Fan-out is working when the
Worker's request count stays flat as clients are added; the custom-domain cache
rule is working when `cf-cache-status: HIT` dominates.

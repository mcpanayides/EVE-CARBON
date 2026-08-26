/**
 * Sequence bucketing — the thing that makes the fan-out cheap.
 *
 * THE PROBLEM WITH MIRRORING
 *
 * Mirroring upstream one-killmail-per-request means a client asks for ~1,900
 * URLs an hour (every killmail in New Eden, plus cursor polls). On workers.dev
 * every one of those is a billed Worker invocation even when it is a cache hit,
 * because the Worker still runs. Cost then scales with clients, which is the
 * problem we were trying to get away from — it just moves the bill from
 * zKillboard to us.
 *
 * THE PROBLEM WITH `?since=N`
 *
 * The obvious fix — "give me everything since my cursor" — fragments the cache.
 * Every client has a slightly different N, so nearly every request is a distinct
 * URL and a distinct miss. A batch endpoint that no two clients share is barely
 * better than no batching at all.
 *
 * BUCKETS
 *
 * Quantise the cursor instead. Sequence ids are grouped into fixed blocks, and
 * a client fetches whole blocks. Two properties fall out, and both matter:
 *
 *   • Every client asks for the SAME URLs, because the block boundaries are
 *     fixed rather than derived from each client's position. One cache entry
 *     serves everyone.
 *   • A completed block is IMMUTABLE — killmails never change and no id is ever
 *     added to a finished block — so it can be cached indefinitely. Only the
 *     newest, still-filling block is volatile.
 *
 * That turns a per-client cost into a per-block cost: ~800 blocks a day at
 * current kill rates, shared by every client alive, however many that is.
 */

/**
 * Killmails per block.
 *
 * 50 is a balance of three things. Larger blocks mean fewer requests but a
 * bigger fetch to fill one (the Worker makes one subrequest per killmail, and
 * the free plan caps a request at 50 subrequests). Smaller blocks lose the
 * batching. At ~40k kills/day, 50 gives ~800 blocks/day and a block of roughly
 * 150 KB.
 */
export const BUCKET_SIZE = 50;

/**
 * A sequence id, or null.
 *
 * Not just `Number(v)`: `Number(null)` and `Number('')` are both 0, which is a
 * perfectly valid bucket, so a missing cursor would silently be read as "start
 * from the beginning of time" and walk the whole sequence.
 */
function toSeq(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Which block a sequence id belongs to. */
export function bucketOf(seq) {
  const n = toSeq(seq);
  return n === null ? null : Math.floor(n / BUCKET_SIZE);
}

/** The inclusive id range a block covers. */
export function bucketRange(bucket) {
  const b = toSeq(bucket);
  if (b === null) return null;
  const from = Math.floor(b) * BUCKET_SIZE;
  return { from, to: from + BUCKET_SIZE - 1 };
}

/**
 * Is this block finished, given the newest sequence upstream has?
 *
 * Only a finished block is safe to cache hard: the newest one is still filling,
 * and caching it for an hour would freeze the feed for every client at once —
 * the exact failure the direct client avoids by never caching sequence.json.
 */
export function isComplete(bucket, newestSeq) {
  const r = bucketRange(bucket);
  const newest = toSeq(newestSeq);
  if (!r || newest === null) return false;
  return r.to < newest;
}

/**
 * The blocks a client at `cursor` needs to reach `newestSeq`, oldest first.
 *
 * Capped, because a client that has been shut for a week must not try to walk
 * back to where it left off: everything in that gap is far older than the
 * twenty minutes that says anything about who is near now, so it would be
 * hundreds of requests to arrive at the same place. Returning the newest
 * `maxBuckets` is the same "jump to the present" the direct client does.
 */
export function bucketsToFetch(cursor, newestSeq, maxBuckets = 4) {
  const first = bucketOf(cursor);
  const last = bucketOf(newestSeq);
  if (first === null || last === null || last < first) return [];
  const cap = Math.max(1, Number(maxBuckets) || 1);
  const out = [];
  for (let b = first; b <= last; b++) out.push(b);
  return out.length > cap ? out.slice(-cap) : out;
}

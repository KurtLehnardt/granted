/**
 * lib/security/rateLimit.ts — a lightweight, best-effort, per-IP fixed-window
 * rate limiter for the unauthenticated LLM endpoints (`/api/match`,
 * `/api/interview`). These routes drive real Anthropic/OpenAI spend, so an
 * unthrottled caller is a denial-of-wallet exposure (security review MEDIUM).
 *
 * SCOPE: this counter lives in one process's memory. Granted runs locally as a
 * single instance, so that is the whole population and the cap holds. It stays a
 * deliberate soft cap — it blunts a naive burst / accidental retry loop from one
 * client cheaply and with zero infra. If this is ever fronted by more than one
 * process, the map is not shared and a hard guarantee would need a shared counter.
 *
 * Pure and dependency-free; never throws.
 */

export interface RateLimitResult {
  ok: boolean;
  /** Requests remaining in the current window (>= 0). */
  remaining: number;
  /** Milliseconds until the window resets (for a Retry-After hint). */
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Count one hit against `key` in a fixed window. Returns `ok: false` once the
 * window's `limit` is exceeded, until the window rolls over.
 */
export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
  now: number = Date.now(),
): RateLimitResult {
  const limit = Math.max(1, Math.floor(opts.limit));
  const windowMs = Math.max(1, Math.floor(opts.windowMs));

  // Opportunistic sweep so the map can't grow unbounded across many IPs.
  // (Deleting the current key during Map.forEach is safe.)
  if (buckets.size > 5000) {
    buckets.forEach((b, k) => { if (b.resetAt <= now) buckets.delete(k); });
  }

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterMs: 0 };
  }

  if (existing.count >= limit) {
    return { ok: false, remaining: 0, retryAfterMs: Math.max(0, existing.resetAt - now) };
  }

  existing.count += 1;
  return { ok: true, remaining: limit - existing.count, retryAfterMs: 0 };
}

/**
 * Best-effort client identifier from proxy headers — NOT a security boundary.
 * Both `x-forwarded-for` and `x-real-ip` are ordinary request headers that any
 * non-browser client (curl, a script, a bot) can set to any value it likes, so
 * a raw HTTP client can mint a fresh rate-limit bucket on every request simply
 * by varying this header, bypassing the cap entirely. This function's purpose
 * is therefore a politeness/accident guard — it blunts a naive retry loop or a
 * buggy client, not a deliberate abuser — never an anti-abuse control.
 *
 * The control that actually blocks cross-origin, off-machine and DNS-rebinding
 * abuse is `isLoopbackRequest` (`lib/corpus/loopback.ts`), which is now applied
 * on every spend route ahead of the rate limit. That check relies on
 * `x-forwarded-for` too, but Next fills it from the raw socket unless the
 * client supplies one, and it cross-checks the `host` header and either
 * `sec-fetch-site` or `origin` — properties a browser cannot forge. A raw
 * client CAN still forge all of those, but at that point it is simply running
 * on the same machine, which is the posture this app already trusts.
 *
 * The headers are still honored here (instead of collapsing to one constant
 * key) because running behind a reverse proxy is a legitimate deployment, and
 * because `npm run dev:lan` deliberately serves several real peers on a
 * trusted network — bucketing per forwarded IP keeps one noisy peer from
 * starving the others, which a single global bucket would not.
 */
export function clientKey(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Test-only: clear all buckets between cases. */
export function __resetRateLimits(): void {
  buckets.clear();
}

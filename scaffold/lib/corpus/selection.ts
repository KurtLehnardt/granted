import type { Opportunity } from "../types";
import { dropExpiredOpportunities } from "./expiry";

/** Per-source weight for cap allocation (Settings "Max cached opportunities",
 *  scripts/refresh-corpus.mjs). Sources not listed here default to weight 1. */
export const DEFAULT_SOURCE_WEIGHTS: Record<string, number> = {
  "grants.gov": 2,
  sbir: 2,
  usaspending: 1,
  "assistance-listings": 1,
};

/**
 * Splits `cap` across the given sources proportionally to weight ×
 * availability, capped by each source's `available` count, and redistributes
 * any share a source can't use. Every source with `available > 0` gets at
 * least one slot (so long as `cap` covers the number of sources) — a
 * low-weight source is never squeezed out entirely.
 */
export function allocateCap(
  available: Record<string, number>,
  cap: number,
  weights: Record<string, number> = DEFAULT_SOURCE_WEIGHTS,
): Record<string, number> {
  const names = Object.keys(available).filter((n) => available[n] > 0);
  const alloc: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  if (names.length === 0 || cap <= 0) return alloc;

  const score = (n: string) => (weights[n] ?? 1) * available[n];

  const totalAvailable = names.reduce((s, n) => s + available[n], 0);
  let remaining = Math.min(cap, totalAvailable);
  let left: Record<string, number> = Object.fromEntries(names.map((n) => [n, available[n]]));

  // Guarantee representation first, in weight×availability order (largest
  // first), so a cap smaller than the source count still favors the intended
  // weighting.
  for (const n of [...names].sort((a, b) => score(b) - score(a))) {
    if (remaining <= 0) break;
    alloc[n] += 1;
    left[n] -= 1;
    remaining -= 1;
  }

  let pool = names.filter((n) => left[n] > 0);
  while (remaining > 0 && pool.length > 0) {
    const totalWeight = pool.reduce((s, n) => s + score(n), 0);
    const shares: Record<string, number> = {};
    let given = 0;
    for (const n of pool) {
      const raw = (remaining * score(n)) / totalWeight;
      const share = Math.min(left[n], Math.floor(raw));
      shares[n] = share;
      given += share;
    }
    // Rounding can leave every share at 0 while capacity remains — break the
    // tie by giving the single largest weight×availability source in the
    // pool as much of the remainder as it can take.
    if (given === 0) {
      const top = pool.slice().sort((a, b) => score(b) - score(a))[0];
      shares[top] = Math.min(left[top], remaining);
      given = shares[top];
    }
    for (const n of pool) {
      if (!shares[n]) continue;
      alloc[n] += shares[n];
      left[n] -= shares[n];
      remaining -= shares[n];
    }
    pool = pool.filter((n) => left[n] > 0);
    if (given === 0) break; // safety valve — should be unreachable
  }
  return alloc;
}

const FY_RE = /FY\s?(\d{4})/i;
const BUSINESS_KEYWORDS = [
  "business", "research", "technology", "technological", "innovation", "innovative",
  "startup", "entrepreneur", "science", "scientific", "engineering", "r&d",
  "commercialization", "manufacturing",
];

/** Higher is more recent. Open grants.gov/SBIR solicitations (a real
 *  deadline) outrank historical awards, which fall back to a `FY<year>`
 *  parsed out of the description (see normalizeSbirAward). */
function recencyKey(o: Opportunity): number {
  if (typeof o.deadline === "string") {
    const t = Date.parse(o.deadline);
    if (!Number.isNaN(t)) return t;
  }
  const m = FY_RE.exec(o.description ?? "");
  if (m) return Date.UTC(Number(m[1]), 0, 1);
  return 0;
}

function keywordScore(o: Opportunity): number {
  const text = `${o.program} ${o.description}`.toLowerCase();
  return BUSINESS_KEYWORDS.reduce((s, kw) => s + (text.includes(kw) ? 1 : 0), 0);
}

/** Orders one source's records best-first, before the cap trims the tail. */
function sortWithinSource(source: string, records: Opportunity[]): Opportunity[] {
  const sorted = records.slice();
  if (source === "grants.gov") {
    // Open before forecasted; within each, soonest deadline first (no
    // deadline sorts last — it's not closing, so it's never urgent).
    sorted.sort((a, b) => {
      if (!!a.forecasted !== !!b.forecasted) return a.forecasted ? 1 : -1;
      const da = a.deadline ? Date.parse(a.deadline) : Infinity;
      const db = b.deadline ? Date.parse(b.deadline) : Infinity;
      return (Number.isNaN(da) ? Infinity : da) - (Number.isNaN(db) ? Infinity : db);
    });
  } else if (source === "sbir") {
    sorted.sort((a, b) => recencyKey(b) - recencyKey(a));
  } else if (source === "assistance-listings") {
    sorted.sort((a, b) => keywordScore(b) - keywordScore(a));
  }
  return sorted;
}

/**
 * Trims a freshly-assembled record set to `cap`, never including an expired
 * deadline, allocating the cap across sources by weight × availability
 * (`allocateCap`) so every present source is represented, and — within a
 * source — keeping the records that best match its own preference order.
 * `cap <= 0` or a record count already at/under `cap` is a no-op (besides
 * dropping expired records).
 */
export function selectCorpusWithinCap(
  records: Opportunity[],
  cap: number,
  weights: Record<string, number> = DEFAULT_SOURCE_WEIGHTS,
  now: number = Date.now(),
): Opportunity[] {
  const open = dropExpiredOpportunities(records, now);
  if (cap <= 0 || open.length <= cap) return open;

  const bySource = new Map<string, Opportunity[]>();
  for (const o of open) {
    const list = bySource.get(o.source) ?? [];
    list.push(o);
    bySource.set(o.source, list);
  }
  const available: Record<string, number> = {};
  Array.from(bySource.entries()).forEach(([source, list]) => (available[source] = list.length));
  const alloc = allocateCap(available, cap, weights);

  const selected: Opportunity[] = [];
  Array.from(bySource.entries()).forEach(([source, list]) => {
    const n = alloc[source] ?? 0;
    selected.push(...sortWithinSource(source, list).slice(0, n));
  });
  return selected;
}

import type { Opportunity } from "../types";
import { dropExpiredOpportunities } from "./expiry";
import { dropPastAwards } from "./pastAwards";

export const DEFAULT_SOURCE_WEIGHTS: Record<string, number> = {
  "grants.gov": 2,
  sbir: 2,
  "assistance-listings": 1,
};

/** Splits `cap` by weight × availability, redistributing unused share; every non-empty source gets a slot first. */
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
    // Rounding left every share at 0: give the remainder to the top-scoring source.
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
    if (given === 0) break;
  }
  return alloc;
}

const BUSINESS_KEYWORDS = [
  "business", "research", "technology", "technological", "innovation", "innovative",
  "startup", "entrepreneur", "science", "scientific", "engineering", "r&d",
  "commercialization", "manufacturing",
];

/** Deadline; records without a parseable one sort last. */
function recencyKey(o: Opportunity): number {
  if (typeof o.deadline === "string") {
    const t = Date.parse(o.deadline);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function keywordScore(o: Opportunity): number {
  const text = `${o.program} ${o.description}`.toLowerCase();
  return BUSINESS_KEYWORDS.reduce((s, kw) => s + (text.includes(kw) ? 1 : 0), 0);
}

function sortWithinSource(source: string, records: Opportunity[]): Opportunity[] {
  const sorted = records.slice();
  if (source === "grants.gov") {
    // Open before forecasted, then soonest deadline.
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

export function selectCorpusWithinCap(
  records: Opportunity[],
  cap: number,
  weights: Record<string, number> = DEFAULT_SOURCE_WEIGHTS,
  now: number = Date.now(),
): Opportunity[] {
  const open = dropPastAwards(dropExpiredOpportunities(records, now));
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

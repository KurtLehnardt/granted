import rawCorpusMeta from "@/data/corpus-meta.json";

/**
 * corpus/meta.ts — the committed corpus's "as of" stamp (data-freshness surface).
 *
 * The opportunity corpus (`data/opportunities.json`) ships COMMITTED: it is a
 * point-in-time snapshot, so a self-hoster who clones months later inherits
 * opportunities whose deadlines have already passed. Honesty thesis (README:
 * "never present possibly-stale data as if it were current") means we must say
 * plainly WHEN the corpus was built rather than let it read as live.
 *
 * `data/corpus-meta.json` carries `{ "builtAt": "<ISO>" }`, written by the data
 * pipeline (`scripts/3-embed.mjs`, `npm run data:embed`) each time the corpus is
 * (re)embedded. This module reads that stamp and formats it for the UI.
 *
 * PURE LOGIC. NO NETWORK, NO LLM. Computed entirely from the committed metadata
 * file + an injectable `now`. Deterministic: the human label is formatted in UTC
 * with fixed month names, so it renders identically in every timezone and in
 * tests. A missing/invalid stamp degrades to `null` (the caller then shows a
 * date-free "verify current deadlines" caveat) — never a fabricated date, never
 * a crash.
 */

/** Shape of `data/corpus-meta.json`. `builtAt` is the only field the app reads. */
export interface CorpusMeta {
  builtAt?: unknown;
  [key: string]: unknown;
}

export interface CorpusAsOf {
  /** The parsed, valid `builtAt` as a canonical ISO-8601 instant. */
  iso: string;
  /** Human, timezone-stable label, e.g. "August 15, 2026". */
  label: string;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Format an instant as "Month D, YYYY" in UTC — deterministic across zones. */
function formatUtcDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * Parse a corpus-meta object into a validated "as of" surface, or `null` when
 * the stamp is absent/unparseable. PURE — pass any object (and optionally
 * `now`, reserved for future age-based caveats) for hermetic tests.
 *
 * `null` is the safe fallback the constraint requires: an absent meta file, a
 * missing `builtAt`, a non-string, or an unparseable/Invalid-Date value all
 * yield `null` so the UI never asserts a build date it doesn't actually have.
 */
export function parseBuiltAt(meta: CorpusMeta | null | undefined): CorpusAsOf | null {
  if (!meta || typeof meta !== "object") return null;
  const builtAt = (meta as CorpusMeta).builtAt;
  if (typeof builtAt !== "string" || builtAt.trim().length === 0) return null;
  const t = Date.parse(builtAt);
  if (Number.isNaN(t)) return null; // guard Invalid Date — never fabricate.
  const d = new Date(t);
  return { iso: d.toISOString(), label: formatUtcDate(d) };
}

/**
 * The committed corpus's "as of" surface, read from `data/corpus-meta.json`.
 * `null` when the stamp is missing/invalid (safe fallback). Reads only the
 * committed file — no network, no request-time state.
 */
export function corpusAsOf(): CorpusAsOf | null {
  return parseBuiltAt(rawCorpusMeta as CorpusMeta);
}

import type { OpportunityKind } from "../contracts/opportunity";

/**
 * C1b — opportunity type filtering + grouping (pure helpers).
 *
 * Dependency-light, hermetically-testable derivations (no rendering, no React)
 * over the already-computed `matches` a map carries. `components/
 * OpportunityGroups.tsx` renders on top of these; nothing here recomputes
 * scoring, retrieval, or eligibility.
 *
 * All ordering is DETERMINISTIC: kinds sort by a fixed canonical order
 * (`KIND_ORDER`), matches within a kind sort by score descending, tie-broken by
 * opportunity id, so the grouped view is stable across renders/runs.
 */

/** User-facing labels for each instrument kind. */
export const KIND_LABEL: Readonly<Record<OpportunityKind, string>> = {
  grant: "Grants",
  rd: "R&D / SBIR",
  procurement: "Procurement",
  loan: "Loans",
  assistance: "Assistance",
  scholarship: "Scholarships",
};

/**
 * Canonical display order: the funding instruments a user is most likely to
 * act on first, then the longer-tail types. Also the tie-break order for the
 * filter chips and group sections.
 */
export const KIND_ORDER: readonly OpportunityKind[] = [
  "grant",
  "rd",
  "procurement",
  "loan",
  "assistance",
  "scholarship",
];

/** Minimal match shape the grouping needs — a structural subset of `Match`
 *  (mirrors the `MatchLike` pattern in `lib/similar` / `AgencyMap`). */
export type GroupableMatch = {
  score?: number;
  tier?: string;
  opportunity?: {
    id?: string;
    kind?: string;
  };
};

export type OpportunityGroup<M extends GroupableMatch = GroupableMatch> = {
  kind: OpportunityKind;
  label: string;
  matches: M[];
};

function kindIndex(kind: OpportunityKind): number {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

function isKnownKind(kind: unknown): kind is OpportunityKind {
  return typeof kind === "string" && kind in KIND_LABEL;
}

/** Stable score-desc, id-asc comparator (matches the pipeline's tie-break). */
function byScoreThenId(a: GroupableMatch, b: GroupableMatch): number {
  const ds = (b.score ?? 0) - (a.score ?? 0);
  if (ds !== 0) return ds;
  const ai = a.opportunity?.id ?? "";
  const bi = b.opportunity?.id ?? "";
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/**
 * The distinct instrument kinds present among `matches`, in canonical order.
 * Unknown/absent kinds are skipped. Used to build the user-facing type
 * filter chips (never offer a filter for a kind that isn't present).
 */
export function availableKinds(matches: GroupableMatch[] | null | undefined): OpportunityKind[] {
  const present = new Set<OpportunityKind>();
  for (const m of Array.isArray(matches) ? matches : []) {
    const k = m?.opportunity?.kind;
    if (isKnownKind(k)) present.add(k);
  }
  return KIND_ORDER.filter((k) => present.has(k));
}

/**
 * Keep only matches whose kind is in `activeKinds`. An empty/nullish
 * `activeKinds` means "no filter" and returns every match unchanged (order
 * preserved) — the caller's "All" state.
 */
export function filterByKinds<M extends GroupableMatch>(
  matches: M[] | null | undefined,
  activeKinds: ReadonlyArray<OpportunityKind> | null | undefined,
): M[] {
  const list = Array.isArray(matches) ? matches : [];
  if (!activeKinds || activeKinds.length === 0) return [...list];
  const active = new Set(activeKinds);
  return list.filter((m) => {
    const k = m?.opportunity?.kind;
    return isKnownKind(k) && active.has(k);
  });
}

/**
 * Group `matches` by instrument kind. Only non-empty groups are returned, in
 * `KIND_ORDER`; within each group matches are sorted score-desc / id-asc.
 * Matches with an unknown/absent kind are omitted from the grouped view (they
 * are still counted by `availableKinds`-driven UI only if they carry a known
 * kind), so a malformed row can never create a phantom group.
 */
export function groupMatchesByKind<M extends GroupableMatch>(
  matches: M[] | null | undefined,
): OpportunityGroup<M>[] {
  const buckets = new Map<OpportunityKind, M[]>();
  for (const m of Array.isArray(matches) ? matches : []) {
    const k = m?.opportunity?.kind;
    if (!isKnownKind(k)) continue;
    const arr = buckets.get(k);
    if (arr) arr.push(m);
    else buckets.set(k, [m]);
  }
  return Array.from(buckets.keys())
    .sort((a, b) => kindIndex(a) - kindIndex(b))
    .map((kind) => ({
      kind,
      label: KIND_LABEL[kind],
      matches: buckets.get(kind)!.slice().sort(byScoreThenId),
    }));
}

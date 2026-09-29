import type { OpportunitySource, OpportunityStatus } from "../contracts/opportunity";
import type { EligibilityDetermination } from "../contracts/eligibilityDetermination";

/**
 * These shapes and the cadence constant used to live in lib/canon/{version,
 * freshness}.ts, alongside the Supabase-backed corpus-sync pipeline that
 * would have populated them. That pipeline was retired (Granted is local-
 * only now) — but `lib/match.ts` has only ever called `annotateFreshness()`
 * with NO options (`m.eligibility = annotateFreshness(determination)`,
 * `annotateFreshness(known)`), so `snapshot`/`syncHealth`/`freshness` below
 * were always undefined in production regardless: every real search already
 * hit the "no Canon corpus snapshot was available" branch unconditionally.
 * Inlining these types (rather than deleting the options entirely) keeps
 * that exact behavior AND this module's existing tests intact, with zero
 * dependency on Supabase or any corpus-sync system.
 */

/** Cadence a corpus snapshot is expected to refresh within, in hours. */
const CANON_SYNC_CADENCE_HOURS = 24;

interface SnapshotSourceCoverage {
  alarms?: string[];
  gaps?: string[];
  notes?: string;
  [key: string]: unknown;
}

interface DataAge {
  /** Milliseconds between `retrieved_at` and now — for programmatic comparison. */
  ms: number;
  /** Convenience: `ms` in hours (fractional). */
  hours: number;
  /** Human-readable for logs/UI copy, e.g. "3.2 hours", "2 days". */
  human: string;
}

/** The data-age surface (§4.4 "opportunities as of …"). */
export interface CurrentSnapshotResult {
  version: string;
  data_age: DataAge;
  retrieved_at: string; // ISO 8601 — alias of the snapshot's created_at
  source_coverage: SnapshotSourceCoverage;
}

type SyncHealthStatus = "OK" | "ALARM";

export interface SyncHealthResult {
  status: SyncHealthStatus;
  /** Empty when OK; one entry per reason when ALARM. */
  reasons: string[];
  snapshot: CurrentSnapshotResult | null;
  checked_at: string; // ISO 8601, when this check ran
}

export interface FreshnessResult {
  /** Opportunity id, e.g. "grants-360339". */
  id: string;
  /** Resolved source, "unknown" if the id doesn't map to one we recognize. */
  source: OpportunitySource | "unknown";
  /**
   * Live status as of `checked_at`. `null` iff `freshness_unavailable` is
   * true — a degraded check NEVER guesses a status.
   */
  status: OpportunityStatus | null;
  /** ISO-8601 close/response date, when the status has a real one. */
  close_date?: string;
  /**
   * ceil((close_date - checked_at) / 1 day). Positive while still open,
   * <= 0 once past close_date. Absent when there is no real close_date.
   */
  days_remaining?: number;
  /** When this determination was made (live check time, or cache-write time on a hit). */
  checked_at: string;
  /** Whether this result was served from the short-TTL cache. */
  cache: "hit" | "miss";
  /** True when the live source could not be re-verified. */
  freshness_unavailable?: boolean;
  /** Why `freshness_unavailable` is true, when known. */
  reason?: string;
  /**
   * Best-effort context from the last known-good check when freshness is
   * unavailable. This is explicitly the STALE cached view — it is never
   * promoted into `status`/`close_date` above, so a caller can't accidentally
   * treat it as current.
   */
  last_known?: {
    status: OpportunityStatus | null;
    close_date?: string;
    retrieved_at?: string;
  };
}

/**
 * freshness.ts (ELG-02) — data-freshness annotator for an ELG-01
 * `EligibilityDetermination`.
 *
 * §4.5 + anti-fabrication (§11): a determination is only as trustworthy as the
 * data it was made against. A screen computed off a STALE Canon corpus, or an
 * opportunity whose live status could not be re-verified, or one that is now
 * CLOSED, must be VISIBLY FLAGGED — never presented as if it were current. This
 * module decorates a determination with that signal so the UI/caller can show a
 * caveat instead of silently asserting a possibly-wrong result.
 *
 * PURE LOGIC. NO LLM. NO NETWORK. The caller passes in already-fetched signals:
 *   - the corpus snapshot / sync-health from CAN-06 (`lib/canon/version.ts`), and
 *   - the per-opportunity live freshness result from CAN-05 (`lib/canon/freshness.ts`).
 * This module NEVER fetches anything itself and is NOT wired into the request
 * path — it is a decorator a later slice composes.
 *
 * It does NOT re-implement any cadence/age math: corpus staleness is read from
 * CAN-06's precomputed `CurrentSnapshotResult.data_age.hours` compared against
 * the imported `CANON_SYNC_CADENCE_HOURS` (or a passed `SyncHealthResult`), and
 * per-opportunity liveness is read from CAN-05's `FreshnessResult`.
 *
 * The input determination is returned UNCHANGED (same object, never mutated, its
 * `bucket` untouched); the freshness assessment rides alongside it in a wrapper.
 */

// ---------------------------------------------------------------------------
// Wrapper type
// ---------------------------------------------------------------------------

/**
 * The freshness assessment attached to a determination.
 *
 * `caveat` is `null` exactly when `is_stale === false` (a fresh, verified
 * result needs no caution note); when `is_stale === true` it is a non-empty,
 * plain-language string naming every reason for caution.
 */
export interface FreshnessAnnotation {
  /**
   * ISO-8601 timestamp the corpus snapshot was retrieved (CAN-06
   * `CurrentSnapshotResult.retrieved_at`) — the "opportunities as of …" instant.
   * `null` when no snapshot was available.
   */
  data_as_of: string | null;
  /** True iff this determination should be treated with caution (see triggers below). */
  is_stale: boolean;
  /**
   * Plain-language explanation of why the determination is stale, or `null` when
   * it is fresh. Never an empty string.
   */
  caveat: string | null;
  /** When this freshness assessment was made (from the injectable `now`). */
  assessed_at: string;
}

/**
 * The ELG-01 determination, UNCHANGED, plus the ELG-02 freshness assessment.
 * `determination` is the exact object passed in (same reference, never mutated).
 */
export interface EligibilityDeterminationWithFreshness {
  determination: EligibilityDetermination;
  freshness: FreshnessAnnotation;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AnnotateFreshnessOptions {
  /**
   * The per-opportunity live freshness result (CAN-05). Absent when no live
   * re-check was performed for this opportunity.
   */
  freshness?: FreshnessResult;
  /**
   * The corpus snapshot (CAN-06). Pass `null` to signal "no snapshot exists"
   * (treated as stale). Omit if you are instead passing `syncHealth`.
   */
  snapshot?: CurrentSnapshotResult | null;
  /**
   * A CAN-06 sync-health result, as an alternative to a raw `snapshot`. An
   * `ALARM` status makes the corpus stale (covering both beyond-cadence age and
   * recorded per-source sync failures); its `.snapshot` supplies `data_as_of`.
   * If both `snapshot` and `syncHealth` are given, `snapshot` wins for
   * `data_as_of` while an `ALARM` still forces staleness.
   */
  syncHealth?: SyncHealthResult;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// annotateFreshness — the pure entry point
// ---------------------------------------------------------------------------

/**
 * Decorate `determination` with a data-freshness signal (§4.5 / CAN-05 /
 * CAN-06). The determination is returned unchanged.
 *
 * `is_stale` is `true` (with a non-empty `caveat`) when ANY of:
 *   - the corpus `SyncHealthResult.status === "ALARM"` (CAN-06); OR
 *   - the corpus snapshot's `data_age.hours > CANON_SYNC_CADENCE_HOURS`; OR
 *   - no corpus snapshot was available (`snapshot === null`/omitted); OR
 *   - the opportunity's `FreshnessResult.freshness_unavailable === true`
 *     (its live status could not be re-verified); OR
 *   - the opportunity has closed (`days_remaining <= 0`, or a live `status`
 *     of `"closed"` — e.g. a delisted/not-found record).
 *
 * A fresh corpus (within cadence / OK) plus a verified live-open opportunity
 * yields `is_stale === false` and `caveat === null`.
 */
export function annotateFreshness(
  determination: EligibilityDetermination,
  opts: AnnotateFreshnessOptions = {},
): EligibilityDeterminationWithFreshness {
  const now = opts.now ?? new Date();
  const reasons: string[] = [];

  // ---- Corpus staleness (CAN-06) ----
  const syncHealth = opts.syncHealth;
  const snapshot: CurrentSnapshotResult | null =
    opts.snapshot !== undefined
      ? opts.snapshot
      : syncHealth
        ? syncHealth.snapshot
        : null;

  const dataAsOf = snapshot ? snapshot.retrieved_at : null;

  let corpusStale = false;
  if (syncHealth && syncHealth.status === "ALARM") {
    // CAN-06 already alarmed (beyond-cadence age and/or recorded source
    // failures) — surface its own reasons verbatim rather than re-deriving them.
    corpusStale = true;
    if (syncHealth.reasons.length > 0) {
      reasons.push(...syncHealth.reasons);
    } else {
      reasons.push("the Canon corpus sync is in an ALARM state");
    }
  } else if (!snapshot) {
    corpusStale = true;
    reasons.push(
      "no Canon corpus snapshot was available, so this determination could not be verified against known-current data",
    );
  } else if (snapshot.data_age.hours > CANON_SYNC_CADENCE_HOURS) {
    corpusStale = true;
    reasons.push(
      `Canon corpus data is ${snapshot.data_age.human} old — beyond the ${CANON_SYNC_CADENCE_HOURS}h documented refresh cadence`,
    );
  }

  // ---- Per-opportunity liveness (CAN-05) ----
  const fr = opts.freshness;
  let oppStale = false;
  if (fr) {
    if (fr.freshness_unavailable === true) {
      // The live source could not be re-verified — never assert the cached
      // status is current (§4.6 / §11).
      oppStale = true;
      reasons.push(
        `the live status for this opportunity could not be re-verified against its source${
          fr.reason ? ` (${fr.reason})` : ""
        }, so its current open/closed status is not confirmed`,
      );
    } else {
      const closedByDate =
        typeof fr.days_remaining === "number" && fr.days_remaining <= 0;
      const closedByStatus = fr.status === "closed";
      if (closedByDate || closedByStatus) {
        oppStale = true;
        reasons.push(
          `this opportunity has closed${
            fr.close_date ? ` (close date ${fr.close_date})` : ""
          } and is no longer accepting applications`,
        );
      }
    }
  }

  const is_stale = corpusStale || oppStale;
  const caveat = is_stale
    ? `This determination should be treated with caution: ${reasons.join("; ")}.`
    : null;

  // Determination returned UNCHANGED (same reference, never mutated).
  return {
    determination,
    freshness: {
      data_as_of: dataAsOf,
      is_stale,
      caveat,
      assessed_at: now.toISOString(),
    },
  };
}

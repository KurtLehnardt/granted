import { z } from "zod";

/**
 * R5 — Competitor & Grant Intelligence result contract.
 *
 * The grounded output of the demo capture (scripts/5-competitors.mjs): the REAL
 * federal award records retrieved for a persona, plus a single claude-sonnet-4-6
 * synthesis of "how each awardee positioned itself to win" + tailored, cited
 * recommendations.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GROUNDING INVARIANT THIS MODULE ENFORCES — do not weaken.
 *
 * This mirrors the defense-in-depth in `lib/eligibility/screen.ts` /
 * `EligibilityDeterminationSchema`: the synthesis may reference ONLY companies
 * that were actually retrieved. Every `competitors[].recordId` and every
 * `recommendations[].citations[]` entry MUST name a record present in
 * `records[]`. `parse()` (via the `superRefine` below) THROWS on any id that is
 * not in the retrieved set — so a fabricated competitor or an ungrounded claim
 * becomes IMPOSSIBLE TO RENDER, not merely discouraged. The renderer
 * (`components/CompetitorResults.tsx`) parses the fixture through this schema at
 * its boundary, and the capture script validates its own output before writing
 * the fixture, so a hallucinated award can never reach the UI.
 *
 * A recommendation with an EMPTY `citations` array is also rejected: every piece
 * of advice must be traceable to at least one real record (§11 "never let a
 * model inference wear the costume of a verified fact").
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The keyless federal sources the capture fans out to (§2 of the feasibility report). */
export const AwardSourceSchema = z.enum([
  "USAspending",
  "NIH RePORTER",
  "NSF",
  "Grants.gov",
]);
export type AwardSource = z.infer<typeof AwardSourceSchema>;

/**
 * One REAL retrieved federal award record — the only allowed evidence
 * downstream. Every field is copied verbatim from a public government API
 * response; `sourceUrl` deep-links to the public award page a user can click to
 * verify it. `id` is assigned by the capture script and is what the synthesis
 * cites.
 */
export const GroundedAwardRecordSchema = z.object({
  /** Capture-assigned stable id the synthesis cites (e.g. "usa_1", "nih_3"). */
  id: z.string().min(1),
  /** Which keyless federal source this record came from. */
  source: AwardSourceSchema,
  /** Recipient / organization name, verbatim from the source. */
  recipient: z.string().min(1),
  /** Award amount in USD. Nullable — a few source records omit it; never invent one. */
  amount: z.number().nonnegative().nullable(),
  /** Awarding agency / funding IC, verbatim from the source. */
  agency: z.string().min(1),
  /** Program / mechanism (e.g. "STTR Phase I", CFDA), when the source provides it. */
  program: z.string().optional(),
  /** The full description / abstract — the awardee's own self-description. */
  abstract: z.string().min(1),
  /** Real, fetchable public source URL (USAspending / NIH RePORTER / NSF award page). */
  sourceUrl: z.string().url(),
  /** Fiscal / award year, when the source provides it. */
  year: z.number().int().optional(),
  /** Cosine similarity to the persona (rerank score, text-embedding-3-small @512). */
  similarity: z.number().optional(),
});
export type GroundedAwardRecord = z.infer<typeof GroundedAwardRecordSchema>;

/**
 * R5-deep — a PRIVATE-company web profile from live web search (exa /
 * WebSearch), for comparable companies that have NO federal award record
 * (feasibility report §2 #5 / §6 Risk 2).
 *
 * These are the honest fallback for the "comparable companies" angle when the
 * comparable is a private company with no public grant. Two invariants keep
 * them honest and are STRUCTURALLY enforced here, not merely by convention:
 *
 *   1. There is DELIBERATELY NO `amount` field. A private web profile can never
 *      carry a federal award figure, so a fabricated award is impossible to
 *      even represent — the type won't hold one.
 *   2. `sourceUrl` is a real, fetchable URL the user can click to verify the
 *      profile, exactly like an award record's deep link.
 *
 * A web profile is cited by `id` the same way an award record is, but the
 * renderer labels it "public web profile — not a federal awardee" so it is
 * never confused with a grounded award.
 */
export const WebCompetitorProfileSchema = z.object({
  /** Capture-assigned stable id the synthesis may cite (e.g. "web_1"). */
  id: z.string().min(1),
  /** Company / organization name, verbatim from the web result. */
  company: z.string().min(1),
  /** Real, fetchable public source URL the profile was drawn from. */
  sourceUrl: z.string().url(),
  /** A short description snippet drawn from the web result — the only evidence. */
  snippet: z.string().min(1),
  /** Which web tool surfaced this profile, for provenance. */
  via: z.enum(["exa", "web_search"]).optional(),
});
export type WebCompetitorProfile = z.infer<typeof WebCompetitorProfileSchema>;

/**
 * Award-size statistics for the "typical award size" section of the brief.
 * These are COMPUTED DETERMINISTICALLY from `records[].amount` server-side (see
 * `lib/competitors/analyze.ts`) — never authored by the model — so they are
 * grounded by construction and cannot drift from the real retrieved amounts.
 * Every field is nullable because a set of records may all omit their amount.
 */
export const AwardStatsSchema = z.object({
  /** How many records the stats were computed over. */
  count: z.number().int().nonnegative(),
  /** How many of those records actually disclosed an amount. */
  withAmount: z.number().int().nonnegative(),
  minAmount: z.number().nonnegative().nullable(),
  medianAmount: z.number().nonnegative().nullable(),
  maxAmount: z.number().nonnegative().nullable(),
});
export type AwardStats = z.infer<typeof AwardStatsSchema>;

/**
 * Honest-degradation metadata for a LIVE run (feasibility §6, §8 Risk 7): which
 * sources responded, and any notes about a source that was unreachable or a
 * capability (e.g. web search) that was unavailable. Surfaced in the UI so a
 * partial run is labeled, never silently presented as complete.
 */
export const AnalysisDegradationSchema = z.object({
  /** Sources that returned at least one usable record (e.g. "USAspending"). */
  sources: z.array(z.string()),
  /** Human-readable notes about anything skipped or degraded. */
  notes: z.array(z.string()),
});
export type AnalysisDegradation = z.infer<typeof AnalysisDegradationSchema>;

/**
 * A synthesized note on ONE kept competitor: how they positioned themselves to
 * win federal funding, grounded in a quote from THAT record's abstract.
 */
export const CompetitorNoteSchema = z.object({
  /** MUST reference a record in `records[]` (enforced by the top-level refine). */
  recordId: z.string().min(1),
  /** How this awardee positioned itself to win — drawn only from its abstract. */
  positioning: z.string().min(1),
  /** A verbatim snippet quoted from the referenced record's abstract. */
  quotedSnippet: z.string().min(1),
});
export type CompetitorNote = z.infer<typeof CompetitorNoteSchema>;

/**
 * One tailored recommendation for the persona. `citations` names the record(s)
 * the advice is drawn from; it must be non-empty and every id must be real.
 */
export const RecommendationSchema = z.object({
  advice: z.string().min(1),
  /** Record ids this advice cites. Non-empty; every id must be in `records[]`. */
  citations: z.array(z.string().min(1)).min(1),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/** The grounded synthesis: kept competitors + cited recommendations. */
export const CompetitorSynthesisSchema = z.object({
  /** Optional one-line framing of the landscape (still grounded in the records). */
  summary: z.string().optional(),
  competitors: z.array(CompetitorNoteSchema).min(1),
  recommendations: z.array(RecommendationSchema).min(1),
  /**
   * R5-deep — gaps / whitespace opportunities the user could exploit. Same
   * cited shape as a recommendation: every entry MUST cite at least one real
   * record or web-profile id (enforced by the top-level refine). Optional so the
   * original demo-first fixture (which predates this section) still validates.
   */
  opportunities: z.array(RecommendationSchema).optional(),
});
export type CompetitorSynthesis = z.infer<typeof CompetitorSynthesisSchema>;

/** Optional capture-cost provenance (metered like the match pipeline, R4b). */
export const CaptureCostSchema = z.object({
  totalCostUsd: z.number().nonnegative(),
  pricingAsOf: z.string().optional(),
});
export type CaptureCost = z.infer<typeof CaptureCostSchema>;

/**
 * The full fixture written by the capture and read by the renderer. The
 * `superRefine` is the load-bearing anti-fabrication gate (see the header).
 */
export const CompetitorAnalysisSchema = z
  .object({
    /** Persona label (e.g. "FasterControl"). */
    persona: z.string().min(1),
    /** The persona description the retrieval + synthesis were grounded in. */
    personaDescription: z.string().min(1),
    /** ISO-8601 timestamp the real data was retrieved / the analysis generated. */
    capturedAt: z.string().datetime(),
    /** The REAL retrieved records — the primary allowed evidence. */
    records: z.array(GroundedAwardRecordSchema).min(1),
    /**
     * R5-deep — private-company web profiles (no federal award). A secondary,
     * clearly-labeled evidence set that recommendations/opportunities MAY cite
     * but competitor cards (federal winners) may NOT. Optional.
     */
    webProfiles: z.array(WebCompetitorProfileSchema).optional(),
    /** R5-deep — deterministic award-size stats over `records[]` (server-computed). */
    awardStats: AwardStatsSchema.optional(),
    /** The grounded, cited synthesis over those records. */
    analysis: CompetitorSynthesisSchema,
    /** R5-deep — "live" (personalized request-time run) vs "demo" (saved example). */
    mode: z.enum(["live", "demo"]).optional(),
    /** R5-deep — honest-degradation metadata for a partial/live run. */
    degraded: AnalysisDegradationSchema.optional(),
    /** Optional metered capture cost (informational). */
    cost: CaptureCostSchema.optional(),
  })
  .superRefine((data, ctx) => {
    // Award-record ids: the ONLY ids a competitor card (a federal winner) may cite.
    const recordIds = new Set(data.records.map((r) => r.id));
    // The union of award-record + web-profile ids is what any CITATION may reference.
    const citableIds = new Set<string>(recordIds);
    (data.webProfiles ?? []).forEach((p) => citableIds.add(p.id));

    // Guard: ids must be unique ACROSS records AND web profiles, or a citation
    // would be ambiguous about which evidence item it points at.
    const totalIds = data.records.length + (data.webProfiles?.length ?? 0);
    if (citableIds.size !== totalIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Record and web-profile ids must all be unique.",
        path: ["records"],
      });
    }

    // Every competitor note must reference a REAL retrieved AWARD record (not a
    // web profile — competitor cards are federal winners, grounded in an award).
    data.analysis.competitors.forEach((c, i) => {
      if (!recordIds.has(c.recordId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Competitor references record id "${c.recordId}" that is not in the retrieved award set — ungrounded claims cannot be rendered.`,
          path: ["analysis", "competitors", i, "recordId"],
        });
      }
    });

    // Every recommendation/opportunity citation must reference a REAL retrieved
    // award record OR a real web profile — nothing invented.
    const checkCited = (
      items: Array<{ citations: string[] }>,
      key: "recommendations" | "opportunities",
    ) => {
      items.forEach((rec, i) => {
        rec.citations.forEach((cid, j) => {
          if (!citableIds.has(cid)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${key === "recommendations" ? "Recommendation" : "Opportunity"} cites id "${cid}" that is not in the retrieved evidence set — ungrounded claims cannot be rendered.`,
              path: ["analysis", key, i, "citations", j],
            });
          }
        });
      });
    };
    checkCited(data.analysis.recommendations, "recommendations");
    if (data.analysis.opportunities) checkCited(data.analysis.opportunities, "opportunities");
  });
export type CompetitorAnalysis = z.infer<typeof CompetitorAnalysisSchema>;

/**
 * Parse an untrusted fixture through the grounding contract. THROWS a `ZodError`
 * if any competitor or cited claim references a record id not present in the
 * retrieved set — the throw-before-render guarantee (mirrors `screen.ts`).
 */
export function parseCompetitorAnalysis(raw: unknown): CompetitorAnalysis {
  return CompetitorAnalysisSchema.parse(raw);
}

/**
 * R5-deep streaming wire events (NDJSON, one JSON object per line) emitted by
 * `POST /api/competitors` so the client can show live progress instead of a
 * frozen spinner for the full ~60s run.
 *
 * IMPORTANT — anti-fabrication boundary is preserved: the only MODEL-generated
 * content (competitor positioning, recommendations, opportunities) rides on the
 * final `result` event, whose `analysis` has already passed `groundSynthesis` +
 * `CompetitorAnalysisSchema.parse()`. The earlier `evidence` event carries only
 * RETRIEVAL data (real federal award records, server-computed award stats, and
 * exa web profiles with real URLs) — never a synthesized claim — so surfacing it
 * early is honest, not a fabrication risk. `stage` is pure progress; `error` is
 * an honest degradation the client renders as a fall-back-to-demo note.
 *
 * A type only (no schema) — it crosses into the client bundle, which must not
 * import the server-only engine. The route builds these; the client narrows on
 * `type`.
 */
export type CompetitorStreamEvent =
  | { type: "stage"; key: string; label: string; pct: number }
  | {
      type: "evidence";
      records: GroundedAwardRecord[];
      awardStats: AwardStats;
      webProfiles: WebCompetitorProfile[];
    }
  | { type: "result"; ok: true; analysis: CompetitorAnalysis }
  | { type: "error"; ok: false; reason: "insufficient_evidence" | "unavailable"; message: string };

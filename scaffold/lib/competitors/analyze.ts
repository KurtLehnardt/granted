import { makeLlmClient, isLocalLlm } from "../llm/client";
import { embedBatch, cosine } from "../embed";
import { loadPrompt } from "../prompts";
import type { CostMeter } from "../metering/meter";
import { retrieveAwards, type RawAwardRecord } from "./retrieve";
import { searchWebCompetitors, type RawWebProfile, type WebSearchResult } from "./web";
import {
  CompetitorAnalysisSchema,
  type CompetitorAnalysis,
  type CompetitorStreamEvent,
  type GroundedAwardRecord,
  type WebCompetitorProfile,
  type AwardStats,
} from "../contracts/competitorAnalysis";

/**
 * R5-deep — the live "competitor & grant intelligence" market brief engine.
 *
 * ONE pipeline behind both the request-time `/api/competitors` route and the
 * demo-capture script (`scripts/5-competitors.mjs`), so live and demo can never
 * drift. It mirrors the match pipeline's posture (lib/claude.ts): a per-call
 * Anthropic timeout BELOW the route's `maxDuration`, `maxRetries: 0`, usage
 * metered the instant the call resolves, fence-stripped JSON.
 *
 *   [1] RETRIEVE  keyless federal awards (USAspending/NIH/NSF) — fault-tolerant.
 *   [2] RERANK    cosine similarity to the persona (text-embedding-3-small@512);
 *                 degrades to retrieval order if embeddings are unavailable.
 *   [3] WEB       optional private-competitor profiles via exa (skipped if no key).
 *   [4] SYNTHESIZE one grounded claude-sonnet-4-6 call over the kept evidence.
 *   [5] GROUND    drop any id the model invented, THEN validate through
 *                 `CompetitorAnalysisSchema.parse()` — which THROWS on any
 *                 ungrounded citation. A fabricated award cannot survive to the UI.
 */

const MODEL = process.env.COMPETITOR_ANALYSIS_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS) || 100_000;
// Local models are legitimately much slower than the cloud path this timeout
// was originally sized for (lib/claude.ts draws the same distinction) -- a
// small local model writing the full cited brief can easily exceed 100s, and
// without this the SYNTHESIZE call gets aborted mid-generation, which the
// route can only report as a generic "unavailable" (the route only
// distinguishes InsufficientEvidenceError from everything else -- an abort
// is "everything else").
const LOCAL_LLM_TIMEOUT_MS = Number(process.env.LOCAL_LLM_TIMEOUT_MS) || 1_800_000; // 30 min

/** Below which a live run is considered too thin to be worth showing (falls back to demo). */
const MIN_GROUNDED_RECORDS = 3;

export interface AnalyzeInput {
  persona: string;
  personaDescription: string;
  /** Broad, expanded gov-vocabulary keywords to retrieve on (over-narrow → []). */
  keywords: string[];
  /** Optional target opportunity, for framing/logging (program + agency). */
  opportunity?: { program?: string; agency?: string };
  /** Optional web-search query for private comparables; defaults from the persona. */
  webQuery?: string;
  keepTopK?: number;
  perKeyword?: number;
  meter?: CostMeter;
  signal?: AbortSignal;
  /**
   * Capture-supplied web profiles (e.g. gathered via the exa MCP by the capture
   * script). When provided, the live exa HTTP fetch is skipped and these are
   * used verbatim — so a fixture can showcase real private competitors even
   * without EXA_API_KEY at capture time.
   */
  webProfilesOverride?: RawWebProfile[];
  /** "live" (request-time run, default) or "example" (a saved fixture capture). */
  mode?: "live" | "example";
  /**
   * Optional progress sink for the streaming route. When present, the pipeline
   * emits `stage` events at each boundary and one `evidence` event (grounded
   * awards/stats/web) BEFORE the sonnet synthesis — so the client can render a
   * live "what we found" view while the brief is still being written. Omitted by
   * the demo-capture script and tests, which just want the returned analysis, so
   * this is purely additive: without it, behavior is byte-identical to before.
   * The synthesized brief itself is NEVER streamed here — it rides the route's
   * final `result` event only after grounding + schema validation.
   */
  onEvent?: (event: CompetitorStreamEvent) => void;
}

/** Thrown when a live run could not assemble enough grounded evidence. */
export class InsufficientEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientEvidenceError";
  }
}

// --- JSON parsing (mirrors lib/claude.ts; copied deliberately, see draft.ts) ---
function firstBalancedJson(text: string): string | undefined {
  const o = text.indexOf("{");
  const a = text.indexOf("[");
  const start = o === -1 ? a : a === -1 ? o : Math.min(o, a);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function parseJson<T>(raw: string): T {
  const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(clean) as T;
  } catch (err) {
    const balanced = firstBalancedJson(clean);
    if (balanced !== undefined) return JSON.parse(balanced) as T;
    throw err;
  }
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Deterministic, model-free award-size stats — grounded by construction. */
function computeAwardStats(records: { amount: number | null }[]): AwardStats {
  const amounts = records
    .map((r) => r.amount)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    .sort((x, y) => x - y);
  return {
    count: records.length,
    withAmount: amounts.length,
    minAmount: amounts.length ? amounts[0] : null,
    medianAmount: median(amounts),
    maxAmount: amounts.length ? amounts[amounts.length - 1] : null,
  };
}

type RawSynthesis = {
  summary?: string;
  competitors?: Array<{ recordId?: string; positioning?: string; quotedSnippet?: string }>;
  recommendations?: Array<{ advice?: string; citations?: string[] }>;
  opportunities?: Array<{ advice?: string; citations?: string[] }>;
};

/**
 * Defense-in-depth grounding filter (PURE + unit-testable): drop any competitor,
 * recommendation, or opportunity the model invented, BEFORE the schema parse — so
 * a stray hallucinated id degrades to fewer honest claims rather than failing the
 * whole run, and only grounded claims survive. Competitor cards may reference ONLY
 * award-record ids (federal winners); recommendations/opportunities may cite award
 * OR web-profile ids. Recommendations/opportunities left with no valid citation are
 * dropped entirely (every claim must trace to real evidence).
 */
export function groundSynthesis(args: {
  records: { id: string }[];
  webProfiles: { id: string }[];
  synthesis: RawSynthesis;
}): {
  competitors: { recordId: string; positioning: string; quotedSnippet: string }[];
  recommendations: { advice: string; citations: string[] }[];
  opportunities: { advice: string; citations: string[] }[];
} {
  const recordIds = new Set(args.records.map((r) => r.id));
  const citableIds = new Set<string>(recordIds);
  args.webProfiles.forEach((p) => citableIds.add(p.id));

  const competitors = (args.synthesis.competitors ?? [])
    .filter((c) => !!c.recordId && recordIds.has(c.recordId) && !!c.positioning && !!c.quotedSnippet)
    .map((c) => ({ recordId: c.recordId!, positioning: c.positioning!, quotedSnippet: c.quotedSnippet! }));

  const cleanCited = (items: RawSynthesis["recommendations"]) =>
    (items ?? [])
      .map((r) => ({ advice: r.advice ?? "", citations: (r.citations ?? []).filter((id) => citableIds.has(id)) }))
      .filter((r) => r.advice.length > 0 && r.citations.length > 0);

  return {
    competitors,
    recommendations: cleanCited(args.synthesis.recommendations),
    opportunities: cleanCited(args.synthesis.opportunities),
  };
}

async function synthesize(
  input: AnalyzeInput,
  records: GroundedAwardRecord[],
  webProfiles: WebCompetitorProfile[],
): Promise<RawSynthesis> {
  const client = makeLlmClient({
    timeout: isLocalLlm() ? LOCAL_LLM_TIMEOUT_MS : ANTHROPIC_TIMEOUT_MS,
    maxRetries: 0,
  });

  const awardEvidence = records.map((r) => ({
    id: r.id, recipient: r.recipient, agency: r.agency, amount: r.amount, program: r.program, abstract: r.abstract,
  }));
  const webEvidence = webProfiles.map((p) => ({ id: p.id, company: p.company, url: p.sourceUrl, snippet: p.snippet }));

  const opp = input.opportunity?.program || input.opportunity?.agency
    ? `\nTARGET OPPORTUNITY: ${[input.opportunity?.program, input.opportunity?.agency].filter(Boolean).join(" — ")}`
    : "";

  const t0 = performance.now();
  const msg = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 3500,
      system: loadPrompt("competitorAnalysis").template,
      messages: [
        {
          role: "user",
          content:
            `COMPANY:\n${input.persona} — ${input.personaDescription}${opp}\n\n` +
            `AWARD RECORDS (real federal awards — cite these by id; the ONLY ids "competitors" may use):\n` +
            `${JSON.stringify(awardEvidence, null, 2)}\n\n` +
            `WEB PROFILES (private companies with NO federal award — recommendations/opportunities may cite these by id):\n` +
            `${webEvidence.length ? JSON.stringify(webEvidence, null, 2) : "(none)"}`,
        },
      ],
    },
    { signal: input.signal },
  );
  // R4b — record usage the instant the call resolves, before parseJson can throw.
  const usage = msg.usage;
  input.meter?.record({
    stage: "competitor_analysis",
    provider: "anthropic",
    model: MODEL,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    latencyMs: performance.now() - t0,
  });

  const text = msg.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
  return parseJson<RawSynthesis>(text);
}

/** Assign stable, source-prefixed ids to the kept award records. */
function assignIds(records: Array<RawAwardRecord & { similarity?: number }>): GroundedAwardRecord[] {
  const prefix = (s: RawAwardRecord["source"]) =>
    s === "USAspending" ? "usa" : s === "NIH RePORTER" ? "nih" : s === "NSF" ? "nsf" : "gov";
  return records.map((r, i) => ({
    id: `${prefix(r.source)}_${i + 1}`,
    source: r.source,
    recipient: r.recipient,
    amount: r.amount,
    agency: r.agency,
    ...(r.program ? { program: r.program } : {}),
    abstract: r.abstract,
    sourceUrl: r.sourceUrl,
    ...(r.year != null ? { year: r.year } : {}),
    ...(typeof r.similarity === "number" ? { similarity: Number(r.similarity.toFixed(4)) } : {}),
  }));
}

/**
 * Build the exa web-search query for comparable PRIVATE companies.
 *
 * The distinctive signal lives in `keywords` (the profile's expanded government
 * vocabulary — e.g. "biomanufacturing, BARDA, 21 CFR Part 11"); the raw
 * description on its own is dominated by generic category words ("platform",
 * "MES", "software"), which is why an un-keyworded query returns generic vendors.
 * So we LEAD with the persona + those keywords, then append a short description
 * tail for context. exa's `category:"company"` already scopes results to
 * companies, so we drop the "startups and companies comparable to" boilerplate
 * that only diluted the semantic signal. An explicit caller `webQuery` wins.
 */
export function buildWebQuery(input: {
  persona: string;
  personaDescription: string;
  keywords?: string[];
  webQuery?: string;
}): string {
  if (input.webQuery && input.webQuery.trim()) return input.webQuery.trim();
  const kws = (input.keywords ?? [])
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 8);
  const desc = input.personaDescription.replace(/\s+/g, " ").trim().slice(0, 180);
  const kwPart = kws.length ? ` — ${kws.join(", ")}` : "";
  return `Companies similar to ${input.persona}${kwPart}. ${desc}`.trim();
}

/**
 * Run the full pipeline and return a schema-VALIDATED CompetitorAnalysis. Throws
 * `InsufficientEvidenceError` when too few grounded records were reachable (the
 * route maps that to an honest fall-back-to-demo), and a `ZodError` if — against
 * all the pre-filtering — an ungrounded claim somehow reached validation.
 */
export async function analyzeCompetitors(input: AnalyzeInput): Promise<CompetitorAnalysis> {
  const keepTopK = input.keepTopK ?? 8;
  const notes: string[] = [];
  const emit = input.onEvent;
  emit?.({ type: "stage", key: "search", label: "Searching federal awards and comparable companies…", pct: 8 });

  // [3-early] WEB (started concurrently). Comparable private companies depend only
  // on the persona/description/keywords — NOT on the retrieved records — so we kick
  // the exa search off now and let it overlap retrieval + rerank instead of running
  // serially after them. searchWebCompetitors never throws (it returns an honest
  // degradation note), and the override branch resolves immediately, so starting it
  // before the retrieval guard below can't leave a rejecting promise dangling.
  const override = input.webProfilesOverride;
  const webJob: Promise<WebSearchResult> =
    override && override.length
      ? Promise.resolve({
          profiles: override,
          notes: [`Included ${override.length} supplied web competitor profile(s).`],
        })
      : searchWebCompetitors({ query: buildWebQuery(input), numResults: 5, signal: input.signal });

  // [1] RETRIEVE
  const retrieval = await retrieveAwards({ keywords: input.keywords, perKeyword: input.perKeyword, signal: input.signal });
  notes.push(...retrieval.notes);
  if (retrieval.records.length < MIN_GROUNDED_RECORDS) {
    throw new InsufficientEvidenceError(
      `Only ${retrieval.records.length} grounded record(s) retrieved (need ≥ ${MIN_GROUNDED_RECORDS}).`,
    );
  }
  emit?.({ type: "stage", key: "retrieved", label: `Found ${retrieval.records.length} federal award records`, pct: 30 });

  // [2] RERANK by similarity to the persona — ONE batched embedding call for the
  // persona + every record (was a serial per-record `await embed()` loop, the
  // dominant latency sink). Degrades to retrieval order if embeddings fail.
  const withSim: (RawAwardRecord & { similarity?: number })[] = retrieval.records.map((r) => ({ ...r }));
  try {
    const texts = [input.personaDescription, ...withSim.map((r) => `${r.recipient}. ${r.abstract}`)];
    const vecs = await embedBatch(texts, input.meter, input.signal);
    const personaVec = vecs[0];
    withSim.forEach((r, i) => {
      r.similarity = cosine(personaVec, vecs[i + 1]);
    });
    withSim.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  } catch {
    notes.push("Similarity rerank unavailable (embeddings) — showing records in retrieval order.");
  }
  emit?.({ type: "stage", key: "ranked", label: "Ranked awards by relevance to your company", pct: 45 });

  const records = assignIds(withSim.slice(0, keepTopK));

  // [3] WEB — await the search kicked off above (now overlapped, not serial).
  const web = await webJob;
  notes.push(...web.notes);
  const rawWeb: RawWebProfile[] = web.profiles;
  const webProfiles: WebCompetitorProfile[] = rawWeb.map((p, i) => ({
    id: `web_${i + 1}`,
    company: p.company,
    sourceUrl: p.sourceUrl,
    snippet: p.snippet,
    via: p.via,
  }));
  const awardStats = computeAwardStats(records);

  // Emit the grounded EVIDENCE (retrieval data only — real awards, server-computed
  // stats, exa web profiles; never a synthesized claim) so the client can render a
  // live "what we found" view while the sonnet brief is still being written.
  emit?.({
    type: "stage",
    key: "web",
    label: webProfiles.length
      ? `Found ${webProfiles.length} comparable ${webProfiles.length === 1 ? "company" : "companies"}`
      : "Comparable companies: federal awardees only",
    pct: 55,
  });
  emit?.({ type: "evidence", records, awardStats, webProfiles });
  emit?.({ type: "stage", key: "synth", label: "Writing your positioning brief…", pct: 65 });

  // [4] SYNTHESIZE
  const synthesis = await synthesize(input, records, webProfiles);

  // [5] GROUND — drop any id the model invented (defense-in-depth before parse).
  const { competitors, recommendations, opportunities } = groundSynthesis({ records, webProfiles, synthesis });

  if (competitors.length === 0 || recommendations.length === 0) {
    throw new InsufficientEvidenceError("Synthesis produced no grounded competitors/recommendations.");
  }

  const analysis: CompetitorAnalysis = {
    persona: input.persona,
    personaDescription: input.personaDescription,
    capturedAt: new Date().toISOString(),
    records,
    ...(webProfiles.length ? { webProfiles } : {}),
    awardStats,
    analysis: {
      ...(synthesis.summary ? { summary: synthesis.summary } : {}),
      competitors,
      recommendations,
      ...(opportunities.length ? { opportunities } : {}),
    },
    mode: input.mode ?? "live",
    degraded: { sources: retrieval.sources, notes },
  };

  // Load-bearing anti-fabrication gate — THROWS on any ungrounded id.
  return CompetitorAnalysisSchema.parse(analysis);
}

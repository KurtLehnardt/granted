import type { AwardSource } from "../contracts/competitorAnalysis";

/**
 * R5-deep — keyless federal award retrieval (USAspending / NIH RePORTER / NSF).
 *
 * The live, request-time port of the retrieval half of `scripts/5-competitors
 * .mjs`, promoted into a reusable, typed module so BOTH the `/api/competitors`
 * route and the demo-capture script fan out through the exact same code (one
 * source of retrieval truth, no drift). Every source and gotcha here is the one
 * proven live in `docs/competitor-grant-analysis-feasibility.md` §2:
 *
 *   - USAspending rejects (HTTP 422) a request mixing grant codes (02-05) with
 *     contract codes (A-D), so each award-type group is queried separately.
 *   - NSF has NO `rows` param (it 400s); paging is by `offset`, default page 25.
 *   - Over-narrow filters return `[]` — callers pass BROAD expanded keywords.
 *
 * FAILURE MODEL (§4.6): fault-tolerant to the record. A source that throws, a
 * keyword that 4xxs, or a malformed row is skipped — never fatal — so a partial
 * outage degrades to fewer grounded records rather than an empty brief. Every
 * network call is time-boxed with an AbortSignal so one hung source cannot burn
 * the whole route's latency budget.
 */

/** A normalized award record BEFORE the capture/route assigns its citable id. */
export interface RawAwardRecord {
  source: AwardSource;
  recipient: string;
  amount: number | null;
  agency: string;
  program?: string;
  abstract: string;
  sourceUrl: string;
  year?: number;
}

export interface RetrieveResult {
  records: RawAwardRecord[];
  /** Sources that returned at least one usable record. */
  sources: string[];
  /** Human-readable degradation notes (a source that failed entirely, etc.). */
  notes: string[];
}

const MAX_ABSTRACT_CHARS = 4000;
const MIN_ABSTRACT_CHARS = 40;
/** Per-network-call timeout. Well under the route's 120s ceiling. */
const FETCH_TIMEOUT_MS = Number(process.env.COMPETITOR_FETCH_TIMEOUT_MS) || 12_000;

function trimAbstract(s: unknown): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > MAX_ABSTRACT_CHARS ? t.slice(0, MAX_ABSTRACT_CHARS) + "…" : t;
}

function toAmount(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * fetch() with a hard timeout that also respects an optional caller signal (the
 * route's overall budget). Throws on timeout so the per-source try/catch skips
 * that call rather than hanging.
 */
async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort((init.signal as AbortSignal)?.reason);
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Max concurrent requests per source (rate-limit ceiling). */
const KEYWORD_CONCURRENCY = 2;

/**
 * Run `fn` over keywords in batches of KEYWORD_CONCURRENCY (Promise.allSettled,
 * so one failure never sinks the batch), sleeping `gapMs` between batches.
 */
async function runBatched(
  keywords: string[],
  gapMs: number,
  fn: (kw: string) => Promise<RawAwardRecord[]>,
): Promise<RawAwardRecord[]> {
  const out: RawAwardRecord[] = [];
  for (let i = 0; i < keywords.length; i += KEYWORD_CONCURRENCY) {
    const batch = keywords.slice(i, i + KEYWORD_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((kw) => fn(kw)));
    for (const s of settled) if (s.status === "fulfilled") out.push(...s.value);
    if (i + KEYWORD_CONCURRENCY < keywords.length) await sleep(gapMs);
  }
  return out;
}

/** Module-level 5-min TTL cache, LRU-capped at 50 entries. Key = `source:keyword`. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 50;
const cache = new Map<string, { records: RawAwardRecord[]; ts: number }>();

function getCached(key: string): RawAwardRecord[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // refresh recency
  cache.delete(key);
  cache.set(key, entry);
  return entry.records;
}

function setCache(key: string, records: RawAwardRecord[]) {
  cache.delete(key);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { records, ts: Date.now() });
}

async function fetchUsaspending(keywords: string[], perKeyword: number, signal?: AbortSignal): Promise<RawAwardRecord[]> {
  // Grants (incl. SBIR/STTR) and contracts must be queried separately (§2 gotcha).
  const TYPE_GROUPS = [
    ["02", "03", "04", "05"],
    ["A", "B", "C", "D"],
  ];
  return runBatched(keywords, 120, async (kw) => {
    const cacheKey = `USAspending:${perKeyword}:${kw.trim().toLowerCase()}`;
    const hit = getCached(cacheKey);
    if (hit) return hit;
    const out: RawAwardRecord[] = [];
    let failed = false;
    for (const codes of TYPE_GROUPS) {
      try {
        const res = await fetchWithTimeout("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filters: { keywords: [kw], award_type_codes: codes },
            fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Description"],
            limit: perKeyword,
            page: 1,
          }),
          signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: any = await res.json();
        for (const r of json?.results ?? []) {
          const desc = r["Description"];
          if (!desc || String(desc).trim().length < MIN_ABSTRACT_CHARS) continue;
          const gid = r["generated_internal_id"];
          out.push({
            source: "USAspending",
            recipient: r["Recipient Name"] || "(unnamed recipient)",
            amount: toAmount(r["Award Amount"]),
            agency: r["Awarding Agency"] || "Federal agency",
            program: r["Award ID"] ? `Award ${r["Award ID"]}` : undefined,
            abstract: trimAbstract(desc),
            sourceUrl: gid
              ? `https://www.usaspending.gov/award/${encodeURIComponent(gid)}`
              : "https://www.usaspending.gov/search",
          });
        }
      } catch {
        failed = true; /* per-keyword/group failure is skipped (§4.6) */
      }
      await sleep(120);
    }
    if (!failed && out.length > 0) setCache(cacheKey, out);
    return out;
  });
}

async function fetchNih(keywords: string[], perKeyword: number, signal?: AbortSignal): Promise<RawAwardRecord[]> {
  // NIH asks <= 1 req/sec sustained; process serially (one keyword at a time).
  const out: RawAwardRecord[] = [];
  for (const kw of keywords) {
    const cacheKey = `NIH RePORTER:${perKeyword}:${kw.trim().toLowerCase()}`;
    const hit = getCached(cacheKey);
    if (hit) {
      out.push(...hit);
    } else {
      const batch: RawAwardRecord[] = [];
      try {
        const res = await fetchWithTimeout("https://api.reporter.nih.gov/v2/projects/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            criteria: {
              advanced_text_search: { operator: "and", search_field: "projecttitle,abstracttext", search_text: kw },
            },
            include_fields: [
              "ProjectTitle", "Organization", "AwardAmount", "AgencyIcAdmin",
              "FiscalYear", "AbstractText", "ApplId", "ProjectNum",
            ],
            limit: perKeyword,
            offset: 0,
          }),
          signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: any = await res.json();
        for (const r of json?.results ?? []) {
          const abstract = r.abstract_text;
          if (!abstract || String(abstract).trim().length < MIN_ABSTRACT_CHARS) continue;
          const applId = r.appl_id;
          batch.push({
            source: "NIH RePORTER",
            recipient: r.organization?.org_name || "(unnamed organization)",
            amount: toAmount(r.award_amount),
            agency: r.agency_ic_admin?.name || "National Institutes of Health",
            program: r.project_num || (r.fiscal_year ? `FY${r.fiscal_year}` : undefined),
            abstract: trimAbstract(abstract),
            sourceUrl: applId
              ? `https://reporter.nih.gov/project-details/${encodeURIComponent(applId)}`
              : "https://reporter.nih.gov/",
            year: Number.isFinite(Number(r.fiscal_year)) ? Number(r.fiscal_year) : undefined,
          });
        }
        if (batch.length > 0) setCache(cacheKey, batch);
        out.push(...batch);
      } catch {
        /* skip this keyword */
      }
    }
    await sleep(350);
  }
  return out;
}

async function fetchNsf(keywords: string[], signal?: AbortSignal): Promise<RawAwardRecord[]> {
  return runBatched(keywords, 200, async (kw) => {
    const cacheKey = `NSF:${kw.trim().toLowerCase()}`;
    const hit = getCached(cacheKey);
    if (hit) return hit;
    const out: RawAwardRecord[] = [];
    try {
      const url = new URL("https://api.nsf.gov/services/v1/awards.json");
      url.searchParams.set("keyword", kw);
      url.searchParams.set("printFields", "id,title,awardeeName,fundsObligatedAmt,startDate,abstractText,agency");
      const res = await fetchWithTimeout(url, { signal }); // NSF: no `rows` param (400s)
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = await res.json();
      for (const r of json?.response?.award ?? []) {
        const abstract = r.abstractText;
        if (!abstract || String(abstract).trim().length < MIN_ABSTRACT_CHARS) continue;
        const year = r.startDate ? Number(String(r.startDate).slice(-4)) : undefined;
        out.push({
          source: "NSF",
          recipient: r.awardeeName || "(unnamed awardee)",
          amount: toAmount(r.fundsObligatedAmt),
          agency: r.agency || "National Science Foundation",
          abstract: trimAbstract(abstract),
          sourceUrl: r.id
            ? `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${encodeURIComponent(r.id)}`
            : "https://www.nsf.gov/awardsearch/",
          year: Number.isFinite(year) ? year : undefined,
        });
      }
      if (out.length > 0) setCache(cacheKey, out);
    } catch {
      /* skip this keyword */
    }
    return out;
  });
}

/** De-duplicate by recipient + first 80 abstract chars (same key as the capture). */
function dedupe(records: RawAwardRecord[]): RawAwardRecord[] {
  const seen = new Set<string>();
  const out: RawAwardRecord[] = [];
  for (const r of records) {
    const key = `${r.recipient.toLowerCase()}::${r.abstract.slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Fan out to the three keyless federal sources in parallel and merge. Never
 * throws for a partial outage — returns whatever grounded records were reachable
 * plus degradation notes. Only the caller decides whether "too few" is fatal.
 */
export async function retrieveAwards(opts: {
  keywords: string[];
  /** Rows per keyword per source (default 8). */
  perKeyword?: number;
  signal?: AbortSignal;
}): Promise<RetrieveResult> {
  const perKeyword = opts.perKeyword ?? 8;
  const keywords = opts.keywords.filter((k) => k && k.trim().length > 0);
  const notes: string[] = [];
  const sources: string[] = [];

  if (keywords.length === 0) {
    return { records: [], sources, notes: ["No keywords supplied for retrieval."] };
  }

  const labels = ["USAspending", "NIH RePORTER", "NSF"] as const;
  const settled = await Promise.allSettled([
    fetchUsaspending(keywords, perKeyword, opts.signal),
    fetchNih(keywords, perKeyword, opts.signal),
    fetchNsf(keywords, opts.signal),
  ]);

  const raw: RawAwardRecord[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      if (s.value.length > 0) sources.push(labels[i]);
      else notes.push(`${labels[i]} returned no matching records.`);
      raw.push(...s.value);
    } else {
      notes.push(`${labels[i]} was unreachable and was skipped (degraded).`);
    }
  });

  return { records: dedupe(raw), sources, notes };
}

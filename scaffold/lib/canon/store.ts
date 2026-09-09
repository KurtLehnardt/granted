import postgres from "postgres";
import type { Opportunity } from "../contracts/opportunity";
import type { CanonOpportunity } from "./CanonOpportunity";

/**
 * store.ts — the typed Canon corpus client (CAN-01).
 *
 * Reads/writes the `opportunities`, `eligibility_rules`, and `corpus_snapshots`
 * tables (see supabase/migrations/00001_canon_corpus_store.sql). Writes take the
 * stricter `CanonOpportunity`; reads return the CON-01 `Opportunity` contract.
 *
 * CONNECTION — transaction pooler, prepared statements DISABLED
 * ------------------------------------------------------------
 * The runtime app connects through Supabase's TRANSACTION pooler
 * (…pooler.supabase.com:6543). That pooler (supavisor / pgbouncer transaction
 * mode) multiplexes many clients onto few server connections and therefore
 * CANNOT support session-scoped prepared statements — a prepared statement made
 * in one transaction is not guaranteed to exist in the next. porsager `postgres`
 * caches and re-uses prepared statements by default, which breaks here, so we
 * set `prepare: false` (equivalent to `?pgbouncer=true`). This makes every query
 * a one-shot extended/simple query — correct for the transaction pooler.
 *
 * Migrations/admin use the SESSION pooler (:5432) via psql instead (see the
 * migration header); only the app runtime path uses this client.
 *
 * SECRETS: the DB password is read from `process.env.FUNDFINDER_DB_PASSWORD` and
 * is NEVER logged. Do not add it to any log/console/error string.
 *
 * ISOLATION: the corpus is shared/public government data — there is no per-user
 * row here (user data stays in localStorage, R9.0), so there is no tenant filter
 * to apply on reads.
 */

const DB_HOST =
  process.env.FUNDFINDER_DB_HOST ?? "aws-0-us-west-2.pooler.supabase.com";
// 6543 = transaction pooler (runtime). Override to 5432 (session pooler) only
// for long-lived/admin scripts if ever needed.
const DB_PORT = Number(process.env.FUNDFINDER_DB_PORT ?? 6543);
const DB_NAME = process.env.FUNDFINDER_DB_NAME ?? "postgres";
// No baked-in project ref — set FUNDFINDER_DB_PROJECT_REF in your own env if you
// use the optional Canon corpus store (the default app ships a prebuilt corpus).
const DB_PROJECT_REF = process.env.FUNDFINDER_DB_PROJECT_REF ?? "";
const DB_USER = process.env.FUNDFINDER_DB_USER ?? `postgres.${DB_PROJECT_REF}`;

let _sql: postgres.Sql | null = null;

/** Lazily create the shared pooled client. */
export function getSql(): postgres.Sql {
  if (_sql) return _sql;
  const password = process.env.FUNDFINDER_DB_PASSWORD;
  if (!DB_PROJECT_REF || !password) {
    // Never echo secret values — only the fact that config is missing.
    throw new Error(
      "The Canon store is not configured. Set FUNDFINDER_DB_PROJECT_REF and " +
        "FUNDFINDER_DB_PASSWORD in your environment (see .env.example) before using it. " +
        "The default app does not need this — the opportunity corpus ships prebuilt in data/.",
    );
  }
  _sql = postgres({
    host: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    username: DB_USER,
    password,
    ssl: "require",
    // REQUIRED for the transaction pooler — see file header.
    prepare: false,
    max: Number(process.env.FUNDFINDER_DB_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 30,
    connection: { application_name: "fundfinder-canon" },
  });
  return _sql;
}

/** Close the shared client (call at process exit in scripts). */
export async function closeStore(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
  }
}

/** Format a number[] as a pgvector text literal: `[0.1,0.2,...]`. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Parse a pgvector text literal (`[0.1,0.2]`) back into number[]. */
export function fromVectorLiteral(v: unknown): number[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") {
    const trimmed = v.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (trimmed.length === 0) return [];
    return trimmed.split(",").map(Number);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Snapshots (§4.3 corpus versioning)
// ---------------------------------------------------------------------------

export interface SnapshotInput {
  version: string;
  sourceCoverage: Record<string, unknown>;
  notes?: string;
}

/** Idempotently create/update a corpus snapshot row (keeps original created_at). */
export async function upsertSnapshot(input: SnapshotInput): Promise<void> {
  const sql = getSql();
  await sql`
    insert into corpus_snapshots (version, source_coverage, notes)
    values (${input.version}, ${sql.json(input.sourceCoverage as any)}, ${input.notes ?? null})
    on conflict (version) do update
      set source_coverage = excluded.source_coverage,
          notes = excluded.notes
  `;
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

/**
 * A Canon opportunity plus the optional `raw` jsonb source record. `raw` is a
 * STORE concept (the retained original source record, §4.3), not a CON-01
 * contract field, so it rides alongside the contract type here.
 */
export type CanonOpportunityRow = CanonOpportunity & {
  raw?: Record<string, unknown>;
};

/**
 * Idempotent upsert of a single Canon opportunity. `on conflict (id)` updates in
 * place, so re-seeding never duplicates. Writes the STRUCTURED Canon columns
 * (status/title/key_dates/award_range/…) alongside the v1 mirrors — the
 * normalization rule documented in CanonOpportunity.ts.
 */
export async function upsertOpportunity(opp: CanonOpportunityRow): Promise<void> {
  const sql = getSql();
  const embeddingLiteral = opp.embedding
    ? toVectorLiteral(opp.embedding)
    : null;
  const kd = opp.key_dates;
  const ar = opp.award_range;

  await sql`
    insert into opportunities (
      id, source, source_id, kind,
      program, title, agency, description, eligibility,
      status, forecasted, deadline,
      open_date, close_date, response_date,
      funding_low, funding_high, award_low, award_high, award_currency,
      industry_tags, geography, url, embedding,
      raw, retrieved_at, snapshot_version, updated_at
    ) values (
      ${opp.id}, ${opp.source}, ${opp.source_id}, ${opp.kind},
      ${opp.program}, ${opp.title}, ${opp.agency}, ${opp.description}, ${opp.eligibility ?? null},
      ${opp.status}, ${opp.forecasted ?? null}, ${opp.deadline ?? null},
      ${kd?.open_date ?? null}, ${kd?.close_date ?? null}, ${kd?.response_date ?? null},
      ${opp.fundingLow ?? null}, ${opp.fundingHigh ?? null},
      ${ar?.floor ?? null}, ${ar?.ceiling ?? null}, ${ar?.currency ?? "USD"},
      ${opp.industryTags ?? null}, ${opp.geography ?? null}, ${opp.url ?? null},
      ${embeddingLiteral}::vector,
      ${sql.json((opp as any).raw ?? {})}, ${opp.retrieved_at}, ${opp.corpus_version ?? null}, now()
    )
    on conflict (id) do update set
      source = excluded.source,
      source_id = excluded.source_id,
      kind = excluded.kind,
      program = excluded.program,
      title = excluded.title,
      agency = excluded.agency,
      description = excluded.description,
      eligibility = excluded.eligibility,
      status = excluded.status,
      forecasted = excluded.forecasted,
      deadline = excluded.deadline,
      open_date = excluded.open_date,
      close_date = excluded.close_date,
      response_date = excluded.response_date,
      funding_low = excluded.funding_low,
      funding_high = excluded.funding_high,
      award_low = excluded.award_low,
      award_high = excluded.award_high,
      award_currency = excluded.award_currency,
      industry_tags = excluded.industry_tags,
      geography = excluded.geography,
      url = excluded.url,
      embedding = excluded.embedding,
      raw = excluded.raw,
      retrieved_at = excluded.retrieved_at,
      snapshot_version = excluded.snapshot_version,
      updated_at = now()
  `;
}

/**
 * Batch upsert with bounded concurrency. Returns the number of rows written.
 * Idempotent (see upsertOpportunity).
 */
export async function upsertOpportunities(
  opps: CanonOpportunityRow[],
  opts: { concurrency?: number } = {},
): Promise<number> {
  const concurrency = opts.concurrency ?? 16;
  let written = 0;
  for (let i = 0; i < opps.length; i += concurrency) {
    const chunk = opps.slice(i, i + concurrency);
    await Promise.all(chunk.map((o) => upsertOpportunity(o)));
    written += chunk.length;
  }
  return written;
}

/** Count opportunities, optionally within a snapshot. */
export async function countOpportunities(
  snapshotVersion?: string,
): Promise<number> {
  const sql = getSql();
  const rows = snapshotVersion
    ? await sql<{ n: number }[]>`
        select count(*)::int as n from opportunities
        where snapshot_version = ${snapshotVersion}`
    : await sql<{ n: number }[]>`select count(*)::int as n from opportunities`;
  return rows[0]?.n ?? 0;
}

/** Fetch one opportunity by id as the CON-01 `Opportunity` contract shape. */
export async function getOpportunityById(
  id: string,
): Promise<Opportunity | null> {
  const sql = getSql();
  const rows = await sql`
    select *, embedding::text as embedding_text
    from opportunities where id = ${id} limit 1`;
  if (rows.length === 0) return null;
  return rowToOpportunity(rows[0]);
}

/** Map a raw DB row to the CON-01 `Opportunity` contract (mirrors + structured). */
export function rowToOpportunity(row: any): Opportunity {
  const num = (v: any): number | undefined =>
    v == null ? undefined : Number(v);
  const iso = (v: any): string | undefined =>
    v == null ? undefined : v instanceof Date ? v.toISOString() : String(v);

  return {
    // v1 base
    id: row.id,
    source: row.source,
    kind: row.kind ?? undefined,
    program: row.program,
    agency: row.agency,
    description: row.description,
    eligibility: row.eligibility ?? undefined,
    fundingLow: num(row.funding_low),
    fundingHigh: num(row.funding_high),
    deadline: row.deadline ?? undefined,
    forecasted: row.forecasted ?? undefined,
    industryTags: row.industry_tags ?? undefined,
    geography: row.geography ?? undefined,
    url: row.url ?? undefined,
    embedding: fromVectorLiteral(row.embedding_text ?? row.embedding),

    // Canon structured
    source_id: row.source_id ?? undefined,
    title: row.title ?? undefined,
    status: row.status ?? undefined,
    key_dates: {
      open_date: iso(row.open_date),
      close_date: iso(row.close_date),
      response_date: iso(row.response_date),
    },
    award_range: {
      floor: num(row.award_low),
      ceiling: num(row.award_high),
      currency: row.award_currency ?? "USD",
    },
    retrieved_at: iso(row.retrieved_at),
    corpus_version: row.snapshot_version ?? undefined,
  } as Opportunity;
}

import { NextRequest, NextResponse } from "next/server";
import { rateLimit, clientKey } from "@/lib/security/rateLimit";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";

/**
 * GTM free tool — "Grant Readiness Score" email capture (STUBBED backend).
 *
 * The readiness tool captures an email AFTER showing the grade ("Get your full
 * opportunity map →"). Per the /ship GTM guidance there is no email store yet,
 * so this route is a deliberate STUB: it validates the payload and returns
 * `{ ok: true }` without persisting anything. It NEVER silently drops a lead
 * with a fake success — validation still runs, a bad email gets a 400, and the
 * one thing missing is real storage, which is called out loudly below.
 *
 * Mirrors the shape of the other unauthenticated routes (extract-profile /
 * interview): same per-IP soft rate limit, same 400-on-bad-input contract.
 *
 * TODO: wire to a real email store (e.g. a Supabase `leads` table, a
 * transactional-email/ESP list, or a CRM webhook). Until then this endpoint
 * accepts and acknowledges but does not persist the lead.
 */

const LEAD_RATE_LIMIT = Number(process.env.LEAD_RATE_LIMIT) || 20;
const LEAD_RATE_WINDOW_MS = Number(process.env.LEAD_RATE_WINDOW_MS) || 60_000;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 practical maximum.

// Intentionally conservative: a single "@", a dot in the domain, no spaces.
// Deep RFC-5322 validation belongs to the real ESP at send time, not here.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

async function postReadinessLead(req: NextRequest) {
  const limit = rateLimit(clientKey(req), { limit: LEAD_RATE_LIMIT, windowMs: LEAD_RATE_WINDOW_MS });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests — please wait a moment." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  let email: unknown;
  let grade: unknown;
  try {
    const body = await req.json();
    email = body?.email;
    grade = body?.grade;
  } catch {
    return badRequest("Invalid request body.");
  }

  if (typeof email !== "string" || email.trim().length === 0) {
    return badRequest("Enter your email to get your full opportunity map.");
  }
  const trimmed = email.trim();
  if (trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(trimmed)) {
    return badRequest("That doesn't look like a valid email address.");
  }

  // Optional context — the grade the tool showed when they signed up. Accepted
  // for future storage, validated loosely, never required.
  const capturedGrade =
    typeof grade === "number" && Number.isFinite(grade) && grade >= 0 && grade <= 100
      ? Math.round(grade)
      : null;

  // TODO: wire to a real email store. For now we only acknowledge — the lead is
  // NOT persisted anywhere. Log server-side so a manual export is at least
  // possible during the concierge phase; contains only the email + grade the
  // user themselves submitted, no derived personal data.
  console.info("[readiness-lead] captured (not persisted):", { email: trimmed, grade: capturedGrade });

  return NextResponse.json({ ok: true });
}

export const POST = withErrorLogging("readiness-lead", postReadinessLead);

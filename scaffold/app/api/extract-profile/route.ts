import { NextRequest, NextResponse } from "next/server";
import { extractProfile } from "@/lib/claude";
import { rateLimit, clientKey } from "@/lib/security/rateLimit";

/**
 * B1b — structured questionnaire free-text AUTOFILL route.
 *
 * Thin server wrapper around the live pipeline's `extractProfile` (Stage 1
 * intake, `lib/claude.ts`), which reads `ANTHROPIC_API_KEY` from the
 * environment — that must never reach the client bundle, so this route is the
 * only place `components/ProfileQuestionnaire.tsx` may call it from. Mirrors
 * `app/api/interview/route.ts`'s shape exactly: same input bounds, same
 * per-IP rate limit, same "never a 5xx" contract.
 *
 * Contract with the client: autofill is a convenience that PRE-FILLS the
 * structured form for the user to confirm/edit — it must never block the
 * form itself. ANY extraction failure (missing/bad key, timeout, malformed
 * model output) degrades to `{ profile: null }` with a 200, and the client
 * falls back to manual entry.
 */

const MAX_DESCRIPTION_LENGTH = Number(process.env.MAX_DESCRIPTION_LENGTH) || 8_000;
const EXTRACT_RATE_LIMIT = Number(process.env.EXTRACT_RATE_LIMIT) || 40;
const EXTRACT_RATE_WINDOW_MS = Number(process.env.EXTRACT_RATE_WINDOW_MS) || 60_000;

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const limit = rateLimit(clientKey(req), { limit: EXTRACT_RATE_LIMIT, windowMs: EXTRACT_RATE_WINDOW_MS });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests — please wait a moment." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  let description: string;
  try {
    const body = await req.json();
    description = body?.description;
  } catch {
    return badRequest("Invalid request body.");
  }

  if (!description || description.trim().length < 20) {
    return badRequest("Add a bit more detail before autofilling — a sentence or two is enough.");
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return badRequest(`That description is too long (max ${MAX_DESCRIPTION_LENGTH.toLocaleString()} characters).`);
  }

  try {
    const { profile } = await extractProfile(description);
    return NextResponse.json({ profile });
  } catch (err) {
    // Any extraction failure (missing/bad ANTHROPIC_API_KEY, timeout,
    // malformed model JSON) degrades to "no autofill" rather than a 5xx — the
    // structured form must always stay usable by hand. Log server-side only.
    console.error("profile extraction (autofill) failed:", err);
    return NextResponse.json({ profile: null });
  }
}

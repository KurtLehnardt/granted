import { NextRequest, NextResponse } from "next/server";
import { generateQuestions, type InterviewQuestion } from "@/lib/interview/generateQuestions";
import { rateLimit, clientKey } from "@/lib/security/rateLimit";

/**
 * Input bounds for the unauthenticated interview endpoint (security review
 * MEDIUM — denial-of-wallet). Env-overridable; generous enough never to impede
 * a real user. The interview call is cheap/fast, so limits are looser than
 * /api/match.
 */
const MAX_DESCRIPTION_LENGTH = Number(process.env.MAX_DESCRIPTION_LENGTH) || 8_000;
const INTERVIEW_RATE_LIMIT = Number(process.env.INTERVIEW_RATE_LIMIT) || 40;
const INTERVIEW_RATE_WINDOW_MS = Number(process.env.INTERVIEW_RATE_WINDOW_MS) || 60_000;

/**
 * FE-03 — R1 pre-search interview: question generation ROUTE.
 *
 * Thin server wrapper around INT-01 (`generateQuestions`). Runs the cheap/fast
 * model pass server-side ONLY — `generateQuestions` reads `OPENAI_API_KEY`
 * from the environment, which must never reach the client bundle.
 *
 * Contract with the client (components/IntakeForm.tsx /
 * components/PreSearchInterview.tsx): this route NEVER 5xxs on a generation
 * failure. `questions: []` (whether from a genuinely clean description, a
 * timeout, a missing key, or a malformed model response) is a valid 200
 * response, and the client treats it as "skip the interview, search
 * directly" — a broken/slow interview must never block the free path.
 */

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const limit = rateLimit(clientKey(req), { limit: INTERVIEW_RATE_LIMIT, windowMs: INTERVIEW_RATE_WINDOW_MS });
  if (!limit.ok) {
    // Still a 200-shaped contract for the client's happy path would be wrong
    // here (this is a hard throttle, not a generation failure) — but keep it a
    // 4xx, never a 5xx.
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
    return badRequest(
      "Add a bit more detail about your company — a sentence or two on what you build, your size, and what you need."
    );
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return badRequest(`That description is too long (max ${MAX_DESCRIPTION_LENGTH.toLocaleString()} characters).`);
  }

  let questions: InterviewQuestion[] = [];
  try {
    questions = await generateQuestions(description);
  } catch (err) {
    // Any generation failure (bad/missing key, timeout, malformed model
    // output) degrades to an empty interview rather than a 5xx — the client
    // falls back to searching directly. Log server-side for visibility.
    console.error("interview generation failed:", err);
    questions = [];
  }

  return NextResponse.json({ questions });
}

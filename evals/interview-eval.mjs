// ============================================================================
// EVL-03(a) — blind interview quality eval over the FROZEN golden set.
// ----------------------------------------------------------------------------
// For every golden-set entry, calls generateQuestions(entry.description) LIVE
// on whichever model provider Granted is configured with (lib/llm: Settings →
// Model, or ANTHROPIC_API_KEY / OPENAI_API_KEY; INTERVIEW_MODEL, imported from
// generateQuestions.ts and never overridden, is what's asked of Anthropic), then
// checks, per entry:
//
//   1. Gate-first ordering held (code-level regression check — normalize()'s
//      own TARGET_RANK/GATE_RANK sort already enforces this; this just checks
//      the invariant survived, it does not re-implement the sort).
//   2. Every question is routing-relevant (valid routing_target enum) and
//      structured (select kinds have options + allow_free_text; free_text has
//      no options) — also a regression check on normalize()'s own guarantees.
//   3. No question re-asks a fact the description already states — judged by
//      the same provider as an LLM judge (the one check that needs judgment).
//   4. A holistic 1-5 "worth a founder's time" score from the same judge call.
//
// Run (from repo root):
//   node --import tsx evals/interview-eval.mjs
//
// Exit-code convention: a nonzero interview-quality pass rate is INFORMATIVE,
// not a harness failure (per the task's test plan) — this script exits 0 as
// long as it completed a full run over every entry (including per-entry
// InterviewGenerationError / judge failures, which are recorded, not fatal).
// It exits 1 only on a hard setup failure (no model provider configured, golden
// set unreadable, etc.) that means the eval could not run at all. Every entry is
// a live, paid model call (two, with the judge).
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  generateQuestions,
  InterviewGenerationError,
  INTERVIEW_MODEL,
  RoutingTargetSchema,
  parseModelJson,
} from "../scaffold/lib/interview/generateQuestions.ts";
import { makeLlmClient } from "../scaffold/lib/llm/client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_SET_PATH = join(__dirname, "golden-set.jsonl");
const FROZEN_HASH =
  "f79c6e579f39431cc2b48cc8073569e529473be796cf0af46041a5e7a4cb04e4"; // evals/README.md v1.0

const VALID_ROUTING_TARGETS = new Set(RoutingTargetSchema.options);

// A harness-only timeout, longer than production's 5s target-latency default,
// purely so a slow-but-eventually-successful live call doesn't get counted as
// a harness failure during a 31-entry batch run. Does NOT change production
// behavior (generateQuestions.ts's own default stays 5s) — this is passed as
// a per-call option, same knob `GenerateQuestionsOptions.timeoutMs` production
// code can already set.
const HARNESS_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Golden set
// ---------------------------------------------------------------------------

const raw = readFileSync(GOLDEN_SET_PATH, "utf8");
const liveHash = createHash("sha256").update(raw).digest("hex");
const entries = raw
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

console.log("=".repeat(78));
console.log("EVL-03(a) interview eval — golden-set version check");
console.log(`  live sha256:   ${liveHash}`);
console.log(`  frozen sha256: ${FROZEN_HASH}`);
console.log(
  liveHash === FROZEN_HASH
    ? "  MATCH — golden set is the frozen v1.0 reference."
    : "  *** MISMATCH — the golden set has drifted from the frozen v1.0 reference. ESCALATE. ***",
);
console.log(`  model: ${INTERVIEW_MODEL} (funded default, not overridden)`);
console.log("=".repeat(78));

let client;
try {
  client = makeLlmClient({ timeout: HARNESS_TIMEOUT_MS, maxRetries: 1 });
} catch (err) {
  console.error(
    `\n*** No model provider is configured (${err.message}) — the interview eval cannot run. ESCALATE per the task's ` +
      "'Escalate if' clause. ***",
  );
  process.exitCode = 1;
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Code-level checks (regression guards on normalize()'s own invariants)
// ---------------------------------------------------------------------------

/**
 * Heuristic: does this entry leave at least one R8.1 hard gate unstated in
 * its description? (entity type / SAM-UEI registration / employee count /
 * US-ownership). Per the task spec this triggers on ANY of: entity_type is
 * "unknown", OR the description doesn't state SAM/UEI status, OR doesn't
 * state employee count, OR doesn't state a US-ownership fact — which is an
 * OR across four conditions, so it is true for nearly every entry (almost no
 * description states literally all four). That is expected and fine: the
 * assertion itself ("if the model emitted an eligibility_gate question, it's
 * first") is a cheap invariant normalize() enforces unconditionally, so this
 * heuristic just decides which entries the check is even meaningful for.
 */
function leavesAGateUnstated(entry) {
  const d = entry.description ?? "";
  const statesSam = /\bSAM\.gov\b|\bUEI\b|SAM registration/i.test(d);
  const statesEmployeeCount = /\b\d+[\s-]?(person|people|employee)/i.test(d);
  const statesOwnership =
    /\bUS-owned\b|\bU\.S\.-owned\b|\bUS owned\b|foreign(-|\s)owned|\bforeign parent\b|\bcitizen\b|permanent resident/i.test(
      d,
    );
  return entry.entity_type === "unknown" || !statesSam || !statesEmployeeCount || !statesOwnership;
}

/** Check 1 — gate-first ordering (regression guard, not a re-implementation). */
function checkGateFirst(entry, questions) {
  if (!leavesAGateUnstated(entry)) return { ok: true, detail: "all 4 gates stated — check N/A" };
  if (questions.length === 0) return { ok: true, detail: "no questions generated" };
  const hasGateQuestion = questions.some((q) => q.routing_target === "eligibility_gate");
  if (!hasGateQuestion) return { ok: true, detail: "no eligibility_gate question generated" };
  const first = questions[0];
  const ok = first.routing_target === "eligibility_gate";
  return {
    ok,
    detail: ok
      ? `first question (priority ${first.priority}) is eligibility_gate`
      : `REGRESSION: first question is "${first.routing_target}", not eligibility_gate, despite a gate question existing`,
  };
}

/** Check 2 — routing-relevant + structured (regression guard). */
function checkStructured(questions) {
  const violations = [];
  for (const q of questions) {
    if (!VALID_ROUTING_TARGETS.has(q.routing_target)) {
      violations.push(`${q.id}: invalid routing_target "${q.routing_target}"`);
      continue;
    }
    if (q.answer_kind === "free_text") {
      if (q.options.length !== 0) violations.push(`${q.id}: free_text has ${q.options.length} options (expected 0)`);
    } else if (q.answer_kind === "single_select" || q.answer_kind === "multi_select") {
      if (q.options.length < 1) violations.push(`${q.id}: ${q.answer_kind} has no options`);
      if (q.allow_free_text !== true) violations.push(`${q.id}: ${q.answer_kind} missing allow_free_text escape hatch`);
    } else {
      violations.push(`${q.id}: unrecognized answer_kind "${q.answer_kind}"`);
    }
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// LLM judge — never-re-asks-a-stated-fact + holistic 1-5 score
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are grading the output of an R1 pre-search interview generator for fundFinder, a federal-funding matcher for startups.

A founder submitted a company DESCRIPTION. The system then generated a list of QUESTIONS meant to be asked before running an expensive federal-funding search. Your job is to grade those questions against the description, in the spirit of a well-informed federal-funding advisor (not exact-wording nitpicking).

Grade two things:

1. RE-ASKS: does any question ask for a fact the description ALREADY states plainly or clearly implies? Examples of a violation: asking "what type of entity are you?" when the description says "a 501(c)(3) nonprofit"; asking about SAM.gov registration status when the description already says the company is not yet registered; asking the industry/sector when it's obvious from context. Do NOT flag a question as a re-ask merely because it touches a related topic in more depth than the description gives (e.g. asking for an EXACT employee count when the description only says "a small team" is fine, not a re-ask; asking about US ownership percentage when the description never mentions ownership at all is fine, not a re-ask).

2. HOLISTIC SCORE (1-5): are the questions, taken as a set, routing-relevant and worth this specific founder's time? 5 = every question earns its place, sharply tuned to what's actually unresolved for this company. 3 = generally useful but has a generic or lower-value question. 1 = wastes the founder's time (redundant, irrelevant, or vague busywork). A description that already resolves everything and correctly returns ZERO questions should score 5 (that is the correct behavior, not a failure).

Return ONLY a JSON object, no preamble, no markdown fences, of exactly this shape:
{
  "reasked_question_ids": string[],       // ids of questions (e.g. "q1") that re-ask a stated fact; [] if none
  "reasked_explanation": string,          // one line: why, or "no re-asks" if none
  "worth_founders_time_score": number,    // 1-5 integer
  "score_explanation": string             // one line justifying the score
}`;

function buildJudgeUserMessage(entry, questions) {
  const questionSummary = questions.map((q) => ({
    id: q.id,
    question: q.question,
    routing_target: q.routing_target,
    gate_class: q.gate_class,
  }));
  return (
    `COMPANY DESCRIPTION:\n${entry.description}\n\n` +
    `GENERATED QUESTIONS (${questions.length}):\n${JSON.stringify(questionSummary, null, 2)}`
  );
}

async function judge(client, entry, questions) {
  if (questions.length === 0) {
    // Nothing to judge for re-asks; still worth a holistic score (zero
    // questions on a fully-resolved description is a legitimate 5).
    return {
      reasked_question_ids: [],
      reasked_explanation: "no questions generated — nothing to re-ask",
      worth_founders_time_score: null, // scored by the code path below instead
      score_explanation: "",
      skippedScore: true,
    };
  }
  const msg = await client.messages.create({
    model: INTERVIEW_MODEL,
    temperature: 0,
    max_tokens: 500,
    system: `${JUDGE_SYSTEM_PROMPT}\n\nRespond with a single JSON object and nothing else.`,
    messages: [{ role: "user", content: buildJudgeUserMessage(entry, questions) }],
  });
  const content = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = parseModelJson(content); // let a malformed judge response throw — caught by the caller
  return {
    reasked_question_ids: Array.isArray(parsed.reasked_question_ids) ? parsed.reasked_question_ids : [],
    reasked_explanation: parsed.reasked_explanation ?? "",
    worth_founders_time_score:
      typeof parsed.worth_founders_time_score === "number" ? parsed.worth_founders_time_score : null,
    score_explanation: parsed.score_explanation ?? "",
    skippedScore: false,
  };
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

const perEntryResults = [];

console.log(`\nRunning generateQuestions() + judge over ${entries.length} entries (live model calls)...\n`);

for (const entry of entries) {
  const row = { id: entry.id, violations: [] };

  // --- generateQuestions() ---
  let questions = null;
  try {
    questions = await generateQuestions(entry.description, { timeoutMs: HARNESS_TIMEOUT_MS });
    row.questionCount = questions.length;
  } catch (err) {
    const isGenError = err instanceof InterviewGenerationError;
    row.generationError = `${isGenError ? "InterviewGenerationError" : err.constructor.name}: ${err.message}`;
    row.violations.push(`generateQuestions() failed: ${row.generationError}`);
    perEntryResults.push(row);
    console.log(`[FAIL] ${entry.id} — generateQuestions() threw: ${row.generationError}`);
    continue; // per entry, not fatal — keep going
  }

  // --- Check 1: gate-first ---
  const gateFirst = checkGateFirst(entry, questions);
  row.gateFirst = gateFirst;
  if (!gateFirst.ok) row.violations.push(`gate-first: ${gateFirst.detail}`);

  // --- Check 2: routing-relevant + structured ---
  const structured = checkStructured(questions);
  row.structured = structured;
  if (!structured.ok) row.violations.push(...structured.violations.map((v) => `structured: ${v}`));

  // --- Check 3 + 4: LLM judge (re-asks + holistic score) ---
  try {
    const j = await judge(client, entry, questions);
    row.judge = j;
    if (j.reasked_question_ids.length > 0) {
      row.violations.push(
        `re-asks a stated fact: ${j.reasked_question_ids.join(", ")} — ${j.reasked_explanation}`,
      );
    }
    if (!j.skippedScore && j.worth_founders_time_score !== null && j.worth_founders_time_score <= 2) {
      row.violations.push(
        `low holistic score (${j.worth_founders_time_score}/5): ${j.score_explanation}`,
      );
    }
  } catch (err) {
    row.judgeError = err.message;
    row.violations.push(`judge call failed: ${err.message}`);
  }

  const pass = row.violations.length === 0;
  row.pass = pass;
  perEntryResults.push(row);

  const scoreStr = row.judge?.worth_founders_time_score != null ? `${row.judge.worth_founders_time_score}/5` : "n/a";
  console.log(
    `[${pass ? "PASS" : "FAIL"}] ${entry.id} — ${questions.length} question(s), score ${scoreStr}` +
      (pass ? "" : ` — ${row.violations.length} violation(s)`),
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(78));
console.log("SUMMARY");
console.log("=".repeat(78));

const total = perEntryResults.length;
const passing = perEntryResults.filter((r) => r.pass).length;
const failing = perEntryResults.filter((r) => !r.pass);

console.log(`Entries run: ${total}`);
console.log(`Pass (zero violations): ${passing}/${total} (${((passing / total) * 100).toFixed(1)}%)`);

const scored = perEntryResults.filter((r) => r.judge?.worth_founders_time_score != null);
if (scored.length > 0) {
  const avgScore =
    scored.reduce((sum, r) => sum + r.judge.worth_founders_time_score, 0) / scored.length;
  console.log(`Average holistic "worth founder's time" score: ${avgScore.toFixed(2)}/5 (n=${scored.length})`);
}

if (failing.length > 0) {
  console.log(`\nFailing entries (${failing.length}):`);
  for (const r of failing) {
    console.log(`  - ${r.id}:`);
    for (const v of r.violations) console.log(`      * ${v}`);
  }
}

console.log("\n(Interview-eval pass rate is informative, not a harness pass/fail gate — see file header.)");
console.log("=".repeat(78));

// Emit a machine-readable summary line other tooling (e.g. the results doc
// generation step) can grep for.
console.log(
  `\nRESULT_JSON ${JSON.stringify({
    goldenSetHash: liveHash,
    frozenHashMatch: liveHash === FROZEN_HASH,
    model: INTERVIEW_MODEL,
    total,
    passing,
    failing: failing.length,
    averageScore: scored.length > 0 ? scored.reduce((s, r) => s + r.judge.worth_founders_time_score, 0) / scored.length : null,
  })}`,
);

process.exitCode = 0; // completed a full run; per-entry failures are informative, not a harness failure

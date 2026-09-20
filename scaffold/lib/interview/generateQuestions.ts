import OpenAI from "openai";
import { z } from "zod";

import {
  MATERIAL_PROFILE_FIELDS,
  isFieldProvided,
  type CompanyProfile,
  type ProfileFieldMeta,
} from "../contracts/companyProfile";
import { DEFAULT_MODEL_ROUTING } from "../contracts/modelRouting";
import { loadPrompt, recordUsage, type PromptUsage } from "../prompts";

/**
 * INT-01 — R1 pre-search interview: question GENERATION.
 *
 * The v2 core insight: ask cheap, routing-relevant questions BEFORE the
 * expensive search. On submit of the "Tell us about your company" box, this
 * runs a small/fast model (`gpt-4o-mini`, model-routing task
 * `interview_generation`, target < 5s — NOT the analysis model) and produces
 * 3–5 questions whose answers change WHICH PROGRAMS MATCH.
 *
 * Guarantees enforced here (not left to the model alone):
 *   - GATE-FIRST — R8.1 hard eligibility gates (entity type, >50% US
 *     ownership, employee count, SAM.gov/UEI registration) are re-sorted ahead
 *     of program-family / agency routing questions, so ordering is a code
 *     invariant, not just a prompt instruction.
 *   - STRUCTURED — every enumerable question keeps a multiple-choice shape with
 *     an `other`/free-text escape hatch (added if the model forgot it).
 *   - ROUTING-RELEVANT — every question is typed to a concrete branch
 *     (eligibility_gate / program_family / agency).
 *
 * This is generation only. The answer→enriched-description merge is INT-02;
 * the interview UI and the "search anyway" skip are FE-03. The prompt lives in
 * the CON-04 registry (`lib/prompts/registry.ts`), versioned + content-hashed.
 */

// --- Public schema / types -------------------------------------------------

/** The concrete branch of the opportunity space a question resolves (R1). */
export const RoutingTargetSchema = z.enum([
  "eligibility_gate", // a hard R8 gate — can they apply AT ALL
  "program_family", // SBIR/STTR vs. grants vs. contracts, research vs. commercialization
  "agency", // which funding agency/agencies are in scope
]);
export type RoutingTarget = z.infer<typeof RoutingTargetSchema>;

/**
 * The R8.1 hard-eligibility gate classes, in priority order. The first four
 * are the ones INT-01 prioritizes explicitly (entity type, >50% US ownership,
 * employee count, SAM.gov/UEI registration); the last two are softer gates.
 */
export const GateClassSchema = z.enum([
  "entity_type",
  "ownership",
  "employee_count",
  "registration",
  "geography",
  "program_prerequisite",
]);
export type GateClass = z.infer<typeof GateClassSchema>;

/** How the answer is collected. Enumerable → select; open-ended → free_text. */
export const AnswerKindSchema = z.enum([
  "single_select",
  "multi_select",
  "free_text",
]);
export type AnswerKind = z.infer<typeof AnswerKindSchema>;

/** One selectable answer option. `value` is stable; `label` is user-facing. */
export const InterviewOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});
export type InterviewOption = z.infer<typeof InterviewOptionSchema>;

/**
 * A single generated interview question. `id` maps to
 * `InterviewAnswer.question_id` in the CON-01 CompanyProfile contract, so the
 * INT-02 merge can attach answers back to the exact question that asked them.
 */
export const InterviewQuestionSchema = z.object({
  /** Stable id (`q1`, `q2`, …) → CompanyProfile.InterviewAnswer.question_id. */
  id: z.string(),
  /** User-facing question text. */
  question: z.string(),
  /** The branch this question resolves. */
  routing_target: RoutingTargetSchema,
  /** The R8 gate class — non-null iff `routing_target === "eligibility_gate"`. */
  gate_class: GateClassSchema.nullable(),
  /** How to collect the answer. */
  answer_kind: AnswerKindSchema,
  /** Choices for select kinds (includes an `other` escape); `[]` for free_text. */
  options: z.array(InterviewOptionSchema),
  /** The free-text escape hatch — always true for select kinds. */
  allow_free_text: z.boolean(),
  /** One line: which branch/gate this resolves and how it changes matches. */
  rationale: z.string(),
  /** The CompanyProfile field this answer enriches (INT-02), or null. */
  maps_to_profile_field: z.string().nullable(),
  /** Gate-first rank, 1-based. Lower is asked first. */
  priority: z.number().int().positive(),
});
export type InterviewQuestion = z.infer<typeof InterviewQuestionSchema>;

// --- Model-output schema (before we normalize + rank) ----------------------

export const RawQuestionSchema = z.object({
  question: z.string().trim().min(1),
  routing_target: RoutingTargetSchema,
  gate_class: GateClassSchema.nullish(),
  answer_kind: AnswerKindSchema,
  options: z.array(InterviewOptionSchema).nullish(),
  allow_free_text: z.boolean().nullish(),
  rationale: z.string().nullish(),
  maps_to_profile_field: z.string().nullish(),
});
export type RawQuestion = z.infer<typeof RawQuestionSchema>;

const RawResponseSchema = z.object({
  questions: z.array(RawQuestionSchema).nullish(),
});

// --- Gate-first ordering ---------------------------------------------------

const TARGET_RANK: Record<RoutingTarget, number> = {
  eligibility_gate: 0,
  program_family: 1,
  agency: 2,
};

/** R8.1 priority order; the first four are INT-01's explicit gate-first set. */
const GATE_RANK: Record<GateClass, number> = {
  entity_type: 0,
  ownership: 1,
  employee_count: 2,
  registration: 3,
  geography: 4,
  program_prerequisite: 5,
};

const GATE_RANK_UNSPECIFIED = 90; // an eligibility_gate the model left unclassed
const GATE_RANK_NON_GATE = 100; // program_family / agency questions have no gate

export function gateRankOf(q: RawQuestion): number {
  if (q.routing_target !== "eligibility_gate") return GATE_RANK_NON_GATE;
  return q.gate_class ? GATE_RANK[q.gate_class] : GATE_RANK_UNSPECIFIED;
}

// --- Options / call config -------------------------------------------------

/**
 * The minimal structural slice of the OpenAI client this module uses. Declared
 * so tests (H7) can inject a canned chat-completions client and exercise the
 * full parse→schema→normalize pipeline hermetically (no network, no API key) —
 * including reproducing the exact EVL-03 `defense-hw-08` model output.
 */
export interface InterviewChatClient {
  chat: {
    completions: {
      create: (
        params: any,
        options?: { signal?: AbortSignal },
      ) => Promise<{ choices: Array<{ message?: { content?: string | null } | null } | null> }>;
    };
  };
}

export interface GenerateQuestionsOptions {
  /** Defaults to `process.env.OPENAI_API_KEY`. Never logged. */
  apiKey?: string;
  /** Override the model. Defaults to the funded cheap/fast `gpt-4o-mini`. */
  model?: string;
  /** Hard cap on returned questions (R1: 3–5). Defaults to 5. */
  maxQuestions?: number;
  /** Per-request timeout in ms. Defaults to the routing target latency. */
  timeoutMs?: number;
  /** Abort in-flight generation (e.g. user hit "search anyway"). */
  signal?: AbortSignal;
  /**
   * Injectable OpenAI-compatible client (H7 testability seam). When provided,
   * the real `new OpenAI(...)` is bypassed and no `OPENAI_API_KEY` is required.
   * Production callers omit this and get the real client.
   */
  client?: InterviewChatClient;
  /**
   * The user's known profile so far (B1a gap interview). When provided, the
   * interview runs gap-first:
   *   - if no MATERIAL field is missing, it returns ZERO questions WITHOUT
   *     calling the model (a fully-filled profile asks nothing); and
   *   - any question that re-asks an already-provided field is pruned from the
   *     result, so a provided field is never re-asked.
   * Omitted (the default) preserves the original description-only behavior.
   */
  profile?: Partial<CompanyProfile>;
}

/**
 * The funded cheap/fast model for R1. The model-routing contract
 * (`interview_generation`) documents this as a small/fast job; its default
 * `model` field is an Anthropic placeholder Team Perf owns — INT-01 routes to
 * OpenAI `gpt-4o-mini` deliberately, per the task spec.
 */
export const INTERVIEW_MODEL = "gpt-4o-mini";
const ROUTING = DEFAULT_MODEL_ROUTING.interview_generation;
const DEFAULT_TIMEOUT_MS = ROUTING?.target_latency_ms ?? 5_000;
const MAX_QUESTIONS = 5;
const PROMPT_ID = "generateInterviewQuestions";

/** The registry record (id/version/contentHash) a Run should log per R10.2. */
export function interviewPromptUsage(): PromptUsage {
  return recordUsage(loadPrompt(PROMPT_ID));
}

// --- Normalization ---------------------------------------------------------

function ensureOtherOption(options: InterviewOption[]): InterviewOption[] {
  const hasOther = options.some(
    (o) => o.value.toLowerCase() === "other" || /other/i.test(o.label),
  );
  if (hasOther) return options;
  return [...options, { value: "other", label: "Other / not sure" }];
}

/**
 * Force the structured-answer invariant regardless of what the model emitted:
 * select kinds keep a non-empty option set, an `other` option, and the
 * free-text escape hatch; free_text carries no options.
 */
function normalizeAnswerShape(q: RawQuestion): {
  answer_kind: AnswerKind;
  options: InterviewOption[];
  allow_free_text: boolean;
} {
  const modelOptions = q.options ?? [];

  if (q.answer_kind === "free_text") {
    return { answer_kind: "free_text", options: [], allow_free_text: true };
  }

  // A select with no options the model forgot to fill degrades to free_text
  // rather than shipping an empty picker.
  if (modelOptions.length === 0) {
    return { answer_kind: "free_text", options: [], allow_free_text: true };
  }

  return {
    answer_kind: q.answer_kind,
    options: ensureOtherOption(modelOptions),
    allow_free_text: true, // the escape hatch is mandatory on enumerable questions
  };
}

export function normalize(raw: RawQuestion[], maxQuestions: number): InterviewQuestion[] {
  // Gate-first, then within gates by R8.1 importance, stable on model order.
  const ordered = raw
    .map((q, index) => ({ q, index }))
    .sort((a, b) => {
      const t = TARGET_RANK[a.q.routing_target] - TARGET_RANK[b.q.routing_target];
      if (t !== 0) return t;
      const g = gateRankOf(a.q) - gateRankOf(b.q);
      if (g !== 0) return g;
      return a.index - b.index;
    })
    .slice(0, Math.max(0, maxQuestions))
    .map(({ q }) => q);

  return ordered.map((q, i): InterviewQuestion => {
    const shape = normalizeAnswerShape(q);
    const gate_class =
      q.routing_target === "eligibility_gate" ? (q.gate_class ?? null) : null;
    return {
      id: `q${i + 1}`,
      question: q.question.trim(),
      routing_target: q.routing_target,
      gate_class,
      answer_kind: shape.answer_kind,
      options: shape.options,
      allow_free_text: shape.allow_free_text,
      rationale: (q.rationale ?? "").trim(),
      maps_to_profile_field: q.maps_to_profile_field ?? null,
      priority: i + 1,
    };
  });
}

// --- Gap detection (B1a) ---------------------------------------------------
//
// The R1 interview is a GAP interview: ask only the material fields the profile
// is still missing, and never re-ask a field it already provides. The material
// set + the "provided" definition both live on the CON-01 contract
// (`MATERIAL_PROFILE_FIELDS`, `isFieldProvided`) so there is a single source of
// truth; this module just consumes them.

/**
 * A material `CompanyProfile` field the interview still needs. Returned by
 * {@link detectGaps} in metadata order (required first, then material).
 */
export type FieldGap = ProfileFieldMeta;

/**
 * The material fields `profile` is still missing — required + material fields
 * whose value `isFieldProvided` reports as absent/empty. A profile that already
 * provides every material field yields `[]` (which is what makes a fully-filled
 * profile ask ZERO questions). Never includes an already-provided field.
 */
export function detectGaps(profile: Partial<CompanyProfile>): FieldGap[] {
  return MATERIAL_PROFILE_FIELDS.filter((m) => !isFieldProvided(profile, m.field));
}

/**
 * Drop any generated question that re-asks a field the profile already
 * provides. Questions with no field mapping (`maps_to_profile_field === null`)
 * or mapping to a still-missing field are kept. This is the second half of the
 * "never re-ask a provided field" guarantee — it prunes what the model returned
 * even when the model ignored the gap set.
 */
export function pruneAnsweredQuestions(
  questions: InterviewQuestion[],
  profile: Partial<CompanyProfile>,
): InterviewQuestion[] {
  return questions.filter((q) => {
    const field = q.maps_to_profile_field;
    if (field === null) return true;
    return !isFieldProvided(profile, field);
  });
}

// --- Entry point -----------------------------------------------------------

export class InterviewGenerationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "InterviewGenerationError";
  }
}

/**
 * Generate the R1 pre-search interview for a company description.
 *
 * Returns 3–5 gate-first, routing-relevant, structured questions — or FEWER
 * (down to zero) when the description already resolves the gates and routes
 * cleanly (the INT-01 escalate case: produce fewer/zero rather than
 * manufacturing questions).
 */
export async function generateQuestions(
  description: string,
  opts: GenerateQuestionsOptions = {},
): Promise<InterviewQuestion[]> {
  const text = description?.trim() ?? "";
  if (text.length === 0) {
    throw new InterviewGenerationError("description is empty");
  }

  // Gap-first: with a known profile and no material gaps left, ask nothing and
  // never touch the model (or require an API key). This is the fully-filled →
  // ZERO-questions guarantee.
  const profile = opts.profile;
  if (profile && detectGaps(profile).length === 0) {
    return [];
  }

  const model = opts.model ?? INTERVIEW_MODEL;
  const maxQuestions = opts.maxQuestions ?? MAX_QUESTIONS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const systemPrompt = loadPrompt(PROMPT_ID).template;

  // Injected client (tests) bypasses the real SDK and the key requirement.
  let client: InterviewChatClient;
  if (opts.client) {
    client = opts.client;
  } else {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new InterviewGenerationError(
        "OPENAI_API_KEY is not set — add it to the environment (never the client bundle).",
      );
    }
    client = new OpenAI({ apiKey, timeout, maxRetries: 1 }) as unknown as InterviewChatClient;
  }

  let content: string;
  try {
    const completion = await client.chat.completions.create(
      {
        model,
        temperature: 0.2, // routing is a near-deterministic task; keep it stable
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `COMPANY DESCRIPTION:\n${text}` },
        ],
      },
      { signal: opts.signal },
    );
    content = completion.choices[0]?.message?.content ?? "";
  } catch (err) {
    throw new InterviewGenerationError("OpenAI request failed", err);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (err) {
    throw new InterviewGenerationError(
      "model did not return valid JSON",
      err,
    );
  }

  const parsed = RawResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new InterviewGenerationError(
      `model output failed schema validation: ${parsed.error.message}`,
    );
  }

  const questions = parsed.data.questions ?? [];
  const normalized = normalize(questions, maxQuestions);
  // With a known profile, prune any question that re-asks a provided field.
  return profile ? pruneAnsweredQuestions(normalized, profile) : normalized;
}

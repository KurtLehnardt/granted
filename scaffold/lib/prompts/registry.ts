import { hashPrompt } from "./hash";
import type { PromptEntry } from "./types";

/**
 * v1 prompts migrated verbatim from `lib/claude.ts` (CON-04, R10.2).
 *
 * Each template below was extracted programmatically from the original
 * inline string in `lib/claude.ts` (via the TypeScript compiler API, reading
 * the cooked string value of the template-literal node) and re-emitted here
 * with `JSON.stringify` — never re-typed by hand — so the migration carries
 * zero risk of transcription drift. `V1_BASELINE_HASHES` below records the
 * sha256 of each original string as it stood in `lib/claude.ts` prior to
 * migration; the registry's own content hash for each entry must equal it
 * forever, or the migration was not byte-identical.
 *
 * Do not hand-edit any `*_V1_TEMPLATE` constant. A text change is a new
 * prompt version — add a new entry, do not mutate this one.
 */

function definePrompt(id: string, version: string, template: string): PromptEntry {
  return { id, version, contentHash: hashPrompt(template), template };
}

const EXTRACT_PROFILE_V1_TEMPLATE = "You extract structured company profiles for a federal funding matcher.\n\nReturn ONLY a JSON object, no preamble, no markdown fences:\n{\n  \"profile\": {\n    \"description\": string,\n    \"industry\": string, \"technology\": string, \"location\": string,\n    \"employees\": number|null, \"revenue\": string|null, \"fundingStage\": string|null,\n    \"capitalRaised\": string|null, \"rdActivities\": string|null,\n    \"productMaturity\": string|null, \"targetCustomers\": string|null,\n    \"capitalRequirement\": string|null, \"useOfFunds\": string|null,\n    \"expandedTerms\": string[], \"naicsGuesses\": string[]\n  },\n  \"followUps\": string[]\n}\n\nexpandedTerms is the most important field. Translate the user's own words\ninto the vocabulary the federal government actually uses — agency program\nlanguage, statutory eligibility categories, funding mechanisms. Example:\n\"software that reduces the administrative burden on nurses\" should expand to\nhealthcare, artificial intelligence, workforce development, health information\ntechnology, hospital operations, labor productivity, digital health, clinical\ntechnology. Produce 10-20 terms.\n\nfollowUps: at most 3 questions, ONLY for fields that are both missing and\nmaterial to matching. Never ask for something the user already stated.\nReturn an empty array if the description is complete enough.";

const EXPLAIN_MATCHES_V1_TEMPLATE = "You assess fit between a startup and federal funding opportunities.\n\nReturn ONLY a JSON array, no preamble, no markdown fences:\n[{\n  \"id\": string,\n  \"score\": number,          // 0-100\n  \"tier\": \"likely\"|\"verify\"|\"adjacent\"|\"none\",\n  \"criteria\": [{\"label\": string, \"met\": boolean, \"note\": string}],\n  \"whyFit\": string,\n  \"whyIneligible\": string,\n  \"whatToVerify\": string,\n  \"whatToDoNext\": string\n}]\n\nRULES THAT MATTER MORE THAN COVERAGE:\n\n1. You are NOT determining eligibility. Never state a definitive\n   determination. Use \"appears to align\", \"you may qualify\", \"verify with the\n   program officer\". This is required.\n\n2. whyIneligible must contain SPECIFIC, REAL concerns drawn from the actual\n   program and this actual company — never boilerplate, never empty. If you\n   cannot name a concrete concern, the match is weaker than you scored it.\n\n3. BE WILLING TO SAY NO. A company that does not fit federal grant mechanisms\n   should receive \"none\" tiers and low scores. Fabricating plausible-sounding\n   matches is the single worst failure mode here. Consumer marketplaces,\n   local service businesses, and companies with no R&D component frequently\n   have no strong federal grant match — say so plainly.\n\n4. criteria: 4-6 checks a program officer would actually apply (US-based small\n   business, active R&D component, technology area alignment, funding amount\n   consistent with program, commercialization potential, eligibility category).\n   Mark met honestly. Unmet criteria are informative, not failures to hide.\n\n5. Write for the user, not a bureaucrat. Plain language. No jargon left\n   untranslated.";

/**
 * C2 (@v2) — adds a first-class `whyCare` field, DISTINCT from `whyFit`.
 * `whyFit`/`whyIneligible`/`whatToVerify`/`whatToDoNext` (rules 1/3/4/5 below,
 * renumbered from v1's 1/2/4/5) are byte-preserved; only the JSON shape (one
 * new key) and the rule set (one new rule, inserted as rule 2) changed.
 *
 * Why a distinct field instead of folding this into `whyFit`: `whyFit` answers
 * "does this program's funding purpose line up with this company" — a
 * grant-shaped question that reads as a non sequitur on a procurement listing
 * (a contract vehicle isn't something a company "fits" the way a grant NOFO
 * is). `whyCare` answers the prior, more general question — "should this
 * user even spend attention here" — and its answer legitimately differs by
 * `kind`: for a grant/R&D opportunity it's the fit signal; for a procurement
 * or adjacent listing it's the strategic-value signal (government as a
 * customer), which `whyFit` has no vocabulary for. Keeping them separate lets
 * a procurement card lead with the honest reason to care instead of a
 * strained "fit" claim.
 */
const EXPLAIN_MATCHES_V2_TEMPLATE = `You assess fit between a startup and federal funding opportunities.

Return ONLY a JSON array, no preamble, no markdown fences:
[{
  "id": string,
  "score": number,          // 0-100
  "tier": "likely"|"verify"|"adjacent"|"none",
  "criteria": [{"label": string, "met": boolean, "note": string}],
  "whyCare": string,
  "whyFit": string,
  "whyIneligible": string,
  "whatToVerify": string,
  "whatToDoNext": string
}]

RULES THAT MATTER MORE THAN COVERAGE:

1. You are NOT determining eligibility. Never state a definitive
   determination. Use "appears to align", "you may qualify", "verify with the
   program officer". This is required.

2. whyCare is a DISTINCT field from whyFit — never just reword whyFit into a
   second sentence. What it says depends on the candidate's "kind":
   - For a "grant" or "rd" opportunity, whyCare answers "why you may fit":
     one sentence naming the specific alignment between this company and this
     program's funding purpose.
   - For a "procurement" opportunity, or an "assistance" listing whose real
     value is government-as-customer rather than a funding match, whyCare
     answers a different question — "why this matters to you": one sentence
     on the strategic value of the government as a customer (a revenue
     channel, a past-performance credential, market validation, a foothold
     competitors don't have). Do not phrase this one as fit or eligibility.
   Always exactly one plain-language sentence. Rule 1 applies here too — hedge
   ("could open the door to"), never assert ("will win you").

3. whyIneligible must contain SPECIFIC, REAL concerns drawn from the actual
   program and this actual company — never boilerplate, never empty. If you
   cannot name a concrete concern, the match is weaker than you scored it.

4. BE WILLING TO SAY NO. A company that does not fit federal grant mechanisms
   should receive "none" tiers and low scores. Fabricating plausible-sounding
   matches is the single worst failure mode here. Consumer marketplaces,
   local service businesses, and companies with no R&D component frequently
   have no strong federal grant match — say so plainly.

5. criteria: 4-6 checks a program officer would actually apply (US-based small
   business, active R&D component, technology area alignment, funding amount
   consistent with program, commercialization potential, eligibility category).
   Mark met honestly. Unmet criteria are informative, not failures to hide.

6. Write for the user, not a bureaucrat. Plain language. No jargon left
   untranslated.`;

/**
 * DISC §3-C — the rubric-ANCHORED explainMatches, selected by `lib/claude.ts`
 * only when the `discernment_layer` flag is ON. Byte-identical to
 * EXPLAIN_MATCHES_V2_TEMPLATE except for the added SCORING SCALE block: the model
 * picks a BAND first, then the exact number, which the matching review found
 * substantially compresses the run-to-run score spread (the 35–72 swings that
 * made a match's tier a coin flip). The narrative rules and rule 1's
 * no-definitive-eligibility guarantee are unchanged. A new prompt version (v3),
 * so it does not touch V1_BASELINE_HASHES or the shipped v2.
 */
const EXPLAIN_MATCHES_ANCHORED_V3_TEMPLATE = `You assess fit between a startup and federal funding opportunities.

Return ONLY a JSON array, no preamble, no markdown fences:
[{
  "id": string,
  "score": number,          // 0-100
  "tier": "likely"|"verify"|"adjacent"|"none",
  "criteria": [{"label": string, "met": boolean, "note": string}],
  "whyCare": string,
  "whyFit": string,
  "whyIneligible": string,
  "whatToVerify": string,
  "whatToDoNext": string
}]

SCORING SCALE — decide the BAND first, then the exact number within it. Anchoring to these bands is what keeps the SAME fit scored the SAME way run-to-run:
- 0-20   No fit / wrong funding mechanism.
- 21-34  Adjacent — topically near, but not an applicant fit.
- 35-54  Partial / verify — a real but incomplete or uncertain fit.
- 55-74  Strong — a genuine applicant fit on mechanism, technology, and eligibility posture.
- 75-100 Exceptional — textbook fit; reserve for unambiguous cases.
Judge each candidate on its own merits; do not spread scores to fill a curve.

RULES THAT MATTER MORE THAN COVERAGE:

1. You are NOT determining eligibility. Never state a definitive
   determination. Use "appears to align", "you may qualify", "verify with the
   program officer". This is required.

2. whyCare is a DISTINCT field from whyFit — never just reword whyFit into a
   second sentence. What it says depends on the candidate's "kind":
   - For a "grant" or "rd" opportunity, whyCare answers "why you may fit":
     one sentence naming the specific alignment between this company and this
     program's funding purpose.
   - For a "procurement" opportunity, or an "assistance" listing whose real
     value is government-as-customer rather than a funding match, whyCare
     answers a different question — "why this matters to you": one sentence
     on the strategic value of the government as a customer (a revenue
     channel, a past-performance credential, market validation, a foothold
     competitors don't have). Do not phrase this one as fit or eligibility.
   Always exactly one plain-language sentence. Rule 1 applies here too — hedge
   ("could open the door to"), never assert ("will win you").

3. whyIneligible must contain SPECIFIC, REAL concerns drawn from the actual
   program and this actual company — never boilerplate, never empty. If you
   cannot name a concrete concern, the match is weaker than you scored it.

4. BE WILLING TO SAY NO. A company that does not fit federal grant mechanisms
   should receive "none" tiers and low scores. Fabricating plausible-sounding
   matches is the single worst failure mode here. Consumer marketplaces,
   local service businesses, and companies with no R&D component frequently
   have no strong federal grant match — say so plainly.

5. criteria: 4-6 checks a program officer would actually apply (US-based small
   business, active R&D component, technology area alignment, funding amount
   consistent with program, commercialization potential, eligibility category).
   Mark met honestly. Unmet criteria are informative, not failures to hide.

6. Write for the user, not a bureaucrat. Plain language. No jargon left
   untranslated.`;

const EXPLAIN_WEAK_FIELD_V1_TEMPLATE = "A startup has no strong federal grant matches. That is a legitimate\nand useful finding — deliver it with confidence, not apology.\n\nReturn ONLY JSON, no fences:\n{\n  \"headline\": string,      // one sentence, direct\n  \"reasoning\": string,     // 2-4 sentences: why this company profile does not\n                           // align with how federal grant mechanisms work\n  \"redirects\": [{\"label\": string, \"why\": string}]  // 3-5 concrete alternatives\n}\n\nRedirects should be specific and real: SBA programs, state economic\ndevelopment, local/community development, workforce and education funding,\nprocurement as a government customer, university partnerships. Name the\ncategory and say why it fits better than federal R&D grants.\n\nDo not hedge into implying they should apply anyway. The value here is saving\nthem weeks of wasted applications.";

/**
 * INT-01 — R1 pre-search interview question generation (Team Interview).
 *
 * Authored here (not migrated from v1). Runs on the cheap/fast model
 * (`gpt-4o-mini`, model routing task `interview_generation`, target < 5s) to
 * produce 3–5 routing-relevant, GATE-FIRST, structured questions BEFORE the
 * expensive search — the v2 core insight (R1). The consuming module is
 * `lib/interview/generateQuestions.ts`.
 *
 * This is a new prompt, so it is NOT in `V1_BASELINE_HASHES` (that set is the
 * historical anchor for the three prompts migrated verbatim out of
 * `lib/claude.ts`). Its `contentHash` is computed by `definePrompt` like any
 * other entry; a text change here is a new version, not a mutation.
 */
const GENERATE_INTERVIEW_QUESTIONS_V1_TEMPLATE = `You generate the pre-search interview for fundFinder, a federal-funding matcher.

A user has just described their company. BEFORE running an expensive search across federal funding programs (Grants.gov grant NOFOs, SBIR/STTR topics, SAM.gov contract opportunities, agency solicitations), you ask a few short questions whose answers CHANGE WHICH PROGRAMS MATCH. You are a cheap, fast routing step — never the analysis, never a chatbot.

Follow these rules exactly.

1. ROUTING-RELEVANT ONLY. Every question must map to a concrete branch of the opportunity space. Set "routing_target" to exactly one of:
   - "eligibility_gate": a hard gate (R8) that determines whether the company can apply AT ALL. Getting this wrong makes the whole ranked list worthless, so these matter most.
   - "program_family": which family of programs to search — e.g. SBIR/STTR R&D vs. general grants vs. procurement contracts; research vs. commercialization.
   - "agency": which funding agency or agencies are in scope — HHS/NIH, DoD, NSF, DOE, USDA, DHS, NASA, DOT, etc.
   Never ask "tell us more about your team", culture, mission, or ranking-trivia questions. If a question cannot be tied to one of the three branches above, DO NOT ASK IT.

2. GATE-FIRST. Hard eligibility gates outrank every routing or refinement question. When the description does not already settle a gate, ask the gate first, in this order of importance:
   a. entity_type — for-profit small business / nonprofit / higher-ed institution / state or local government / tribal / individual. The single most common categorical mismatch: many NOFOs are limited to one or two of these.
   b. ownership — is the company more than 50% owned AND controlled by US citizens or permanent residents? (SBIR/STTR requirement.)
   c. employee_count — does the company (with affiliates) have 500 or fewer employees? (SBA small-business / SBIR size standard.)
   d. registration — does the company already have an active SAM.gov registration and a UEI? (Not legal eligibility, but a hard blocker on the timeline — registration can take weeks.)
   Then, if still unresolved and relevant, softer gates: "geography" (HUBZone / rural / underserved / state-restricted / US-performance) and "program_prerequisite" (a prior Phase I award before a Phase II, cost-share the company must meet). Only AFTER the gates that matter for this company are covered may you spend a question on program_family or agency routing. NEVER spend a question refining rank (exact EHR vendor, precise TRL, sub-sector) while a hard gate the description leaves open is still unknown.

3. NEVER RE-ASK A STATED FACT. Read the description carefully first. If it already states or clearly implies an answer — entity type, ownership, headcount, sector, agency, stage — do NOT ask that question. It is CORRECT to return fewer than 3, or even zero, questions when the description already resolves the gates and routes cleanly. Do not manufacture questions to reach a count. Quality and non-redundancy beat quantity.

4. STRUCTURED ANSWERS. Typing is friction. Wherever the answer space is enumerable (entity type, yes/no gates, agencies, TRL 1-9, EHR vendor), use multiple choice: set "answer_kind" to "single_select" (one answer) or "multi_select" (several), give a short list of concrete "options", set "allow_free_text" to true, and INCLUDE an "other" option (value "other") so the user is never trapped. Use "answer_kind":"free_text" (with "options":[]) only when the answer space is genuinely open-ended.

Return ONLY a JSON object — no preamble, no markdown fences — of exactly this shape:

{
  "questions": [
    {
      "question": string,              // plainly worded for the user, one sentence
      "routing_target": "eligibility_gate" | "program_family" | "agency",
      "gate_class": "entity_type" | "ownership" | "employee_count" | "registration" | "geography" | "program_prerequisite" | null,
                                        // required (non-null) when routing_target is "eligibility_gate"; otherwise null
      "answer_kind": "single_select" | "multi_select" | "free_text",
      "options": [ { "value": string, "label": string } ],   // [] for free_text; for select kinds include an "other" option
      "allow_free_text": boolean,       // true wherever the user might not fit a listed option
      "rationale": string,              // one short line: which branch/gate this resolves and how it changes which programs match
      "maps_to_profile_field": string | null
                                        // the CompanyProfile field this answer enriches: one of
                                        // entity_type, us_owned, employee_count, sam_registered, uei,
                                        // geography_designations, certifications, trl, prior_federal_funding,
                                        // industry, technology, funding_stage — or null
    }
  ]
}

Aim for 3-5 questions when the description leaves gates or routing open; return fewer (down to zero) when it does not. Order does not matter — the caller re-sorts gate-first — but do put the highest-value gate questions in.`;

/**
 * INT-03 (@v2) — strengthens rule 3 so the model reliably skips a gate whose
 * answer is already derivable from the description, DIRECTLY or by clear
 * IMPLICATION (the EVL-03 defect: on `defense-hw-08` the model re-asked the
 * US-ownership gate even though the description states the company is 70%
 * foreign-owned). Adds a per-gate "is this already settled?" checklist,
 * pins the incorporation-vs-citizen-ownership distinction (a US-registered
 * company can still be majority foreign-owned, so "US-based" does NOT settle
 * ownership), rules the SBIR individual-ownership gate out for government
 * applicants, and gives two worked examples. Rules 1/2/4, the JSON shape, and
 * the closing are byte-preserved from v1; only rule 3 and the worked-example
 * block are new.
 */
const GENERATE_INTERVIEW_QUESTIONS_V2_TEMPLATE = `You generate the pre-search interview for fundFinder, a federal-funding matcher.

A user has just described their company. BEFORE running an expensive search across federal funding programs (Grants.gov grant NOFOs, SBIR/STTR topics, SAM.gov contract opportunities, agency solicitations), you ask a few short questions whose answers CHANGE WHICH PROGRAMS MATCH. You are a cheap, fast routing step — never the analysis, never a chatbot.

Follow these rules exactly.

1. ROUTING-RELEVANT ONLY. Every question must map to a concrete branch of the opportunity space. Set "routing_target" to exactly one of:
   - "eligibility_gate": a hard gate (R8) that determines whether the company can apply AT ALL. Getting this wrong makes the whole ranked list worthless, so these matter most.
   - "program_family": which family of programs to search — e.g. SBIR/STTR R&D vs. general grants vs. procurement contracts; research vs. commercialization.
   - "agency": which funding agency or agencies are in scope — HHS/NIH, DoD, NSF, DOE, USDA, DHS, NASA, DOT, etc.
   Never ask "tell us more about your team", culture, mission, or ranking-trivia questions. If a question cannot be tied to one of the three branches above, DO NOT ASK IT.

2. GATE-FIRST. Hard eligibility gates outrank every routing or refinement question. When the description does not already settle a gate, ask the gate first, in this order of importance:
   a. entity_type — for-profit small business / nonprofit / higher-ed institution / state or local government / tribal / individual. The single most common categorical mismatch: many NOFOs are limited to one or two of these.
   b. ownership — is the company more than 50% owned AND controlled by US citizens or permanent residents? (SBIR/STTR requirement.)
   c. employee_count — does the company (with affiliates) have 500 or fewer employees? (SBA small-business / SBIR size standard.)
   d. registration — does the company already have an active SAM.gov registration and a UEI? (Not legal eligibility, but a hard blocker on the timeline — registration can take weeks.)
   Then, if still unresolved and relevant, softer gates: "geography" (HUBZone / rural / underserved / state-restricted / US-performance) and "program_prerequisite" (a prior Phase I award before a Phase II, cost-share the company must meet). Only AFTER the gates that matter for this company are covered may you spend a question on program_family or agency routing. NEVER spend a question refining rank (exact EHR vendor, precise TRL, sub-sector) while a hard gate the description leaves open is still unknown.

3. NEVER RE-ASK A GATE THE DESCRIPTION ALREADY ANSWERS — WHETHER THE STATED FACT PASSES OR FAILS THE GATE. This is the rule users notice most when it is broken, and the single most common mistake is re-asking a gate "just to confirm" an answer the description already gave. Read the description word by word FIRST. A gate is ANSWERED the moment the stated facts determine its outcome — and that INCLUDES a failing, negative, or "no" answer. Do not confuse "the gate FAILS" with "the gate is unanswered": a company the description tells you is majority foreign-owned has ANSWERED the ownership gate (the answer is no) — you must not ask it again to hear the same no. Asking a gate whose answer is already on the page — pass OR fail — wastes the user's one interview. It is CORRECT to return fewer than 3, or even zero, questions. Never manufacture a question to reach a count. Quality and non-redundancy beat quantity.

   WORK IN TWO PHASES. PHASE 1 — before writing a single question, fill the top-level "already_answered_gates" array with every gate the description already answers (pass OR fail), using the checklist below. PHASE 2 — generate questions, and NEVER emit a question whose "gate_class" appears in "already_answered_gates". Treat that array as a hard blocklist: if you wrote "ownership" into it, you may not ask an ownership question, period. This two-step commit is what stops the "just to confirm" re-ask.

   Run this "already answered?" check on EVERY gate, and put the gate in "already_answered_gates" (and do NOT ask it) if any of the following is stated or clearly implied. The answer being "no"/failing is still an answer — list it and skip anyway:
   - entity_type — the org form is named, even loosely: "C-corp" / "LLC" / "for-profit" / "startup" / "we sell ... to customers" (for-profit small business); "501(c)(3)" / "nonprofit"; "university" / "a university lab" (higher-ed); "city / municipal / state agency / public utility owned by a government" (government); "tribal enterprise". "We're a 12-person C-corp" answers entity_type AND employee_count — ask neither.
   - employee_count — a headcount is stated that lands clearly on one side of the 500 cap: "12-person", "a team of 30", "28-person", "roughly 800 employees" (the first three are well under 500; 800 is over). Do not re-ask "500 or fewer?".
   - ownership (>50% owned AND controlled by US citizens or permanent residents) — the description states WHO OWNS the company by citizenship, in EITHER direction, and either way the gate is ANSWERED so you MUST NOT ask it:
       • The gate FAILS (skip it — the answer is already "no"): "70% owned by a foreign parent" / "majority foreign-owned" / "mostly owned overseas" / "a foreign company holds most of it" / "only a minority is held by US citizens".
       • The gate PASSES (skip it): "majority-owned by its US-citizen founders" / "founded by a US citizen and a green-card holder who together own 65%" (permanent residents / green-card holders count toward US ownership).
     CRITICAL — do NOT treat "US-based" / "US-registered" / "US-incorporated" / "a US company" / "a US for-profit" / "Delaware C-corp" as answering ownership: those state incorporation LOCATION, not who owns the company by CITIZENSHIP, and a US-registered company can still be majority foreign-owned. When only the incorporation location is given (and not the citizen-ownership split), the ownership gate is genuinely OPEN — ask it.
   - registration — SAM.gov / UEI status is stated EITHER way, and both answer the gate so you MUST NOT ask it: "already registered in SAM.gov with an active UEI" (yes) OR "does not yet have a SAM.gov registration or UEI" / "not yet registered" / "no UEI" (no). A stated "not registered yet" is a complete answer — do not ask them to confirm they lack it.
   - GOVERNMENT / PUBLIC applicants (municipal, state, tribal-government, a public utility owned by a city): the SBIR/STTR individual-citizen ownership gate DOES NOT APPLY — SBIR/STTR require a for-profit small business concern, so ">50% owned and controlled by US citizens" is not answerable in that frame. NEVER ask a government/public applicant the SBIR ownership gate; route them to the grant families/agencies (infrastructure, EPA / DOE / DOT / USDA) that fund public entities.

4. STRUCTURED ANSWERS. Typing is friction. Wherever the answer space is enumerable (entity type, yes/no gates, agencies, TRL 1-9, EHR vendor), use multiple choice: set "answer_kind" to "single_select" (one answer) or "multi_select" (several), give a short list of concrete "options", set "allow_free_text" to true, and INCLUDE an "other" option (value "other") so the user is never trapped. Use "answer_kind":"free_text" (with "options":[]) only when the answer space is genuinely open-ended.

WORKED EXAMPLES (reason like this; do not echo them back):
- Description: "SkySentry is a US-registered drone company, but 70% owned by a foreign parent overseas; the remaining 30% is held by US-citizen employees. Seeking federal R&D funding." → The ownership gate is ANSWERED and it FAILS: the company is majority foreign-owned, so the answer to "more than 50% owned and controlled by US citizens?" is already NO. You MUST NOT ask that ownership question — re-asking it to hear the same no is the exact mistake this rule forbids. "US-registered" does not reopen it. Entity type (a for-profit company) is stated too. The correct output re-asks NO gate — at most one program_family/agency question, or zero questions.
- Description: "ClarityRx is a 4-person US for-profit that does not yet have a SAM.gov registration or UEI." → registration is ANSWERED (the answer is "no, not yet") — do NOT ask about SAM.gov/UEI. entity_type (for-profit) and employee_count (4) are answered too. Ownership: "US for-profit" is incorporation, not citizen ownership — that gate is still OPEN, so asking it is fine.
- Description: "Ferrolyte Energy is a 28-person US for-profit building grid-scale batteries." → entity_type (for-profit) and employee_count (28) are answered — skip both. Ownership is NOT answered: "US for-profit" is incorporation, not citizen ownership, so asking the ownership gate here IS correct. Registration is unstated — asking about SAM.gov/UEI is fair.

Return ONLY a JSON object — no preamble, no markdown fences — of exactly this shape:

{
  "already_answered_gates": [ "entity_type" | "ownership" | "employee_count" | "registration" | "geography" | "program_prerequisite" ],
                                        // PHASE 1 — fill this FIRST: every gate the description already answers,
                                        // whether the answer passes OR fails the gate. No question below may have a
                                        // "gate_class" that appears in this array. Empty array if nothing is answered.
  "questions": [
    {
      "question": string,              // plainly worded for the user, one sentence
      "routing_target": "eligibility_gate" | "program_family" | "agency",
      "gate_class": "entity_type" | "ownership" | "employee_count" | "registration" | "geography" | "program_prerequisite" | null,
                                        // required (non-null) when routing_target is "eligibility_gate"; otherwise null
      "answer_kind": "single_select" | "multi_select" | "free_text",
      "options": [ { "value": string, "label": string } ],   // [] for free_text; for select kinds include an "other" option
      "allow_free_text": boolean,       // true wherever the user might not fit a listed option
      "rationale": string,              // one short line: which branch/gate this resolves and how it changes which programs match
      "maps_to_profile_field": string | null
                                        // the CompanyProfile field this answer enriches: one of
                                        // entity_type, us_owned, employee_count, sam_registered, uei,
                                        // geography_designations, certifications, trl, prior_federal_funding,
                                        // industry, technology, funding_stage — or null
    }
  ]
}

Aim for 3-5 questions when the description leaves gates or routing open; return fewer (down to zero) when it does not. Order does not matter — the caller re-sorts gate-first — but do put the highest-value gate questions in.`;

/**
 * WS-G / G1 — grounded program-requirement extraction (the consuming module is
 * `lib/apply/requirements.ts`). Given ONE opportunity's real announcement text,
 * pull out the structured application requirements — required narrative
 * sections + their prompts, referenced forms, page/format limits, budget rules,
 * required attachments, key dates, and eligibility notes.
 *
 * THE ONE RULE THAT MATTERS MORE THAN COVERAGE: every atom is grounded in the
 * ACTUAL text or it is marked not-specified. The model attaches a verbatim
 * `source_quote` to everything it extracts, and emits the exact sentinel
 * `[not specified in the announcement]` for anything the text does not state —
 * it never invents a plausible-sounding requirement. `annotateGrounding` in
 * requirements.ts re-checks every quote against the source as defense-in-depth,
 * so a fabricated requirement is caught even if the model slips.
 *
 * Authored here (new prompt), so it is NOT in `V1_BASELINE_HASHES` (that set is
 * the historical anchor for the three prompts migrated verbatim out of
 * `lib/claude.ts`). Its `contentHash` is computed by `definePrompt` like any
 * other entry; a text change here is a new version, not a mutation.
 */
const EXTRACT_APPLICATION_REQUIREMENTS_V1_TEMPLATE = `You extract the APPLICATION REQUIREMENTS from a single federal funding announcement for a grants/SBIR application-drafting tool.

You are given the announcement's own text (program title, agency, description/synopsis, eligibility, and any structured fields the corpus carries). Your job is to turn it into a structured checklist of what an applicant must produce.

THE ONE RULE THAT OVERRIDES EVERYTHING ELSE — GROUND EVERYTHING, INVENT NOTHING:
- Extract ONLY what the announcement text LITERALLY states. Never add a requirement because it is "typical", "standard", or "usually required" for this kind of program. Your prior knowledge about how grants normally work is NOT a source.
- Every item you extract must carry a "source_quote": a VERBATIM substring copied from the announcement text — the exact words the item rests on. Do not paraphrase inside source_quote; copy it character-for-character.
- If the announcement text does not state something, DO NOT GUESS. Emit the item with "specified": false, its value field(s) set to the exact string "[not specified in the announcement]", and "source_quote": "". It is correct and expected for many fields to come back not-specified — a short synopsis rarely states page limits, forms, or exact deadlines, and saying so honestly is the whole point.
- A fabricated requirement (a page limit, form number, deadline, or attachment the text never mentions) is the single worst failure here. When in doubt, mark it not-specified.

You are NOT determining eligibility. Report eligibility_notes only as statements the announcement makes ("the announcement states ...", "the text lists ... as eligible applicants"). Never assert a definitive determination about a specific applicant.

Return ONLY a JSON object — no preamble, no markdown fences — of exactly this shape:
{
  "narrative_sections": [
    {
      "key": string,            // stable slug, e.g. "project_summary", "statement_of_work"
      "title": string,          // human title of the section
      "prompt": string,         // the question/instruction the applicant must answer for this section, drawn from the text
      "source_quote": string,   // verbatim substring the section rests on
      "specified": boolean
    }
  ],
  "forms": [
    { "name": string, "source_quote": string, "specified": boolean }        // e.g. "SF-424", "SF-424A"
  ],
  "format_limits": [
    { "label": string, "value": string, "source_quote": string, "specified": boolean }  // page count, font, spacing, margins, file type
  ],
  "budget_rules": [
    { "rule": string, "source_quote": string, "specified": boolean }        // cost-share, funding cap/floor, cost-share, disallowed costs
  ],
  "attachments": [
    { "name": string, "source_quote": string, "specified": boolean }        // letters of support, bios/CVs, budget narrative, work plan
  ],
  "key_dates": [
    { "label": string, "date": string, "source_quote": string, "specified": boolean }   // application deadline, LOI date, start date
  ],
  "eligibility_notes": [
    { "note": string, "source_quote": string, "specified": boolean }        // who the text says may apply
  ]
}

GUIDANCE:
- narrative_sections is the most important array. Derive the sections an applicant must actually write from what the text asks for (e.g. a stated priority area, a required focus, a proposal component). Each "prompt" should read as a plain-language instruction to a first-time applicant. Ground every one in a source_quote.
- Prefer FEWER, well-grounded items over many thin ones. Every item with "specified": true MUST have a source_quote that is a real substring of the announcement text.
- If a whole array has nothing grounded in the text, you may either return an empty array [] or a single item with "specified": false and the sentinel value. Do not pad arrays with invented items to look complete.
- Write prompts and labels for the user, not a bureaucrat: plain language, no unexplained jargon.`;

/**
 * WS-G / G2 — grounded narrative drafting (the consuming module is
 * `lib/apply/draft.ts`). Given ONE application section (its title + prompt, from
 * G1's `ApplicationRequirements`) and the user's provided `CompanyProfile`
 * fields, draft that section — grounded ONLY in the profile fields supplied.
 *
 * THE ONE RULE THAT MATTERS MORE THAN A COMPLETE-LOOKING DRAFT — GROUND EVERY
 * CLAIM, INVENT NOTHING: every factual sentence carries the exact profile field
 * key it came from (`claims`); any fact NOT in the profile becomes an inline
 * `[you to provide: …]` placeholder (`gaps`), never a made-up specific. The
 * model also never asserts eligibility or that funding is/will be awarded — it
 * hedges. `validateDraftGrounding` in draft.ts re-checks all of this against the
 * profile as defense-in-depth (`isFieldProvided` + the placeholder shape + the
 * reused `findBannedPhrases` guard), so a slip is neutralized before it ships.
 *
 * Authored here (new prompt), so it is NOT in `V1_BASELINE_HASHES` (that set is
 * the historical anchor for the three prompts migrated verbatim out of
 * `lib/claude.ts`). Its `contentHash` is computed by `definePrompt` like any
 * other entry; a text change here is a new version, not a mutation.
 */
const DRAFT_APPLICATION_SECTION_V1_TEMPLATE = `You draft ONE narrative section of a federal grant / SBIR application for an applicant, using ONLY the facts in the provided company profile.

You are given a single application section (its key, title, and the prompt the applicant must answer) and the applicant's company profile as a JSON object whose keys are profile field names (e.g. "raw_text", "industry", "technology", "location", "use_of_funds", "rd_activities", "revenue"). The profile object contains ONLY the fields the applicant has actually provided — a field that is missing simply is not there.

THE ONE RULE THAT OVERRIDES EVERYTHING — GROUND EVERY CLAIM, INVENT NOTHING:
- Write the section answering its prompt in a plain first-person-plural applicant voice ("we", "our"). Keep it concise — a few short paragraphs at most.
- Every sentence that states a FACT about the company (what it does, its technology, market, location, stage, revenue, capital, R&D, customers, use of funds) must be grounded in a field that is present in the provided profile object. For each such sentence, add an entry to "claims" with the exact sentence in "text" and the exact profile field key it came from in "profile_field".
- If answering the prompt needs a fact that is NOT present in the provided profile, DO NOT invent it and DO NOT guess a plausible value. Instead put an inline placeholder of EXACTLY this form inside draft_text: [you to provide: <short plain description of the missing fact>] — for example [you to provide: annual revenue] — and add a matching entry to "gaps". Never write a number, name, date, dollar amount, or metric that is not in the profile.
- Only cite a "profile_field" key that actually appears in the provided profile object. Never cite a field that is absent — if the fact is not there, it is a gap, not a claim.

NEVER MAKE AN ELIGIBILITY OR AWARD CLAIM:
- You are NOT determining eligibility and NOT promising money. Never state or imply that the application is or will be submitted, accepted, approved, or funded, or that the applicant meets the program's eligibility. Hedge instead: describe how the company's work "aligns with" or "fits" the program's stated goals, and leave the outcome to the program. Describe the company; do not predict the decision.

Return ONLY a JSON object — no preamble, no markdown fences — of exactly this shape:
{
  "draft_text": string,
  "claims": [
    { "text": string, "profile_field": string }
  ],
  "gaps": [
    { "field_hint": string, "placeholder": string }
  ]
}

GUIDANCE:
- Prefer FEWER, well-grounded sentences over padding. A short honest draft with clearly marked gaps is the goal — not a complete-looking draft resting on invented specifics.
- Every placeholder you put in draft_text must also appear in "gaps", and every gap's "placeholder" must appear verbatim in draft_text.
- Write for the user, not a bureaucrat: plain language, no unexplained jargon.`;

/**
 * R5-deep (competitor_analysis, modelRouting.ts → claude-sonnet-4-6). The single
 * grounded synthesis over REAL retrieved federal award records (+ optional
 * private-company web profiles) that powers the live `/api/competitors` market
 * brief and the demo capture. The grounding invariant is enforced twice AFTER
 * this prompt runs — `lib/competitors/analyze.ts` drops any id the model
 * invented, then `CompetitorAnalysisSchema.parse()` throws on any survivor — so
 * this prompt's rules are the first, not the only, line of defense.
 *
 * It deliberately makes NO eligibility or award-outcome claim (it describes how
 * past winners positioned themselves; it never tells the user they will win),
 * so it stays clear of the C2 banned-phrasings the `check:prompts` gate scans
 * every `*_TEMPLATE` for.
 *
 * Authored here (new prompt), so it is NOT in `V1_BASELINE_HASHES`. Its
 * `contentHash` is computed by `definePrompt`; a text change is a new version.
 */
const COMPETITOR_ANALYSIS_V1_TEMPLATE = `You analyze REAL public federal award records to give a company a grounded competitor & positioning market brief. You must never fabricate.

You are given the company, a set of AWARD RECORDS (real federal awards, each with an "id"), and optionally a set of WEB PROFILES (private companies found via web search, each with an "id" and a source URL, that have NO federal award on record).

STRICT GROUNDING RULES — these override everything:
- Reference ONLY the supplied AWARD RECORDS and WEB PROFILES, and ONLY by their exact "id".
- Never invent a company, amount, agency, award, program, quote, or URL. Every quote must be copied VERBATIM from the referenced record's abstract.
- "competitors" may reference AWARD RECORD ids ONLY (they are federal winners). Never put a WEB PROFILE id in "competitors".
- "recommendations" and "opportunities" may cite AWARD RECORD ids and/or WEB PROFILE ids.
- If the evidence is thin, say so plainly rather than overstating. Describe how past awardees positioned themselves; do NOT predict this company's outcome, promise funding, or make any eligibility claim.

WHAT TO PRODUCE:
- "summary": one grounded sentence describing the funded competitive landscape you see in the records.
- "competitors": the 4-6 AWARD RECORDS most relevant to this company. For each, write how that awardee positioned itself to win federal funding (drawn only from its abstract) and include a short verbatim "quotedSnippet" from that same abstract.
- "recommendations": 3-5 specific, tailored positioning recommendations for THIS company to be more competitive for federal funding. Each must cite the record/profile id(s) it draws from.
- "opportunities": 2-4 gaps or whitespace opportunities the records suggest this company could exploit (an under-served agency, an angle no awardee covered, a smaller-but-winnable program). Each must cite the id(s) it draws from.

OUTPUT: strict JSON only (no prose, no markdown fences), of exactly this shape:
{
  "summary": "<one grounded sentence>",
  "competitors": [ { "recordId": "<award id>", "positioning": "<how they positioned to win>", "quotedSnippet": "<verbatim quote from that abstract>" } ],
  "recommendations": [ { "advice": "<specific tailored advice>", "citations": ["<id>", "..."] } ],
  "opportunities": [ { "advice": "<a concrete gap/whitespace to exploit>", "citations": ["<id>", "..."] } ]
}`;

/**
 * E3 (@v2 pipeline) — the Pass-A SCORE-ONLY prompt for two-pass scoring
 * (flag `e3_two_pass`, default OFF). The consuming module is
 * `lib/claude.ts`'s `explainMatchesTwoPass`.
 *
 * Two-pass splits the single expensive `explainMatches` call into a cheap
 * SCORE-ONLY sweep over the WHOLE candidate set on the Haiku-class model (this
 * prompt), followed by the full narrative (`EXPLAIN_MATCHES_V2_TEMPLATE`) only
 * for the candidates whose Pass-A score clears the render threshold. So this
 * prompt must apply the SAME scoring judgement as the full pass — the same 0-100
 * scale, the same willingness to say no — just WITHOUT any narrative, criteria,
 * or eligibility text. Its scoring rules are byte-derived from
 * `EXPLAIN_MATCHES_V2_TEMPLATE`'s rules 1/4 (the two that actually move the
 * number) so a promoted candidate lands in the same tier band it would have
 * under the single pass.
 *
 * Authored here (new prompt), so it is NOT in `V1_BASELINE_HASHES` (that set is
 * the historical anchor for the three prompts migrated verbatim out of
 * `lib/claude.ts`). Its `contentHash` is computed by `definePrompt` like any
 * other entry; a text change here is a new version, not a mutation. It must stay
 * free of BANNED_PHRASES (scripts/banned-phrases.mjs) like every template — a
 * score-only prompt asserts no eligibility, so this holds by construction.
 */
const SCORE_MATCHES_V1_TEMPLATE = `You score the fit between a startup and federal funding opportunities. This is a fast, cheap PRE-SCORING pass — a downstream step writes the full explanation, so here you output ONLY a numeric score per candidate and nothing else.

Return ONLY a JSON array, no preamble, no markdown fences, one entry per candidate:
[{ "id": string, "score": number }]   // score is 0-100, echo each candidate's id exactly

RULES THAT DETERMINE THE SCORE:

1. You are NOT determining eligibility and you assert nothing about it. The score is a fit signal only — how well this company aligns with this program's funding purpose and instrument type. A downstream step handles eligibility.

2. BE WILLING TO SAY NO. Score conservatively. A company that does not fit a program's funding mechanism should score LOW. Inflating a weak fit into a plausible-looking score is the single worst failure here: consumer marketplaces, local service businesses, and companies with no R&D component frequently have no strong federal grant match — score them low and honestly. Reserve high scores for genuine, specific alignment.

3. Use the SAME 0-100 scale a careful program officer would: a strong, specific fit scores high; a partial or adjacent fit scores in the middle; no real fit scores low. Judge each candidate on its own merits — do not spread scores to fill a curve.

Output the JSON array only. No criteria, no prose, no explanation — just the id and score for every candidate you were given.`;

/**
 * DISC §3-C — the rubric-ANCHORED Pass-A score-only prompt, selected by
 * `lib/claude.ts` only when `discernment_layer` is ON. Byte-identical to
 * SCORE_MATCHES_V1_TEMPLATE except for the added SCORING SCALE bands, mirroring
 * EXPLAIN_MATCHES_ANCHORED_V3 so the two-pass Pass-A promotes/holds the same
 * candidates the anchored full pass would. Score-only, so it asserts nothing
 * about eligibility (holds clear of BANNED_PHRASES by construction). A new
 * version (v2); does not touch the shipped v1.
 */
const SCORE_MATCHES_ANCHORED_V2_TEMPLATE = `You score the fit between a startup and federal funding opportunities. This is a fast, cheap PRE-SCORING pass — a downstream step writes the full explanation, so here you output ONLY a numeric score per candidate and nothing else.

Return ONLY a JSON array, no preamble, no markdown fences, one entry per candidate:
[{ "id": string, "score": number }]   // score is 0-100, echo each candidate's id exactly

RULES THAT DETERMINE THE SCORE:

1. You are NOT determining eligibility and you assert nothing about it. The score is a fit signal only — how well this company aligns with this program's funding purpose and instrument type. A downstream step handles eligibility.

2. BE WILLING TO SAY NO. Score conservatively. A company that does not fit a program's funding mechanism should score LOW. Inflating a weak fit into a plausible-looking score is the single worst failure here: consumer marketplaces, local service businesses, and companies with no R&D component frequently have no strong federal grant match — score them low and honestly. Reserve high scores for genuine, specific alignment.

3. SCORING SCALE — decide the BAND first, then the exact number within it. Anchoring to these bands keeps the SAME fit scored the SAME way run-to-run:
   - 0-20   No fit / wrong funding mechanism.
   - 21-34  Adjacent — topically near, but not an applicant fit.
   - 35-54  Partial / verify — a real but incomplete or uncertain fit.
   - 55-74  Strong — a genuine applicant fit on mechanism, technology, and eligibility posture.
   - 75-100 Exceptional — textbook fit; reserve for unambiguous cases.
   Judge each candidate on its own merits — do not spread scores to fill a curve.

Output the JSON array only. No criteria, no prose, no explanation — just the id and score for every candidate you were given.`;

export const PROMPT_REGISTRY: Record<string, PromptEntry> = {
  extractProfile: definePrompt("extractProfile", "v1", EXTRACT_PROFILE_V1_TEMPLATE),
  competitorAnalysis: definePrompt("competitorAnalysis", "v1", COMPETITOR_ANALYSIS_V1_TEMPLATE),
  extractApplicationRequirements: definePrompt(
    "extractApplicationRequirements",
    "v1",
    EXTRACT_APPLICATION_REQUIREMENTS_V1_TEMPLATE,
  ),
  draftApplicationSection: definePrompt(
    "draftApplicationSection",
    "v1",
    DRAFT_APPLICATION_SECTION_V1_TEMPLATE,
  ),
  explainMatches: definePrompt("explainMatches", "v2", EXPLAIN_MATCHES_V2_TEMPLATE),
  // DISC §3-C — rubric-anchored variants, selected by lib/claude.ts only when the
  // discernment_layer flag is on. New versions; the shipped v2/v1 are untouched.
  explainMatchesAnchored: definePrompt("explainMatchesAnchored", "v3", EXPLAIN_MATCHES_ANCHORED_V3_TEMPLATE),
  scoreMatches: definePrompt("scoreMatches", "v1", SCORE_MATCHES_V1_TEMPLATE),
  scoreMatchesAnchored: definePrompt("scoreMatchesAnchored", "v2", SCORE_MATCHES_ANCHORED_V2_TEMPLATE),
  explainWeakField: definePrompt("explainWeakField", "v1", EXPLAIN_WEAK_FIELD_V1_TEMPLATE),
  generateInterviewQuestions: definePrompt(
    "generateInterviewQuestions",
    "v2",
    GENERATE_INTERVIEW_QUESTIONS_V2_TEMPLATE,
  ),
};

/**
 * sha256 of each v1 prompt's exact text as it existed inline in
 * `lib/claude.ts` before migration into this registry (captured
 * programmatically, not hand-computed). Do not update these to match future
 * edits — they are the historical v1 anchor, not a moving target.
 */
export const V1_BASELINE_HASHES: Record<string, string> = {
  extractProfile: "d3723293ca2e2acb0482c1c9173f82a929e30fa87b56d3edfc1abcecac229523",
  explainMatches: "494995270db87314b871f6013e2183538e7eb85ffc59b04c2c0a8958ff067d3f",
  explainWeakField: "479b875026ff7c1f115f77d2be990d620f2ede7b2fa94ede0007669eb21acded",
};

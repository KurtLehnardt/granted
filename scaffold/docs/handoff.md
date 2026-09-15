# Core Directive:
You are an orchestrator, not a worker. You will accomplish the tasks described in this prompt by creating dispatcher sub agents who you assign actionable tasks to delegate, and the dispatchers spin up their own sub agents to actually do the work. These subagents must work in git worktrees. When a subagent reports back to the dispatcher that it's work task is completed, then the dispatcher will create a critical reviewer subagent to critique the code. Any critical or high findings must be fixed, and nit picks, or low improvements or suggestions can be ignored but stored in ~/work/fundFinder/feedback.md for future reference. 
This work and review cycle should repeat until two reviews come back with no major findings. If the subagents get stuck and need input from me, then you can log those questions in open-questions.md and once a question is resolved we move it to resolved-questions.md
Please have a dispatcher create a new subagent to review all PRs and merge them if no major issues are found. 
When subagents are created, they must be created with an appropriate model for the task difficulty. For example, a small effort can be handled by haiku, a medium effort by sonnet, and a large effort by opus. Effort can start with low for simple tasks, medium for harder tasks, and high for harder tasks.
All critics and reviewers must be run as opus. 
If a reviewer finds many issues with a task during its review cycle, then the subagent must be moved to a higher effort tier (up to xhigh) or a higher model (up to opus).  
subagents must also read the <repo-root>/northstar.md and <repo-root>/scaffold/docs/bounty.md files for alignment before doing work or critiquing work so they can stay aligned on our guiding principles.


We're building a "Government Opportunity Finder" for the GOED bounty at AI Builder Day
(judging tomorrow, Aug 15, 2:00 PM). A scaffold already exists in this directory. Read
README.md first — it explains the thesis and architecture. Then work through the tasks
below in order.

## What this is

A founder describes their company in plain language. The system translates that into
federal government vocabulary, matches against real opportunities from Grants.gov / SBIR
/ USAspending, explains every match, and — critically — says plainly when there isn't a
strong match rather than hallucinating one.

Rubric: Usefulness 30%, Quality of Matching 25%, Intelligence & Insight 20%, UX 15%,
Technical Execution 10%. Note that technical execution is the SMALLEST slice. Do not
gold-plate infrastructure.

## Environment

`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` must be available in the environment.
Export them in your shell, or put them in `scaffold/.env.local`. Never print key values.

GitHub remote: https://github.com/KurtLehnardt/granted
Vercel project is already created and linked to those env vars.

## Task 1 — shrink the embeddings BEFORE running anything

This must happen first or we pay for embeddings twice and commit a ~45MB file.

In `scripts/3-embed.mjs`, add `dimensions: 512` to the request body, and round the
returned vectors to 5 decimal places when assigning them.

In `lib/embed.ts`, add the same `dimensions: 512` to the runtime request. Build-time and
runtime vectors MUST use identical model and dimensions or cosine similarity is garbage.

## Task 2 — run the data pipeline and fix the normalizer

```
npm install
npm run data:fetch
```

**`scripts/1-fetch.mjs` was written against documented API shapes that were never
verified against live responses. Assume it is partly wrong.** After fetching, inspect
`data/raw/grants.json`, `data/raw/sbir-solicitations.json`, `data/raw/sbir-awards.json`,
and `data/raw/usaspending.json`. Check actual field names against what
`scripts/2-normalize.mjs` expects and fix the mapping. All source-shape assumptions are
deliberately isolated in that one file.

If an endpoint 404s or changed, search for current API docs and adapt. Do not silently
drop a source — tell me if one is unrecoverable.

Then:
```
npm run data:normalize
npm run data:embed
```

Report how many opportunities survived normalization. **If it's under ~200, widen the
`KEYWORDS` array in `1-fetch.mjs` and re-run.** A thin corpus makes every match look weak
and will make test case 5 pass for the wrong reason.

## Task 3 — calibrate against the five test cases

This is the actual work. Everything above is plumbing.

```
npm run dev
```

Run all five cases from `lib/testCases.ts` through the UI. Expected behavior:

| Case | Expected |
|---|---|
| 1. AI healthcare | Strong matches: HHS/NIH/NSF, SBIR/STTR, health IT, workforce |
| 2. Advanced manufacturing | Strong: DoD/NASA/DOE, manufacturing, aerospace, **procurement** |
| 3. Climate / water | Strong: DOE/EPA, water/environmental, infrastructure, pilots |
| 4. Cybersecurity | Strong: DoD/DHS, SBIR/STTR, **federal procurement** |
| 5. Youth marketplace | **Weak-field finding.** Few or no strong federal grant matches, honest explanation, redirects to SBA / state / local / workforce programs |

Case 5 is the differentiator. The bounty brief explicitly says it will reward systems
that say "there probably isn't a strong match" over ones that fabricate one. If case 5
returns confident matches, we lose the two heaviest criteria at once.

Tune the four constants in `CALIBRATION` (top of `lib/match.ts`):
- Case 5 returning strong matches → raise `scoreFloor`
- Cases 1-4 going thin → lower `candidateFloor`

**Check both directions after every change.** Fixing case 5 by breaking case 1 is the
trap. Report the strong-match count for all five after each tuning pass.

## Task 4 — freeze the demo

Once all five behave correctly, with `npm run dev` still running in another terminal:

```
npm run data:precompute
```

This bakes the five judged cases into `data/precomputed.json` so they render instantly
regardless of venue wifi. Re-run it any time matching logic changes. Novel input still
takes the live path.

## Task 5 — ship

```
git add -A
git commit -m "Working pipeline, calibrated matching"
git push -u origin main
```

`data/opportunities.json`, `awards.json`, and `precomputed.json` must be committed — the
app reads them at runtime and Vercel's filesystem is read-only. `data/raw/` is gitignored.

Deploy via the Vercel dashboard's GitHub integration if it's connected, otherwise
`npx vercel --prod`. Verify all five test cases work on the deployed URL, not just
locally.

## Explicitly out of scope

The bounty brief lists these as things we do NOT need: every federal agency, guaranteed
eligibility, a complete application system, every state program, production readiness,
scraping. Also skip: vector databases (a few thousand programs is an in-memory cosine
loop), auth, user accounts, tests beyond the five cases, CI.

## If time remains after Task 4

In rough priority order:
1. Federal procurement via SAM.gov Contract Opportunities — the government as *customer*,
   not just funder. Cases 2, 3, and 4 all expect procurement results and we currently
   have none.
2. A small set of Utah state/local programs, so the case-5 redirect names real programs
   instead of gesturing at categories.
3. Mobile layout pass. UX is 15% and judges will look at this on a laptop, but broken
   mobile is an easy avoidable ding.

## How to work with me

Ask before large refactors. Show me the strong-match counts after each calibration pass
rather than just saying it looks better. If an API is unrecoverable, say so early — I'd
rather cut a source than burn an hour on it.

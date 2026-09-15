# Feedback / nit log

Deferred LOW/MEDIUM findings that were *not* fixed in a given pass, kept here so
they aren't lost. Anything requiring a maintainer decision, a breaking change, or
a git-history rewrite lives here rather than being actioned silently.

## From the self-host-readiness review (4-agent pass)

The consolidated must-fix items from that review were applied on branch
`chore/selfhost-readiness-fixes` (path/username scrub, README de-dup + zero-config
lead, `.env.example` R5 wording, `package.json` name/engines, `next` security
bump). The items below were deliberately deferred.

### LOW / MEDIUM — safe to do later

- **Next.js audit (residual).** `next` was bumped to `14.2.35` (latest 14.2.x
  patch), which clears the Dec-2025 advisory that motivated the bump. `npm audit`
  still reports **1 critical + 1 high** on the 14.2 line — the critical is a set
  of Next.js advisories and the high is a transitive `postcss` XSS pulled in by
  Next. `npm audit` only offers to resolve them via `next@16` (a **major,
  breaking** upgrade). Deferred: chasing a major upgrade was explicitly out of
  scope; needs a maintainer decision + a real regression pass. Re-audit whenever
  a new 14.2.x patch ships.

- **Product name lingering in historical docs.** `package.json` `name` is now
  `granted`, but some internal/historical docs still say "Government Opportunity
  Finder" / "fundFinder". Cosmetic only; the historical narrative (e.g.
  `retrospective/`) is intentionally left intact. Sweep the *user-facing* docs if
  a fully consistent product name matters.

- **Dev port 3000.** `npm run dev` binds `http://localhost:3000`; if 3000 is
  taken, Next auto-picks the next free port (e.g. 3001) — occasionally trips
  people who hard-expect 3000. Already noted in the README Troubleshooting
  section; no code change needed.

- **`/demo` undocumented.** The app ships a static `/demo` route (the
  FasterControl sample map) and `/demo/eligibility`, but the README never mentions
  them. LOW: add a one-line pointer so evaluators can see a no-input sample, or
  keep it as an intentional easter egg.

### Repo bloat — needs a maintainer decision (OUT OF SCOPE here)

These were **not** actioned: they change repo layout / rewrite history and so
must be a maintainer call, not a quiet chore.

- **Move internal artifacts under `internal/`.** The root holds a lot of
  build-process material (`tasks/`, `prompts/`, `docs/`, `retrospective/`,
  `go-to-market/`, `golden-set-review/`, `canon.md`, `as-built.md`,
  `task-graph.md`, `hypothesis-check.md`, the `*-questions.md` files, …) sitting
  next to the shippable app in `scaffold/`. Relocating them under `internal/`
  would declutter the repo for self-hosters. **OUT OF SCOPE:** many docs
  cross-link each other by relative path, so a move needs a coordinated
  link-fix pass + maintainer sign-off.

- **Stop shipping the demo video in git.** `retrospective/granted-demo.mp4` is
  ~9.8 MB committed in-tree, which every `git clone` pays for. Recommend hosting
  it as a **GitHub release asset** (or Git LFS) and linking to it instead.
  **OUT OF SCOPE:** removing it from the working tree only shrinks new commits —
  reclaiming the clone size needs a **git history rewrite** (force-push), which
  is a maintainer decision.

### Local-model runtime notes (LOW — observed during the local-path review)

- **Noisy $0 metering log.** On local models, metering logs
  `no PRICE_TABLE entry for <model> (e.g. gemma4:latest / nomic-embed-text) —
  costUsd defaulting to 0` on every call. The `$0` is correct (local inference is
  free); the line is just noise. LOW: add local model names to the price table as
  explicit `0` entries, or suppress the warning when the provider is local.

- **Local-model profile-extraction contract drift.** On a local model, profile
  extraction sometimes returns `location` / `revenue` / `capitalRaised` as objects
  rather than strings, which trips the `OpportunityMap` zod boundary. It's handled
  gracefully today (the map still renders), but it's a real local-model
  contract-drift signal worth hardening (coerce/normalize at the boundary) if
  local models become a first-class path.

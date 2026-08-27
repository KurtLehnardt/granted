# Granted: Build Retrospective (bundle)

A self-contained record of how **Granted** (formerly *fundFinder*) was built: an overnight,
multi-agent buildout orchestrated with Claude Code under a single north star.

## Contents

| File | What it is |
|------|------------|
| `granted-retrospective.md` | The retrospective **deck** (Marp markdown; open in VS Code + Marp, or convert to slides) |
| `granted-retrospective.pptx` | The deck rendered to **PowerPoint** |
| `granted-demo.mp4` | A ~60s **Remotion** demo video of the app |
| `user-prompt-arc.md` | Chronological trace of the **human prompts** that steered the build |
| `northstar.md` | The **product principles** that governed wherever the spec was silent |
| `prompts/START-HERE.md` | The phased **entry point** (Phase-1 recon gated behind approval) |
| `prompts/fundfinder-orchestrator-prompt.md` | The authoritative **specification** (requirements, contracts, ship order) |
| `prompts/mock-auth-bundle.md` | The R9.0 mock-auth implementation bundle |

## The operating model (in one picture)

```
YOU → ORCHESTRATOR → DISPATCHER (haiku) → WORKER (opus/sonnet, isolated git worktree)
              └── merges centrally, gates every change, broadcasts rebases
```

Every change ran five gates before merge: `tsc --noEmit` · `npm test` · `npm run build`
· `check:hex` · `check:contrast` (+`check:prompts`). Feature flags shipped default-off.

## The one-line thesis

> Granted is a personal government-funding intelligence analyst with the integrity to say,
> in calibrated and well-explained terms, when there is **nothing worth chasing**, a promise
> enforced in the type system, not just the prompt.

## To rebuild the deck / video
- Deck → PowerPoint: `npx @marp-team/marp-cli granted-retrospective.md --pptx`
- Video: the Remotion project renders with `npx remotion render <CompositionId> out/granted-demo.mp4`
  (open `npm run dev` for Remotion Studio to tweak it).

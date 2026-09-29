/**
 * banned-phrases — the DEPENDENCY-FREE core of the C2 banned-phrasings check.
 *
 * `BANNED_PHRASES` + `findBannedPhrases` are the pure, runtime-safe half of
 * `scripts/check-prompt-registry.mjs`. They were factored out here so RUNTIME
 * code that must ship in the Next.js server bundle can reuse the EXACT same
 * "banned phrasing" definition WITHOUT dragging in the check script's
 * build-only machinery — `typescript`, `node:fs`, and a
 * `new URL("..", import.meta.url)` that webpack tries (and fails) to resolve
 * as a bundled asset.
 *
 * `check-prompt-registry.mjs` re-exports both symbols, so every existing
 * importer (the `check:prompts` gate, its tests, the G2 drafting tests) keeps
 * importing them from there unchanged. This file is plain JS (no TypeScript, no
 * Node built-ins) so it loads under plain `node`, under `tsx`, AND under
 * webpack's server bundle.
 *
 * Extend `BANNED_PHRASES` here rather than adding a second check — this IS the
 * one definition of "definitive-eligibility phrasing this product never uses"
 * (R8 / explainMatches rule 1).
 */

/**
 * Definitive-eligibility language a prompt template — or any generated
 * `draft_text` — must never contain. Each entry is matched as a plain
 * case-insensitive substring (not a regex), so the list stays auditable at a
 * glance.
 */
export const BANNED_PHRASES = [
  "you qualify",
  "you are eligible",
  "you're eligible",
  "guaranteed",
  "you will receive",
  "you will be awarded",
];

/** Case-insensitive substring scan of `text` against `BANNED_PHRASES`. */
export function findBannedPhrases(text) {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter((phrase) => lower.includes(phrase));
}

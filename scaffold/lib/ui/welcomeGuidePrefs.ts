/**
 * welcomeGuidePrefs.ts — persistence for whether this browser has already
 * been shown the first-visit welcome guide (components/WelcomeGuide.tsx).
 *
 * Uses localStorage, NOT sessionStorage, so the guide fires at most once ever
 * per browser, not once per tab session. Framework-agnostic (no React) so the
 * "show at most once ever" contract is trivially unit-testable and degrades
 * safely to "not seen" under SSR / private browsing via lib/localStore's
 * never-throw storage guards.
 */

import { readJSON, writeJSON } from '@/lib/localStore';

const WELCOME_GUIDE_SEEN_KEY = 'ff.ui.welcomeGuide.seen.v1';

/** Has this browser already been shown the welcome guide? SSR/privacy-safe, never throws. */
export function hasSeenWelcomeGuide(): boolean {
  return readJSON<boolean>(WELCOME_GUIDE_SEEN_KEY, false);
}

/**
 * Mark the guide as seen. No-ops when storage is unavailable (SSR / private
 * mode / quota exceeded) — never throws. Worst case in that fallback: the
 * guide can show again on a future visit, which is harmless.
 */
export function markWelcomeGuideSeen(): void {
  writeJSON(WELCOME_GUIDE_SEEN_KEY, true);
}

export interface WelcomeGuideStartState {
  /** True once this component instance has already started the guide. */
  started: boolean;
  /** True once this browser has already been shown the guide (localStorage). */
  seen: boolean;
}

/**
 * Pure start predicate: the guide auto-starts at most once ever per browser.
 * Kept free of I/O (storage, DOM, React) so the "start at most once" contract
 * is exhaustively testable. Replaying from Settings bypasses this entirely —
 * it opens the guide directly, regardless of `seen`.
 */
export function shouldAutoStartWelcomeGuide(state: WelcomeGuideStartState): boolean {
  return !state.started && !state.seen;
}

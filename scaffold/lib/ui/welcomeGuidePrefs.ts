/** Persistence for whether this browser has already been shown the
 *  first-visit welcome guide (components/WelcomeGuide.tsx). localStorage, not
 *  sessionStorage — fires at most once ever, not once per tab. */

import { readJSON, writeJSON } from '@/lib/localStore';
import { latestRun } from '@/lib/runs/runsStore';

const WELCOME_GUIDE_SEEN_KEY = 'ff.ui.welcomeGuide.seen.v1';
// Pre-rename key from the original WelcomeTour (#53) — a browser that already
// saw that guide must not have this one sprung on it too.
const LEGACY_WELCOME_TOUR_SEEN_KEY = 'ff.ui.welcomeTour.seen.v1';

/** True if this browser has seen the guide, saw its predecessor (WelcomeTour),
 *  or already has a prior run — a returning user shouldn't get it unexpectedly. */
export function hasSeenWelcomeGuide(): boolean {
  if (readJSON<boolean>(WELCOME_GUIDE_SEEN_KEY, false)) return true;
  if (readJSON<boolean>(LEGACY_WELCOME_TOUR_SEEN_KEY, false)) return true;
  return latestRun() !== null;
}

export function markWelcomeGuideSeen(): void {
  writeJSON(WELCOME_GUIDE_SEEN_KEY, true);
}

export interface WelcomeGuideStartState {
  started: boolean;
  seen: boolean;
}

/** Pure start predicate — replaying from Settings bypasses this entirely. */
export function shouldAutoStartWelcomeGuide(state: WelcomeGuideStartState): boolean {
  return !state.started && !state.seen;
}

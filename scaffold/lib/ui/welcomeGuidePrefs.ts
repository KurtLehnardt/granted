/** Persistence for whether this browser has already been shown the
 *  first-visit welcome guide (components/WelcomeGuide.tsx). localStorage, not
 *  sessionStorage — fires at most once ever, not once per tab. */

import { readJSON, writeJSON } from '@/lib/localStore';

const WELCOME_GUIDE_SEEN_KEY = 'ff.ui.welcomeGuide.seen.v1';

export function hasSeenWelcomeGuide(): boolean {
  return readJSON<boolean>(WELCOME_GUIDE_SEEN_KEY, false);
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

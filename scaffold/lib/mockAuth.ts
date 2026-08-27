/**
 * mockAuth.ts — demo-only auth backed by localStorage.
 *
 * THIS IS NOT AUTHENTICATION. It is a UI state machine that pretends to be one.
 * Anyone can open devtools and set isAuthenticated to true. Never gate anything
 * that matters (paid features, private data, API access) on this — server-side
 * entitlement checks only. Delete this file when real Google OAuth lands.
 *
 * Framework-agnostic: no React, no Next.js imports. The React layer sits on top,
 * so porting to vanilla JS or another framework means keeping this file as-is.
 */

import type { Provenanced } from '@/lib/contracts/primitives';

export const STORAGE_KEYS = {
  authed: 'ff.auth.isAuthenticated',
  user: 'ff.auth.user',
  demoMode: 'ff.auth.demoMode',
  demoUser: 'ff.auth.demoUser',
  consent: 'ff.consent.v1',
  runs: 'ff.runs.v1',
  autoFill: 'ff.autofill.v1',
  // FE-07 — left-sidebar local stores. All client-only; clearAllLocalData()
  // below already wipes every value in STORAGE_KEYS, so "Delete my data"
  // covers these too without any extra wiring.
  grants: 'ff.grants.v1',
  descriptions: 'ff.descriptions.v1',
  billing: 'ff.billing.v1',
} as const;

export type MockUser = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string;
  signedInAt: string;
};

/** Demo mode is opt-in via env so this can never silently ride to production. */
export const MOCK_AUTH_ENABLED = process.env.NEXT_PUBLIC_MOCK_AUTH === 'true';

/** localStorage is unavailable during SSR and in some privacy modes. Never throw. */
function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    const probe = '__ff_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null; // Safari private mode, storage disabled, quota exceeded
  }
}

/** Inline SVG avatar — no external request, works offline during a demo. */
function avatarDataUri(initials: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
    <rect width="96" height="96" rx="48" fill="#005ea2"/>
    <text x="50%" y="50%" dy="0.35em" text-anchor="middle"
      font-family="system-ui, sans-serif" font-size="38" font-weight="600" fill="#ffffff">${initials}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function createMockUser(name = 'Hackathon Judge'): MockUser {
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return {
    id: `mock_${Math.random().toString(36).slice(2, 10)}`,
    name,
    email: 'judge@example.com', // reserved domain — never a real address
    avatarUrl: avatarDataUri(initials),
    signedInAt: new Date().toISOString(),
  };
}

export function signIn(name?: string): MockUser {
  const store = safeStorage();
  const user = createMockUser(name);
  if (store) {
    store.setItem(STORAGE_KEYS.authed, 'true');
    store.setItem(STORAGE_KEYS.user, JSON.stringify(user));
  }
  return user;
}

export function signOut(): void {
  const store = safeStorage();
  if (!store) return;
  // Clear auth only. Saved runs and consent survive sign-out, matching real behavior.
  store.removeItem(STORAGE_KEYS.authed);
  store.removeItem(STORAGE_KEYS.user);
}

export function getUser(): MockUser | null {
  const store = safeStorage();
  if (!store) return null;
  if (store.getItem(STORAGE_KEYS.authed) !== 'true') return null;

  const raw = store.getItem(STORAGE_KEYS.user);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as MockUser;
    // Anything hand-edited in devtools gets discarded rather than rendered.
    if (!parsed?.id || !parsed?.name) throw new Error('malformed');
    return parsed;
  } catch {
    signOut();
    return null;
  }
}

export function isAuthenticated(): boolean {
  return getUser() !== null;
}

/* ---- Demo mode (hackathon-judge override) ----
 * A runtime, localStorage-only override the app honors in EITHER auth backend
 * (mock or real Supabase): when `ff.auth.demoMode` is set, the app presents a
 * fixed "Hackathon Judge" identity regardless of any Supabase session, so a
 * judge can explore signed-in without a real Google account and without any
 * env/flag change. Same caveat as the rest of this file — THIS IS NOT
 * AUTHENTICATION; it gates nothing server-side. It is toggled from the login
 * page (see useDemoMode() in AuthProvider), cleared on sign-out and by the
 * Google path. The demo user is persisted so its id/timestamp survive a reload;
 * both keys live in the ff.auth.* namespace and are wiped by clearAllLocalData().
 */

export const DEMO_JUDGE_NAME = 'Hackathon Judge';

export function isDemoMode(): boolean {
  return safeStorage()?.getItem(STORAGE_KEYS.demoMode) === 'true';
}

/** The fixed demo user when demo mode is on, else null. Idempotent: a first
 *  read with no persisted user synthesizes one and stores it. */
export function getDemoUser(): MockUser | null {
  const store = safeStorage();
  if (!store) return null;
  if (store.getItem(STORAGE_KEYS.demoMode) !== 'true') return null;

  const raw = store.getItem(STORAGE_KEYS.demoUser);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as MockUser;
      if (parsed?.id && parsed?.name) return parsed;
    } catch {
      // fall through and re-synthesize a fresh demo user below
    }
  }

  const user = createMockUser(DEMO_JUDGE_NAME);
  store.setItem(STORAGE_KEYS.demoUser, JSON.stringify(user));
  return user;
}

/** Turn demo mode on and return the fixed "Hackathon Judge" user. */
export function enterDemoMode(): MockUser {
  const store = safeStorage();
  const user = createMockUser(DEMO_JUDGE_NAME);
  if (store) {
    store.setItem(STORAGE_KEYS.demoMode, 'true');
    store.setItem(STORAGE_KEYS.demoUser, JSON.stringify(user));
  }
  return user;
}

/** Turn demo mode off. Leaves the real backend (mock or Supabase) untouched. */
export function exitDemoMode(): void {
  const store = safeStorage();
  if (!store) return;
  store.removeItem(STORAGE_KEYS.demoMode);
  store.removeItem(STORAGE_KEYS.demoUser);
}

/* ---- Consent (§5.3: descriptions reusable only with opt-in) ---- */

export type ConsentRecord = { granted: boolean; grantedAt: string | null };

export function getConsent(): ConsentRecord {
  const raw = safeStorage()?.getItem(STORAGE_KEYS.consent);
  if (!raw) return { granted: false, grantedAt: null }; // default: no consent
  try {
    return JSON.parse(raw) as ConsentRecord;
  } catch {
    return { granted: false, grantedAt: null };
  }
}

export function setConsent(granted: boolean): ConsentRecord {
  const record: ConsentRecord = {
    granted,
    grantedAt: granted ? new Date().toISOString() : null,
  };
  safeStorage()?.setItem(STORAGE_KEYS.consent, JSON.stringify(record));
  return record;
}

/* ---- Auto-fill requirements (FE-06) ----
 * "Auto Fill" is a locked, stubbed affordance on each opportunity card: it
 * opens a Pro-upsell modal listing what the founder needs on file before a
 * real auto-fill flow (blocked on grant-site API keys) could act on their
 * behalf. This form — reached via the hamburger menu's Settings panel — lets
 * them record those facts locally so the modal can show what's already done.
 * Gates nothing: there is no server side to gate.
 */

export type AutoFillRequirements = {
  samRegistered: boolean;
  /** Optional; only meaningful when samRegistered is true. Free-form date text, '' if unset. */
  samRegisteredDate: string;
  uei: string;
  aorName: string;
  /** "Confirm on file" checkbox — satisfies the requirement even with no name typed. */
  aorOnFile: boolean;
  /** "Confirm on file" checkbox for E-Biz POC delegation. */
  eBizPocOnFile: boolean;
};

export const EMPTY_AUTO_FILL_REQUIREMENTS: AutoFillRequirements = {
  samRegistered: false,
  samRegisteredDate: '',
  uei: '',
  aorName: '',
  aorOnFile: false,
  eBizPocOnFile: false,
};

export function getAutoFillRequirements(): AutoFillRequirements {
  const raw = safeStorage()?.getItem(STORAGE_KEYS.autoFill);
  if (!raw) return EMPTY_AUTO_FILL_REQUIREMENTS;
  try {
    const parsed = JSON.parse(raw);
    // Merge over the defaults so an older/partial saved record never yields undefined fields.
    return { ...EMPTY_AUTO_FILL_REQUIREMENTS, ...parsed };
  } catch {
    return EMPTY_AUTO_FILL_REQUIREMENTS;
  }
}

export function setAutoFillRequirements(reqs: AutoFillRequirements): AutoFillRequirements {
  safeStorage()?.setItem(STORAGE_KEYS.autoFill, JSON.stringify(reqs));
  return reqs;
}

/**
 * §3.1 CompanyProfile carries the same two registration facts (sam_registered,
 * uei) that R8.1 eligibility screening reads. Pure, unwired mapper from the
 * local Auto Fill form to that shape, provided so ELG/Interview can adopt it
 * later without re-deriving the mapping — nothing in the app calls this today.
 * Provenance is always `user_stated` (the founder's own self-report);
 * confidence 1 because a self-report carries no model uncertainty.
 */
export function mapAutoFillToCompanyProfileFields(
  reqs: AutoFillRequirements
): { sam_registered?: Provenanced<boolean>; uei?: Provenanced<string> } {
  const out: { sam_registered?: Provenanced<boolean>; uei?: Provenanced<string> } = {};
  if (reqs.samRegistered) {
    out.sam_registered = { value: true, provenance: 'user_stated', confidence: 1 };
  }
  if (reqs.uei.trim().length > 0) {
    out.uei = { value: reqs.uei.trim(), provenance: 'user_stated', confidence: 1 };
  }
  return out;
}

/** Wipe everything this app stored. Wire this to a visible "Delete my data" control. */
export function clearAllLocalData(): void {
  const store = safeStorage();
  if (!store) return;
  Object.values(STORAGE_KEYS).forEach((key) => store.removeItem(key));
}

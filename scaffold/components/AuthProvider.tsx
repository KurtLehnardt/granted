'use client';

/**
 * AuthProvider.tsx — React state layer over the auth backend.
 *
 * Wrap your app once in app/layout.tsx:
 *   <AuthProvider>{children}</AuthProvider>
 *
 * This is a DROP-IN: the exported context shape
 * `{ user, loading, consent, signIn, signOut, setConsent }` and `useAuth()` are
 * unchanged, and `user` stays `MockUser | null`, so every consumer (login page,
 * AppMenu, UserMenu, IntakeForm) compiles and behaves untouched.
 *
 * Granted is local-only now — this is localStorage-only mock auth, always.
 * (A real Supabase + Google OAuth backend used to live behind a flag here;
 * removed along with the rest of the Supabase dependency.)
 *
 * DEMO MODE: a thin `DemoModeLayer` wraps the mock backend. When the runtime
 * `ff.auth.demoMode` override is set (from the login page's toggle), it
 * presents a fixed "Hackathon Judge" user through the SAME `useAuth()`
 * context — so a judge can sign in without going through the real flow. The
 * `useAuth()` shape is unchanged; the toggle itself is exposed on a separate
 * `useDemoMode()` hook so no consumer of the auth contract has to change.
 * Sign-out always clears demo mode, returning the user to the real login
 * screen. The layer is always mounted and hydrates the override in an effect
 * (never during render), so the Rules of Hooks and SSR safety both hold.
 *
 * The `loading` flag matters: localStorage can't be read during SSR, so the
 * first client render always starts unauthenticated. Redirecting before
 * `loading` flips false will bounce signed-in users straight back to login.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  getUser,
  signIn as storeSignIn,
  signOut as storeSignOut,
  getConsent,
  setConsent as storeSetConsent,
  getDemoUser,
  enterDemoMode as storeEnterDemoMode,
  exitDemoMode as storeExitDemoMode,
  type MockUser,
  type ConsentRecord,
} from '@/lib/mockAuth';
import { setAnalyticsConsent } from '@/lib/analytics/track';

type AuthContextValue = {
  user: MockUser | null;
  loading: boolean;
  consent: ConsentRecord;
  signIn: (name?: string) => void;
  signOut: () => void;
  setConsent: (granted: boolean) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/** Demo-mode controls, kept OFF the auth contract so `useAuth()` is unchanged. */
type DemoModeContextValue = {
  /** True when the hackathon-judge demo identity is active. */
  demoMode: boolean;
  /** Enter demo mode (fixed "Hackathon Judge" user), reactively + persisted. */
  enterDemoMode: () => void;
  /** Leave demo mode; the mock backend takes over again. */
  exitDemoMode: () => void;
};

const DemoModeContext = createContext<DemoModeContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // DemoModeLayer sits BELOW the mock provider: it reads the backend's
  // context via useAuth(), then re-provides a possibly-overridden context to
  // the app. This keeps the demo toggle a pure runtime override on top.
  return (
    <MockAuthProvider>
      <DemoModeLayer>{children}</DemoModeLayer>
    </MockAuthProvider>
  );
}

/* ---- Mock backend — localStorage-only, the only backend now ---- */

function MockAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MockUser | null>(null);
  const [consent, setConsentState] = useState<ConsentRecord>({
    granted: false,
    grantedAt: null,
  });
  const [loading, setLoading] = useState(true);

  // Hydrate from storage after mount — never during render.
  useEffect(() => {
    setUser(getUser());
    setConsentState(getConsent());
    setLoading(false);
  }, []);

  // Analytics is private by default: keep the emit gate in sync with the opt-in
  // so events only ever fire once the user has actually consented (§5.3).
  useEffect(() => {
    setAnalyticsConsent(consent.granted);
  }, [consent.granted]);

  // Keep tabs in sync: sign out in one tab, every tab follows.
  useEffect(() => {
    const onStorage = () => setUser(getUser());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const signIn = useCallback((name?: string) => {
    setUser(storeSignIn(name));
  }, []);

  const signOut = useCallback(() => {
    storeSignOut();
    setUser(null);
  }, []);

  const setConsent = useCallback((granted: boolean) => {
    setConsentState(storeSetConsent(granted));
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, consent, signIn, signOut, setConsent }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/* ---- Demo-mode override — runtime, layers over the mock backend ---- */

function DemoModeLayer({ children }: { children: ReactNode }) {
  // The backend's context (the nearest provider above this layer).
  const backend = useAuth();

  const [demoUser, setDemoUser] = useState<MockUser | null>(null);
  const [demoLoading, setDemoLoading] = useState(true);

  // Hydrate the override after mount — never during render. Both SSR and the
  // first client render start with no demo user, so there is no hydration
  // mismatch even when the override is set in storage.
  useEffect(() => {
    setDemoUser(getDemoUser());
    setDemoLoading(false);
  }, []);

  // Follow demo toggles made in other tabs, mirroring the mock backend.
  useEffect(() => {
    const onStorage = () => setDemoUser(getDemoUser());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const enterDemoMode = useCallback(() => {
    setDemoUser(storeEnterDemoMode());
  }, []);

  const exitDemoMode = useCallback(() => {
    storeExitDemoMode();
    setDemoUser(null);
  }, []);

  // Sign-out must always drop the demo identity too, so leaving demo returns to
  // the real login screen rather than straight back into demo. It then defers
  // to the live backend's own sign-out.
  const backendSignOut = backend.signOut;
  const signOut = useCallback(() => {
    storeExitDemoMode();
    setDemoUser(null);
    backendSignOut();
  }, [backendSignOut]);

  const demoActive = demoUser !== null;

  // When demo is active we present the fixed judge user regardless of the
  // backend's own user/session; otherwise we pass the backend through untouched
  // (only folding demoLoading into loading and hardening signOut).
  const authValue: AuthContextValue = demoActive
    ? {
        user: demoUser,
        loading: false,
        consent: backend.consent,
        signIn: backend.signIn,
        signOut,
        setConsent: backend.setConsent,
      }
    : {
        ...backend,
        loading: backend.loading || demoLoading,
        signOut,
      };

  const demoValue: DemoModeContextValue = {
    demoMode: demoActive,
    enterDemoMode,
    exitDemoMode,
  };

  return (
    <DemoModeContext.Provider value={demoValue}>
      <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>
    </DemoModeContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Demo-mode toggle controls. Separate from `useAuth()` so the auth contract is
 * unchanged. Used by the login page to switch between a real Google sign-in and
 * the hackathon-judge demo identity at runtime.
 */
export function useDemoMode(): DemoModeContextValue {
  const ctx = useContext(DemoModeContext);
  if (!ctx) throw new Error('useDemoMode must be used inside <AuthProvider>');
  return ctx;
}

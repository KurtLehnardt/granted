"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import Link from "next/link";
import { isFlagEnabled } from "@/lib/flags";
import { useAuth } from "@/components/AuthProvider";
import { UserMenu } from "@/components/UserMenu";
import SettingsPanel from "@/components/SettingsPanel";
import AppSidebar from "@/components/AppSidebar";

/**
 * FE-06 — one nav cluster: hamburger menu (always present; Settings is
 * device-local and independent of sign-in) + the PLT-01 mock-auth surface
 * (only when r9_0_mockauth is on), reconciled here instead of living inline
 * in app/page.tsx.
 */

// ---------------------------------------------------------------------------
// Settings panel context — lets anything under the provider (not just this
// component's own menu item, e.g. the Auto Fill modal's "Add these in
// Settings" button deep inside OpportunityCard) open the Settings panel
// without prop-drilling through OpportunityMap.
// ---------------------------------------------------------------------------

type SettingsPanelContextValue = { openSettings: () => void };
const SettingsPanelContext = createContext<SettingsPanelContextValue | null>(null);

export function useSettingsPanel(): SettingsPanelContextValue {
  const ctx = useContext(SettingsPanelContext);
  // Outside the provider (shouldn't happen in the real app — it wraps
  // app/layout.tsx — but keeps callers safe rather than throwing) this is a
  // harmless no-op.
  return ctx ?? { openSettings: () => {} };
}

/** Wrap the app once (app/layout.tsx) so Settings is reachable from anywhere. */
export function SettingsPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSettings = useCallback(() => setOpen(true), []);
  const closeSettings = useCallback(() => setOpen(false), []);

  return (
    <SettingsPanelContext.Provider value={{ openSettings }}>
      {children}
      {open && <SettingsPanel onClose={closeSettings} />}
    </SettingsPanelContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hamburger menu
// ---------------------------------------------------------------------------

export default function AppMenu() {
  // FE-07: when on, the hamburger opens a left slide-out drawer (AppSidebar)
  // instead of Settings directly (Settings lives inside the drawer).
  // Default OFF -> the hamburger opens the Settings modal directly.
  const sidebar = isFlagEnabled("left_sidebar");
  // Show the sign-in surface when EITHER auth backend is live: the real
  // Supabase flag (R9) or the interim mock flag (R9.0). Checking only the mock
  // flag would hide sign-in when real auth is the one that's on.
  const authOn = isFlagEnabled("r9_supabase_auth") || isFlagEnabled("r9_0_mockauth");
  const { user, loading } = useAuth();
  const { openSettings } = useSettingsPanel();

  // Polish: real hover fill + press feedback on the icon control (44px target).
  const hamburgerBtnClass =
    "flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm border border-structure-on-canvas p-2 text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  const signInLinkClass =
    "inline-flex min-h-[44px] items-center rounded-sm border border-structure-on-canvas px-4 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  // FE-07 ON: the persistent, collapsible left sidebar (AppSidebar) owns all its
  // own toggles (desktop collapse + re-open, mobile menu button + overlay) and
  // the identity/sign-in surface lives in its Account section, so AppMenu renders
  // ONLY the sidebar here — no top-left button, no top-right auth surface.
  if (sidebar) {
    return <AppSidebar />;
  }

  // FE-07 OFF (default): the hamburger opens the Settings modal directly
  // (no intermediate dropdown) + the top-right mock-auth surface.
  return (
    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={openSettings}
        aria-label="Open settings"
        className={hamburgerBtnClass}
      >
        <HamburgerIcon className="h-4 w-4" />
      </button>

      {authOn && !loading && (
        user ? (
          <UserMenu />
        ) : (
          <Link href="/login" className={signInLinkClass}>
            Sign in
          </Link>
        )
      )}
    </div>
  );
}

function HamburgerIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

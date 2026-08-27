"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  // FE-01 / design revamp: the CON-02 USWDS 60/30/10 restyle is now the DEFAULT
  // on this A/B branch (previously gated behind r7_design).
  const design = true;
  // FE-07: when on, the hamburger opens a left slide-out drawer (AppSidebar)
  // instead of the dropdown, and the dropdown's "Settings" button is dropped
  // (Settings lives inside the drawer). Default OFF -> today's dropdown.
  const sidebar = isFlagEnabled("left_sidebar");
  // Show the sign-in surface when EITHER auth backend is live: the real
  // Supabase flag (R9) or the interim mock flag (R9.0). Checking only the mock
  // flag would hide sign-in when real auth is the one that's on.
  const authOn = isFlagEnabled("r9_supabase_auth") || isFlagEnabled("r9_0_mockauth");
  const { user, loading } = useAuth();
  const { openSettings } = useSettingsPanel();

  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click and on Esc — this is a lightweight dropdown, not
  // a modal dialog, so it gets simple dismiss behavior rather than the full
  // focus-trap treatment AutoFillModal/SettingsPanel use.
  useEffect(() => {
    // In sidebar mode the drawer (AppSidebar) supplies its own focus-trap/Esc
    // via useDialogA11y, so this dropdown-only dismiss handler is skipped.
    if (!menuOpen || sidebar) return;
    function onPointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, sidebar]);

  // Polish: real hover fill + press feedback on the icon control (44px target).
  const hamburgerBtnClass = design
    ? "flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm border border-structure-on-canvas p-2 text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm border border-rule bg-white p-2 text-slate-550 transition hover:border-federal hover:text-federal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  // Dropdown: elevated surface (rounded + overlay shadow) over a definition border.
  const menuClass = design
    ? "absolute right-0 top-full z-40 mt-2 w-48 overflow-hidden rounded-md border border-structure-on-canvas bg-canvas py-1 text-foreground shadow-overlay"
    : "absolute right-0 top-full z-40 mt-2 w-48 border border-rule bg-white py-1 shadow-sm";

  // Menu items get a full 44px hit height.
  const menuItemClass = design
    ? "flex min-h-[44px] w-full items-center px-4 py-2 text-left font-mono text-[11px] uppercase tracking-eyebrow text-foreground transition hover:bg-canvas-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-inset"
    : "block w-full px-4 py-2 text-left font-mono text-[11px] uppercase tracking-eyebrow text-slate-550 hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-inset";

  const signInLinkClass = design
    ? "inline-flex min-h-[44px] items-center rounded-sm border border-structure-on-canvas px-4 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2"
    : "inline-flex min-h-[44px] items-center rounded-sm border border-rule bg-white px-4 font-mono text-[11px] uppercase tracking-eyebrow text-slate-550 transition hover:border-federal hover:text-federal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-federal focus-visible:ring-offset-2";

  // FE-07 ON: the persistent, collapsible left sidebar (AppSidebar) owns all its
  // own toggles (desktop collapse + re-open, mobile menu button + overlay) and
  // the identity/sign-in surface lives in its Account section, so AppMenu renders
  // ONLY the sidebar here — no top-left button, no top-right auth surface.
  if (sidebar) {
    return <AppSidebar />;
  }

  // FE-07 OFF (default, unchanged): the original hamburger dropdown + the
  // top-right mock-auth surface.
  return (
    <div className="flex items-center justify-between gap-3">
      <div ref={wrapRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Open menu"
          className={hamburgerBtnClass}
        >
          <HamburgerIcon className="h-4 w-4" />
        </button>
        {menuOpen && (
          <div role="menu" aria-label="App menu" className={menuClass}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                openSettings();
              }}
              className={menuItemClass}
            >
              Settings
            </button>
          </div>
        )}
      </div>

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

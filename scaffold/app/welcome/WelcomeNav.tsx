"use client";

/**
 * Marketing-landing top nav (GTM landing page, /welcome). Self-contained to
 * this route — it does NOT touch the app shell in app/page.tsx. Server-rendered
 * initial markup (App Router SSRs client components too), so the nav is present
 * for crawlers; the only client state is the mobile menu open/closed toggle.
 *
 * Styling is CON-02 design tokens only (no raw hex — check:hex scans app/**),
 * dark-mode aware via the CSS-variable-backed token classes, and every hit
 * target clears 44px (a11y). The global prefers-reduced-motion rule in
 * app/globals.css already neutralizes the transitions below.
 */
import { useState } from "react";
import Link from "next/link";

const NAV_LINKS: { href: string; label: string }[] = [
  { href: "#how", label: "How it works" },
  { href: "#why", label: "Why Granted" },
  { href: "#pricing", label: "Free to start" },
];

const navLinkClass =
  "font-body text-[15px] text-foreground transition hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-canvas rounded-sm";

const navCtaClass =
  "inline-flex min-h-[44px] items-center justify-center rounded-md bg-action px-4 font-body text-[14px] font-semibold text-token-white shadow-card transition hover:brightness-110 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

export default function WelcomeNav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-canvas-alt bg-canvas">
      <nav
        aria-label="Primary"
        className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3 sm:px-6"
      >
        <Link
          href="/welcome"
          className="rounded-sm font-display text-[22px] font-bold leading-none tracking-tight text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          Granted
        </Link>

        {/* Desktop nav */}
        <div className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={navLinkClass}>
              {l.label}
            </Link>
          ))}
          <Link href="/readiness" className={navCtaClass}>
            Check your fit — free
          </Link>
        </div>

        {/* Mobile hamburger */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="welcome-mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-structure-on-canvas text-structure-on-canvas transition hover:bg-structure hover:text-token-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-canvas md:hidden"
        >
          {open ? <CloseIcon className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
        </button>
      </nav>

      {/* Mobile menu panel — stacked links + CTA, each a 44px target */}
      {open && (
        <div
          id="welcome-mobile-menu"
          className="border-t border-canvas-alt bg-canvas px-5 pb-4 pt-2 md:hidden"
        >
          <ul className="flex flex-col">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="flex min-h-[44px] items-center font-body text-[16px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href="/readiness"
            onClick={() => setOpen(false)}
            className={`${navCtaClass} mt-2 w-full`}
          >
            Check your fit — free
          </Link>
        </div>
      )}
    </header>
  );
}

function MenuIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

import type { Metadata } from "next";
import { Bricolage_Grotesque, Inter, IBM_Plex_Mono } from "next/font/google";
import { AuthProvider } from "@/components/AuthProvider";
import { SettingsPanelProvider } from "@/components/AppMenu";
import { BillingProvider } from "@/components/BillingProvider";
import { SearchDraftProvider } from "@/components/SearchDraftProvider";
import { AnalyticsProvider } from "@/components/AnalyticsProvider";
import { BRAND } from "@/lib/brand";
import "./globals.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display", weight: ["500", "700"] });
const body = Inter({ subsets: ["latin"], variable: "--font-body" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500"] });

export const metadata: Metadata = {
  title: `${BRAND} — federal funding intelligence for founders`,
  description: "Tell us about your company. We'll tell you what federal resources you should know about — and why.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body className="font-body antialiased" suppressHydrationWarning>
        {/*
          AuthProvider always wraps the app, flag or no flag. It is a passive
          React context — no network calls, no redirects, no rendered UI of its
          own — so mounting it unconditionally does not change v1 behavior.
          Whether any *visible* R9.0 surface (sign-in link, avatar, consent,
          delete-my-data) appears is decided per-component behind the
          `r9_0_mockauth` flag (see app/page.tsx, components/IntakeForm.tsx).
          Keeping the provider itself unconditional also means the real OAuth
          swap at R9 only has to change what's inside this file, not add it.

          SettingsPanelProvider (FE-06) is the same kind of always-on, no-UI-
          of-its-own context: it just makes the device-local Settings panel
          (Auto Fill requirements) reachable from anywhere in the tree —
          the hamburger menu (AppMenu) and the Auto Fill modal deep inside
          each OpportunityCard both open the same panel through it, without
          prop-drilling through OpportunityMap.
        */}
        {/*
          BillingProvider (FE-07) and SearchDraftProvider (FE-07) are the same
          kind of always-on, no-UI, no-network passive contexts as the two
          above: BillingProvider holds the local MOCK billing tier that the
          drawer's Billing section and the OpportunityCard padlocks read (so a
          tier change reflects live); SearchDraftProvider carries the drawer's
          "Use this" text into IntakeForm's search box. Mounting them
          unconditionally does not change flag-off behavior — nothing reads them
          in a way that alters today's UI unless the left_sidebar flag is on.
        */}
        {/*
          H5 — AnalyticsProvider (PLT-03 / R10.1). Same always-on, passive,
          no-UI/no-network context posture as the providers above: it only hands
          feature code the typed funnel-event builders. Every emit still no-ops
          unless the `r10_analytics` flag is on (gating lives in track()), so
          mounting it unconditionally does not change flag-off behavior.
        */}
        <AuthProvider>
          <BillingProvider>
            <SearchDraftProvider>
              <SettingsPanelProvider>
                <AnalyticsProvider>{children}</AnalyticsProvider>
              </SettingsPanelProvider>
            </SearchDraftProvider>
          </BillingProvider>
        </AuthProvider>
      </body>
    </html>
  );
}

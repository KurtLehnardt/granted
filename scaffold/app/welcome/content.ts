/**
 * Pure SEO/AEO content for the /welcome landing page: route metadata and the
 * Organization + SoftwareApplication JSON-LD. Kept dependency-free (no React,
 * no next/link) so it is unit-testable under the node:test runner without a DOM
 * — see app/welcome/__tests__/welcome.test.ts. `import type { Metadata }` is a
 * type-only import (erased at runtime), so this module loads under plain node.
 *
 * Every claim here is grounded in the shipped corpus (data/opportunities.json:
 * 968 opportunities from grants.gov, SAM.gov assistance listings, SBIR/STTR, and
 * USAspending). No mock/flag-gated capability is claimed.
 */
import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";

/** Live URL today (Vercel subdomain). Swap for the real domain once purchased. */
// Set NEXT_PUBLIC_SITE_URL to your own deployment's URL; falls back to localhost
// for local dev so the repo carries no specific deployment.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const TITLE = "Granted — know if a federal grant is worth chasing";

export const DESCRIPTION =
  "Granted maps your company to 968 real federal funding opportunities, scores your fit on program-officer criteria, and is honest enough to tell you when not to apply. Grounded in real award data — never fabricated.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  applicationName: BRAND,
  keywords: [
    "federal grants",
    "SBIR",
    "STTR",
    "grant eligibility",
    "grant fit",
    "non-dilutive funding",
    "grants.gov",
    "SAM.gov",
  ],
  alternates: { canonical: "/welcome" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: BRAND,
    url: `${SITE_URL}/welcome`,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

/**
 * Organization + SoftwareApplication JSON-LD. `offers.price = "0"` reflects the
 * real "free to start" model; the description makes no mock-feature claim.
 */
export const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: BRAND,
      url: SITE_URL,
      description:
        "Granted helps founders decide whether a federal grant is worth chasing — grounded in real federal award data and calibrated to say when not to apply.",
      slogan: "Federal funding intelligence for founders.",
    },
    {
      "@type": "SoftwareApplication",
      name: BRAND,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      url: SITE_URL,
      description:
        "Describe your company in plain English and Granted scores your fit across 968 real federal funding opportunities — grants.gov, SAM.gov, SBIR/STTR, and USAspending — screens eligibility, and gives an honest recommend / verify / don't-apply verdict.",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        description: "Free to start — no credit card required.",
      },
    },
  ],
} as const;

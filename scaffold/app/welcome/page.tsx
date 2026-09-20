/**
 * Granted — marketing landing page (GTM "honest-no" hero).
 *
 * A NEW, self-contained route at /welcome. It does not import from or modify
 * the app shell (app/page.tsx) — the running product is untouched. This is a
 * Server Component on purpose: `metadata` + the JSON-LD structured data are
 * emitted in the server HTML for SEO/AEO. The only client island is the mobile
 * nav (./WelcomeNav).
 *
 * Design: CON-02 tokens only (no raw hex — check:hex scans app/**), dark-mode
 * aware via the CSS-variable-backed token classes, mobile-first responsive,
 * 44px hit targets + visible focus rings. `bg-action` (white-on-green, the AA-
 * verified CTA pairing) is reserved for the single primary CTA — "Check your
 * fit — free"; secondary actions use the navy `structure` outline affordance,
 * mirroring components/OpportunityCard.tsx.
 *
 * Every factual claim is grounded in the shipped corpus: 968 real opportunities
 * (data/opportunities.json) from grants.gov, SAM.gov assistance listings,
 * SBIR/STTR, and USAspending, spanning six funding types. Nothing here claims a
 * mock/flag-gated capability (no auto-filing of applications).
 *
 * TO PROMOTE /welcome TO ROOT LATER: rename this route to app/page.tsx (moving
 * today's app shell to e.g. app/app/page.tsx and repointing the "Run a full
 * search" links here from "/" to that path). One route move; no logic change.
 */
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import WelcomeNav from "./WelcomeNav";
import { metadata as welcomeMetadata, structuredData } from "./content";

// Next reads `metadata` from the page module itself — re-export the pure
// definition from ./content (which the a11y/SEO smoke test imports directly).
export const metadata = welcomeMetadata;

// --- shared class strings (token-only) -------------------------------------

const sectionClass = "mx-auto w-full max-w-5xl px-5 sm:px-6";
const eyebrowClass =
  "font-mono text-[12px] uppercase tracking-eyebrow text-structure-on-canvas";
const h2Class =
  "text-balance font-display text-[30px] font-bold leading-[1.12] text-foreground sm:text-[38px]";
const leadClass = "text-pretty font-body text-[17px] leading-relaxed text-foreground";

const primaryCtaClass =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md bg-action px-6 py-3 font-body text-[15px] font-semibold text-token-white shadow-card transition hover:brightness-110 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

const secondaryCtaClass =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border border-structure-on-canvas bg-canvas px-6 py-3 font-body text-[15px] font-semibold text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

const cardClass = "rounded-lg bg-canvas-alt p-6 text-foreground shadow-card sm:p-7";

export default function WelcomePage() {
  return (
    <>
      {/* Organization + SoftwareApplication structured data (SEO/AEO). */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <div className="min-h-screen bg-canvas text-foreground">
        <WelcomeNav />

        <main>
          {/* ---------------------------------------------------------------
              1. HERO — the value prop + a proof match card
          ---------------------------------------------------------------- */}
          <section className={`${sectionClass} pb-16 pt-14 sm:pb-20 sm:pt-20`}>
            <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
              <div className="stagger">
                <p className={eyebrowClass}>Federal funding intelligence</p>
                <h1 className="mt-4 text-balance font-display text-[34px] font-bold leading-[1.08] text-foreground sm:text-[46px]">
                  Find government funding matched to your business or research.
                </h1>
                <p className="mt-5 max-w-xl text-pretty font-body text-[18px] leading-relaxed text-foreground">
                  Describe your work in plain English. Granted scores your fit
                  across 968 real federal opportunities, grounded in actual award
                  data.
                </p>

                <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                  <Link href="/readiness" className={primaryCtaClass}>
                    Check your fit — free
                  </Link>
                  <Link href="/" className={secondaryCtaClass}>
                    Run a full search
                  </Link>
                </div>
                <p className="mt-4 font-body text-[13px] text-foreground">
                  Free to start · no credit card · your description stays yours.
                </p>
              </div>

              {/* Proof: a realistic strong-match card. Clearly a SAMPLE — shows
                  the primary outcome (funding matched to you) made visible. */}
              <div className="reveal">
                <VerdictCard />
              </div>
            </div>

            {/* Grounded sources strip — verified counts from the corpus. */}
            <div className="mt-14 rounded-lg bg-canvas-alt px-6 py-5 shadow-card">
              <p className={eyebrowClass}>What it&rsquo;s grounded in</p>
              <p className="mt-2 font-body text-[15px] leading-relaxed text-foreground">
                <span className="font-semibold">968 real federal opportunities</span>{" "}
                from keyless, public sources — grants.gov, SAM.gov assistance
                listings, SBIR/STTR, and USAspending — across six funding types.
              </p>
              <ul className="mt-4 flex flex-wrap gap-2">
                {[
                  "grants.gov",
                  "SAM.gov",
                  "SBIR / STTR",
                  "USAspending",
                  "6 funding types",
                ].map((chip) => (
                  <li
                    key={chip}
                    className="rounded-sm border border-structure-on-canvas px-2.5 py-1 font-mono text-[12px] text-structure-on-canvas"
                  >
                    {chip}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* ---------------------------------------------------------------
              2. THE PROBLEM
          ---------------------------------------------------------------- */}
          <section className={`${sectionClass} py-16 sm:py-20`}>
            <p className={eyebrowClass}>The problem</p>
            <h2 className={`mt-3 ${h2Class}`}>Three weeks. The wrong grant.</h2>
            <div className="mt-6 grid gap-6 md:grid-cols-3">
              <p className={leadClass}>
                Federal funding is real money — but the process punishes guesses.
                You sink weeks into a 30-page application for a program you
                were never eligible for, or that no company like yours has ever
                won.
              </p>
              <p className={leadClass}>
                The tools that are supposed to help just show you <em>more</em>{" "}
                matches, because more looks like value. A wall of amber
                &ldquo;maybe&rdquo; cards is not an answer — it&rsquo;s a way to
                keep you clicking.
              </p>
              <p className={leadClass}>
                Granted is built to do the opposite: tell you the truth early,
                while it&rsquo;s still cheap to change course — and point you
                somewhere better when the answer is no.
              </p>
            </div>
          </section>

          {/* ---------------------------------------------------------------
              3. HOW IT WORKS — 3 steps
          ---------------------------------------------------------------- */}
          <section id="how" className={`${sectionClass} scroll-mt-20 py-16 sm:py-20`}>
            <p className={eyebrowClass}>How it works</p>
            <h2 className={`mt-3 ${h2Class}`}>Three steps to your matches.</h2>
            <ol className="mt-8 grid gap-5 md:grid-cols-3">
              <Step
                n="1"
                title="Describe your company"
                body="Plain English, the way you'd explain it to a friend. No forms, no jargon, no spelunking through grants.gov."
              />
              <Step
                n="2"
                title="We score your fit across 968 real opportunities"
                body="Your profile is matched against 968 real federal opportunities — grants.gov, SAM.gov, SBIR/STTR, and USAspending — and scored on program-officer criteria, then screened for eligibility."
              />
              <Step
                n="3"
                title="See your scored matches"
                body="Each opportunity is scored and called — recommend, verify, or don't-apply — with a whole-map read on where you actually stand."
              />
            </ol>
          </section>

          {/* ---------------------------------------------------------------
              4. THE DIFFERENTIATOR — grounded in real award data
          ---------------------------------------------------------------- */}
          <section id="why" className={`${sectionClass} scroll-mt-20 py-16 sm:py-20`}>
            <p className={eyebrowClass}>Why Granted</p>
            <h2 className={`mt-3 ${h2Class}`}>
              Grounded in real federal award data.
            </h2>
            <p className={`mt-5 max-w-2xl ${leadClass}`}>
              The quick alternative is pasting your pitch into a general chatbot.
              Here&rsquo;s the difference.
            </p>

            <div className="mt-8 grid gap-5 md:grid-cols-2">
              <div className="rounded-lg border border-structure-on-canvas bg-canvas p-6 sm:p-7">
                <p className="font-mono text-[12px] uppercase tracking-eyebrow text-foreground">
                  A general chatbot
                </p>
                <h3 className="mt-2 font-display text-[20px] font-semibold text-foreground">
                  Eager to please. Prone to invent.
                </h3>
                <ul className="mt-4 space-y-3">
                  <ConItem>
                    Sycophantic by design — it wants to help, so it leans toward
                    yes.
                  </ConItem>
                  <ConItem>
                    Will confidently describe a program that doesn&rsquo;t exist,
                    or a deadline it made up.
                  </ConItem>
                  <ConItem>
                    Has no calibrated way to tell you to stop — so it rarely does.
                  </ConItem>
                </ul>
              </div>

              <div className={cardClass}>
                <p className={eyebrowClass}>Granted</p>
                <h3 className="mt-2 font-display text-[20px] font-semibold text-foreground">
                  Grounded in real data. Matched to your work.
                </h3>
                <ul className="mt-4 space-y-3">
                  <ProItem>
                    Every claim traces to a real federal opportunity or award
                    record. Nothing is fabricated.
                  </ProItem>
                  <ProItem>
                    Fit is scored against a corpus of 968 actual programs, on the
                    criteria a program officer would apply.
                  </ProItem>
                  <ProItem>
                    Award history shows whether companies like yours have won —
                    so your matches reflect real fit.
                  </ProItem>
                </ul>
              </div>
            </div>

            <p className="mt-6 max-w-2xl font-body text-[14px] italic leading-relaxed text-foreground">
              If Granted can&rsquo;t ground a claim in a real opportunity or award
              record, it doesn&rsquo;t make it.
            </p>
          </section>

          {/* ---------------------------------------------------------------
              5. FREE TO START + privacy assurance
          ---------------------------------------------------------------- */}
          <section id="pricing" className={`${sectionClass} scroll-mt-20 py-16 sm:py-20`}>
            <div className={`${cardClass} sm:p-9`}>
              <p className={eyebrowClass}>Pricing</p>
              <h2 className={`mt-3 ${h2Class}`}>Free to start.</h2>
              <p className={`mt-4 max-w-2xl ${leadClass}`}>
                Run your fit check and see your opportunity map for free. No credit
                card.
              </p>
              <p className="mt-3 max-w-2xl font-body text-[14px] leading-relaxed text-foreground">
                Your company description is used to find your matches — it&rsquo;s
                not sold, and it stays yours.
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link href="/readiness" className={primaryCtaClass}>
                  Check your fit — free
                </Link>
                <Link href="/demo" className={secondaryCtaClass}>
                  See a sample map
                </Link>
              </div>
            </div>
          </section>

          {/* ---------------------------------------------------------------
              6. SAMPLE MAP link (in-context callout)
          ---------------------------------------------------------------- */}
          <section className={`${sectionClass} pb-4`}>
            <p className="font-body text-[15px] leading-relaxed text-foreground">
              Want to see what the output actually looks like?{" "}
              <Link
                href="/demo"
                className="font-medium text-structure-on-canvas underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                See a sample opportunity map →
              </Link>
            </p>
          </section>

          {/* ---------------------------------------------------------------
              7. FOOTER CTA
          ---------------------------------------------------------------- */}
          <section className={`${sectionClass} py-16 sm:py-24`}>
            <div className="rounded-lg bg-structure px-6 py-12 text-center shadow-card sm:px-10 sm:py-16">
              <h2 className="text-balance font-display text-[28px] font-bold leading-[1.14] text-token-white sm:text-[36px]">
                Find funding matched to your work.
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-pretty font-body text-[16px] leading-relaxed text-token-white">
                A free fit check and a map of 968 real federal opportunities,
                scored to your business or research.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Link href="/readiness" className={primaryCtaClass}>
                  Check your fit — free
                </Link>
                <Link
                  href="/"
                  className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border border-token-white bg-structure px-6 py-3 font-body text-[15px] font-semibold text-token-white transition hover:brightness-110 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-white focus-visible:ring-offset-2 focus-visible:ring-offset-structure"
                >
                  Run a full search
                </Link>
              </div>
            </div>
          </section>
        </main>

        <SiteFooter />
      </div>
    </>
  );
}

// --- local presentational components ---------------------------------------

/**
 * The hero proof card: a realistic strong-match result, mirroring the app's
 * match treatment (bold-foreground verdict, a green "strong match" chip) with
 * the fit reasoning. Explicitly labelled SAMPLE — it is illustrative, not a real
 * determination for any specific company.
 */
function VerdictCard() {
  return (
    <figure className="rounded-lg bg-canvas-alt p-6 text-foreground shadow-card sm:p-7">
      <div className="flex items-center justify-between gap-3">
        <figcaption className="font-mono text-[12px] uppercase tracking-eyebrow text-foreground">
          Sample match
        </figcaption>
        <span className="rounded-sm bg-success px-2 py-0.5 font-mono text-[11px] uppercase tracking-eyebrow text-on-semantic">
          Strong match
        </span>
      </div>

      <p className="mt-4 font-display text-[22px] font-bold leading-snug text-foreground">
        NSF SBIR Phase I — worth applying.
      </p>
      <p className="mt-3 text-pretty font-body text-[14px] leading-relaxed text-foreground">
        Your early-stage R&amp;D fits this program&rsquo;s scope, and the award
        history shows companies like yours have won it. Here&rsquo;s what to
        emphasize in your application.
      </p>

      <div className="mt-5 border-t border-structure-on-canvas pt-4">
        <p className="font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas">
          Why it fits
        </p>
        <ul className="mt-2 space-y-1.5 font-body text-[14px] text-foreground">
          <li>→ Stage and scope match the program&rsquo;s criteria</li>
          <li>→ Recent awards to comparable early-stage teams</li>
        </ul>
      </div>
    </figure>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className={cardClass}>
      <span
        aria-hidden
        className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-structure font-display text-[16px] font-bold text-token-white"
      >
        {n}
      </span>
      <h3 className="mt-4 font-display text-[19px] font-semibold leading-snug text-foreground">
        {title}
      </h3>
      <p className="mt-2 text-pretty font-body text-[14px] leading-relaxed text-foreground">
        {body}
      </p>
    </li>
  );
}

function ProItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 font-body text-[14px] leading-relaxed text-foreground">
      <span aria-hidden className="mt-0.5 font-bold text-structure-on-canvas">
        ✓
      </span>
      <span>{children}</span>
    </li>
  );
}

function ConItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 font-body text-[14px] leading-relaxed text-foreground">
      <span aria-hidden className="mt-0.5 font-bold text-foreground">
        ✗
      </span>
      <span>{children}</span>
    </li>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-canvas-alt bg-canvas">
      <div className={`${sectionClass} py-10`}>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="font-display text-[20px] font-bold text-structure-on-canvas">
              {BRAND}
            </p>
            <p className="mt-1 font-body text-[14px] text-foreground">
              Federal funding intelligence for everyone.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
            {[
              { href: "#how", label: "How it works" },
              { href: "#why", label: "Why Granted" },
              { href: "/demo", label: "Sample map" },
              { href: "/readiness", label: "Check your fit" },
              { href: "/", label: "Full search" },
            ].map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-sm font-body text-[14px] text-foreground transition hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <p className="mt-8 max-w-3xl font-body text-[12px] leading-relaxed text-foreground">
          Granted surfaces public federal funding information and an honest fit
          assessment grounded in real award data. It is not legal, financial, or
          grant-writing advice, and it does not submit applications on your
          behalf. Confirm eligibility and requirements with the program officer
          before applying.
        </p>
        <p className="mt-4 font-mono text-[12px] text-foreground">
          © {new Date().getFullYear()} {BRAND}
        </p>
      </div>
    </footer>
  );
}

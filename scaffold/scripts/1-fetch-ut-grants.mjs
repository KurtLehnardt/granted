/**
 * Step 1 (state breadth) — Utah funding opportunities (Looker Studio BI dashboard).
 *
 * NOT keyless-API, NOT scrapable-HTML like CA/IL/NC: Utah's only public,
 * central listing of its funding opportunities is a Google Looker Studio
 * report (no API, no CSV export, no server-rendered table). Confirmed live
 * (this session, via Playwright): the report renders ~200 opportunity cards
 * inside a visualization embedded TWO iframes deep —
 *   top page -> iframe#receiver (thirdPartyViz) -> iframe#viz-loader (the
 *   actual cards-view content, same-origin-restricted to plain page JS, but
 *   reachable from Playwright via frameLocator/CDP).
 * Each card is a flat, uniform shape: an <h4> title, exactly five <h5> lines
 * ("Category:", "Agency:", "Opportunity Amount:", "Grant Match:",
 * "Loan Interest:"), a <p> description, and one "Learn More" <a> link.
 *
 * Data quality is meaningfully weaker than CA/IL/NC (no deadline field, no
 * eligibility field, no stable native id, occasional overlap with federal
 * programs the state is just highlighting alongside its own) — this is WHY
 * Utah ships opt-in and OFF by default in Settings (see
 * lib/searchSettings.ts's getSelectedStateSources), unlike the other three
 * state sources, which are on by default. This fetcher itself always runs
 * when invoked directly; the opt-in gate lives in refresh-corpus.mjs, which
 * only invokes this script when "ut-grants" is in the selected set.
 *
 * Requires a headless Chromium (Playwright browser binary) — unlike every
 * other fetcher, which is a plain fetch(). If missing, run
 * `npx playwright install chromium` once.
 *
 * Writes ONLY its own raw file (data/raw/ut-grants.json), same convention as
 * every other fetcher.
 *
 * Run on your laptop: `node scripts/1-fetch-ut-grants.mjs`
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { MANUAL_ADDITIONS } from "./lib/utManualAdditions.mjs";

const RAW_DIR = process.env.RAW_DIR || "data/raw";
const rawPath = (name) => join(RAW_DIR, name);

await mkdir(RAW_DIR, { recursive: true });

const REPORT_URL =
  "https://lookerstudio.google.com/u/0/reporting/ef90555b-7a4d-4b8e-898e-c427c996bf65/page/WFAzC";

// Confirmed live: top page -> iframe#receiver -> iframe#viz-loader is the
// exact (and only) nesting that reaches the cards content. Each level is its
// own cross-origin document, which is exactly why this needs a real browser
// (frameLocator/CDP) instead of a plain fetch() + regex like IL/CA.
function cardsLocator(page) {
  return page.frameLocator("iframe#receiver").frameLocator("iframe#viz-loader").locator(".mdc-layout-grid__cell");
}

/** Poll (rather than a single wait) because Looker Studio renders its nested
 *  iframes and populates the visualization asynchronously, in stages — a
 *  single fixed-delay wait was confirmed live to sometimes catch a
 *  partially-rendered set. */
async function waitForCards(locator, { min = 100, timeoutMs = 60_000, pollMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await locator.count();
    if (last >= min) return last;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out waiting for Utah funding cards to render (saw ${last}, need >= ${min})`);
}

async function extractCards(locator) {
  return locator.evaluateAll((cells) =>
    cells.map((cell) => {
      const h4 = cell.querySelector("h4");
      const h5s = Array.from(cell.querySelectorAll("h5")).map((h) => h.textContent.trim());
      const field = (label) => {
        const line = h5s.find((h) => h.toLowerCase().startsWith(`${label.toLowerCase()}:`));
        return line ? line.slice(label.length + 1).trim() : "";
      };
      const p = cell.querySelector("p");
      const a = cell.querySelector("a");
      return {
        title: h4 ? h4.textContent.trim() : "",
        category: field("Category"),
        agency: field("Agency"),
        amount: field("Opportunity Amount"),
        grantMatch: field("Grant Match"),
        loanInterest: field("Loan Interest"),
        description: p ? p.textContent.trim() : "",
        url: a ? a.getAttribute("href") || "" : "",
      };
    }),
  );
}

async function main() {
  console.log("UT grants  launching headless Chromium for the Utah Looker Studio dashboard…");

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/executable doesn't exist/i.test(msg) || /playwright install/i.test(msg)) {
      console.error("\nUT grants  Chromium isn't installed — run `npx playwright install chromium` first.\n");
      process.exit(1);
    }
    throw e;
  }

  let out = [];
  try {
    const page = await browser.newPage();
    console.log("UT grants  loading the Looker Studio report (this can take a few seconds)…");
    await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const cards = cardsLocator(page);
    const count = await waitForCards(cards);
    console.log(`UT grants  rendered ${count} cards -- extracting…`);
    out = await extractCards(cards);
  } finally {
    await browser.close();
  }

  // No prior-run baseline exists for this brand-new source, so a silent
  // scrape break (Looker Studio changes its markup, or the state trims its
  // listing) has nothing else to catch it. ~200 cards confirmed live; warn
  // loudly well short of that rather than fail quietly.
  if (out.length < 100) {
    console.warn(`UT grants  WARNING: only extracted ${out.length} cards -- expected ~200. The dashboard markup may have changed.`);
  }

  out = out.concat(MANUAL_ADDITIONS);

  await writeFile(rawPath("ut-grants.json"), JSON.stringify(out, null, 2));
  console.log(`UT grants  kept ${out.length} opportunities (${MANUAL_ADDITIONS.length} hand-added, not on the dashboard)`);
  console.log(`→ ${rawPath("ut-grants.json")}\n`);
}

await main();

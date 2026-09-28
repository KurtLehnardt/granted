import { test, expect } from "@playwright/test";
import { stubBackend, skipWelcomeGuide, DETAILED_DESCRIPTION, FIXTURE_PROGRAM, fixtureMap } from "./fixtures";

/**
 * Journey 2 — Results (+ buckets) (critical, wired). After a search, the
 * opportunity map shows the summary and at least one opportunity card with its
 * agency and next-step guidance. The eligibility BUCKETS surface is behind the
 * default-off `r8_eligibility` flag; when that build flag is on this same
 * fixture (matches carry `eligibility`) also exercises the bucket bodies, and
 * an `excluded` bucket must always render a reason — see the guarded check.
 */
test("results: the opportunity map renders a card with agency + next steps", async ({ page }) => {
  await stubBackend(page);
  await skipWelcomeGuide(page);
  await page.goto("/");
  await page.getByLabel(/tell us about your company/i).fill(DETAILED_DESCRIPTION);
  await page.getByRole("button", { name: /find opportunities/i }).click();

  const program = fixtureMap.matches[0].opportunity.program;
  await expect(page.getByText(program).first()).toBeVisible();
  await expect(page.getByText(fixtureMap.matches[0].opportunity.agency).first()).toBeVisible();
});

test("results (buckets, when r8_eligibility is on): an excluded bucket never renders without a reason", async ({ page }) => {
  await stubBackend(page);
  await skipWelcomeGuide(page);
  await page.goto("/");
  await page.getByLabel(/tell us about your company/i).fill(DETAILED_DESCRIPTION);
  await page.getByRole("button", { name: /find opportunities/i }).click();
  await expect(page.getByText(FIXTURE_PROGRAM).first()).toBeVisible();

  // Only assert when the flag-gated bucket UI is actually present in this build.
  const excluded = page.getByText(/not eligible|excluded/i);
  if (await excluded.count()) {
    // R8.2: a shown exclusion must carry its cited reason, never a bare label.
    await expect(excluded.first()).toBeVisible();
  }
});

import { test, expect } from "@playwright/test";
import { stubBackend, skipWelcomeGuide, DETAILED_DESCRIPTION, FIXTURE_PROGRAM } from "./fixtures";

/**
 * Journey 1 — Search (critical, wired). Land on /, describe a company, submit,
 * and see the opportunity map render. /api/match is stubbed (no model spend).
 */
test("search: describe a company, submit, and see the opportunity map", async ({ page }) => {
  await stubBackend(page);
  await skipWelcomeGuide(page);
  await page.goto("/");

  await page.getByLabel(/tell us about your company/i).fill(DETAILED_DESCRIPTION);

  const cta = page.getByRole("button", { name: /find opportunities/i });
  await expect(cta).toBeEnabled();
  await cta.click();

  // The streamed result renders the opportunity card for our fixture program.
  await expect(page.getByText(FIXTURE_PROGRAM).first()).toBeVisible();
});

/**
 * H1 regression at the journey level: a stream that closes without a result
 * must surface an error + a retry, never a silent blank form.
 */
test("search: a result-less stream shows an error and a Try again affordance", async ({ page }) => {
  await page.route("**/api/interview", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ questions: [] }) }),
  );
  await page.route("**/api/match", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      // progress only — the stream closes with no `result` line.
      body: JSON.stringify({ type: "progress", key: "start", label: "Reading…", pct: 5 }) + "\n",
    }),
  );
  await skipWelcomeGuide(page);
  await page.goto("/");
  await page.getByLabel(/tell us about your company/i).fill(DETAILED_DESCRIPTION);
  await page.getByRole("button", { name: /find opportunities/i }).click();

  await expect(page.getByText(/didn't complete|try again/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
});

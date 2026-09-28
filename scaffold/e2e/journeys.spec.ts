import { test, expect } from "@playwright/test";
import {
  stubBackend,
  skipWelcomeGuide,
  FIXTURE_PROGRAM,
  fixtureMap,
  ndjson,
  DETAILED_DESCRIPTION,
} from "./fixtures";

/**
 * The remaining named critical journeys. Sample-pick (via the welcome guide)
 * and the welcome-guide journeys below are wired + passing on the default
 * build. The rest are SCRIPTED skeletons marked `test.fixme` because they
 * depend on build-time NEXT_PUBLIC_* flags (r1_interview, r9_0_mockauth,
 * r6_auto_fill, left_sidebar, billing) that the default build has off — run
 * against a build with the relevant flag on, then promote them to `test(...)`.
 */

test("welcome guide: first visit shows the guide; picking a sample runs the search and shows results, without filling the description", async ({ page }) => {
  await stubBackend(page);
  await page.goto("/");

  const dialog = page.getByRole("dialog", { name: /welcome/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Describe your company")).toBeVisible();

  await dialog.getByRole("button", { name: "Show sample companies" }).click();
  await dialog.getByRole("button").filter({ hasText: /Fictional/i }).first().click();
  await dialog.getByRole("button", { name: "Next" }).click();

  await expect(dialog.getByText("Choose your model")).toBeVisible();
  // The guide inerts the page, so find the Settings button by its tour attribute.
  const settingsButton = page.locator('[data-tour="settings"]:visible').first();
  const settingsBox = await settingsButton.boundingBox();
  expect(settingsBox).not.toBeNull();
  const highlight = page.locator('[aria-hidden][style*="box-shadow"]');
  await expect(highlight).toBeVisible();
  const highlightBox = await highlight.boundingBox();
  expect(highlightBox).not.toBeNull();
  expect(Math.abs(highlightBox!.x - settingsBox!.x)).toBeLessThan(20);
  expect(Math.abs(highlightBox!.y - settingsBox!.y)).toBeLessThan(20);

  await dialog.getByRole("button", { name: "Done" }).click();

  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(FIXTURE_PROGRAM).first()).toBeVisible();
  await expect(page.getByLabel("Company description")).toHaveValue("");
});

test("welcome guide: closing step 2 with X still applies the selected sample", async ({ page }) => {
  await stubBackend(page);
  await page.goto("/");

  const dialog = page.getByRole("dialog", { name: /welcome/i });
  await dialog.getByRole("button", { name: "Show sample companies" }).click();
  await dialog.getByRole("button").filter({ hasText: /Fictional/i }).first().click();
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByText("Choose your model")).toBeVisible();

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(FIXTURE_PROGRAM).first()).toBeVisible();
  await expect(page.getByLabel("Company description")).toHaveValue("");
});

test("welcome guide: never shows again after the first visit, but Settings can replay it", async ({ page }) => {
  await stubBackend(page);
  await page.goto("/");
  await expect(page.getByRole("dialog", { name: /welcome/i })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog", { name: /welcome/i })).not.toBeVisible();

  await page.reload();
  await expect(page.getByRole("dialog", { name: /welcome/i })).not.toBeVisible();

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Replay welcome guide" }).click();
  await expect(page.getByRole("dialog", { name: /welcome/i })).toBeVisible();
});

test("welcome guide: not shown to a returning user with a saved run", async ({ page }) => {
  await stubBackend(page);
  await page.addInitScript((map) => {
    window.localStorage.setItem("ff.runs.v1", JSON.stringify([{ id: "run_1", savedAt: new Date().toISOString(), map }]));
  }, fixtureMap);
  await page.goto("/");
  await expect(page.getByText(FIXTURE_PROGRAM).first()).toBeVisible();
  await expect(page.getByRole("dialog", { name: /welcome/i })).toHaveCount(0);
});

test("welcome guide: replaying it after typing a description leaves the description untouched when a sample is picked", async ({ page }) => {
  await stubBackend(page);
  await skipWelcomeGuide(page);
  await page.goto("/");

  const myDescription = "My own real company description for federal grant matching.";
  await page.getByLabel("Company description").fill(myDescription);

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Replay welcome guide" }).click();

  const dialog = page.getByRole("dialog", { name: /welcome/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Show sample companies" }).click();
  await dialog.getByRole("button").filter({ hasText: /Fictional/i }).first().click();
  await dialog.getByRole("button", { name: "Next" }).click();
  await dialog.getByRole("button", { name: "Done" }).click();

  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(FIXTURE_PROGRAM).first()).toBeVisible();
  // Blurring commits the textarea into the questionnaire's read-only summary.
  await expect(page.getByText(myDescription)).toBeVisible();
});

test("welcome guide: sample list disables while a search is in flight", async ({ page }) => {
  await skipWelcomeGuide(page);
  await page.route("**/api/interview", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questions: [] }),
    }),
  );
  await page.route("**/api/match", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      body: ndjson([
        { type: "progress", key: "start", label: "Reading the federal register…", pct: 5 },
        { type: "result", map: fixtureMap },
      ]),
    });
  });
  await page.goto("/");

  await page.getByLabel("Company description").fill(DETAILED_DESCRIPTION);
  await page.getByLabel("Industry / market").fill("Health IT");
  await page.getByLabel("Core technology").fill("Diagnostic imaging software");
  await page.getByLabel("Primary US location").fill("Boise, Idaho");
  await page.getByLabel("Use of funds").fill("Hire two engineers");
  await page.getByLabel("Use of funds").blur();
  await page.getByRole("button", { name: "Find opportunities" }).click();

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Replay welcome guide" }).click();
  const dialog = page.getByRole("dialog", { name: /welcome/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Show sample companies" }).click();
  await expect(dialog.getByText(/Available when your current search finishes/i)).toBeVisible();
  await expect(dialog.getByRole("button").filter({ hasText: /Fictional/i }).first()).toBeDisabled();

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText(FIXTURE_PROGRAM).first()).toBeVisible({ timeout: 10_000 });
});

test("intake: optional details stay collapsed after required fields are filled, and expand on toggle click", async ({ page }) => {
  await stubBackend(page);
  await skipWelcomeGuide(page);
  await page.goto("/");

  await page.getByLabel("Company description").fill("AI diagnostics for rural clinics");
  await page.getByLabel("Industry / market").fill("Health IT");
  await page.getByLabel("Core technology").fill("Diagnostic imaging software");
  await page.getByLabel("Primary US location").fill("Boise, Idaho");
  await page.getByLabel("Use of funds").fill("Hire two engineers");
  await page.getByLabel("Use of funds").blur();
  await expect(page.getByRole("button", { name: "Find opportunities" })).toBeEnabled();

  const toggle = page.getByRole("button", { name: /add optional details/i });
  await expect(toggle).toBeVisible();
  await expect(page.getByText("A few more details (optional)")).not.toBeVisible();

  await toggle.click();
  await expect(page.getByText("A few more details (optional)")).toBeVisible();
});

test("intake: Find opportunities enables while still typing the last required field, and submits its current text", async ({ page }) => {
  await stubBackend(page);
  await skipWelcomeGuide(page);
  await page.goto("/");

  await page.getByLabel("Company description").fill(DETAILED_DESCRIPTION);
  await page.getByLabel("Industry / market").fill("Health IT");
  await page.getByLabel("Core technology").fill("Diagnostic imaging software");
  await page.getByLabel("Primary US location").fill("Boise, Idaho");
  const useOfFunds = page.getByLabel("Use of funds");
  await useOfFunds.fill("Hire two engineers");
  await expect(useOfFunds).toBeFocused();

  const button = page.getByRole("button", { name: "Find opportunities" });
  await expect(button).toBeEnabled();
  const matchRequest = page.waitForRequest("**/api/match");
  await button.click();

  expect((await matchRequest).postDataJSON().description).toContain("Use of funds: Hire two engineers");
  await expect(page.getByText(FIXTURE_PROGRAM).first()).toBeVisible();
});

// Journey 3 — Interview (needs r1_interview on + a short description).
test.fixme("interview: a short description shows the pre-search interview before results", async ({ page }) => {
  await page.route("**/api/interview", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        questions: [
          {
            id: "q1",
            question: "What type of entity is your company?",
            routing_target: "eligibility_gate",
            gate_class: "entity_type",
            answer_kind: "single_select",
            options: [{ value: "for_profit", label: "For-profit" }, { value: "other", label: "Other / not sure" }],
            allow_free_text: true,
            rationale: "Determines which programs you can apply to.",
            maps_to_profile_field: "entity_type",
            priority: 1,
          },
        ],
      }),
    }),
  );
  await stubBackend(page);
  await skipWelcomeGuide(page);
  await page.goto("/");
  await page.getByLabel(/tell us about your company/i).fill("AI for clinics");
  await page.getByRole("button", { name: /find opportunities/i }).click();
  await expect(page.getByText(/entity/i)).toBeVisible();
});

// Journey 5 — Sign-in / demo (needs r9_0_mockauth on).
test.fixme("sign-in/demo: entering demo mode shows the Hackathon Judge identity", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /demo|judge/i }).click();
  await expect(page.getByText(/judge/i)).toBeVisible();
});

// Journey 6 — Auto-fill flow (needs r6_auto_fill / left_sidebar).
test.fixme("auto-fill: opening Auto Fill while signed out gates on sign-in", async ({ page }) => {
  await stubBackend(page);
  await skipWelcomeGuide(page);
  await page.goto("/");
  await page.getByLabel(/tell us about your company/i).fill(
    "We build AI diagnostics for rural clinics. We have 12 employees. We need federal funding.",
  );
  await page.getByRole("button", { name: /find opportunities/i }).click();
  await expect(page.getByText(FIXTURE_PROGRAM)).toBeVisible();
  await page.getByRole("button", { name: /auto fill/i }).first().click();
  await expect(page.getByText(/sign in/i)).toBeVisible();
});

// Journey 8 — Billing → padlock (needs left_sidebar + billing).
test.fixme("billing: switching to a paid tier unlocks padlocked features live", async ({ page }) => {
  await skipWelcomeGuide(page);
  await page.goto("/");
  await page.getByRole("button", { name: /open menu/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // On Free, Auto Fill / Competitor Analysis show locked/upsell framing; after
  // switching to Max via the billing selector they unlock without a reload.
});

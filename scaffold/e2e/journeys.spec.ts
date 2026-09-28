import { test, expect } from "@playwright/test";
import {
  stubBackend,
  skipWelcomeGuide,
  fillRequiredIntakeFields,
  FIXTURE_PROGRAM,
  fixtureMap,
  ndjson,
  DETAILED_DESCRIPTION,
} from "./fixtures";

/**
 * The remaining named critical journeys. Sample-pick (via the welcome guide)
 * and the welcome-guide journeys below are wired + passing on the default
 * build. Interview and sign-in/demo below are SCRIPTED skeletons marked
 * `test.fixme` because they depend on build-time NEXT_PUBLIC_* flags
 * (r1_interview, mock auth) that the default build has off — run against a
 * build with the relevant flag on, then promote them to `test(...)`.
 *
 * The auto-fill and billing journeys that used to live here are gone, not
 * fixme'd: Auto Fill's UI entry point was removed (replaced by the "How can
 * I apply?" modal) and the billing/entitlements padlock UI was removed
 * entirely, so those flows have nothing left to open regardless of which
 * flags are on — scripting them further would describe features that no
 * longer exist rather than ones pending a flag flip.
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

  await fillRequiredIntakeFields(page, {
    technology: "Diagnostic imaging software",
    location: "Boise, Idaho",
    useOfFunds: "Hire two engineers",
  });
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

  await fillRequiredIntakeFields(page, {
    description: "AI diagnostics for rural clinics",
    technology: "Diagnostic imaging software",
    location: "Boise, Idaho",
    useOfFunds: "Hire two engineers",
  });
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

test("intake: the form collapses to a summary bar after a real search starts, and expands back with values intact on click", async ({ page }) => {
  await stubBackend(page);
  await skipWelcomeGuide(page);
  await page.goto("/");

  const description = "AI diagnostics for rural clinics, built for overworked front-desk staff.";
  await fillRequiredIntakeFields(page, {
    description,
    technology: "Diagnostic imaging software",
    location: "Boise, Idaho",
    useOfFunds: "Hire two engineers",
  });
  await page.getByLabel("Use of funds").blur();
  const toggle = page.locator('button[aria-controls="pq-form-fields"]');
  await expect(toggle).toHaveCount(0);

  await page.getByRole("button", { name: "Find opportunities" }).click();

  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText(description);
  await expect(toggle).toBeFocused();
  await expect(page.getByLabel("Company description")).toHaveCount(0);
  await expect(page.getByText(FIXTURE_PROGRAM).first()).toBeVisible();

  await toggle.click();
  const descriptionField = page.getByLabel("Company description");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(descriptionField).toHaveValue(description);
  await expect(descriptionField).toBeFocused();
  await expect(page.getByLabel("Industry / market")).toHaveValue("Health IT");
  await expect(page.getByText(FIXTURE_PROGRAM).first()).toBeVisible();

  await descriptionField.fill(`${description} Now piloting in three states.`);
  await page.getByRole("button", { name: "Find opportunities" }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText("Now piloting in three states.");
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
  // IntakeForm.beginSearch's interview gate is a word/sentence count on the
  // FULL compiled description (raw_text + every other filled field, one
  // "Label: value" line each — see buildDescriptionFromProfile) — every
  // field here must stay short, or the other 4 fields' text alone can push
  // the total past the "detailed enough, skip the interview" threshold.
  await fillRequiredIntakeFields(page, {
    description: "AI for clinics",
    industry: "Health",
    technology: "AI",
    location: "Utah",
    useOfFunds: "R&D",
  });
  await page.getByRole("button", { name: /find opportunities/i }).click();
  await expect(page.getByText(/entity/i)).toBeVisible();
});

// Journey 5 — Sign-in / demo (needs mock auth on).
test.fixme("sign-in/demo: entering demo mode shows the Hackathon Judge identity", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /demo|judge/i }).click();
  await expect(page.getByText(/judge/i)).toBeVisible();
});

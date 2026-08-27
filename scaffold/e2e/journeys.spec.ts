import { test, expect } from "@playwright/test";
import { stubBackend, FIXTURE_PROGRAM } from "./fixtures";

/**
 * The remaining named critical journeys. Sample-pick is wired + passing on the
 * default build. The rest are SCRIPTED skeletons marked `test.fixme` because
 * they depend on build-time NEXT_PUBLIC_* flags (r1_interview, r9_0_mockauth,
 * r6_auto_fill, left_sidebar, billing) that the default build has off — run
 * against a build with the relevant flag on, then promote them to `test(...)`.
 */

// Journey 2b — Sample pick (wired). The sample picker is always available.
test("sample-pick: choosing a sample company runs the search and shows results", async ({ page }) => {
  await stubBackend(page);
  await page.goto("/");

  await page.getByRole("button", { name: /see a sample company/i }).click();
  // Sample items render their one-line "Fictional …" blurb; click the first.
  await page.getByRole("button").filter({ hasText: /^Fictional/i }).first().click();

  await expect(page.getByText(FIXTURE_PROGRAM)).toBeVisible();
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
  await page.goto("/");
  await page.getByRole("button", { name: /open menu/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // On Free, Auto Fill / Competitor Analysis show locked/upsell framing; after
  // switching to Max via the billing selector they unlock without a reload.
});

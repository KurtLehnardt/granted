import { test, expect } from "@playwright/test";

/**
 * A saved profile (restored from localStorage) must render straight into
 * editable controls — no "Edit" button gating them — and those controls must
 * stay editable as the user types, including the rd_activities boolean_text
 * detail box (the reviewer's regression: typing into a restored detail box
 * used to blank the radio choice and unmount the box).
 */

const STORAGE_KEY = "ff.questionnaire.profile.v1";

test("a field with a saved value renders as an editable control with no Edit button", async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [
      STORAGE_KEY,
      JSON.stringify({
        industry: { value: "agtech", provenance: "user_stated", confidence: 1 },
      }),
    ],
  );
  await page.goto("/");

  const industry = page.getByLabel("Industry / market");
  await expect(industry).toHaveValue("agtech");
  await expect(page.getByRole("button", { name: /^edit$/i })).toHaveCount(0);

  await industry.fill("agtech, biotech");
  await expect(industry).toHaveValue("agtech, biotech");
});

test("typing into a restored boolean_text detail box keeps the radio checked and the box mounted", async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [
      STORAGE_KEY,
      JSON.stringify({
        rd_activities: { value: "Yes — prototype testing", provenance: "user_stated", confidence: 1 },
      }),
    ],
  );
  await page.goto("/");
  await page.getByRole("button", { name: /add optional details/i }).click();

  const yesRadio = page.getByRole("radio", { name: "Yes" });
  const detail = page.getByLabel("R&D activities — details");
  await expect(yesRadio).toBeChecked();
  await expect(detail).toHaveValue("prototype testing");

  await detail.type(" X");

  await expect(yesRadio).toBeChecked();
  await expect(detail).toBeVisible();
  await expect(detail).toHaveValue("prototype testing X");
});

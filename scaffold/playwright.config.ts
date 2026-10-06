import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Lightweight Playwright journey harness (H6/H7).
 *
 * Targets a running app. By default it reuses whatever server is already up at
 * E2E_BASE_URL (the user runs the A/B build on :3001) — `reuseExistingServer`
 * means the harness does NOT spin up a competing dev server when one is present.
 * In CI (no server running) it falls back to `npm run start` (after `npm run
 * build`) on the same URL.
 *
 * The critical journeys stub /api/match and /api/interview at the network layer
 * (page.route) so they are deterministic and spend zero model credits.
 *
 * Flag-gated journeys (interview, sidebar sections, buckets, auto-fill,
 * billing) depend on build-time NEXT_PUBLIC_* flags; run against a build with
 * the relevant flag on, or see the fixme notes in e2e/journeys.spec.ts.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3001";

/**
 * Errors the journeys provoke must never land in the user's real error log
 * (%LOCALAPPDATA%\Granted\logs): the server this config starts, and this
 * process, log to a temp folder instead. (A server that's already running
 * keeps its own setting -- reuseExistingServer can't change that.)
 */
const E2E_LOG_DIR = process.env.GRANTED_LOG_DIR ?? join(tmpdir(), "granted-e2e-error-log");
process.env.GRANTED_LOG_DIR = E2E_LOG_DIR;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: process.env.E2E_WEB_SERVER_CMD ?? "npm run start",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    env: { ...(process.env as Record<string, string>), GRANTED_LOG_DIR: E2E_LOG_DIR },
  },
});

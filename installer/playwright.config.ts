import { defineConfig } from "@playwright/test";

// End-to-end tests drive the BUILT app (out/) through Playwright's Electron
// support — `npm run e2e` builds first. One worker: every test needs port
// 3000 (the port `npm run dev` serves Granted on) to itself.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [["list"]],
});

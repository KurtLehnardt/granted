/**
 * Background service worker. INV-7: this file, and everything under
 * `src/background/**`, performs ZERO network I/O — no `fetch`,
 * `XMLHttpRequest`, `WebSocket`, or `sendBeacon`, enforced by the ESLint
 * `no-restricted-globals`/`no-restricted-syntax` rule (`eslint.config.js`)
 * AND the independent static-scan test (`test/networkBan.test.ts`).
 *
 * This worker's job is intentionally small: extension lifecycle logging and
 * a "Clear package" relay for the popup (spec §7.3 — data lifecycle). It
 * never imports, fills, or navigates anything itself; all of that is
 * user-gesture-triggered directly from the popup against the active tab
 * (`scripting` + `activeTab`), per spec §1.1.
 */

chrome.runtime.onInstalled.addListener(() => {
  // No network call, no telemetry. Local-only lifecycle marker for debugging
  // via chrome://extensions "service worker" console.
  console.log("[Granted Assisted Fill] installed. No network egress in this extension.");
});

type ClearPackageMessage = { type: "CLEAR_PACKAGE" };
type BackgroundMessage = ClearPackageMessage;

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  if (message?.type === "CLEAR_PACKAGE") {
    chrome.storage.session.remove(["grantedPackage", "grantedFillState"], () => {
      sendResponse({ ok: true });
    });
    return true; // keep the message channel open for the async sendResponse
  }
  return false;
});

import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

/**
 * MV3 manifest — Granted Assisted Fill.
 *
 * Honest, least-privilege, client-side-only. In short:
 *
 * - `permissions`: only `storage` (hold the imported package + configs),
 *   `scripting` + `activeTab` (user-gesture-scoped fill on the active tab).
 *   Deliberately NOT `tabs`, `webNavigation`, `cookies`, `webRequest`, `<all_urls>`.
 * - `host_permissions`: scoped to exactly the four in-scope portals (INV-6).
 *   No login.gov / sam.gov / IdP origin is ever listed (INV-5).
 * - `content_security_policy.extension_pages`: `connect-src 'none'` — the
 *   manifest-level partner to INV-7 (zero network egress).
 * - `externally_connectable`: DELIBERATELY OMITTED. See spec §6.2 — the
 *   app→extension handoff is a user-mediated file import, never a standing
 *   web-origin message channel into this extension.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Granted Assisted Fill",
  version: pkg.version,
  description:
    "Fills a grant-portal form in your own session from your Granted package. You review; your AOR submits. It never submits.",
  minimum_chrome_version: "116",

  permissions: ["storage", "scripting", "activeTab"],

  // Scoped to the four in-scope portals ONLY. No <all_urls>. No login.gov, no sam.gov.
  // NOTE: exact Grants.gov Workspace host is TODO (in-session capture) — see spec §1.3.
  host_permissions: [
    "https://www.grants.gov/*",
    "https://grants.gov/*",
    "https://apply07.grants.gov/*", // legacy Workspace host — CONFIRM in in-session pass
    "https://www.research.gov/*",
    "https://research.gov/*",
    "https://public.era.nih.gov/*", // NIH ASSIST; content script path-scoped to /assist/
    "https://www.sbir.gov/*",
    "https://sbir.gov/*",
  ],

  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },

  // Declarative content scripts — passive presence on the exact fill surfaces only.
  // Path-scoped so injection is tighter than the host_permissions grant.
  //
  // NOTE: each portal points at its OWN thin entry file (`src/content/entries/*.ts`,
  // each just `import "../runtime"`) rather than all four sharing
  // `src/content/runtime.ts` directly. @crxjs/vite-plugin computes
  // `web_accessible_resources` matches per BUILD CHUNK; when multiple
  // `content_scripts` entries reference the exact same source file, only the
  // last-registered portal's origins end up granted access to the shared
  // dynamically-imported chunk, silently breaking content-script
  // initialization (a failed runtime `import()`) on every other portal.
  // Separate entry files (still importing the one shared `runtime.ts`
  // implementation) give each portal its own correctly-scoped grant.
  content_scripts: [
    {
      matches: ["https://www.grants.gov/*", "https://grants.gov/*", "https://apply07.grants.gov/*"],
      js: ["src/content/entries/grantsGov.ts"],
      run_at: "document_idle",
    },
    {
      matches: ["https://www.research.gov/*", "https://research.gov/*"],
      js: ["src/content/entries/researchGov.ts"],
      run_at: "document_idle",
    },
    {
      matches: ["https://public.era.nih.gov/assist/*"], // path-scoped: ASSIST only
      js: ["src/content/entries/nihAssist.ts"],
      run_at: "document_idle",
    },
    {
      matches: ["https://www.sbir.gov/*", "https://sbir.gov/*"],
      js: ["src/content/entries/sbirGov.ts"],
      run_at: "document_idle",
    },
  ],

  action: {
    default_popup: "src/popup/index.html",
    default_title: "Granted Assisted Fill",
  },

  // Strict CSP: no remote code, everything bundled. (MV3 default already forbids
  // remote code; stated explicitly for the review gate and as the manifest-level
  // partner to INV-7.)
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; connect-src 'none'",
  },

  // externally_connectable: DELIBERATELY OMITTED. See spec §6.
});

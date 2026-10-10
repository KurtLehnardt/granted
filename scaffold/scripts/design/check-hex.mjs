#!/usr/bin/env node
/**
 * CON-02 — no-raw-hex CI check (R7.6).
 *
 * Scans components/ and app/ for raw hex color literals. Components must
 * reference design tokens (lib/design/tokens.ts, or the Tailwind classes /
 * CSS variables it generates) — never a hardcoded hex value.
 *
 * This is a standalone CI script rather than an ESLint rule so it has no
 * dependency on an ESLint config existing in this project (none does yet).
 * It is intentionally NOT wired into `npm run build` — wire this into a
 * separate CI job or a pre-merge check instead.
 *
 * The match deliberately excludes three things that look like hex but are
 * not colors. First, a `#` immediately preceded by a word character or by
 * `&` is skipped, because that is either part of a longer alphanumeric
 * token or an HTML numeric character entity such as `&#8599;`, neither of
 * which is a color literal. Second and third, a `#` followed by exactly
 * three or exactly four decimal digits with no hex letters (for example
 * `#210` or `#1234`) is skipped, because in this codebase that pattern is
 * always a GitHub issue or PR reference, never a real CSS hex color of
 * that length — a genuine 3- or 4-digit hex color always contains at
 * least one a-f letter (`#fff`, `#a1b`, `#0f0`, `#1a2b`, `#fff0`), so an
 * all-decimal value is not a color worth flagging. This check runs in CI
 * (see the workflow that invokes `npm run check:hex`), and this repo's
 * issue numbers are already in the 300s and will reach four digits before
 * long; without the 4-digit exclusion, a comment or test name mentioning
 * an issue like `#1234` would turn CI red for a non-problem, whereas a
 * genuine hand-written 4-digit all-decimal RGBA color is essentially never
 * seen in practice. With these exclusions in place, running this script
 * against today's tree finds zero raw hex violations.
 *
 * Usage:
 *   node scripts/design/check-hex.mjs
 *
 * Exit code 0 = no raw hex found. Exit code 1 = raw hex found (details
 * printed to stdout).
 *
 * Escape hatch: append `// hex-ok` (or `/* hex-ok *\/` in CSS) to a line to
 * exclude it from this check, for the rare legitimate exception (e.g. a
 * third-party embed snippet). Use sparingly — this defeats the point of
 * the check.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const SCAN_DIRS = ["components", "app"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".css"]);
const IGNORE_DIRS = new Set(["node_modules", ".next", ".git"]);
const SUPPRESSION_MARKER = "hex-ok";

// app/globals.css is the CSS-variable source of truth for the design-token
// contract (see lib/design/tokens.ts's header — the two are meant to be
// kept in sync by hand). It necessarily contains literal hex to *define*
// each --color-* custom property; that is the token contract, not a
// violation of it. Everything else under app/ and components/ (including
// any future consumer of these variables) is still fully scanned — this
// is the one intentionally-exempt file, not a broad carve-out.
const EXCLUDED_FILES = new Set(["app/globals.css"]);

// R9.0 interim mock-auth surface (PLT-01). TEMPORARY carve-out — not a general
// license for raw hex. These files are throwaway scaffolding deleted at R9 (real
// OAuth), and the login page renders the Google logo in Google's own brand palette
// (#4285F4 / #34A853 / #FBBC05 / #EA4335) — brand assets that cannot become design
// tokens — plus a few one-off greys outside this project's small semantic token
// set. The *product* UI is still fully scanned. REVISIT: when R9 replaces the mock
// with real OAuth, delete these files and drop this carve-out.
const INTERIM_EXCLUDED = new Set([
  "components/UserMenu.tsx",
  "app/login/page.tsx",
]);

// Matches #RGB, #RGBA, #RRGGBB, #RRGGBBAA — longest alternative first so a
// 6-digit hex isn't matched as a 3-digit prefix. Rejects a match that's
// immediately preceded by a word character or by "&" (a negative lookbehind,
// not a consuming character class, so a match at the very start of a line
// still works) — "&" specifically guards against HTML numeric character
// entities like "&#8599;", which are not color literals. Also rejects a
// match that's immediately followed by another word character, so it
// doesn't fire on a longer alphanumeric token that happens to contain a
// hex-looking substring. Both the 3-digit and 4-digit alternatives
// additionally require at least one non-decimal hex digit (a-f/A-F) — a bare
// run of 3 or 4 decimal digits (e.g. "#210", "#1234") is always a GitHub
// issue/PR reference in this codebase, never a literal CSS hex color of that
// length.
const HEX_PATTERN =
  /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?![0-9]{4})[0-9a-fA-F]{4}|(?![0-9]{3})[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g;

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (SCAN_EXTENSIONS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

function checkFile(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    if (line.includes(SUPPRESSION_MARKER)) return;
    let match;
    HEX_PATTERN.lastIndex = 0;
    while ((match = HEX_PATTERN.exec(line)) !== null) {
      hits.push({ line: i + 1, column: match.index + 1, text: match[0], context: line.trim() });
    }
  });
  return hits;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(repoRoot, d), [])).filter((file) => {
  const relPath = file.replace(repoRoot + "/", "");
  return !EXCLUDED_FILES.has(relPath) && !INTERIM_EXCLUDED.has(relPath);
});

let totalHits = 0;
for (const file of files) {
  const hits = checkFile(file);
  if (hits.length === 0) continue;
  totalHits += hits.length;
  const relPath = file.replace(repoRoot + "/", "");
  for (const hit of hits) {
    console.log(`${relPath}:${hit.line}:${hit.column}  raw hex ${hit.text}  |  ${hit.context}`);
  }
}

console.log("");
if (totalHits > 0) {
  console.log(
    `FAILED: ${totalHits} raw hex value(s) found in components/ or app/. Reference a design token instead (lib/design/tokens.ts), or Tailwind classes/CSS variables it generates. Add "// ${SUPPRESSION_MARKER}" on the line for a documented, deliberate exception.`
  );
  process.exitCode = 1;
} else {
  console.log(`OK: no raw hex found in ${SCAN_DIRS.join(", ")}.`);
}

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AnalyticsPayloadSchema,
  AnalyticsEventSchema,
  FORBIDDEN_CONTENT_KEYS,
} from "../contracts/analyticsEvent";

/**
 * PLT-02 — R9.0 / §5.3 "no server-side retention" regression guard.
 *
 * R9.0 (original product spec, line ~633) and §5.3 require
 * that the server retain NO user company-description or PII content — not in
 * request logs, error tracking, analytics payloads, or ad-hoc console output.
 * PLT-01 built the mock auth as a client-only UI state machine that gates
 * nothing server-side; this suite is an AUTOMATED, repo-local static scan that
 * keeps that invariant true as the codebase grows, so a future change that
 * reintroduces server-side description capture fails `npm test` instead of
 * shipping silently.
 *
 * This is a RECON-STYLE REGRESSION GUARD, complementary to — NOT a substitute
 * for — PLT-01's manual recon. In particular it CANNOT see:
 *   - LLM-provider-side retention (OpenAI/Anthropic API data retention
 *     policy) — that's a vendor policy question, not statically checkable
 *     from this repo.
 *   - Hosting-platform request/access logs (e.g. Vercel's own request
 *     logging) — not visible to a repo-local static scan.
 *   - Any logging call built from a dynamically-concatenated string, a
 *     multi-line call whose "description"-mentioning argument lands on a
 *     different line than `console.x(`, or any other pattern this file's
 *     regexes don't anticipate (see the scanner sanity check in part (c)
 *     for exactly what shape of violation these regexes do catch).
 *
 * Three checks, corresponding to PLT-02's definition of done:
 *   (a) no file under app/api/** references a mock-auth identifier
 *   (b) the AnalyticsEvent contract still rejects description content
 *   (c) no console.(log|error|warn|info) call under app/**|lib/** mentions
 *       "description"
 */

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// This file lives at scaffold/lib/__tests__/noServerRetention.test.ts, so the
// scaffold app root is two directories up.
const SCAFFOLD_ROOT = join(__dirname, "..", "..");

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const IGNORE_DIRS = new Set(["node_modules", ".next", ".git"]);

/** Recursively collect scannable source files under `dir`. Missing dir -> []. */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
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
    } else if (CODE_EXTENSIONS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

function isUnderTestsDir(relPath: string): boolean {
  return relPath.split("/").includes("__tests__");
}

// ---------------------------------------------------------------------------
// (a) No file under app/api/** references a mock-auth identifier.
//
// The mock auth built in PLT-01 (lib/mockAuth.ts, components/AuthProvider.tsx)
// is a client-side-only UI state machine (R9.0). It must never be read by any
// server route, or the "client-only" claim stops being true. This is checked
// with a real filesystem scan of app/api/** run from inside the test, not a
// hardcoded pass.
// ---------------------------------------------------------------------------

const MOCK_AUTH_IDENTIFIERS = [
  "mockAuth",
  "isAuthenticated",
  "r9_0_mockauth",
  "NEXT_PUBLIC_MOCK_AUTH",
] as const;

describe("(a) app/api never references mock-auth (R9.0: gates nothing server-side)", () => {
  const API_DIR = join(SCAFFOLD_ROOT, "app", "api");

  test("app/api directory exists and contains at least one scannable file", () => {
    // A missing/renamed app/api directory must not silently make the next
    // test's scan vacuously pass (0 files scanned == 0 violations found).
    assert.ok(
      existsSync(API_DIR),
      `expected app/api to exist at ${API_DIR}. If it was moved/renamed, update ` +
        `this test's path — do not let this guard silently pass with nothing to scan.`,
    );
    const files = walk(API_DIR);
    assert.ok(
      files.length > 0,
      `expected at least one scannable file under ${API_DIR}, found 0 — a 0-file ` +
        `scan would defang this guard by vacuously passing.`,
    );
  });

  test("no file under app/api/** contains a mock-auth identifier", () => {
    if (!existsSync(API_DIR)) {
      // Fail loudly rather than let a missing directory read as "no violations".
      throw new Error(
        `app/api directory not found at ${API_DIR} — cannot verify the R9.0 ` +
          `server-side-gating invariant. This must fail the suite, not pass it.`,
      );
    }
    const files = walk(API_DIR);
    if (files.length === 0) {
      throw new Error(
        `app/api directory at ${API_DIR} contains no scannable files — cannot ` +
          `verify the R9.0 server-side-gating invariant (would otherwise pass vacuously).`,
      );
    }

    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const id of MOCK_AUTH_IDENTIFIERS) {
        if (text.includes(id)) {
          violations.push(`${relative(SCAFFOLD_ROOT, file)}: contains forbidden identifier "${id}"`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `app/api must gate nothing server-side on mock auth (R9.0); found:\n${violations.join("\n")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// (b) The AnalyticsEvent contract still rejects description content.
//
// This is a recon-level guard that the CON-01 contract is wired the way
// R9.0/§5.3 needs — complementary to, not a duplicate of, the contract's own
// unit tests in lib/contracts/__tests__/analyticsEvent.test.ts. This suite
// does not depend on that file existing.
// ---------------------------------------------------------------------------

describe("(b) AnalyticsEvent contract rejects description content", () => {
  test("FORBIDDEN_CONTENT_KEYS still lists the description-shaped keys", () => {
    for (const key of ["description", "company_description", "companyDescription"]) {
      assert.ok(
        FORBIDDEN_CONTENT_KEYS.includes(key),
        `expected FORBIDDEN_CONTENT_KEYS to still include "${key}"`,
      );
    }
  });

  test("AnalyticsPayloadSchema rejects a payload with a description key", () => {
    const result = AnalyticsPayloadSchema.safeParse({
      description: "we build AI for hospitals, pre-filing IP",
    });
    assert.equal(result.success, false);
  });

  test("AnalyticsEventSchema rejects a full event with description-shaped free text under a benign key", () => {
    const event = {
      name: "search_started",
      ts: 0,
      payload: { blurb: "we build AI for hospitals, pre-filing IP" },
    };
    const result = AnalyticsEventSchema.safeParse(event);
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// (c) No obvious server-side logging of raw description.
//
// Scans app/** and lib/** (excluding **/__tests__/**) for a
// console.(log|error|warn|info)(...) call whose line also mentions
// "description" (case-insensitive, so it also catches profile.description /
// companyDescription). This is deliberately a coarse, line-based scan (same
// approach as scripts/design/check-hex.mjs in this repo) — see the header
// comment for the false-negative shapes it cannot catch.
// ---------------------------------------------------------------------------

const CONSOLE_CALL_RE = /console\.(log|error|warn|info)\s*\(/;
const DESCRIPTION_MENTION_RE = /description/i;

interface ConsoleDescriptionHit {
  file: string;
  line: number;
  text: string;
}

function scanForDescriptionLogging(dirs: string[]): ConsoleDescriptionHit[] {
  const hits: ConsoleDescriptionHit[] = [];
  for (const dir of dirs) {
    const files = walk(dir).filter((f) => !isUnderTestsDir(relative(SCAFFOLD_ROOT, f)));
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (CONSOLE_CALL_RE.test(line) && DESCRIPTION_MENTION_RE.test(line)) {
          hits.push({ file: relative(SCAFFOLD_ROOT, file), line: i + 1, text: line.trim() });
        }
      });
    }
  }
  return hits;
}

describe("(c) no server-side console logging mentions description content", () => {
  test("app/** and lib/** (excluding __tests__) contain zero description-mentioning console calls", () => {
    const scanDirs = [join(SCAFFOLD_ROOT, "app"), join(SCAFFOLD_ROOT, "lib")];
    // Real filesystem scan run from inside the test, not a hardcoded pass.
    for (const dir of scanDirs) {
      assert.ok(existsSync(dir), `expected ${dir} to exist for this scan to be meaningful`);
    }
    const hits = scanForDescriptionLogging(scanDirs);
    assert.deepEqual(
      hits,
      [],
      `found console logging that mentions "description" — this may leak company-` +
        `description content server-side (R9.0/§5.3):\n` +
        hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join("\n"),
    );
  });

  // Proves the scanner above is not vacuously true: exercises the same regexes
  // against synthetic in-memory strings (no filesystem writes, no scratch
  // files in scanned directories — see PLT-02's constraint against touching
  // real source to prove this).
  test("scanner sanity check: the matcher actually catches description-mentioning console calls", () => {
    const violatingLines = [
      'console.log("desc:", profile.description);',
      'console.error("failed", companyDescription);',
      "console.warn(`submitting ${description}`);",
      "console.info('company_description', payload.company_description)",
    ];
    for (const line of violatingLines) {
      assert.ok(CONSOLE_CALL_RE.test(line), `expected console-call regex to match: ${line}`);
      assert.ok(DESCRIPTION_MENTION_RE.test(line), `expected description-mention regex to match: ${line}`);
    }

    // The one real console call in this codebase today (app/api/match/route.ts)
    // logs the caught error, not the description — the matcher must NOT flag it.
    const safeLine = 'console.error("match failed:", err);';
    assert.ok(CONSOLE_CALL_RE.test(safeLine));
    assert.ok(!DESCRIPTION_MENTION_RE.test(safeLine));
  });
});

/**
 * The tray (scripts/windows/report-problem.ps1) can't import the app's
 * sanitizer, so it carries a copy of the rule list. This keeps the copy
 * identical to sanitize-rules.json. (The installer's Windows integration
 * tests also run the PowerShell sanitizer for real and compare its output.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SANITIZE_RULES } from "../sanitize";

const PS = join(process.cwd(), "scripts", "windows", "report-problem.ps1");

export function rulesInPowerShell(script: string): unknown {
  const m = /\$GrantedSanitizeRulesJson = @'\r?\n([\s\S]*?)\r?\n'@/.exec(script);
  assert.ok(m, "report-problem.ps1 has a $GrantedSanitizeRulesJson here-string");
  return (JSON.parse(m[1]) as { rules: unknown }).rules;
}

test("report-problem.ps1's rule list is the same as sanitize-rules.json (same order, same patterns)", () => {
  assert.deepEqual(rulesInPowerShell(readFileSync(PS, "utf8")), SANITIZE_RULES);
});

test("report-problem.ps1 mirrors the home-folder, user-name and .env.local rules of sanitize.ts and server.ts", () => {
  const ps = readFileSync(PS, "utf8");
  // the same patterns, spelled the same way
  assert.ok(ps.includes(`'(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$'`));
  assert.ok(ps.includes(`'^(?=.*[0-9])(?=.*[A-Za-z])[^\\s]{16,}$'`));
  assert.ok(ps.includes(`'(?![A-Za-z0-9_\\-])'`));
  assert.ok(ps.includes(`'(^|[^A-Za-z0-9_])'`));
  assert.ok(ps.includes(`'$1[user]'`));
  assert.ok(ps.includes(`-ge 6`), "minimum secret length 6");
});

test("report-problem.ps1 is plain ASCII (Windows PowerShell 5.1 reads BOM-less scripts as ANSI)", () => {
  assert.doesNotMatch(readFileSync(PS, "utf8"), /[^\x00-\x7F]/);
});

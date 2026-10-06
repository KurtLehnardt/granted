/**
 * The tray (scripts/windows/report-problem.ps1) can't import the app's
 * sanitizer, so it carries a copy of the shared settings. This keeps the copy
 * identical to sanitize-rules.json. (The installer's Windows integration
 * tests also run the PowerShell sanitizer for real and compare its output.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SANITIZE_SETTINGS } from "../sanitize";

const PS = join(process.cwd(), "scripts", "windows", "report-problem.ps1");

export function settingsInPowerShell(script: string): unknown {
  const m = /\$GrantedSanitizeRulesJson = @'\r?\n([\s\S]*?)\r?\n'@/.exec(script);
  assert.ok(m, "report-problem.ps1 has a $GrantedSanitizeRulesJson here-string");
  return JSON.parse(m[1]);
}

test("report-problem.ps1's settings are sanitize-rules.json's (same rules in the same order, env-name rules, public hosts)", () => {
  const { $comment: _comment, ...shared } = SANITIZE_SETTINGS as typeof SANITIZE_SETTINGS & { $comment?: string };
  assert.deepEqual(settingsInPowerShell(readFileSync(PS, "utf8")), shared);
});

test("report-problem.ps1 uses the shared env-name rules and the same home / user / host patterns as sanitize.ts", () => {
  const ps = readFileSync(PS, "utf8");
  assert.ok(ps.includes("$GrantedSanitize.secretEnvName"));
  assert.ok(ps.includes("$GrantedSanitize.settingEnvName"));
  assert.ok(ps.includes("$GrantedSanitize.tokenLikeValue"));
  assert.ok(ps.includes("$GrantedSanitize.publicHosts"));
  assert.ok(ps.includes(`'(?![A-Za-z0-9_\\-])'`), "home pattern");
  assert.ok(ps.includes(`'(^|[^A-Za-z0-9_])'`), "user pattern");
  assert.ok(ps.includes(`'$1[user]'`));
  assert.ok(ps.includes(`'(^|[^A-Za-z0-9.\\-])'`), "host pattern");
  assert.ok(ps.includes(`'(?![A-Za-z0-9\\-]|\\.[A-Za-z0-9])'`), "host pattern end");
  assert.ok(ps.includes(`-ge 6`), "minimum secret length 6");
  assert.ok(ps.includes(`"~/.fcc/proxy_auth_token"`), "fcc's default key file");
});

test("REGRESSION (review): the log tail and config files are read as UTF-8 (PS 5.1 would read them as ANSI)", () => {
  const ps = readFileSync(PS, "utf8");
  assert.match(ps, /Get-Content -LiteralPath \$LogPath -Tail \$TailLines -Encoding UTF8/);
  assert.doesNotMatch(ps, /ReadAllText\(\$Path\)/);
});

test("report-problem.ps1 opens the issue form, never labels=", () => {
  const ps = readFileSync(PS, "utf8");
  assert.match(ps, /template=bug_report\.yml/);
  assert.doesNotMatch(ps, /labels=/);
});

test("report-problem.ps1 is plain ASCII (Windows PowerShell 5.1 reads BOM-less scripts as ANSI)", () => {
  assert.doesNotMatch(readFileSync(PS, "utf8"), /[^\x00-\x7F]/);
});

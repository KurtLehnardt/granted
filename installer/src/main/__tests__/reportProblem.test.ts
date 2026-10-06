/**
 * The installer's "Report this problem" link, and its copy of the app's
 * sanitizing rules: identical to scaffold/lib/errorLog/sanitize-rules.json and
 * to the tray's copy in scaffold/scripts/windows/report-problem.ps1.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildInstallerIssueUrl, envFileSecrets, ISSUE_NEW_URL, SANITIZE_RULES, sanitize } from "../../shared/reportProblem";
import { installerIssueUrl } from "../reportProblem";

// `npm test` runs from installer/; the app lives in scaffold/.
const SCAFFOLD = resolve(process.cwd(), "..", "scaffold");
const RULES_JSON = join(SCAFFOLD, "lib", "errorLog", "sanitize-rules.json");
const TRAY_SCRIPT = join(SCAFFOLD, "scripts", "windows", "report-problem.ps1");

describe("the rule list is the app's", { skip: !existsSync(RULES_JSON) && "run from installer/" }, () => {
  test("same as scaffold/lib/errorLog/sanitize-rules.json", () => {
    assert.deepEqual(SANITIZE_RULES, JSON.parse(readFileSync(RULES_JSON, "utf8")).rules);
  });
  test("same as the tray's copy in report-problem.ps1", () => {
    const m = /\$GrantedSanitizeRulesJson = @'\r?\n([\s\S]*?)\r?\n'@/.exec(readFileSync(TRAY_SCRIPT, "utf8"));
    assert.ok(m);
    assert.deepEqual(JSON.parse(m[1]).rules, SANITIZE_RULES);
  });
});

describe("sanitize (installer copy)", () => {
  test("keys, emails, paths, user name, literal secrets", () => {
    const out = sanitize(
      "clone into C:\\Users\\Jane Doe\\granted failed for jane@example.com; ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAA; jdoe; zz-secret-zz",
      { home: "C:\\Users\\Jane Doe", user: "jdoe", secrets: ["zz-secret-zz"] },
    );
    assert.equal(out, "clone into ~\\granted failed for [email]; ANTHROPIC_API_KEY=[redacted]; [user]; [redacted]");
  });
  test("never throws", () => {
    for (const v of [undefined, null, 3, {}]) assert.doesNotThrow(() => sanitize(v));
  });
  test("envFileSecrets: keys yes, settings no", () => {
    assert.deepEqual(envFileSecrets("OPENAI_API_KEY=sk-x123\nLLM_PROVIDER=ollama\nEXA_API_KEY=\n"), ["sk-x123"]);
  });
});

describe("the issue link", () => {
  const deps = { version: "0.2.3", scaffoldDir: "C:\\nowhere", platform: "win32", home: "C:\\Users\\jane", user: "jane", readFile: () => "OPENAI_API_KEY=my-openai-key-from-env\n" };

  test("pre-filled with the sanitized error, version and OS; the bug label", () => {
    const url = new URL(
      installerIssueUrl("git clone failed in C:\\Users\\jane\\granted: auth for jane@example.com with my-openai-key-from-env", "install", deps),
    );
    assert.equal(`${url.origin}${url.pathname}`, ISSUE_NEW_URL);
    assert.equal(url.searchParams.get("labels"), "bug");
    assert.match(url.searchParams.get("title")!, /^Problem \(installer\): git clone failed/);
    const body = url.searchParams.get("body")!;
    assert.match(body, /Granted installer version: 0\.2\.3/);
    assert.match(body, /Operating system: win32/);
    assert.match(body, /Reported from: installer \(install\)/);
    assert.match(body, /git clone failed in ~\\granted: auth for \[email\] with \[redacted\]/);
    assert.doesNotMatch(decodeURIComponent(url.href), /jane|my-openai-key-from-env/);
    for (const heading of ["### What happened", "### Error ID", "### Environment", "### Recent errors"]) assert.ok(body.includes(heading));
  });

  test("never longer than ~7,000 characters", () => {
    const url = installerIssueUrl("x ".repeat(20_000), "install", deps);
    assert.ok(url.length <= 7000, String(url.length));
    assert.ok(buildInstallerIssueUrl({ message: "y".repeat(9000), version: "1", os: "w", where: "x", maxLength: 1000 }).length <= 1000);
  });

  test("odd input from the renderer is coerced", () => {
    const url = new URL(installerIssueUrl({ evil: true }, "<script>", deps));
    assert.match(url.searchParams.get("body")!, /Reported from: installer \(installer\)/);
  });
});

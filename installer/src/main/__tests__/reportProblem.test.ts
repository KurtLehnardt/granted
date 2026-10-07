/**
 * The installer's "Report this problem" link, and its copy of the app's
 * sanitizing settings: identical to scaffold/lib/errorLog/sanitize-rules.json
 * and to the tray's copy in scaffold/scripts/windows/report-problem.ps1.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildInstallerIssueUrl, envFileSecrets, ISSUE_NEW_URL, privateHosts, SANITIZE_SETTINGS, sanitize } from "../../shared/reportProblem";
import { installerIssueUrl } from "../reportProblem";

// `npm test` runs from installer/; the app lives in scaffold/.
const SCAFFOLD = resolve(process.cwd(), "..", "scaffold");
const RULES_JSON = join(SCAFFOLD, "lib", "errorLog", "sanitize-rules.json");
const TRAY_SCRIPT = join(SCAFFOLD, "scripts", "windows", "report-problem.ps1");

describe("the settings are the app's", { skip: !existsSync(RULES_JSON) && "run from installer/" }, () => {
  test("same as scaffold/lib/errorLog/sanitize-rules.json (all but its comment)", () => {
    const { $comment: _c, ...shared } = JSON.parse(readFileSync(RULES_JSON, "utf8")) as Record<string, unknown>;
    assert.deepEqual(SANITIZE_SETTINGS, shared);
  });
  test("same as the tray's copy in report-problem.ps1", () => {
    const m = /\$GrantedSanitizeRulesJson = @'\r?\n([\s\S]*?)\r?\n'@/.exec(readFileSync(TRAY_SCRIPT, "utf8"));
    assert.ok(m);
    assert.deepEqual(JSON.parse(m[1]), SANITIZE_SETTINGS);
  });
});

describe("sanitize (installer copy)", () => {
  test("keys, emails, paths, user name, literal secrets, private hosts", () => {
    const out = sanitize(
      "clone into C:\\Users\\Jane Doe\\OneDrive - Contoso\\granted failed for jane@example.com; ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAA; jdoe; zz-secret-zz; https://git.acme.example/x",
      { home: "C:\\Users\\Jane Doe", user: "jdoe", secrets: ["zz-secret-zz"], hosts: ["git.acme.example"] },
    );
    assert.equal(out, "clone into ~\\OneDrive\\granted failed for [email]; ANTHROPIC_API_KEY=[redacted]; [user]; [redacted]; https://[private-host]/x");
  });
  test("never throws", () => {
    for (const v of [undefined, null, 3, {}]) assert.doesNotThrow(() => sanitize(v));
  });
  test("envFileSecrets: keys yes; ordinary settings no, however token-like (review of #286)", () => {
    const env = [
      "OPENAI_API_KEY=sk-x123",
      "LLM_PROVIDER=ollama",
      "EXA_API_KEY=",
      "OLLAMA_BASE_URL=http://127.0.0.1:11434",
      "LOCAL_LLM_MODEL=qwen2.5-coder:32b-instruct-q4",
      "SEARCH_EMBEDDINGS_X=abc123def456ghi789",
      "SOME_ID=a1b2c3d4e5f6g7h8i9j0",
    ].join("\n");
    assert.deepEqual(envFileSecrets(env), ["sk-x123", "a1b2c3d4e5f6g7h8i9j0"]);
  });
  test("privateHosts: loopback and public provider hosts stay", () => {
    assert.deepEqual(privateHosts(["http://127.0.0.1:11434", "https://api.openai.com/v1", "http://gpu-box.lan:8080"]), ["gpu-box.lan"]);
  });
});

describe("the issue link", () => {
  const deps = {
    version: "0.2.3",
    scaffoldDir: "C:\\nowhere",
    platform: "win32",
    home: "C:\\Users\\jane",
    user: "jane",
    readFile: () => "OPENAI_API_KEY=my-openai-key-from-env\nEMBEDDINGS_BASE_URL=http://embed.acme.internal:9000/v1\n",
  };

  test("opens the bug_report.yml form, filled with the sanitized error, version and OS", () => {
    const url = new URL(
      installerIssueUrl(
        "git clone failed in C:\\Users\\jane\\granted: auth for jane@example.com with my-openai-key-from-env via embed.acme.internal",
        "install",
        deps,
      ),
    );
    assert.equal(`${url.origin}${url.pathname}`, ISSUE_NEW_URL);
    assert.equal(url.searchParams.get("template"), "bug_report.yml");
    assert.equal(url.searchParams.get("labels"), null, "the form applies the label");
    assert.match(url.searchParams.get("title")!, /^Problem \(installer\): git clone failed/);
    const env = url.searchParams.get("environment")!;
    assert.match(env, /Granted installer version: 0\.2\.3/);
    assert.match(env, /Operating system: win32/);
    assert.match(env, /Reported from: installer \(install\)/);
    assert.match(url.searchParams.get("recent-errors")!, /git clone failed in ~\\granted: auth for \[email\] with \[redacted\] via \[private-host\]/);
    assert.doesNotMatch(decodeURIComponent(url.href), /jane|my-openai-key-from-env|acme/);
  });

  test("never longer than ~7,000 characters", () => {
    const url = installerIssueUrl("x ".repeat(20_000), "install", deps);
    assert.ok(url.length <= 7000, String(url.length));
    assert.ok(buildInstallerIssueUrl({ message: "y".repeat(9000), version: "1", os: "w", where: "x", maxLength: 1000 }).length <= 1000);
  });

  test("odd input from the renderer is coerced", () => {
    const url = new URL(installerIssueUrl({ evil: true }, "<script>", deps));
    assert.match(url.searchParams.get("environment")!, /Reported from: installer \(installer\)/);
  });
});

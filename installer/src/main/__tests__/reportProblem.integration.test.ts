/**
 * Integration: the tray's "Report a problem" (scaffold/scripts/windows/
 * report-problem.ps1), run by a real powershell.exe. Its PowerShell
 * sanitizer must give exactly what the app's (TypeScript) one gives on the
 * same text, and the link it builds must be a short, secret-free GitHub
 * new-issue link. Windows only (on CI: the installer-windows job).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ISSUE_NEW_URL, sanitize } from "../../shared/reportProblem";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve(process.cwd(), "..", "scaffold", "scripts", "windows", "report-problem.ps1");
const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT];

const HOME = "C:\\Users\\Jane Doe";
const USER = "jdoe";
const ENV_LOCAL = "OPENAI_API_KEY=sk-proj-envlocalvalue1234567\nLLM_PROVIDER=ollama\nCUSTOM_PROVIDER_KEY=plainsecret99\nSEARCH_EMBEDDINGS=builtin\n";
const ENV_SECRETS = ["sk-proj-envlocalvalue1234567", "plainsecret99"];

// One case per line; the whole file is compared at once (line endings included).
const SAMPLES = [
  "Error: ENOENT: no such file, open 'C:\\Users\\Jane Doe\\granted\\scaffold\\data\\local\\x.json'",
  "    at Object.openSync (node:fs:573:3) C:/Users/Jane Doe/AppData/Local/Granted/logs",
  "401 Unauthorized: Incorrect API key provided: sk-proj-AbCdEfGhIjKlMnOpQrSt1234 (anthropic sk-ant-api03-Zzzzzzzzzzzzzzzz)",
  "GET https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyA1234567890abcdefghijkl&alt=sse 403",
  "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig and Basic dXNlcjpwYXNzd29yZA==",
  "groq gsk_abcdefghijklmnopqrstuvwx xai-abcdefghijklmnopqrstuvwx hf_abcdefghijklmnopqrstuvwx ghp_abcdefghijklmnopqrstuvwxyz0123",
  "contact jane.doe+granted@mail.example.co.uk or ops@example.com",
  'x-api-key: plainsecretvalue {"apiKey":"abcdefgh","model":"m"} password=hunter22',
  "OPENAI_API_KEY=whatever GITHUB_TOKEN = abcdef proxy https://bob:s3cr3t@proxy.example:8080/",
  "jdoe started /home/jdoe/x and /Users/jdoe/y; JDOE again; jdoe2 stays",
  "the .env.local values sk-proj-envlocalvalue1234567 and plainsecret99 go too",
  "ordinary words stay: The search didn't complete. Please try again. task-runner sk8 monkey=1",
  "D:\\Users\\someone\\x and c:\\users\\other\\y and C:\\Users\\Jane Doe",
  "",
].join("\r\n");

describe("report-problem.ps1, run for real", { skip: (process.platform !== "win32" || !existsSync(SCRIPT)) && "Windows only, run from installer/" }, () => {
  let root: string;
  let scaffold: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "granted-report-"));
    scaffold = join(root, "scaffold");
    mkdirSync(join(scaffold, "data", "local"), { recursive: true });
    await writeFile(join(scaffold, ".env.local"), ENV_LOCAL);
    await writeFile(join(scaffold, "package.json"), JSON.stringify({ name: "granted", version: "0.2.3" }));
    await writeFile(join(scaffold, "data", "local", "llm-config.json"), JSON.stringify({ provider: "cloud", cloud: { providerId: "gemini", keySource: { type: "inline", key: "saved-gemini-key-777" } } }));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test("the PowerShell sanitizer gives exactly what the app's gives", async () => {
    const input = join(root, "in.txt");
    const output = join(root, "out.txt");
    await writeFile(input, SAMPLES, "utf8");
    await execFileAsync("powershell.exe", [...PS, "-SanitizeFile", input, "-OutFile", output, "-ScaffoldDir", scaffold, "-HomeDir", HOME, "-UserName", USER], {
      windowsHide: true,
      timeout: 60_000,
    });
    const fromPowerShell = await readFile(output, "utf8");
    const fromApp = sanitize(SAMPLES, { home: HOME, user: USER, secrets: [...ENV_SECRETS, "saved-gemini-key-777"] });
    const ps = fromPowerShell.split("\r\n");
    const ts = fromApp.split("\r\n");
    ps.forEach((line, i) => assert.equal(line, ts[i], `line ${i + 1}`));
    assert.equal(fromPowerShell, fromApp);
    for (const leak of ["Jane Doe", "sk-proj-", "sk-ant-api03", "AIzaSy", "jane.doe", "hunter22", "envlocalvalue", "plainsecret99", "s3cr3t", "eyJhbGci"]) {
      assert.ok(!fromPowerShell.includes(leak), `leaked ${leak}`);
    }
    assert.match(fromPowerShell, /ordinary words stay: The search didn't complete/);
  });

  test("the tray's link: the sanitized log tail, version and setup, under 7,000 characters", async () => {
    const log = join(root, "server-3000.log");
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} GET /api/match 500 for C:\\Users\\Jane Doe\\granted with sk-ant-api03-Zzzzzzzzzzzzzzzz`);
    lines.push("the last line: saved-gemini-key-777 jane@example.com");
    await writeFile(log, lines.join("\r\n"), "utf8");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [...PS, "-LogPath", log, "-ScaffoldDir", scaffold, "-HomeDir", HOME, "-UserName", USER, "-PrintUrl"],
      { windowsHide: true, timeout: 60_000 },
    );
    const href = stdout.trim();
    assert.ok(href.startsWith(`${ISSUE_NEW_URL}?`), href.slice(0, 100));
    assert.ok(href.length <= 7000, String(href.length));
    const url = new URL(href);
    assert.equal(url.searchParams.get("labels"), "bug");
    assert.match(url.searchParams.get("title")!, /Problem \(tray\)/);
    const body = url.searchParams.get("body")!;
    assert.match(body, /Granted version: 0\.2\.3/);
    assert.match(body, /Operating system: win32/);
    assert.match(body, /Model provider: cloud \(gemini\)/);
    assert.match(body, /Search mode: builtin/);
    assert.match(body, /Reported from: tray/);
    // The newest lines are kept; older ones were left out, and it says so.
    assert.match(body, /the last line: \[redacted\] \[email\]/);
    assert.doesNotMatch(body, /line 0 GET/);
    assert.match(body, /earlier line\(s\) were left out/);
    const decoded = decodeURIComponent(href);
    for (const leak of ["Jane Doe", "sk-ant-api03", "saved-gemini-key-777", "jane@example.com"]) assert.ok(!decoded.includes(leak), `leaked ${leak}`);
  });

  test("no server log yet: still a usable link", async () => {
    const { stdout } = await execFileAsync("powershell.exe", [...PS, "-LogPath", join(root, "missing.log"), "-ScaffoldDir", scaffold, "-PrintUrl"], {
      windowsHide: true,
      timeout: 60_000,
    });
    const body = new URL(stdout.trim()).searchParams.get("body")!;
    assert.match(body, /The server log is empty/);
  });
});

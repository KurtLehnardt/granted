/**
 * Integration: the tray's "Report a problem" (scaffold/scripts/windows/
 * report-problem.ps1), run by a real powershell.exe. Its PowerShell
 * sanitizer must give exactly what the app's (TypeScript) one gives on the
 * same text, with the same secrets and private hosts found the same way, and
 * the link it builds must be a short, secret-free link to the issue form.
 * Windows only (on CI: the installer-windows job).
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

// REGRESSION (review of #286): a non-ASCII user name and folder. Windows
// PowerShell 5.1 reads BOM-less files as ANSI, which turned José into JosÃ©,
// and then nothing matched it.
const HOME = "C:\\Users\\José Núñez";
const USER = "José";
const KEY_VAR = "GRANTED_TEST_ODD_KEY_VAR";
const KEY_FROM_VAR = "key-from-an-oddly-named-var-42";
const ENV_LOCAL = [
  "OPENAI_API_KEY=sk-proj-envlocalvalue1234567",
  "LLM_PROVIDER=anthropic",
  "CUSTOM_PROVIDER_KEY=plainsecret99",
  "SEARCH_EMBEDDINGS=builtin",
  "OLLAMA_BASE_URL=http://127.0.0.1:11434",
  "LOCAL_LLM_MODEL=qwen2.5-coder:32b-instruct-q4",
  "EMBEDDINGS_BASE_URL=http://embed-box.acme.example:9000/v1",
  "",
].join("\n");
const SECRETS = ["sk-proj-envlocalvalue1234567", "plainsecret99", KEY_FROM_VAR];
const HOSTS = ["embed-box.acme.example", "llm.private-co.example"];

// One case per line; the whole file is compared at once (line endings included).
const SAMPLES = [
  "Error: ENOENT: no such file, open 'C:\\Users\\José Núñez\\granted\\scaffold\\data\\local\\x.json'",
  "    at Object.openSync (node:fs:573:3) C:/Users/José Núñez/AppData/Local/Granted/logs",
  "José started it; JOSÉ again; Josélito stays",
  "401 Unauthorized: Incorrect API key provided: sk-proj-AbCdEfGhIjKlMnOpQrSt1234 (anthropic sk-ant-api03-Zzzzzzzzzzzzzzzz)",
  "GET https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyA1234567890abcdefghijkl&alt=sse 403",
  "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig and Basic dXNlcjpwYXNzd29yZA== and Authorization: Token abcdef123456",
  'groq gsk_abcdefghijklmnopqrstuvwx {"token":"opaque123456","secret":"s3cr3tvalue"} hf_abcdefghijklmnopqrstuvwx',
  "contact jane.doe+granted@mail.example.co.uk or ops@example.com",
  'x-api-key: plainsecretvalue {"apiKey":"abcdefgh","model":"m"} password=hunter22',
  "OPENAI_API_KEY=whatever GITHUB_TOKEN = abcdef proxy https://bob:s3cr3t@proxy.example:8080/",
  `the configured keys go too: sk-proj-envlocalvalue1234567, plainsecret99, ${KEY_FROM_VAR}`,
  "fetch http://embed-box.acme.example:9000/v1 and https://llm.private-co.example/v1/chat failed; http://192.168.1.20:11434 and https://box.lan/x",
  "kept: http://127.0.0.1:11434 https://api.openai.com/v1 qwen2.5-coder:32b-instruct-q4 max_tokens: 4096",
  "C:\\Users\\José Núñez\\OneDrive - Contoso Ltd\\Documents\\granted",
  "ordinary words stay: The search didn't complete. Please try again. task-runner sk8 monkey=1",
  "",
].join("\r\n");

describe("report-problem.ps1, run for real", { skip: (process.platform !== "win32" || !existsSync(SCRIPT)) && "Windows only, run from installer/" }, () => {
  let root: string;

  async function makeScaffold(name: string, files: Record<string, string>): Promise<string> {
    const dir = join(root, name, "scaffold");
    mkdirSync(join(dir, "data", "local"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "granted", version: "0.2.3" }));
    for (const [f, text] of Object.entries(files)) await writeFile(join(dir, f), text, "utf8");
    return dir;
  }

  const run = (args: string[]) =>
    execFileAsync("powershell.exe", [...PS, ...args], {
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, [KEY_VAR]: KEY_FROM_VAR },
    });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "granted-report-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test("the PowerShell sanitizer gives exactly what the app's gives (secrets from any key source, private hosts, non-ASCII names)", async () => {
    const scaffold = await makeScaffold("parity", {
      ".env.local": ENV_LOCAL,
      "data/local/llm-config.json": JSON.stringify({
        provider: "cloud",
        cloud: { providerId: "other", baseUrl: "https://llm.private-co.example/v1", keySource: { type: "env", name: KEY_VAR } },
      }),
    });
    const input = join(root, "in.txt");
    const output = join(root, "out.txt");
    await writeFile(input, SAMPLES, "utf8");
    await run(["-SanitizeFile", input, "-OutFile", output, "-ScaffoldDir", scaffold, "-HomeDir", HOME, "-UserName", USER]);
    const fromPowerShell = await readFile(output, "utf8");
    const fromApp = sanitize(SAMPLES, { home: HOME, user: USER, secrets: SECRETS, hosts: HOSTS });
    const ps = fromPowerShell.split("\r\n");
    const ts = fromApp.split("\r\n");
    ps.forEach((line, i) => assert.equal(line, ts[i], `line ${i + 1}`));
    assert.equal(fromPowerShell, fromApp);
    for (const leak of [
      "José", "JOSÉ", "Núñez", "sk-proj-", "sk-ant-api03", "AIzaSy", "jane.doe", "hunter22", "envlocalvalue", "plainsecret99",
      KEY_FROM_VAR, "s3cr3t", "eyJhbGci", "acme", "private-co", "192.168", "box.lan", "Contoso", "opaque123456",
    ]) {
      // "Josélito" is a different word and rightly stays: ignore it when looking for "José".
      assert.ok(!fromPowerShell.replace("Josélito", "").includes(leak), `leaked ${leak}`);
    }
    assert.match(fromPowerShell, /Josélito stays/);
    assert.match(fromPowerShell, /kept: http:\/\/127\.0\.0\.1:11434 https:\/\/api\.openai\.com\/v1 qwen2\.5-coder:32b-instruct-q4 max_tokens: 4096/);
    assert.match(fromPowerShell, /~\\OneDrive\\Documents\\granted/);
  });

  test("the tray's link: the issue form, the sanitized UTF-8 log tail, and the setup in the app's words, under 7,000 characters", async () => {
    const keyFile = join(root, "proxy_auth_token");
    await writeFile(keyFile, "fcc-proxy-token-from-file-1\n");
    const scaffold = await makeScaffold("tail", {
      ".env.local": "LLM_PROVIDER=anthropic\n",
      "data/local/llm-config.json": JSON.stringify({ provider: "cloud", cloud: { providerId: "fcc", baseUrl: "http://127.0.0.1:8082", keySource: { type: "file", path: keyFile } } }),
    });
    const log = join(root, "server-3000.log");
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} GET /api/match 500 for C:\\Users\\José Núñez\\granted with sk-ant-api03-Zzzzzzzzzzzzzzzz`);
    lines.push("José saw: fcc-proxy-token-from-file-1 rejected for jane@example.com");
    await writeFile(log, lines.join("\r\n"), "utf8");
    const { stdout } = await run(["-LogPath", log, "-ScaffoldDir", scaffold, "-HomeDir", HOME, "-UserName", USER, "-PrintUrl"]);
    const href = stdout.trim();
    assert.ok(href.startsWith(`${ISSUE_NEW_URL}?template=bug_report.yml&`), href.slice(0, 120));
    assert.ok(href.length <= 7000, String(href.length));
    const url = new URL(href);
    assert.equal(url.searchParams.get("labels"), null);
    assert.match(url.searchParams.get("title")!, /Problem \(tray\)/);
    const env = url.searchParams.get("environment")!;
    assert.match(env, /Granted version: 0\.2\.3/);
    assert.match(env, /Operating system: win32/);
    assert.match(env, /Model provider: cloud \(fcc\)/);
    assert.match(env, /Search mode: builtin/);
    assert.match(env, /Reported from: tray/);
    const recent = url.searchParams.get("recent-errors")!;
    // The newest lines are kept; older ones were left out, and it says so.
    assert.match(recent, /\[user\] saw: \[redacted\] rejected for \[email\]/);
    assert.doesNotMatch(recent, /line 0 GET/);
    assert.match(recent, /earlier line\(s\) were left out/);
    const decoded = decodeURIComponent(href);
    for (const leak of ["Jos", "Núñez", "sk-ant-api03", "fcc-proxy-token-from-file-1", "jane@example.com"]) assert.ok(!decoded.includes(leak), `leaked ${leak}`);
  });

  test("the setup in the app's words: cloud (not set up), and the search mode actually in effect", async () => {
    const cases: Array<[string, string, RegExp, RegExp]> = [
      ["nothing", "", /Model provider: cloud \(not set up\)/, /Search mode: builtin/],
      ["openai", "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz\n", /Model provider: cloud \(openai\)/, /Search mode: openai/],
      ["local", "LLM_PROVIDER=ollama\nOPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz\n", /Model provider: local \(Ollama\)/, /Search mode: builtin/],
      ["custom", "EMBEDDINGS_BASE_URL=http://localhost:8080/v1\n", /Model provider: cloud \(not set up\)/, /Search mode: custom/],
    ];
    for (const [name, envLocal, provider, search] of cases) {
      const scaffold = await makeScaffold(`ctx-${name}`, { ".env.local": envLocal });
      const { stdout } = await run(["-LogPath", join(root, "missing.log"), "-ScaffoldDir", scaffold, "-PrintUrl"]);
      const env = new URL(stdout.trim()).searchParams.get("environment")!;
      assert.match(env, provider, name);
      assert.match(env, search, name);
    }
  });

  test("no server log yet: still a usable link", async () => {
    const scaffold = await makeScaffold("nolog", {});
    const { stdout } = await run(["-LogPath", join(root, "missing.log"), "-ScaffoldDir", scaffold, "-PrintUrl"]);
    assert.match(new URL(stdout.trim()).searchParams.get("recent-errors")!, /The server log is empty/);
  });
});

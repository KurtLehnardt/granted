import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLogsGet, handleLogsPost, logAsText, MAX_LOG_BODY_BYTES, type LogsDeps, type LogsSummary } from "../handler";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { logError } from "@/lib/errorLog/server";
import { readErrorEntries } from "@/lib/errorLog/store";

// Real loopback check, real logError and store (in a temp folder): only the
// computer-specific bits are pinned.
let dir: string;
const saved = process.env["GRANTED_LOG_DIR"];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "granted-api-logs-"));
  process.env["GRANTED_LOG_DIR"] = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env["GRANTED_LOG_DIR"];
  else process.env["GRANTED_LOG_DIR"] = saved;
  rmSync(dir, { recursive: true, force: true });
});

const LOCAL = { "x-forwarded-for": "127.0.0.1", host: "localhost:3000", "sec-fetch-site": "same-origin" };

function req(method: "GET" | "POST", path: string, body?: string, headers: Record<string, string> = LOCAL) {
  return new Request(`http://localhost:3000${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body });
}

const opened: string[] = [];
const deps = (over: Partial<LogsDeps> = {}): Partial<LogsDeps> => ({
  issueContext: () => ({ version: "0.2.3", os: "win32 10 x64", provider: "local (Ollama)", searchMode: "builtin" }),
  sanitizeContext: () => ({ home: "C:\\Users\\kurt", user: "kurt", secrets: ["dot-env-local-secret"] }),
  logDir: () => dir,
  openFolder: (d) => (opened.push(d), true),
  platform: "win32",
  allowClientLog: () => true,
  ...over,
});

const post = (body: unknown, over: Partial<LogsDeps> = {}, headers?: Record<string, string>) =>
  handleLogsPost(req("POST", "/api/logs", typeof body === "string" ? body : JSON.stringify(body), headers), deps(over));

describe("loopback only", () => {
  const remote = { "x-forwarded-for": "192.168.1.20", host: "192.168.1.5:3000" };
  const crossSite = { "x-forwarded-for": "127.0.0.1", host: "localhost:3000", "sec-fetch-site": "cross-site", origin: "https://evil.example" };
  for (const [name, headers] of [["another computer", remote], ["another website", crossSite]] as const) {
    test(`${name}: GET and POST are refused`, async () => {
      assert.equal((await handleLogsGet(req("GET", "/api/logs", undefined, headers), deps())).status, 403);
      assert.equal((await post({ action: "log", entry: { message: "x" } }, {}, headers)).status, 403);
      assert.equal((await post({ action: "clear" }, {}, headers)).status, 403);
      assert.equal(readErrorEntries().length, 0);
    });
  }
  test("the real loopback check is the default", () => {
    assert.equal(isLoopbackRequest(req("GET", "/api/logs")), true);
  });
});

describe("POST action=log (errors the page hit)", () => {
  test("stored sanitized, with this computer's own secrets and paths removed too", async () => {
    const res = await post({
      action: "log",
      entry: {
        id: "E-ABCDEF",
        area: "search",
        message: "fetch failed for kurt@example.com: sk-ant-api03-QQQQQQQQQQQQQQQQ",
        stack: "TypeError: x\n    at run (C:\\Users\\kurt\\granted\\scaffold\\components\\IntakeForm.tsx:1:1)",
        path: "/",
      },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: "E-ABCDEF" });
    const [e] = readErrorEntries();
    assert.equal(e.source, "client");
    assert.equal(e.area, "search");
    assert.equal(e.message, "fetch failed for [email]: [redacted-key]");
    assert.match(e.stack!, /at run \(~\\granted/);
    assert.doesNotMatch(JSON.stringify(e), /kurt|QQQQ/);
  });

  test("an invalid id or area is replaced", async () => {
    const res = await post({ action: "log", entry: { id: "<img>", area: "../../x", message: "m" } });
    const { id } = await res.json();
    assert.match(id, /^E-[A-Z0-9]{6}$/);
    assert.equal(readErrorEntries()[0].area, "unknown");
  });

  test("size limits: a body over 16 KB is refused, by header or by actual size", async () => {
    const big = JSON.stringify({ action: "log", entry: { message: "x".repeat(MAX_LOG_BODY_BYTES) } });
    assert.equal((await post(big)).status, 413);
    const lying = { ...LOCAL, "content-length": String(MAX_LOG_BODY_BYTES + 1) };
    assert.equal((await post({ action: "log", entry: { message: "small" } }, {}, lying)).status, 413);
    assert.equal(readErrorEntries().length, 0);
  });

  test("long fields are cut before storing", async () => {
    await post({ action: "log", entry: { message: "m".repeat(5000), stack: "    at x (y.js:1:1)\n".repeat(400), path: "/p".repeat(500) } });
    const [e] = readErrorEntries();
    assert.ok(e.message.length <= 2000);
    assert.ok((e.stack ?? "").split("\n").length <= 8);
    assert.ok((e.path ?? "").length <= 200);
  });

  test("bad requests", async () => {
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post({ action: "log" })).status, 400);
    assert.equal((await post({ action: "log", entry: { message: "" } })).status, 400);
    assert.equal((await post({ action: "nope" })).status, 400);
  });

  test("rate limited (an error loop can't flood the log)", async () => {
    const res = await post({ action: "log", entry: { message: "m" } }, { allowClientLog: () => false });
    assert.equal(res.status, 429);
    assert.equal(readErrorEntries().length, 0);
  });
});

describe("GET (Settings → Problems & logs)", () => {
  test("counts, the newest five first, and a report link pre-filled for an error", async () => {
    for (let i = 0; i < 7; i++) logError("search", `failure ${i} for kurt@example.com`);
    const id = logError("llm-provider", "provider said no", { id: "E-QWERTY" });
    const res = await handleLogsGet(req("GET", `/api/logs?issue=${id}`), deps({ now: () => Date.now() }));
    const s = (await res.json()) as LogsSummary;
    assert.equal(s.count, 8);
    assert.equal(s.recentCount, 8);
    assert.equal(s.recent.length, 5);
    assert.equal(s.recent[0].id, "E-QWERTY");
    assert.equal(s.recent[1].message, "failure 6 for [email]");
    assert.equal(s.logDir, dir);
    assert.equal(s.canOpenFolder, true);
    const url = new URL(s.issueUrl);
    assert.equal(url.origin + url.pathname, "https://github.com/KurtLehnardt/granted/issues/new");
    assert.match(url.searchParams.get("title")!, /E-QWERTY/);
    const body = url.searchParams.get("body")!;
    assert.match(body, /Model provider: local \(Ollama\)/);
    assert.match(body, /Search mode: builtin/);
    assert.ok(body.indexOf("provider said no") < body.indexOf("failure 6"), "the asked-about error goes first");
    assert.doesNotMatch(body, /kurt@example\.com/);
    assert.ok(s.issueUrl.length <= 7000);
  });

  test("old errors aren't counted as recent", async () => {
    logError("search", "x");
    const s = (await (await handleLogsGet(req("GET", "/api/logs"), deps({ now: () => Date.now() + 8 * 86_400_000 }))).json()) as LogsSummary;
    assert.equal(s.count, 1);
    assert.equal(s.recentCount, 0);
  });

  test("an empty log", async () => {
    const s = (await (await handleLogsGet(req("GET", "/api/logs"), deps())).json()) as LogsSummary;
    assert.equal(s.count, 0);
    assert.deepEqual(s.recent, []);
    assert.match(s.issueUrl, /^https:\/\/github\.com\/KurtLehnardt\/granted\/issues\/new\?/);
  });

  test("format=text: the whole log for Copy log, newest first, sanitized again on the way out", async () => {
    logError("search", "first");
    logError("search", "second");
    const res = await handleLogsGet(req("GET", "/api/logs?format=text"), deps());
    assert.match(res.headers.get("content-type")!, /^text\/plain/);
    const text = await res.text();
    assert.ok(text.indexOf("second") < text.indexOf("first"));
    assert.match(text, /Granted 0\.2\.3/);
    assert.match(logAsText([], {}), /0 errors/);
  });

  test("sanitized again on the way out, with today's secrets (e.g. a key added to .env.local since)", async () => {
    logError("search", "provider rejected dot-env-local-secret for kurt");
    const s = (await (await handleLogsGet(req("GET", "/api/logs"), deps())).json()) as LogsSummary;
    assert.equal(s.recent[0].message, "provider rejected [redacted] for [user]");
    assert.doesNotMatch(decodeURIComponent(s.issueUrl), /dot-env-local-secret|kurt/);
  });

  test("the dedupe key never leaves the server", async () => {
    logError("app-update", "x", { once: "update-status:secret-ish" });
    const s = (await (await handleLogsGet(req("GET", "/api/logs"), deps())).json()) as LogsSummary;
    assert.equal((s.recent[0] as Record<string, unknown>)["key"], undefined);
  });
});

describe("POST clear / open-folder", () => {
  test("clear empties the log", async () => {
    logError("search", "x");
    assert.deepEqual(await (await post({ action: "clear" })).json(), { cleared: true });
    assert.equal(readErrorEntries().length, 0);
  });

  test("open-folder: Explorer on Windows; elsewhere just the path", async () => {
    opened.length = 0;
    assert.deepEqual(await (await post({ action: "open-folder" })).json(), { opened: true, path: dir });
    assert.deepEqual(opened, [dir]);
    assert.deepEqual(await (await post({ action: "open-folder" }, { platform: "darwin" })).json(), { opened: false, path: dir });
    assert.equal(opened.length, 1);
  });
});

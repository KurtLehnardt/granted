import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleOllamaActionPost, handleOllamaStatusGet, type OllamaRouteDeps } from "../handler";
import { getOllamaStatus } from "@/lib/llm/ollamaStatus";
import { getOllamaJobs, installOllama, pullModel, resetOllamaJobs, startOllama } from "@/lib/llm/ollamaJobs";
import { startMockOllama, type MockOllama } from "@/lib/llm/__tests__/mockOllama";

/**
 * GET/POST /api/llm/ollama against a stand-in Ollama on a random local port
 * (LLM_BASE_URL points there). Nothing here touches a real Ollama, winget or
 * the network.
 */

const savedBaseUrl = process.env.LLM_BASE_URL;
const savedModel = process.env.LOCAL_LLM_MODEL;
let mock: MockOllama | undefined;

beforeEach(() => {
  resetOllamaJobs();
  delete process.env.LOCAL_LLM_MODEL;
});

afterEach(async () => {
  await mock?.close();
  mock = undefined;
  resetOllamaJobs();
  if (savedBaseUrl === undefined) delete process.env.LLM_BASE_URL;
  else process.env.LLM_BASE_URL = savedBaseUrl;
  if (savedModel === undefined) delete process.env.LOCAL_LLM_MODEL;
  else process.env.LOCAL_LLM_MODEL = savedModel;
});

async function useMock(models: MockOllama["models"], opts?: { listening?: boolean }) {
  mock = await startMockOllama(models, opts);
  process.env.LLM_BASE_URL = `${mock.host}/v1`;
  return mock;
}

/** Real status + jobs against the mock, with the machine-specific probes pinned. */
function deps(over: Partial<OllamaRouteDeps> = {}): Partial<OllamaRouteDeps> {
  return {
    isLoopbackRequest: () => true,
    getStatus: () => getOllamaStatus({ detectInstalled: () => true, hasWinget: () => false, memGB: () => 16, platform: "linux" }),
    start: () => startOllama({ launch: () => void mock!.listen(), startTimeoutMs: 5_000, pollIntervalMs: 25 }),
    pull: (model) => pullModel(model),
    platform: "linux",
    ...over,
  };
}

function post(body: unknown) {
  return { headers: { get: () => null }, json: async () => body };
}

async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("GET /api/llm/ollama — tags", () => {
  test("running: chat models with sizes, embedding models apart, default model, recommendation", async () => {
    await useMock([
      { name: "llama3.2:1b", details: { parameter_size: "1.2B", family: "llama" } },
      { name: "nomic-embed-text:latest", details: { parameter_size: "137M", family: "nomic-bert" } },
    ]);
    const j = await (await handleOllamaStatusGet(deps())).json();
    assert.equal(j.running, true);
    assert.equal(j.isOllama, true);
    assert.deepEqual(j.chatModels, [{ name: "llama3.2:1b", paramsB: 1.2 }]);
    assert.deepEqual(j.embeddingModels, ["nomic-embed-text:latest"]);
    // gemma4:latest (the configured default) isn't installed: Default runs the installed chat model.
    assert.equal(j.configuredModel, "gemma4:latest");
    assert.equal(j.defaultModel, "llama3.2:1b");
    assert.equal(j.recommended.model, "qwen2.5:7b");
    assert.equal(j.canManage, true);
    assert.equal(j.install.auto, null);
    assert.match(j.install.command, /install\.sh/);
  });

  test("not running: running:false, installed per the probe", async () => {
    await useMock([], { listening: false });
    const j = await (await handleOllamaStatusGet(deps())).json();
    assert.equal(j.running, false);
    assert.equal(j.installed, true);
    const notInstalled = await (
      await handleOllamaStatusGet(deps({ getStatus: () => getOllamaStatus({ detectInstalled: () => false, hasWinget: () => true, platform: "win32" }) }))
    ).json();
    assert.equal(notInstalled.installed, false);
    assert.equal(notInstalled.install.auto, "winget");
  });
});

describe("POST /api/llm/ollama — start", () => {
  test("a stopped daemon is launched (setup-local's launcher, injected) and reported running", async () => {
    await useMock([{ name: "llama3.2:1b" }], { listening: false });
    let launched = 0;
    const res = await handleOllamaActionPost(
      post({ action: "start" }),
      deps({ start: () => startOllama({ launch: () => { launched++; void mock!.listen(); }, startTimeoutMs: 5_000, pollIntervalMs: 25 }) }),
    );
    assert.equal(res.status, 202);
    await until(() => getOllamaJobs().start?.status === "done");
    assert.equal(launched, 1);
    const j = await (await handleOllamaStatusGet(deps())).json();
    assert.equal(j.running, true);
    assert.equal(j.jobs.start.status, "done");
  });

  test("a daemon that never answers -> an error that says what to do", async () => {
    await useMock([], { listening: false });
    await handleOllamaActionPost(post({ action: "start" }), deps({ start: () => startOllama({ launch: () => {}, startTimeoutMs: 100, pollIntervalMs: 20 }) }));
    await until(() => getOllamaJobs().start?.status === "error");
    assert.match(getOllamaJobs().start!.error!, /didn't start/);
  });

  test("not installed -> 400, nothing launched", async () => {
    await useMock([], { listening: false });
    const res = await handleOllamaActionPost(
      post({ action: "start" }),
      deps({ getStatus: () => getOllamaStatus({ detectInstalled: () => false, hasWinget: () => false }), start: () => assert.fail("must not launch") }),
    );
    assert.equal(res.status, 400);
  });
});

describe("POST /api/llm/ollama — pull progress", () => {
  test("streams Ollama's /api/pull progress into the job, then the model is installed", async () => {
    await useMock([{ name: "nomic-embed-text:latest" }]);
    const res = await handleOllamaActionPost(post({ action: "pull", model: "qwen2.5:7b" }), deps());
    assert.equal(res.status, 202);
    const seen = new Set<number>();
    await until(() => {
      const p = getOllamaJobs().pull;
      if (typeof p?.pct === "number") seen.add(p.pct);
      return p?.status !== "running";
    });
    const job = getOllamaJobs().pull!;
    assert.equal(job.status, "done", job.error);
    assert.equal(job.pct, 100);
    assert.deepEqual(mock!.pulls, ["qwen2.5:7b"]);
    assert.ok(Array.from(seen).every((p) => p >= 0 && p <= 100));
    const j = await (await handleOllamaStatusGet(deps())).json();
    assert.deepEqual(j.chatModels.map((m: any) => m.name), ["qwen2.5:7b"]);
  });

  test("progress is aggregated over layers", async () => {
    await useMock([]);
    const updates: Array<{ pct?: number; message: string }> = [];
    const { pullModelStream } = await import("@/lib/llm/ollamaJobs");
    await pullModelStream(mock!.host, "qwen2.5:7b", (p) => updates.push(p));
    const pcts = updates.filter((u) => typeof u.pct === "number").map((u) => u.pct!);
    assert.ok(pcts.includes(25), `saw ${pcts}`);
    assert.ok(pcts.includes(50));
    assert.equal(pcts.at(-1), 100);
    assert.ok(updates.some((u) => /Downloading qwen2\.5:7b: 1\.0 GB of 2\.0 GB/.test(u.message)));
  });

  test("Ollama's error line (unknown tag) fails the job with its message", async () => {
    await useMock([]);
    mock!.pullError = "pull model manifest: file does not exist";
    await handleOllamaActionPost(post({ action: "pull", model: "nope:1b" }), deps());
    await until(() => getOllamaJobs().pull?.status !== "running");
    assert.match(getOllamaJobs().pull!.error!, /couldn't download nope:1b: pull model manifest: file does not exist/);
  });

  test("a second model while one is downloading -> 409", async () => {
    await useMock([]);
    await handleOllamaActionPost(post({ action: "pull", model: "qwen2.5:7b" }), deps());
    const res = await handleOllamaActionPost(post({ action: "pull", model: "llama3.2:3b" }), deps());
    assert.equal(res.status, 409);
    await until(() => getOllamaJobs().pull?.status !== "running");
  });

  test("an invalid tag -> 400; Ollama not running -> 409", async () => {
    await useMock([], { listening: false });
    assert.equal((await handleOllamaActionPost(post({ action: "pull", model: "a b; rm" }), deps())).status, 400);
    assert.equal((await handleOllamaActionPost(post({ action: "pull", model: "qwen2.5:7b" }), deps())).status, 409);
  });
});

describe("POST /api/llm/ollama — install", () => {
  test("Windows: winget, then the daemon starts", async () => {
    await useMock([], { listening: false });
    const commands: string[] = [];
    const res = await handleOllamaActionPost(
      post({ action: "install" }),
      deps({
        platform: "win32",
        getStatus: () => getOllamaStatus({ detectInstalled: () => false, hasWinget: () => true, platform: "win32" }),
        install: () =>
          installOllama({
            platform: "win32",
            hasWinget: () => true,
            runCommand: async (cmd, args, onLine) => {
              commands.push(`${cmd} ${args.join(" ")}`);
              onLine("██████  50%");
              return 0;
            },
            launch: () => void mock!.listen(),
            startTimeoutMs: 5_000,
            pollIntervalMs: 25,
          }),
      }),
    );
    assert.equal(res.status, 202);
    await until(() => getOllamaJobs().install?.status !== "running");
    assert.equal(getOllamaJobs().install!.status, "done", getOllamaJobs().install!.error);
    assert.match(commands[0], /^winget install -e --id Ollama\.Ollama/);
  });

  test("Windows: winget fails -> the official installer, run silently", async () => {
    await useMock([], { listening: false });
    const commands: string[] = [];
    const fetched: string[] = [];
    installOllama({
      platform: "win32",
      hasWinget: () => true,
      fetch: (async (url: any, init?: any) => {
        if (String(url).startsWith("https://ollama.com/")) {
          fetched.push(String(url));
          return new Response(new Uint8Array(1024), { status: 200, headers: { "content-length": "1024" } });
        }
        return fetch(url, init);
      }) as typeof fetch,
      tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "granted-ollama-install-test-")),
      runCommand: async (cmd, args) => {
        commands.push(`${cmd} ${args.join(" ")}`);
        return cmd === "winget" ? 1 : 0;
      },
      launch: () => void mock!.listen(),
      startTimeoutMs: 5_000,
      pollIntervalMs: 25,
    });
    await until(() => getOllamaJobs().install?.status !== "running");
    assert.equal(getOllamaJobs().install!.status, "done", getOllamaJobs().install!.error);
    assert.deepEqual(fetched, ["https://ollama.com/download/OllamaSetup.exe"]);
    assert.match(commands[1], /OllamaSetup\.exe \/VERYSILENT/);
  });

  test("not Windows -> 400 with the download link and command", async () => {
    await useMock([], { listening: false });
    const res = await handleOllamaActionPost(
      post({ action: "install" }),
      deps({ getStatus: () => getOllamaStatus({ detectInstalled: () => false, platform: "darwin" }) }),
    );
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /ollama\.com\/download.*brew install ollama/);
  });
});

test("POST is loopback-only", async () => {
  await useMock([]);
  const res = await handleOllamaActionPost(post({ action: "start" }), deps({ isLoopbackRequest: () => false }));
  assert.equal(res.status, 403);
});

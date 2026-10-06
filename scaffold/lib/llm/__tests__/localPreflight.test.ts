import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prepareLocalSearch } from "../localPreflight";
import { LocalSetupError } from "../searchErrors";
import { startMockOllama, type MockOllama } from "./mockOllama";

/** The check before a Local search, against a stand-in Ollama on a random local port. */

let mock: MockOllama | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

// The mock is on a random port, not 11434: canManage says "this is Ollama on this machine" unless a test checks the real rule.
const base = (m: MockOllama) => ({ host: m.host, defaultModel: "gemma4:latest", detectInstalled: () => true, canManage: () => true, start: async () => false });

describe("prepareLocalSearch", () => {
  test("ok: the picked model, when installed, with its size", async () => {
    mock = await startMockOllama([{ name: "llama3.2:1b", details: { parameter_size: "1.2B" } }, { name: "gemma4:latest" }]);
    assert.deepEqual(await prepareLocalSearch("llama3.2:1b", undefined, base(mock)), { local: true, model: "llama3.2:1b", paramsB: 1.2 });
    assert.equal((await prepareLocalSearch(undefined, undefined, base(mock))).model, "gemma4:latest");
  });

  test("the user's report: configured gemma4:latest not installed, llama3.2:1b + nomic-embed-text -> Default runs llama3.2:1b", async () => {
    mock = await startMockOllama([{ name: "llama3.2:1b" }, { name: "nomic-embed-text:latest" }]);
    assert.equal((await prepareLocalSearch(undefined, undefined, base(mock))).model, "llama3.2:1b");
  });

  test("configured model not installed -> the best installed model in MODEL_TIERS order", async () => {
    mock = await startMockOllama([{ name: "llama3.2:1b" }, { name: "qwen2.5:7b" }, { name: "nomic-embed-text:latest" }]);
    assert.equal((await prepareLocalSearch(undefined, undefined, base(mock))).model, "qwen2.5:7b");
    // A pick that's installed still wins over the resolved default.
    assert.equal((await prepareLocalSearch("llama3.2:1b", undefined, base(mock))).model, "llama3.2:1b");
  });

  test("only embedding models -> no_chat_models (an embedding model is never used as the chat model)", async () => {
    mock = await startMockOllama([{ name: "nomic-embed-text:latest" }]);
    await assert.rejects(prepareLocalSearch("nomic-embed-text:latest", undefined, base(mock)), (e: unknown) => {
      assert.ok(e instanceof LocalSetupError);
      assert.equal(e.kind, "no_chat_models");
      assert.match(e.message, /no chat model installed/);
      return true;
    });
  });

  test("stopped but installed: starts Ollama, says so, then runs", async () => {
    mock = await startMockOllama([{ name: "llama3.2:1b" }], { listening: false });
    const statuses: string[] = [];
    const info = await prepareLocalSearch("llama3.2:1b", (s) => statuses.push(s), {
      ...base(mock),
      start: async () => {
        await mock!.listen();
        return true;
      },
    });
    assert.deepEqual(statuses, ["Starting Ollama…"]);
    assert.equal(info.model, "llama3.2:1b");
  });

  test("stopped and won't start -> ollama_unreachable", async () => {
    mock = await startMockOllama([], { listening: false });
    await assert.rejects(prepareLocalSearch(undefined, undefined, base(mock)), (e: unknown) => e instanceof LocalSetupError && e.kind === "ollama_unreachable");
  });

  test("not installed -> ollama_unreachable without trying to start it", async () => {
    mock = await startMockOllama([], { listening: false });
    await assert.rejects(
      prepareLocalSearch(undefined, undefined, { ...base(mock), detectInstalled: () => false, start: async () => assert.fail("must not start") }),
      /couldn't reach Ollama/,
    );
  });

  test("a local server that isn't Ollama (not port 11434), down -> 'couldn't reach the local model server', never starts Ollama", async () => {
    mock = await startMockOllama([], { listening: false });
    await assert.rejects(
      prepareLocalSearch(undefined, undefined, {
        host: mock.host,
        defaultModel: "gemma4:latest",
        detectInstalled: () => true,
        start: async () => assert.fail("must not start Ollama for LM Studio / vLLM"),
      }),
      (e: unknown) => {
        assert.ok(e instanceof LocalSetupError);
        assert.equal(e.kind, "server_unreachable");
        assert.equal(e.message, `Couldn't reach the local model server at ${mock!.host} — start it, or switch to Cloud in Settings → Model.`);
        return true;
      },
    );
  });

  test("a pick that isn't installed says so in the progress, and uses Default", async () => {
    mock = await startMockOllama([{ name: "llama3.2:1b" }, { name: "qwen2.5:7b" }]);
    const statuses: string[] = [];
    const info = await prepareLocalSearch("deleted-model:3b", (s) => statuses.push(s), base(mock));
    assert.equal(info.model, "qwen2.5:7b");
    assert.deepEqual(statuses, ["Your pick deleted-model:3b isn't installed; using qwen2.5:7b."]);
  });

  test("an OpenAI-compatible server that isn't Ollama (no /api/tags) passes through with the default model", async () => {
    mock = await startMockOllama([]);
    const info = await prepareLocalSearch("x", undefined, { ...base(mock), host: `${mock.host}/not-ollama` });
    assert.deepEqual(info, { local: true, model: "gemma4:latest" });
  });
});

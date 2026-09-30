import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

import {
  MODEL_TIERS,
  recommendModel,
  currentValue,
  upsert,
  mergeEnvLocal,
  bytesToGB,
  kbToGB,
  mibToGB,
  parseSysctlMemsize,
  parseNvidiaSmi,
  parseProcMeminfo,
  parseWinBytes,
  parseOllamaList,
  installGuidance,
  parseMacosMajor,
  OLLAMA_MIN_MACOS,
  pickAutoInstallCommand,
  ollamaWindowsDir,
  withOllamaOnPath,
  waitForDaemon,
  embedWithRetry,
  launchOllamaDaemon,
} from "../setup-local.mjs";

/**
 * Unit tests for the PURE logic behind `npm run setup:local`. None of these touch
 * a TTY, a live Ollama daemon, or the filesystem — they exercise the memory→model
 * recommendation, the .env.local merge contract, and every command-output parser.
 */

describe("recommendModel: memory (GB) → tier", () => {
  test("picks the top tier at/above 32GB", () => {
    assert.equal(recommendModel(64).model, "qwen2.5:14b");
    assert.equal(recommendModel(32).model, "qwen2.5:14b");
  });

  test("16–32GB → the 7b default", () => {
    assert.equal(recommendModel(31).model, "qwen2.5:7b");
    assert.equal(recommendModel(16).model, "qwen2.5:7b");
  });

  test("8–16GB → a 3b model", () => {
    assert.equal(recommendModel(15).model, "llama3.2:3b");
    assert.equal(recommendModel(8).model, "llama3.2:3b");
  });

  test("<8GB (e.g. a 4GB GPU) → the smallest model, flagged as rougher/slow", () => {
    const tier = recommendModel(4);
    assert.equal(tier.model, "llama3.2:1b");
    assert.match(tier.note, /rougher|slow/i);
  });

  test("unreliable/failed detection (NaN, 0, negative) is conservative → smallest tier", () => {
    assert.equal(recommendModel(NaN).model, "llama3.2:1b");
    assert.equal(recommendModel(0).model, "llama3.2:1b");
    assert.equal(recommendModel(-5).model, "llama3.2:1b");
    assert.equal(recommendModel(undefined as unknown as number).model, "llama3.2:1b");
  });

  test("every tier has a real, non-empty public tag, an alt, and a note", () => {
    for (const t of MODEL_TIERS) {
      assert.ok(t.model && t.model.includes(":"), `tier ${t.minGB} has a tag`);
      assert.ok(t.alt && t.alt.length > 0, `tier ${t.minGB} has an alt`);
      assert.ok(t.note && t.note.length > 0, `tier ${t.minGB} has a note`);
    }
  });
});

describe("mergeEnvLocal: idempotent, non-clobbering merge", () => {
  const UPDATES = {
    LLM_PROVIDER: "ollama",
    LOCAL_LLM_MODEL: "qwen2.5:7b",
    LLM_BASE_URL: "http://localhost:11434/v1",
    EMBEDDINGS_BASE_URL: "http://localhost:11434/v1",
    EMBEDDINGS_MODEL: "nomic-embed-text",
  };

  test("writes all keys into empty text and reports them as applied", () => {
    const { text, applied, skipped } = mergeEnvLocal("", UPDATES);
    assert.equal(skipped.length, 0);
    assert.equal(applied.length, 5);
    assert.equal(currentValue(text, "LLM_PROVIDER"), "ollama");
    assert.equal(currentValue(text, "LOCAL_LLM_MODEL"), "qwen2.5:7b");
    assert.equal(currentValue(text, "EMBEDDINGS_MODEL"), "nomic-embed-text");
  });

  test("NEVER clobbers an existing non-empty value; reports it as skipped", () => {
    const existing = "LLM_PROVIDER=anthropic\nLOCAL_LLM_MODEL=my-custom:latest\n";
    const { text, applied, skipped } = mergeEnvLocal(existing, UPDATES);
    // The two pre-set keys are kept verbatim…
    assert.equal(currentValue(text, "LLM_PROVIDER"), "anthropic");
    assert.equal(currentValue(text, "LOCAL_LLM_MODEL"), "my-custom:latest");
    // …and the three missing ones are added.
    assert.equal(currentValue(text, "LLM_BASE_URL"), "http://localhost:11434/v1");
    assert.equal(currentValue(text, "EMBEDDINGS_MODEL"), "nomic-embed-text");
    const skippedKeys = skipped.map((s) => s.key).sort();
    assert.deepEqual(skippedKeys, ["LLM_PROVIDER", "LOCAL_LLM_MODEL"]);
    assert.equal(applied.length, 3);
  });

  test("an EMPTY-valued key (KEY=) is treated as unset and gets filled", () => {
    const { text, skipped } = mergeEnvLocal("LLM_PROVIDER=\n", { LLM_PROVIDER: "ollama" });
    assert.equal(currentValue(text, "LLM_PROVIDER"), "ollama");
    assert.equal(skipped.length, 0);
  });

  test("preserves surrounding lines/comments and is idempotent on re-run", () => {
    const seed = "# my env\nOPENAI_API_KEY=sk-real-key\n";
    const once = mergeEnvLocal(seed, UPDATES).text;
    assert.match(once, /# my env/);
    assert.equal(currentValue(once, "OPENAI_API_KEY"), "sk-real-key");
    // Running again changes nothing (all keys now non-empty → all skipped).
    const twice = mergeEnvLocal(once, UPDATES);
    assert.equal(twice.text, once);
    assert.equal(twice.applied.length, 0);
    assert.equal(twice.skipped.length, 5);
  });
});

describe("upsert / currentValue (mirrors setup.mjs)", () => {
  test("upsert replaces in place when the key exists", () => {
    assert.equal(upsert("A=1\nB=2\n", "A", "9"), "A=9\nB=2\n");
  });
  test("upsert appends when the key is absent", () => {
    assert.match(upsert("A=1\n", "B", "2"), /^A=1\nB=2\n$/);
  });
  test("currentValue trims and returns '' for absent keys", () => {
    assert.equal(currentValue("A= 1 \n", "A"), "1");
    assert.equal(currentValue("A=1\n", "MISSING"), "");
  });
});

describe("byte/unit conversions", () => {
  test("bytesToGB floors and rejects junk", () => {
    assert.equal(bytesToGB(34359738368), 32); // 32 GiB
    assert.equal(bytesToGB(17179869184), 16); // 16 GiB
    assert.ok(Number.isNaN(bytesToGB("nope")));
    assert.ok(Number.isNaN(bytesToGB(-1)));
  });
  test("kbToGB (/proc/meminfo kB)", () => {
    assert.equal(kbToGB(16 * 1024 * 1024), 16);
    assert.equal(kbToGB(32 * 1024 * 1024), 32);
  });
  test("mibToGB (nvidia-smi MiB)", () => {
    assert.equal(mibToGB(8192), 8);
    assert.equal(mibToGB(24576), 24);
  });
});

describe("command-output parsers", () => {
  test("parseSysctlMemsize (macOS hw.memsize, bytes on one line)", () => {
    assert.equal(parseSysctlMemsize("34359738368\n"), 32);
    assert.ok(Number.isNaN(parseSysctlMemsize("")));
  });

  test("parseNvidiaSmi takes the LARGEST GPU's VRAM in GB", () => {
    assert.equal(parseNvidiaSmi("8192\n24576\n"), 24);
    assert.equal(parseNvidiaSmi("4096"), 4);
    assert.ok(Number.isNaN(parseNvidiaSmi("")));
    assert.ok(Number.isNaN(parseNvidiaSmi("No devices were found")));
  });

  test("parseProcMeminfo reads MemTotal", () => {
    const meminfo = "MemTotal:       16332432 kB\nMemFree:         1234 kB\n";
    assert.equal(parseProcMeminfo(meminfo), 15);
    assert.ok(Number.isNaN(parseProcMeminfo("no memtotal here")));
  });

  test("parseWinBytes takes the largest bare-number (bytes) line", () => {
    assert.equal(parseWinBytes("\n34359738368\n"), 32);
    assert.equal(parseWinBytes("4293918720"), 3); // AdapterRAM uint32 near-4GB cap
    assert.ok(Number.isNaN(parseWinBytes("AdapterRAM\n----------")));
  });

  test("parseOllamaList extracts model names, skipping the header", () => {
    const out =
      "NAME                       ID              SIZE      MODIFIED\n" +
      "llama3.2:3b                abc123          2.0 GB    2 days ago\n" +
      "nomic-embed-text:latest    def456          274 MB    1 week ago\n";
    assert.deepEqual(parseOllamaList(out), ["llama3.2:3b", "nomic-embed-text:latest"]);
    assert.deepEqual(parseOllamaList(""), []);
    assert.deepEqual(parseOllamaList("NAME  ID  SIZE  MODIFIED\n"), []);
  });
});

describe("parseMacosMajor (sw_vers -productVersion)", () => {
  test("reads the major version", () => {
    assert.equal(parseMacosMajor("12.7.6"), 12);
    assert.equal(parseMacosMajor("26.4"), 26);
    assert.equal(parseMacosMajor("15"), 15);
    assert.equal(parseMacosMajor(" 14.2.1 \n"), 14);
  });
  test("junk/empty degrades to null rather than a wrong number", () => {
    for (const bad of ["", "   ", "sonoma", null, undefined]) {
      assert.equal(parseMacosMajor(bad as never), null);
    }
  });
});

describe("installGuidance: platform-specific, no wrong-OS instructions", () => {
  test("macOS mentions the download page and brew, not apt/curl-sh", () => {
    const g = installGuidance("darwin");
    assert.match(g, /ollama\.com\/download/);
    assert.match(g, /brew install ollama/);
    assert.doesNotMatch(g, /install\.sh/);
  });
  test("a macOS older than Ollama's app floor gets the CLI tarball, NOT brew/the app", () => {
    const g = installGuidance("darwin", OLLAMA_MIN_MACOS - 1);
    // The .dmg and the Homebrew cask both fail there. They may be NAMED (to say
    // so), but must never be offered as the install path, and the app can't launch.
    assert.doesNotMatch(g, /Install Ollama:\s+https/);
    assert.match(g, /will NOT work/);
    assert.doesNotMatch(g, /open the Ollama app/);
    assert.match(g, /ollama-darwin\.tgz/);
    assert.match(g, /ollama serve/);
    assert.doesNotMatch(g, /install\.sh/);
  });
  test("a supported macOS still gets the normal app guidance", () => {
    for (const v of [OLLAMA_MIN_MACOS, OLLAMA_MIN_MACOS + 12]) {
      const g = installGuidance("darwin", v);
      assert.match(g, /brew install ollama/);
      assert.doesNotMatch(g, /ollama-darwin\.tgz/);
    }
  });
  test("an undetectable macOS version degrades to the normal guidance", () => {
    assert.equal(installGuidance("darwin", null), installGuidance("darwin"));
  });
  test("Windows points at the download page, not a shell installer", () => {
    const g = installGuidance("win32");
    assert.match(g, /ollama\.com\/download/);
    assert.doesNotMatch(g, /brew|install\.sh/);
  });
  test("Linux gives the curl|sh installer", () => {
    const g = installGuidance("linux");
    assert.match(g, /install\.sh \| sh/);
  });
});

describe("pickAutoInstallCommand: platform install-command selection", () => {
  test("Windows + winget → winget install", () => {
    const cmd = pickAutoInstallCommand("win32", { hasWinget: true });
    assert.equal(cmd?.cmd, "winget");
    assert.deepEqual(cmd?.args, [
      "install",
      "-e",
      "--id",
      "Ollama.Ollama",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ]);
  });
  test("Windows without winget → null (fall back to manual guidance)", () => {
    assert.equal(pickAutoInstallCommand("win32", { hasWinget: false }), null);
  });
  test("macOS + brew → brew install ollama", () => {
    const cmd = pickAutoInstallCommand("darwin", { hasBrew: true });
    assert.equal(cmd?.cmd, "brew");
    assert.deepEqual(cmd?.args, ["install", "ollama"]);
  });
  test("macOS older than OLLAMA_MIN_MACOS → null even with brew (no bottle)", () => {
    assert.equal(pickAutoInstallCommand("darwin", { hasBrew: true, macosMajor: OLLAMA_MIN_MACOS - 1 }), null);
    assert.equal(pickAutoInstallCommand("darwin", { hasBrew: true, macosMajor: OLLAMA_MIN_MACOS })?.cmd, "brew");
  });
  test("macOS without brew → null", () => {
    assert.equal(pickAutoInstallCommand("darwin", { hasBrew: false }), null);
  });
  test("Linux → null (no automatic path; keep existing guidance)", () => {
    assert.equal(pickAutoInstallCommand("linux", { hasWinget: true, hasBrew: true }), null);
  });
});

describe("ollamaWindowsDir / withOllamaOnPath", () => {
  test("builds the winget default install dir", () => {
    assert.equal(
      ollamaWindowsDir("C:\\Users\\me\\AppData\\Local"),
      "C:\\Users\\me\\AppData\\Local\\Programs\\Ollama",
    );
  });
  test("appends the install dir to PATH on win32, so an ollama already on PATH wins", () => {
    const env = { Path: "C:\\Windows\\System32" };
    const out = withOllamaOnPath(env, "win32", "C:\\Users\\me\\AppData\\Local");
    assert.equal(out.Path, "C:\\Windows\\System32;C:\\Users\\me\\AppData\\Local\\Programs\\Ollama");
    assert.equal("PATH" in out, false);
  });
  test("is a no-op off win32", () => {
    const env = { PATH: "/usr/bin" };
    assert.equal(withOllamaOnPath(env, "darwin", "/whatever"), env);
  });
  test("is a no-op without localAppData", () => {
    const env = { PATH: "C:\\Windows\\System32" };
    assert.equal(withOllamaOnPath(env, "win32", undefined), env);
  });
  test("doesn't duplicate an already-present dir", () => {
    const dir = "C:\\Users\\me\\AppData\\Local\\Programs\\Ollama";
    const env = { PATH: `${dir};C:\\Windows\\System32` };
    const out = withOllamaOnPath(env, "win32", "C:\\Users\\me\\AppData\\Local");
    assert.equal(out.PATH, env.PATH);
  });
});

describe("waitForDaemon: poll with injectable fetch + sleep", () => {
  test("resolves true immediately when the daemon is already up", async () => {
    const up = await waitForDaemon(async () => true, { sleepFn: async () => {} });
    assert.equal(up, true);
  });
  test("polls until the daemon comes up, then resolves true", async () => {
    let calls = 0;
    const fetchTags = async () => {
      calls++;
      return calls >= 3;
    };
    const sleeps: number[] = [];
    const up = await waitForDaemon(fetchTags, {
      timeoutMs: 100000,
      intervalMs: 2000,
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    assert.equal(up, true);
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2000, 2000]);
  });
  test("gives up and resolves false once the timeout elapses", async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const up = await waitForDaemon(async () => false, {
        timeoutMs: 5000,
        intervalMs: 2000,
        sleepFn: async (ms: number) => {
          now += ms;
        },
      });
      assert.equal(up, false);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("embedWithRetry: warm + run data:embed, retry once, report failure", () => {
  test("succeeds on the first attempt after warming", async () => {
    let warmed = false;
    const result = await embedWithRetry({
      warmFn: async () => {
        warmed = true;
        return true;
      },
      runFn: async () => ({ ok: true, output: "791 embedded" }),
      waitFn: async () => {},
    });
    assert.equal(warmed, true);
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
  });
  test("retries once after a failure, then succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await embedWithRetry({
      runFn: async () => {
        calls++;
        return calls === 1 ? { ok: false, output: "ECONNRESET" } : { ok: true, output: "done" };
      },
      waitFn: async (ms: number) => {
        waits.push(ms);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.deepEqual(waits, [5000]);
  });
  test("fails after two attempts, reporting the last output and attempt count", async () => {
    let calls = 0;
    const result = await embedWithRetry({
      runFn: async () => {
        calls++;
        return { ok: false, output: `attempt ${calls} failed` };
      },
      waitFn: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
    assert.match(result.output, /attempt 2 failed/);
  });
  test("works without a warmFn", async () => {
    const result = await embedWithRetry({
      runFn: async () => ({ ok: true, output: "" }),
      waitFn: async () => {},
    });
    assert.equal(result.ok, true);
  });
});

describe("launchOllamaDaemon: never inherits stdio from a long-lived grandchild", () => {
  test("Windows: spawns via `cmd /c start` detached with stdio ignored", () => {
    const calls: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }> = [];
    launchOllamaDaemon("win32", {
      localAppData: "C:/Users/me/AppData/Local",
      env: { FOO: "bar", NODE_ENV: "test" },
      spawnFn: ((cmd: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ cmd, args, options });
        return { on: () => {}, unref: () => {} };
      }) as unknown as typeof spawn,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "cmd");
    assert.deepEqual(calls[0].args.slice(0, 3), ["/c", "start", ""]);
    assert.equal(calls[0].options.stdio, "ignore");
    assert.equal(calls[0].options.detached, true);
  });

  test("non-Windows: spawns `ollama serve` detached with stdio ignored", () => {
    const calls: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }> = [];
    launchOllamaDaemon("darwin", {
      env: { FOO: "bar", NODE_ENV: "test" },
      spawnFn: ((cmd: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ cmd, args, options });
        return { on: () => {}, unref: () => {} };
      }) as unknown as typeof spawn,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "ollama");
    assert.deepEqual(calls[0].args, ["serve"]);
    assert.equal(calls[0].options.stdio, "ignore");
    assert.equal(calls[0].options.detached, true);
  });

  test("real process: a caller waiting on the launcher isn't held open by the long-lived daemon", () => {
    const driver = `import { spawn } from "node:child_process";
      import { launchOllamaDaemon } from ${JSON.stringify(new URL("../setup-local.mjs", import.meta.url).href)};
      const d = launchOllamaDaemon(process.platform, {
        spawnFn: (_cmd, _args, options) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], options),
      });
      console.log(d.pid);`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], { encoding: "utf8", timeout: 10000 });
    const pid = Number(r.stdout);
    try {
      assert.equal(r.error, undefined, "the caller blocked on pipes inherited by the daemon");
      assert.equal(r.status, 0, r.stderr);
      assert.ok(pid > 0 && process.kill(pid, 0), "the daemon stand-in should still be running");
    } finally {
      if (pid > 0) {
        try {
          process.kill(pid);
        } catch {
          /* already gone */
        }
      }
    }
  });
});

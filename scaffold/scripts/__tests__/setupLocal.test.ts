import { describe, test } from "node:test";
import assert from "node:assert/strict";

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

describe("installGuidance: platform-specific, no wrong-OS instructions", () => {
  test("macOS mentions the download page and brew, not apt/curl-sh", () => {
    const g = installGuidance("darwin");
    assert.match(g, /ollama\.com\/download/);
    assert.match(g, /brew install ollama/);
    assert.doesNotMatch(g, /install\.sh/);
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

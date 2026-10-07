import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getModel, setModel, LAST_SEARCH_MS_KEY, getSelectedStateSources, setSelectedStateSources, DEFAULT_STATE_SOURCES } from "../searchSettings";

let mem: Map<string, string>;

beforeEach(() => {
  mem = new Map();
  (globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
    },
  };
});

describe("setModel", () => {
  test("round-trips, and null clears back to the server default", () => {
    setModel("qwen2.5:7b");
    assert.equal(getModel(), "qwen2.5:7b");
    setModel(null);
    assert.equal(getModel(), null);
  });

  test("switching models drops the last-search duration measured on the old one", () => {
    mem.set(LAST_SEARCH_MS_KEY, "1200000");
    setModel("qwen2.5:7b");
    assert.equal(mem.has(LAST_SEARCH_MS_KEY), false);
  });

  test("re-saving the same model keeps the last-search duration", () => {
    setModel("qwen2.5:7b");
    mem.set(LAST_SEARCH_MS_KEY, "1200000");
    setModel("qwen2.5:7b");
    assert.equal(mem.get(LAST_SEARCH_MS_KEY), "1200000");
  });
});

describe("getSelectedStateSources / setSelectedStateSources", () => {
  test("default (nothing stored yet) is CA/IL/NC on, Utah opt-in off", () => {
    assert.deepEqual(getSelectedStateSources(), ["ca-grants", "il-grants", "nc-grants"]);
    assert.deepEqual(getSelectedStateSources(), DEFAULT_STATE_SOURCES);
  });

  test("round-trips an explicit selection, including Utah opted in", () => {
    setSelectedStateSources(["ca-grants", "ut-grants"]);
    assert.deepEqual(getSelectedStateSources(), ["ca-grants", "ut-grants"]);
  });

  test("round-trips an empty selection (every state source deselected)", () => {
    setSelectedStateSources([]);
    assert.deepEqual(getSelectedStateSources(), []);
  });

  test("malformed stored JSON falls back to the default, not a crash", () => {
    mem.set("granted:selectedStateSources", "{not json");
    assert.deepEqual(getSelectedStateSources(), DEFAULT_STATE_SOURCES);
  });
});

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isFlagEnabled, getAllFlags, FLAG_DEFAULT } from "../accessor";
import { FLAG_REGISTRY, type FlagName } from "../registry";

const ALL_FLAG_NAMES = Object.keys(FLAG_REGISTRY) as FlagName[];

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Every flag's env var starts unset for each test, regardless of what the outer shell/CI set.
  for (const name of ALL_FLAG_NAMES) {
    delete process.env[FLAG_REGISTRY[name].envVar];
  }
});

afterEach(() => {
  process.env = savedEnv;
});

describe("FLAG_DEFAULT", () => {
  test("is off", () => {
    assert.equal(FLAG_DEFAULT, false);
  });
});

describe("isFlagEnabled — defaults", () => {
  test("every registered flag defaults to off with no override present", () => {
    for (const name of ALL_FLAG_NAMES) {
      assert.equal(isFlagEnabled(name), false, `${name} should default off`);
    }
  });

  test("defaults off even when NODE_ENV is not production (default is universal, not per-env)", () => {
    // NODE_ENV is typed read-only on process.env; go through an untyped view to flip it for the
    // test, same as the try/finally below restores it.
    const env = process.env as Record<string, string | undefined>;
    const original = env.NODE_ENV;
    env.NODE_ENV = "development";
    try {
      assert.equal(isFlagEnabled("r1_interview"), false);
    } finally {
      env.NODE_ENV = original;
    }
  });
});

describe("isFlagEnabled — env override", () => {
  test("a truthy env override flips a flag on", () => {
    process.env[FLAG_REGISTRY.r1_interview.envVar] = "true";
    assert.equal(isFlagEnabled("r1_interview"), true);
  });

  for (const truthy of ["1", "true", "on", "yes", "TRUE", " True "]) {
    test(`recognizes ${JSON.stringify(truthy)} as on`, () => {
      process.env[FLAG_REGISTRY.r2_verify.envVar] = truthy;
      assert.equal(isFlagEnabled("r2_verify"), true);
    });
  }

  for (const falsy of ["0", "false", "off", "no", "FALSE"]) {
    test(`recognizes ${JSON.stringify(falsy)} as off`, () => {
      // Flip default false -> true is not meaningful here since default is already false; prove
      // an explicit "off" override still resolves to off (i.e. it's read, not just ignored).
      process.env[FLAG_REGISTRY.r3_enhance.envVar] = falsy;
      assert.equal(isFlagEnabled("r3_enhance"), false);
    });
  }

  test("an unrecognized override value falls back to the default instead of throwing or guessing", () => {
    process.env[FLAG_REGISTRY.r4_progress.envVar] = "banana";
    assert.equal(isFlagEnabled("r4_progress"), FLAG_DEFAULT);
  });

  test("r9_0_mockauth reads the mock-auth drop-in's own env var (NEXT_PUBLIC_MOCK_AUTH)", () => {
    assert.equal(FLAG_REGISTRY.r9_0_mockauth.envVar, "NEXT_PUBLIC_MOCK_AUTH");
    process.env.NEXT_PUBLIC_MOCK_AUTH = "true";
    assert.equal(isFlagEnabled("r9_0_mockauth"), true);
  });

  test("each flag's own env var is independent of the others", () => {
    process.env[FLAG_REGISTRY.r8_eligibility.envVar] = "true";
    assert.equal(isFlagEnabled("r8_eligibility"), true);
    for (const name of ALL_FLAG_NAMES) {
      if (name === "r8_eligibility") continue;
      assert.equal(isFlagEnabled(name), false, `${name} should be unaffected`);
    }
  });
});

describe("isFlagEnabled — config override", () => {
  test("a config override takes precedence over an env var", () => {
    process.env[FLAG_REGISTRY.left_sidebar.envVar] = "false";
    assert.equal(isFlagEnabled("left_sidebar", { left_sidebar: "true" }), true);
  });

  test("a config override of an unset env var still works", () => {
    assert.equal(isFlagEnabled("r10_analytics", { r10_analytics: "true" }), true);
  });

  test("an explicit undefined config value falls through to the default, not the env var", () => {
    process.env[FLAG_REGISTRY.r1_interview.envVar] = "true";
    assert.equal(isFlagEnabled("r1_interview", { r1_interview: undefined }), false);
  });
});

describe("getAllFlags", () => {
  test("reports every registered flag", () => {
    const all = getAllFlags();
    assert.deepEqual(Object.keys(all).sort(), ALL_FLAG_NAMES.slice().sort());
  });

  test("reflects env overrides", () => {
    process.env[FLAG_REGISTRY.r2_verify.envVar] = "true";
    const all = getAllFlags();
    assert.equal(all.r2_verify, true);
    assert.equal(all.r1_interview, false);
  });

  test("reflects config overrides", () => {
    const all = getAllFlags({ r3_enhance: "true" });
    assert.equal(all.r3_enhance, true);
    assert.equal(all.r1_interview, false);
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FLAG_REGISTRY, type FlagName } from "../registry";

describe("FLAG_REGISTRY", () => {
  test("every entry's key matches its own `name` field", () => {
    for (const [key, def] of Object.entries(FLAG_REGISTRY)) {
      assert.equal(def.name, key as FlagName);
    }
  });

  test("every entry declares a requirement, description, and envVar", () => {
    for (const def of Object.values(FLAG_REGISTRY)) {
      assert.ok(def.requirement.length > 0, `${def.name} missing requirement`);
      assert.ok(def.description.length > 0, `${def.name} missing description`);
      assert.ok(def.envVar.length > 0, `${def.name} missing envVar`);
    }
  });

  test("every env var is NEXT_PUBLIC_-prefixed (readable client-side, per Next.js convention)", () => {
    for (const def of Object.values(FLAG_REGISTRY)) {
      assert.ok(
        def.envVar.startsWith("NEXT_PUBLIC_"),
        `${def.name}'s envVar (${def.envVar}) must be NEXT_PUBLIC_-prefixed to be client-readable`
      );
    }
  });

  test("no two flags share the same env var", () => {
    const envVars = Object.values(FLAG_REGISTRY).map((d) => d.envVar);
    assert.equal(new Set(envVars).size, envVars.length);
  });

  test("covers one flag per named requirement from the CON-03 task spec", () => {
    const expected: FlagName[] = [
      "r1_interview",
      "r2_verify",
      "r3_enhance",
      "r4_progress",
      "r6_auto_fill",
      "r6_export_autofill",
      "r7_design",
      "r8_eligibility",
      "r9_0_mockauth",
      "r9_supabase_auth",
      "r10_analytics",
      "r4b_cost_debug",
      "left_sidebar",
      "g6_s2s_submission",
      "b2_enriched_ranking",
      "c1b_type_groups",
      "d4_opportunity_graph",
      "d3_funding_strategy",
      "d5_alerts",
      "r5_deep_analysis",
      "e3_two_pass",
      "discernment_layer",
      "commercial_ui",
    ];
    assert.deepEqual(Object.keys(FLAG_REGISTRY).sort(), expected.slice().sort());
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  STUB_TIER,
  readEntitlements,
  toEntitlementsView,
  useEntitlements,
} from "../useEntitlements";

/**
 * R6 — the client-only entitlement stub must default to the free tier, which is
 * what makes `assisted_application` resolve to false (so the R6 flow shows Pro
 * framing). It gates nothing; these are contract-shape sanity checks only.
 */
describe("useEntitlements (client-only stub)", () => {
  test("defaults to the free tier", () => {
    assert.equal(STUB_TIER, "free");
    assert.equal(readEntitlements().tier, "free");
  });

  test("free tier does NOT entitle assisted_application", () => {
    assert.equal(readEntitlements("free").features.assisted_application, false);
  });

  test("the framing view exposes isPro=false / assistedApplication=false at the default", () => {
    const view = useEntitlements();
    assert.equal(view.tier, "free");
    assert.equal(view.isPro, false);
    assert.equal(view.assistedApplication, false);
  });

  test("projection stays in sync with the underlying entitlements record", () => {
    const view = toEntitlementsView(readEntitlements("free"));
    assert.equal(view.assistedApplication, view.features.assisted_application);
  });

  test("contract sanity: the pro tier WOULD entitle assisted_application (stub just never selects it)", () => {
    assert.equal(readEntitlements("pro").features.assisted_application, true);
    assert.equal(toEntitlementsView(readEntitlements("pro")).isPro, true);
  });

  // ---------------------------------------------------------------------
  // [ADDED] FE-07 injectable billingTier param — tier -> gating mapping
  // ---------------------------------------------------------------------

  test("[added] useEntitlements('pro') — legacy tier collapses to pro, autoFill on, competitor off, limit 10", () => {
    const view = useEntitlements("pro");
    assert.equal(view.tier, "pro");
    assert.equal(view.billingTier, "pro");
    assert.equal(view.autoFillEnabled, true);
    assert.equal(view.competitorEnabled, false);
    assert.equal(view.autoFillLimitPerMonth, 10);
  });

  test("[added] useEntitlements('max') — legacy tier still collapses to pro, but billingTier stays max (unlimited + competitor)", () => {
    const view = useEntitlements("max");
    assert.equal(view.tier, "pro"); // legacy 2-tier contract has no "max"
    assert.equal(view.billingTier, "max"); // FE-07 field carries the true tier
    assert.equal(view.competitorEnabled, true);
    assert.equal(view.autoFillLimitPerMonth, null);
  });

  test("[added] toEntitlementsView(readEntitlements('pro')) — autoFillLimitPerMonth is null when assisted_application is entitled", () => {
    const view = toEntitlementsView(readEntitlements("pro"));
    assert.equal(view.features.assisted_application, true);
    assert.equal(view.autoFillLimitPerMonth, null);
  });
});

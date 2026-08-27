"use client";

/**
 * R6 — client-only entitlement stub.
 *
 * §3.7 says every Pro surface reads its tier/feature access from the CON-01
 * `Entitlements` contract instead of scattering tier checks through components.
 * This module centralizes that read for the client so the R6 assisted-apply
 * PREVIEW can frame itself as a Pro feature (badge / lock / eyebrow).
 *
 * IT GATES NOTHING. There is deliberately no server call and no identity read
 * here: it always resolves the default `free` tier from `DEFAULT_ENTITLEMENTS`,
 * so `assisted_application` is `false`. Real server-side enforcement is PLT-07
 * (out of scope) — never treat this hook as an authorization decision. It only
 * tells the UI how to *frame* itself; the walkthrough proceeds regardless
 * because it is a preview that submits nothing.
 *
 * Kept React-free (pure functions + a trivial hook wrapper) so the read is unit
 * testable without a React runtime and so nothing here can accidentally grow a
 * side effect.
 */

import {
  DEFAULT_ENTITLEMENTS,
  type Entitlements,
  type SubscriptionTier,
} from "../contracts/entitlements";
import {
  billingFeatures,
  getBillingTier,
  type BillingTier,
} from "../billing/mockBilling";

/**
 * The tier this stub always reports. Free by default — matching a signed-out /
 * unpaid user — which is what makes `assisted_application` resolve to `false`.
 */
export const STUB_TIER: SubscriptionTier = "free";

/** Pure, React-free read of the default entitlements for a tier. */
export function readEntitlements(tier: SubscriptionTier = STUB_TIER): Entitlements {
  return DEFAULT_ENTITLEMENTS[tier];
}

/** The narrow, UI-facing view the R6 flow consumes for Pro *framing* only. */
export interface EntitlementsView {
  tier: SubscriptionTier;
  /** Whether the resolved tier is the paid one. Framing only. */
  isPro: boolean;
  features: Entitlements["features"];
  /**
   * Convenience: is `assisted_application` entitled? Always `false` at the free
   * default. Used ONLY to decide whether to show the Pro lock/upsell framing —
   * never to allow or block any real action.
   */
  assistedApplication: boolean;
  /**
   * FE-07 additive fields — the locally-selected MOCK billing tier and the
   * feature bundle it advertises. These drive the sidebar's live padlock
   * framing (Auto Fill / competitor analysis). Unlike the legacy `tier`
   * field (2-tier CON-01 contract), `billingTier` carries the true 3-tier
   * mock value, so "max" is distinguishable from "pro" here. Still framing
   * only — gates nothing, charges nothing.
   */
  billingTier: BillingTier;
  autoFillEnabled: boolean;
  competitorEnabled: boolean;
  autoFillLimitPerMonth: number | null;
}

/** Project an `Entitlements` record down to the framing-only view. */
export function toEntitlementsView(ent: Entitlements): EntitlementsView {
  // `ent.tier` is the 2-tier contract value ("free"|"pro"), both valid
  // BillingTier literals, so mirroring it into `billingTier` stays type-safe.
  const billingTier: BillingTier = ent.tier;
  return {
    tier: ent.tier,
    isPro: ent.tier === "pro",
    features: ent.features,
    assistedApplication: ent.features.assisted_application,
    billingTier,
    autoFillEnabled: ent.features.assisted_application,
    competitorEnabled: ent.features.competitor_intelligence,
    autoFillLimitPerMonth: ent.features.assisted_application ? null : 0,
  };
}

/**
 * Client hook: the current entitlement view, driven by the FE-07 local MOCK
 * billing tier (getBillingTier(); no window / SSR -> "free"). Still a PURE
 * function — no React state/effect — so it is safe to call anywhere (and
 * testable outside React), and it can never gate anything server-side.
 *
 * The 3-tier mock is projected onto the 2-tier CON-01 contract for the legacy
 * fields: "free" -> free (isPro/assistedApplication false); "pro" AND "max" ->
 * pro (isPro/assistedApplication true, legacy `tier` "pro" since the contract
 * has no "max"). The FE-07 fields below carry the true tier + per-tier limits.
 */
export function useEntitlements(tier: BillingTier = getBillingTier()): EntitlementsView {
  // Single source of truth: components pass the REACTIVE tier from `useBilling()`
  // (the mounted BillingProvider context) so all Pro framing reacts to the same
  // state and can't diverge from the OpportunityCard padlocks during hydration or
  // after an in-modal tier change (arch review MEDIUM). The `getBillingTier()`
  // default is a non-reactive fallback for non-React callers/tests only.
  const billingTier = tier;
  const feats = billingFeatures(billingTier);
  // max collapses to "pro" for the legacy 2-tier contract fields only.
  const legacyTier: SubscriptionTier = billingTier === "free" ? "free" : "pro";
  const ent = readEntitlements(legacyTier);
  return {
    tier: legacyTier,
    isPro: legacyTier === "pro",
    features: ent.features,
    assistedApplication: ent.features.assisted_application,
    billingTier,
    autoFillEnabled: feats.autoFill,
    competitorEnabled: feats.competitor,
    autoFillLimitPerMonth: feats.autoFillLimitPerMonth,
  };
}

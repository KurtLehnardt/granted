import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isForecasted,
  isEvergreen,
  opportunityAvailability,
  isClosingSoon,
  isDeadlinePassed,
  expiredCount,
  fundingCell,
  closingSoonCount,
  money,
} from "../opportunitySummary";

/**
 * F1 — forecasted-vs-current labels + evergreen-safe math.
 *
 * Mirrors the existing pure-helper test style (node:test + assert, no
 * network, no DOM — see components/__tests__/AgencyMap.test.ts).
 */

describe("isForecasted", () => {
  test("true when the legacy boolean is true", () => {
    assert.equal(isForecasted({ forecasted: true }), true);
  });

  test("false when the legacy boolean is explicitly false, even if status says forecasted", () => {
    assert.equal(isForecasted({ forecasted: false, status: "forecasted" }), false);
  });

  test("falls back to status:'forecasted' when the boolean is absent", () => {
    assert.equal(isForecasted({ status: "forecasted" }), true);
  });

  test("false when neither signal is present", () => {
    assert.equal(isForecasted({}), false);
  });
});

describe("isEvergreen", () => {
  test("true for rolling / continuous / standing status", () => {
    assert.equal(isEvergreen({ status: "rolling" }), true);
    assert.equal(isEvergreen({ status: "continuous" }), true);
    assert.equal(isEvergreen({ status: "standing" }), true);
  });

  test("false for open/closed/unknown/missing status", () => {
    assert.equal(isEvergreen({ status: "open" }), false);
    assert.equal(isEvergreen({ status: "closed" }), false);
    assert.equal(isEvergreen({ status: "unknown" }), false);
    assert.equal(isEvergreen({}), false);
  });

  test("never evergreen when forecasted, even if status is rolling", () => {
    assert.equal(isEvergreen({ forecasted: true, status: "rolling" }), false);
  });

  test("a merely-missing deadline is NOT inferred as evergreen (no fabrication)", () => {
    assert.equal(isEvergreen({ deadline: undefined }), false);
  });
});

describe("opportunityAvailability", () => {
  test("forecasted wins over everything else", () => {
    const result = opportunityAvailability({ forecasted: true, status: "open", deadline: "2027-01-01" });
    assert.equal(result?.kind, "forecasted");
    assert.match(result!.label, /not yet open/i);
  });

  test("closed status labels as closed", () => {
    assert.equal(opportunityAvailability({ status: "closed" })?.kind, "closed");
  });

  test("evergreen status labels as rolling", () => {
    assert.equal(opportunityAvailability({ status: "rolling" })?.kind, "rolling");
  });

  test("explicit open status labels as open", () => {
    assert.equal(opportunityAvailability({ status: "open" })?.kind, "open");
  });

  test("a real deadline with no Canon status still honestly reads as open", () => {
    assert.equal(opportunityAvailability({ deadline: "2027-01-01" })?.kind, "open");
  });

  test("no signal at all -> null (never fabricate a status)", () => {
    assert.equal(opportunityAvailability({}), null);
  });
});

describe("isClosingSoon", () => {
  const now = Date.parse("2026-08-16T00:00:00.000Z");

  test("true for a deadline within the window", () => {
    assert.equal(isClosingSoon({ deadline: "2026-09-01T00:00:00.000Z" }, { now }), true);
  });

  test("false for a deadline beyond the window", () => {
    assert.equal(isClosingSoon({ deadline: "2027-06-01T00:00:00.000Z" }, { now }), false);
  });

  test("false for a deadline already in the past", () => {
    assert.equal(isClosingSoon({ deadline: "2026-01-01T00:00:00.000Z" }, { now }), false);
  });

  test("false with no deadline at all", () => {
    assert.equal(isClosingSoon({}, { now }), false);
  });

  test("false for an unparseable deadline string", () => {
    assert.equal(isClosingSoon({ deadline: "not-a-date" }, { now }), false);
  });

  test("evergreen-safe: never closing-soon even with a stray in-window deadline value", () => {
    assert.equal(
      isClosingSoon({ status: "rolling", deadline: "2026-09-01T00:00:00.000Z" }, { now }),
      false,
    );
    assert.equal(
      isClosingSoon({ status: "continuous", deadline: "2026-09-01T00:00:00.000Z" }, { now }),
      false,
    );
    assert.equal(
      isClosingSoon({ status: "standing", deadline: "2026-09-01T00:00:00.000Z" }, { now }),
      false,
    );
  });

  test("closed-safe: never closing-soon once closed", () => {
    assert.equal(
      isClosingSoon({ status: "closed", deadline: "2026-09-01T00:00:00.000Z" }, { now }),
      false,
    );
  });

  test("respects a custom window", () => {
    assert.equal(
      isClosingSoon({ deadline: "2026-08-20T00:00:00.000Z" }, { now, windowDays: 3 }),
      false,
    );
    assert.equal(
      isClosingSoon({ deadline: "2026-08-18T00:00:00.000Z" }, { now, windowDays: 3 }),
      true,
    );
  });
});

describe("isDeadlinePassed", () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");

  test("true for a deadline strictly before now", () => {
    assert.equal(isDeadlinePassed({ deadline: "2026-08-14T00:00:00.000Z" }, { now }), true);
    // US MM/DD/YYYY form, as the committed corpus stores deadlines.
    assert.equal(isDeadlinePassed({ deadline: "08/27/2026" }, { now }), true);
  });

  test("false for a future deadline", () => {
    assert.equal(isDeadlinePassed({ deadline: "2026-10-09T00:00:00.000Z" }, { now }), false);
    assert.equal(isDeadlinePassed({ deadline: "10/09/2026" }, { now }), false);
  });

  test("false with no deadline at all (missing data is not a passed deadline)", () => {
    assert.equal(isDeadlinePassed({}, { now }), false);
  });

  test("false for an unparseable deadline string (guards Invalid Date)", () => {
    assert.equal(isDeadlinePassed({ deadline: "not-a-date" }, { now }), false);
  });

  test("evergreen-safe: a rolling/continuous/standing program is never expired, even with a past deadline value", () => {
    assert.equal(isDeadlinePassed({ status: "rolling", deadline: "2026-08-14T00:00:00.000Z" }, { now }), false);
    assert.equal(isDeadlinePassed({ status: "continuous", deadline: "2026-08-14T00:00:00.000Z" }, { now }), false);
    assert.equal(isDeadlinePassed({ status: "standing", deadline: "2026-08-14T00:00:00.000Z" }, { now }), false);
  });

  test("forecasted-safe: a not-yet-open program is never expired (its date is an estimate)", () => {
    assert.equal(isDeadlinePassed({ forecasted: true, deadline: "2026-08-14T00:00:00.000Z" }, { now }), false);
    assert.equal(isDeadlinePassed({ status: "forecasted", deadline: "2026-08-14T00:00:00.000Z" }, { now }), false);
  });

  test("mutually exclusive with isClosingSoon: no opportunity is ever both", () => {
    const past = { deadline: "2026-08-14T00:00:00.000Z" };
    const soon = { deadline: "2026-09-20T00:00:00.000Z" };
    assert.equal(isDeadlinePassed(past, { now }) && isClosingSoon(past, { now }), false);
    assert.equal(isDeadlinePassed(soon, { now }) && isClosingSoon(soon, { now }), false);
    // The past one is expired-not-soon; the near one is soon-not-expired.
    assert.equal(isDeadlinePassed(past, { now }), true);
    assert.equal(isClosingSoon(soon, { now }), true);
  });
});

describe("expiredCount", () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");

  test("counts only genuinely-dated, non-evergreen matches whose deadline has passed", () => {
    const shown = [
      { opportunity: { deadline: "2026-08-14T00:00:00.000Z" } }, // passed
      { opportunity: { status: "continuous", deadline: "2026-08-14T00:00:00.000Z" } }, // evergreen guard
      { opportunity: { forecasted: true, deadline: "2026-08-14T00:00:00.000Z" } }, // forecasted guard
      { opportunity: { deadline: "2026-10-09T00:00:00.000Z" } }, // still open
      { opportunity: {} }, // no deadline
    ];
    assert.equal(expiredCount(shown, { now }), 1);
  });

  test("handles a match with no opportunity", () => {
    assert.equal(expiredCount([{}], { now }), 0);
  });
});

describe("fundingCell", () => {
  test("never shows $0+ when every tier sums to zero", () => {
    const shown = [
      { tier: "likely", opportunity: {} },
      { tier: "adjacent", opportunity: {} },
    ];
    assert.equal(fundingCell(shown), null);
  });

  test("prefers stated funding ranges from strong matches", () => {
    const shown = [
      { tier: "likely", opportunity: { fundingHigh: 500_000 } },
      { tier: "verify", opportunity: { fundingLow: 250_000 } },
    ];
    const result = fundingCell(shown);
    assert.equal(result?.label, "potential funding identified");
    assert.equal(result?.n, money(750_000));
  });

  test("falls back to median award to similar companies", () => {
    const shown = [{ tier: "likely", opportunity: {}, history: { medianAward: 300_000 } }];
    const result = fundingCell(shown);
    assert.equal(result?.label, "median award to similar companies");
  });

  test("falls back to total awarded to similar companies as a last resort", () => {
    const shown = [{ tier: "adjacent", opportunity: {}, history: { totalAwarded: 1_200_000 } }];
    const result = fundingCell(shown);
    assert.equal(result?.label, "awarded to similar companies");
  });
});

describe("closingSoonCount", () => {
  const now = Date.parse("2026-08-16T00:00:00.000Z");

  test("counts only genuinely-dated, non-evergreen matches within the window", () => {
    const shown = [
      { opportunity: { deadline: "2026-09-01T00:00:00.000Z" } }, // within window
      { opportunity: { status: "rolling", deadline: "2026-09-01T00:00:00.000Z" } }, // evergreen guard
      { opportunity: { deadline: "2027-06-01T00:00:00.000Z" } }, // too far out
      { opportunity: {} }, // no deadline
    ];
    assert.equal(closingSoonCount(shown, { now }), 1);
  });

  test("handles a match with no opportunity", () => {
    assert.equal(closingSoonCount([{}], { now }), 0);
  });
});

describe("money", () => {
  test("formats millions with one decimal and a trailing +", () => {
    assert.equal(money(1_250_000), "$1.3M+");
  });

  test("formats thousands rounded with a trailing +", () => {
    assert.equal(money(75_000), "$75K+");
  });
});

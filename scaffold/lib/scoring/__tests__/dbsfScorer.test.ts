import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { shrinkCriteria, dbsfScores, type ScoreSignals } from "../dbsfScorer";

describe("shrinkCriteria (Beta(2,2) posterior mean)", () => {
  test("1/1 shrinks well below raw 100%", () => {
    const s = shrinkCriteria(1, 1);
    assert.ok(s < 1);
    assert.ok(Math.abs(s - 0.6) < 1e-9); // (1+2)/(1+4)
  });

  test("9/10 stays close to raw 90%", () => {
    const s = shrinkCriteria(9, 10);
    assert.ok(Math.abs(s - 11 / 14) < 1e-9);
    assert.ok(Math.abs(s - 0.9) < 0.15);
  });

  test("0/5 stays near raw 0%", () => {
    const s = shrinkCriteria(0, 5);
    assert.ok(Math.abs(s - 2 / 9) < 1e-9);
    assert.ok(s < 0.25);
  });

  test("9/10 outranks 1/1 after shrinkage", () => {
    assert.ok(shrinkCriteria(9, 10) > shrinkCriteria(1, 1));
  });
});

describe("dbsfScores", () => {
  test("empty array returns []", () => {
    assert.deepEqual(dbsfScores([]), []);
  });

  test("single candidate: sigma=0 normalizes every signal to 0.5", () => {
    const [s] = dbsfScores([
      { cosine: 0.9, bm25: 12, criteriaMet: 3, criteriaCount: 4, metadataOverlap: 0.7, eligibility: "eligible" },
    ]);
    // cos/crit/bm/meta = 0.5, elig = 1 -> 0.5*0.85 + 0.15 = 0.575 -> 58
    assert.equal(s, 58);
  });

  test("identical cosine scores normalize to 0.5 (equal outputs)", () => {
    const c: ScoreSignals[] = [0.5, 0.5, 0.5].map((cosine) => ({ cosine, eligibility: "eligible" }));
    const out = dbsfScores(c);
    // (0.5*0.3 + 1*0.15)/0.45 = 0.6667 -> 67
    assert.deepEqual(out, [67, 67, 67]);
  });

  test("highest cosine gets highest score", () => {
    const out = dbsfScores([
      { cosine: 0.1, eligibility: "eligible" },
      { cosine: 0.9, eligibility: "eligible" },
      { cosine: 0.5, eligibility: "eligible" },
    ]);
    assert.ok(out[1] > out[2]);
    assert.ok(out[2] > out[0]);
  });

  test("missing signal redistributes weight and still yields a valid score", () => {
    const out = dbsfScores([
      { cosine: 0.2, eligibility: "eligible" },
      { cosine: undefined, eligibility: "eligible" },
      { cosine: 0.8, eligibility: "eligible" },
    ]);
    // candidate without cosine: only eligibility present -> 1.0 -> 100
    assert.equal(out[1], 100);
    for (const s of out) {
      assert.ok(Number.isInteger(s) && s >= 0 && s <= 100);
    }
  });

  test("excluded eligibility is capped at 15", () => {
    const out = dbsfScores([
      { cosine: 0.99, bm25: 50, criteriaMet: 10, criteriaCount: 10, metadataOverlap: 1, eligibility: "excluded" },
      { cosine: 0.1, bm25: 1, criteriaMet: 0, criteriaCount: 10, metadataOverlap: 0, eligibility: "eligible" },
    ]);
    assert.ok(out[0] <= 15);
  });

  test("known weighted output for 3 candidates (hand-calculated)", () => {
    // cosine [0.2,0.5,0.8]: mu=0.5, sigma=sqrt(0.06)=0.24495
    // norm(0.8)=0.5+0.3/(6*0.24495)=0.70412; norm(0.5)=0.5; norm(0.2)=0.29588
    // score = (0.3*norm + 0.15*1) / 0.45
    //   0.8 -> 0.80275 -> 80 ; 0.5 -> 0.66667 -> 67 ; 0.2 -> 0.53059 -> 53
    const out = dbsfScores([
      { cosine: 0.2, eligibility: "eligible" },
      { cosine: 0.5, eligibility: "eligible" },
      { cosine: 0.8, eligibility: "eligible" },
    ]);
    assert.deepEqual(out, [53, 67, 80]);
  });
});

describe("dbsfScores edge cases", () => {
  test("only eligibility present still produces a score", () => {
    assert.deepEqual(
      dbsfScores([{ eligibility: "eligible" }, { eligibility: "conditional" }, { eligibility: "unknown" }]),
      [100, 60, 30],
    );
  });

  test("20+ candidates: no crash, integers in 0-100", () => {
    const elig = ["eligible", "conditional", "unknown", "excluded"] as const;
    const cands: ScoreSignals[] = Array.from({ length: 30 }, (_, i) => ({
      cosine: i / 30,
      bm25: (i * 7) % 11,
      criteriaMet: i % 6,
      criteriaCount: 5,
      metadataOverlap: (i % 5) / 5,
      eligibility: elig[i % 4],
    }));
    const out = dbsfScores(cands);
    assert.equal(out.length, 30);
    for (const s of out) assert.ok(Number.isInteger(s) && s >= 0 && s <= 100);
  });

  test("bm25 all zeros normalizes to 0.5", () => {
    const out = dbsfScores([
      { bm25: 0, eligibility: "eligible" },
      { bm25: 0, eligibility: "eligible" },
    ]);
    // (0.5*0.15 + 1*0.15)/0.30 = 0.75 -> 75
    assert.deepEqual(out, [75, 75]);
  });
});

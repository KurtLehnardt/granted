import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { scoreDescription, FILLER_WORDS } from "../descriptionStrength";

/**
 * The meter's whole reason for not being a word counter is the pair in
 * "ordering" below, which was measured against the real 791-program corpus:
 * the buzzword blurb has ~2x the words and ~2x the unique words of the terse
 * vertical-farm line, and retrieves nothing relevant, while the terse line
 * retrieves three on-topic farm programs. Any future "simplification" toward
 * length or unique-word count will flip that test red, which is the point.
 */

const TERSE_BUT_CONCRETE = "vertical farm using llm for crop growth and serving food deserts";

const BUZZWORD_PADDING =
  "we are an innovative company leveraging cutting-edge technology to deliver " +
  "scalable solutions and drive meaningful impact for our customers and " +
  "stakeholders across many markets";

const FULL =
  "We operate indoor vertical farms in converted warehouses, using machine learning " +
  "models to optimise crop growth cycles, lighting and nutrient dosing for leafy greens. " +
  "We are a 9-person Colorado company distributing produce into USDA-designated food " +
  "deserts, and we are seeking funding to expand growing capacity and run a " +
  "nutrition-outcomes study with a local health department.";

describe("scoreDescription — ordering (the reason this isn't a word counter)", () => {
  test("a terse but concrete description beats a longer buzzword one", () => {
    const terse = scoreDescription(TERSE_BUT_CONCRETE);
    const buzz = scoreDescription(BUZZWORD_PADDING);

    assert.ok(
      BUZZWORD_PADDING.length > TERSE_BUT_CONCRETE.length,
      "precondition: the buzzword blurb really is the longer text",
    );
    assert.ok(
      terse.score > buzz.score,
      `concrete (${terse.score}) must beat buzzword padding (${buzz.score}) despite being shorter`,
    );
  });

  test("padding a description with filler LOWERS its score", () => {
    const plain = scoreDescription(TERSE_BUT_CONCRETE);
    const padded = scoreDescription(
      TERSE_BUT_CONCRETE + " We are an innovative, mission-driven company leveraging " +
        "best-in-class scalable solutions to empower stakeholders.",
    );
    assert.ok(
      padded.score <= plain.score,
      `filler must not be a way to game the meter (plain ${plain.score}, padded ${padded.score})`,
    );
  });

  test("a full, specific description scores strong", () => {
    const full = scoreDescription(FULL);
    assert.equal(full.band, "strong");
    assert.ok(full.score >= 70, `expected >=70, got ${full.score}`);
  });
});

describe("scoreDescription — bands and fields", () => {
  test("empty input is weak, scores 0, and asks for the basics", () => {
    for (const empty of ["", "   ", null, undefined]) {
      const r = scoreDescription(empty);
      assert.equal(r.score, 0);
      assert.equal(r.band, "weak");
      assert.equal(r.contentWordCount, 0);
      assert.equal(r.suggestions.length, 1);
    }
  });

  test("score stays within 0–100 for hostile input", () => {
    const inputs = [
      "a",
      "the the the the the",
      Array.from(FILLER_WORDS).join(" "),
      "word ".repeat(5000),
      "🌱🌱🌱",
    ];
    for (const i of inputs) {
      const r = scoreDescription(i);
      assert.ok(r.score >= 0 && r.score <= 100, `${r.score} out of range for ${i.slice(0, 20)}`);
      assert.ok(["weak", "fair", "strong"].includes(r.band));
    }
  });

  test("an all-filler description scores near zero and names the filler back", () => {
    const r = scoreDescription(BUZZWORD_PADDING);
    assert.equal(r.band, "weak");
    assert.ok(r.fillerFound.length >= 3, "should surface the filler it found");
    assert.ok(
      r.suggestions.some((s) => s.includes("Replace vague words")),
      "should tell the user which words are dead weight",
    );
  });

  test("suggestions are actionable and drop away as the description improves", () => {
    const weak = scoreDescription(TERSE_BUT_CONCRETE);
    const strong = scoreDescription(FULL);
    assert.ok(weak.suggestions.length > strong.suggestions.length);
    // FULL states headcount ("9-person"), so the size prompt must be gone.
    assert.ok(!strong.suggestions.some((s) => s.includes("size or stage")));
    // And nothing should ever advise "say who it's for" — that heuristic was
    // removed for contradicting descriptions that already did (see the module).
    assert.ok(!weak.suggestions.concat(strong.suggestions).some((s) => s.includes("who it's for")));
  });

  test("filler words are not counted as content", () => {
    const r = scoreDescription("innovative scalable robust solutions platform technology");
    assert.equal(r.contentWordCount, 0, "every one of those is filler");
  });

  test("identical content in a different order scores the same (no positional bias)", () => {
    const a = scoreDescription("acoustic sensors detect wildfire ignition forested terrain");
    const b = scoreDescription("forested terrain ignition wildfire detect sensors acoustic");
    assert.equal(a.score, b.score);
  });
});

/**
 * CALIBRATION GUARD — the check that caught this meter being wrong.
 *
 * data/precomputed.json holds the four sample companies the app ships and
 * replays from the welcome guide. They are curated, they each return 33
 * matches, and they are the closest thing the repo has to ground truth for
 * "a description that works".
 *
 * An earlier calibration graded them 34–45, i.e. told the user that the
 * product's own worked examples were thin — and graded the manufacturing one
 * WEAK while flagging "advanced" as filler, though "advanced manufacturing" is
 * a federal program category appearing in 11% of the corpus. Scoring against
 * real data rather than invented strings is what surfaced that, so the real
 * data stays in the test.
 */
describe("calibration against the shipped sample companies", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const samples: { id: string; key: string }[] = JSON.parse(
    readFileSync(join(dir, "..", "..", "data", "precomputed.json"), "utf8"),
  );

  test("the fixture is present and looks like descriptions", () => {
    assert.ok(samples.length >= 4, "expected the shipped sample companies");
    for (const s of samples) assert.ok(s.key.length > 80, `${s.id}: not a real description`);
  });

  test("no curated sample company reads as thin", () => {
    const thin = samples
      .map((s) => ({ id: s.id, ...scoreDescription(s.key) }))
      .filter((r) => r.band === "weak");
    assert.deepEqual(
      thin.map((t) => `${t.id} (${t.score})`),
      [],
      "the app's own worked examples must not be graded weak — that is the meter being wrong, not the samples",
    );
  });

  test("every curated sample outscores the buzzword blurb by a wide margin", () => {
    const buzz = scoreDescription(BUZZWORD_PADDING).score;
    for (const s of samples) {
      const r = scoreDescription(s.key);
      assert.ok(r.score > buzz + 30, `${s.id} scored ${r.score}, buzzword ${buzz} — too close`);
    }
  });
});

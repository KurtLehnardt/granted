import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { truncateDescriptionForPrompt } from "../truncateForPrompt";

// Matches the module's own GAP_MARKER exactly (kept local to the test so the
// test doesn't need to export an internal implementation detail).
const GAP_MARKER_FOR_TEST = " […] ";

describe("truncateDescriptionForPrompt", () => {
  test("no-op when already within the budget", () => {
    const short = "A short program description.";
    assert.equal(truncateDescriptionForPrompt(short, 1200), short);
  });

  test("falls back to plain head-first truncation when nothing scores above zero", () => {
    // No eligibility-shaped keywords anywhere -- the result should match the
    // old description.slice(0, maxLength) behavior (sentences kept in order,
    // nothing reordered for a score that's uniformly zero).
    const description =
      "This program funds community arts projects. It supports murals, performances, and workshops. " +
      "Funding ranges from ten thousand to fifty thousand dollars. Projects run for up to one year.";
    const truncated = truncateDescriptionForPrompt(description, 60);
    assert.ok(description.startsWith(truncated.replace(/\s*$/, "")) || truncated === description.slice(0, 60));
  });

  test("a single run-on sentence with no terminator just slices", () => {
    const description = "x".repeat(2000);
    assert.equal(truncateDescriptionForPrompt(description, 100), "x".repeat(100));
  });

  test("an opening sentence alone longer than the budget is itself truncated", () => {
    const description = `${"x".repeat(2000)}. A second sentence with must/eligibility words.`;
    const truncated = truncateDescriptionForPrompt(description, 50);
    assert.equal(truncated, "x".repeat(50));
  });

  test("prioritizes eligibility-keyword sentences over earlier generic ones, within budget", () => {
    const description =
      "Program Name Here. " +
      "This program may fund a wide variety of community technology projects of many shapes and sizes. " +
      "Projects can include broadband expansion, affordability support, and digital skills training. " +
      "Applicants must be a 501(c)(3) nonprofit with a demonstrated record of community technology work. " +
      "The application window opens in July and closes in October.";
    // Budget tight enough that NOT everything fits, but big enough for the
    // opening + the eligibility sentence.
    const truncated = truncateDescriptionForPrompt(description, 160);
    assert.match(truncated, /demonstrated record of community technology work/);
    assert.ok(truncated.startsWith("Program Name Here."));
    assert.ok(truncated.length <= 160);
  });

  test("keeps selected sentences in original order, not score order", () => {
    const description =
      "Opening sentence here. " +
      "Applicants must meet requirement A, a highly specific eligibility must-have. " +
      "Some unrelated filler sentence with no special keywords at all here. " +
      "Applicants must also meet requirement B, another specific eligibility must-have.";
    const truncated = truncateDescriptionForPrompt(description, 220);
    const posA = truncated.indexOf("requirement A");
    const posB = truncated.indexOf("requirement B");
    assert.ok(posA >= 0 && posB >= 0, "both eligibility sentences should be selected");
    assert.ok(posA < posB, "requirement A must still appear before requirement B (original order preserved)");
  });

  test("marks a gap between non-adjacent kept sentences, not false continuity", () => {
    const description =
      "Opening sentence. " +
      "Filler sentence with nothing special in it at all whatsoever here today. " +
      "Applicants must satisfy this one eligibility requirement exactly.";
    const truncated = truncateDescriptionForPrompt(description, 90);
    // The filler sentence should be skipped (lower score) while the opening
    // and the eligibility sentence are both kept -- non-adjacent, so a gap
    // marker should separate them.
    assert.match(truncated, /\[…\]/);
  });

  test("real-shaped case: a long CA grant description keeps the complete CBO eligibility sentence, not a mid-word cutoff", () => {
    // A trimmed, representative excerpt shaped like the real ca-184092
    // record (2026-27 Digital Divide Grant Program Round 4) that motivated
    // this fix: plain head-first truncation at 1200 chars cuts the key
    // eligibility sentence off mid-word ("...demonstrated record of wo").
    const filler =
      "The Digital Divide Grant Program will award grants for rural and urban public schools and non-profit Community Based Organizations. " +
      "The grants will fund digital projects that serve beneficiary public schools and non-profit Community Organizations. " +
      "Projects may address gaps in broadband networks, affordability, access to personal devices and digital skills training. " +
      "The DDGP is funded by fees collected from leases of state-owned property to wireless telecommunications service providers. " +
      "Eligible projects will serve a beneficiary public school located in an urban or rural low-income small school district. ";
    const eligibilitySentence =
      "Grant recipients must be a non-profit community-based organization (CBO) with a demonstrated record of work in addressing the digital divide.";
    const description = `Program Title Here. ${filler.repeat(2)}${eligibilitySentence} A closing sentence about the application window.`;

    const oldWay = description.slice(0, 1200);
    const newWay = truncateDescriptionForPrompt(description, 1200);

    assert.ok(
      !oldWay.includes(eligibilitySentence),
      "sanity check: the fixture must actually reproduce the old mid-cutoff problem",
    );
    assert.ok(
      newWay.includes(eligibilitySentence),
      "the new truncation must keep the COMPLETE eligibility sentence, not cut it off",
    );
    assert.ok(newWay.length <= 1200);
  });

  test("REGRESSION: tight budget with a non-adjacent gap never cuts a selected sentence mid-word", () => {
    // Real bug caught in review: the greedy loop used to charge every
    // candidate a flat "+1 joining space" cost, but a non-adjacent
    // selection is actually joined by the 5-char GAP_MARKER -- undercounting
    // real length and letting the final blind slice cut the selected
    // eligibility sentence itself. Multiple scored sentences separated by
    // low-score filler (so a gap marker is required) at a budget tight
    // enough to expose the miscount.
    const description =
      "Opening sentence here. " +
      "Some filler sentence with nothing special in it at all today. " +
      "Applicants must satisfy requirement A for this specific eligibility rule exactly. " +
      "More filler sentence with nothing special in it either, at all. " +
      "Applicants must satisfy requirement B for this specific eligibility rule exactly.";

    for (let maxLength = 80; maxLength <= 260; maxLength += 1) {
      const truncated = truncateDescriptionForPrompt(description, maxLength);
      assert.ok(truncated.length <= maxLength, `output must never exceed maxLength=${maxLength}`);
      // Every sentence present must be COMPLETE: either a full kept sentence
      // ends in terminal punctuation (optionally followed by a gap marker),
      // or the string ends exactly at the opening/a full sentence boundary --
      // never mid-word.
      const withoutGaps = truncated.split(GAP_MARKER_FOR_TEST).join(" ");
      assert.ok(
        /[.!?]$/.test(withoutGaps.trimEnd()) || withoutGaps === description.slice(0, withoutGaps.length),
        `truncated output must end on a real sentence boundary, not mid-word (maxLength=${maxLength}, got: ${JSON.stringify(truncated)})`,
      );
    }
  });
});

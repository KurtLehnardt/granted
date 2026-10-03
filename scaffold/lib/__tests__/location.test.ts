import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeStateName, statesMatch } from "../location";

test("[case] bare full name", () => {
  assert.equal(normalizeStateName("Utah"), "Utah");
  assert.equal(normalizeStateName("utah"), "Utah");
});

test("[case] bare abbreviation", () => {
  assert.equal(normalizeStateName("UT"), "Utah");
  assert.equal(normalizeStateName("ut"), "Utah");
});

test("[case] City, ST", () => {
  assert.equal(normalizeStateName("Draper, UT"), "Utah");
});

test("[case] City, State", () => {
  assert.equal(normalizeStateName("Salt Lake City, Utah"), "Utah");
});

test("[case] City, ST ZIP", () => {
  assert.equal(normalizeStateName("Draper, UT 84020"), "Utah");
});

test("[case] City, State ZIP+4", () => {
  assert.equal(normalizeStateName("Salt Lake City, Utah 84020-1234"), "Utah");
});

test("[edge] multi-word full name via comma tail", () => {
  assert.equal(normalizeStateName("Austin, Texas"), "Texas");
  assert.equal(normalizeStateName("Buffalo, New York"), "New York");
});

test("[edge] Washington, DC resolves to the District, not the state", () => {
  assert.equal(normalizeStateName("Washington, DC"), "District of Columbia");
});

test("[edge] only an exact comma-tail resolves -- trailing words or no comma at all stay undefined", () => {
  // Deliberate design choice (see the function's doc comment): there is no
  // free scan over prose for a state name. The comma-tail must be an EXACT
  // state (plus optional ZIP) -- extra trailing words defeat it, same as no
  // comma at all. This is intentionally conservative, not a missed case: a
  // free scan can't distinguish a real state name from the first word of an
  // unrelated place name (see the next test).
  assert.equal(normalizeStateName("Headquartered in Draper, Utah"), "Utah"); // clean comma-tail
  assert.equal(normalizeStateName("Headquartered in Draper, Utah area"), undefined); // trailing word defeats it
  assert.equal(normalizeStateName("Based out of Texas"), undefined); // no comma at all
});

test("[edge] unparseable input returns undefined, never a default", () => {
  assert.equal(normalizeStateName(""), undefined);
  assert.equal(normalizeStateName(undefined), undefined);
  assert.equal(normalizeStateName(null), undefined);
  assert.equal(normalizeStateName("Remote"), undefined);
  assert.equal(normalizeStateName("asdf1234"), undefined);
});

test("[edge] bare place names containing a state name never match without a comma", () => {
  // No free-text scan at all, so none of these can wrongly resolve --
  // including the case a word-boundary-guarded scan still got wrong: a
  // state name as the whole first WORD of a real, different place
  // ("Idaho Springs" is in Colorado; "Nevada City" is in California),
  // which a boundary check alone can't distinguish from someone just
  // typing the state name.
  assert.equal(normalizeStateName("Ohiopyle"), undefined); // real PA town
  assert.equal(normalizeStateName("Washingtonville"), undefined); // real NY village
  assert.equal(normalizeStateName("Idaho Springs"), undefined); // real CO town
  assert.equal(normalizeStateName("Nevada City"), undefined); // real CA town
  // The comma-qualified form always resolves correctly via the comma-tail step.
  assert.equal(normalizeStateName("Ohiopyle, PA"), "Pennsylvania");
  assert.equal(normalizeStateName("Idaho Springs, CO"), "Colorado");
});

test("[edge] common-word collision guard: no bare-abbreviation scan over prose", () => {
  // "or" and "in" are real abbreviations (Oregon, Indiana) but must not be
  // picked up from arbitrary prose -- only a comma-tail or the whole string.
  assert.equal(normalizeStateName("Remote or hybrid, based in Draper, UT"), "Utah");
});

test("statesMatch: both resolve and agree", () => {
  assert.equal(statesMatch("Utah", "UT"), true);
  assert.equal(statesMatch("Draper, UT 84020", "Utah"), true);
});

test("statesMatch: both resolve but disagree", () => {
  assert.equal(statesMatch("Utah", "Texas"), false);
});

test("statesMatch: one or both unresolvable is never a match", () => {
  assert.equal(statesMatch("Utah", "Remote"), false);
  assert.equal(statesMatch(undefined, "Utah"), false);
  assert.equal(statesMatch(undefined, undefined), false);
});

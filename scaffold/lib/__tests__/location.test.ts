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

test("[edge] no-comma substring fallback", () => {
  assert.equal(normalizeStateName("Headquartered in Draper, Utah area"), "Utah");
  assert.equal(normalizeStateName("Based out of Texas"), "Texas");
});

test("[edge] unparseable input returns undefined, never a default", () => {
  assert.equal(normalizeStateName(""), undefined);
  assert.equal(normalizeStateName(undefined), undefined);
  assert.equal(normalizeStateName(null), undefined);
  assert.equal(normalizeStateName("Remote"), undefined);
  assert.equal(normalizeStateName("asdf1234"), undefined);
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

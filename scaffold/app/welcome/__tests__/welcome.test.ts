import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { metadata, structuredData, TITLE, DESCRIPTION } from "../content";

/**
 * SEO/AEO + honest-claims smoke test for the /welcome landing page. Imports the
 * pure content module only (no React / next/link), matching the node:test +
 * assert style used across the repo. Guards the brand name, the required SEO
 * tags (title / description / OpenGraph / Twitter), and — because "the brand is
 * trust" — that the JSON-LD is grounded (real corpus size, real sources, free
 * price) and never claims to auto-file applications.
 *
 * The corpus-size claim is checked against the ACTUAL committed corpus length,
 * not a hardcoded number -- content.ts's "791" went stale silently once the
 * corpus grew to 968 (README had the same drift). Deriving it here means a
 * future corpus-size change that forgets to update the marketing copy fails
 * this test instead of shipping a wrong number, mirroring the same rationale
 * already applied to embedding-dimension checks in corpus-breadth.test.ts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_COUNT = JSON.parse(
  readFileSync(join(here, "../../../data/opportunities.json"), "utf8"),
).length;
describe("welcome landing metadata", () => {
  test("title and description carry the Granted brand + matched-funding thesis", () => {
    assert.equal(metadata.title, TITLE);
    assert.match(String(metadata.title), /Granted/);
    assert.match(String(metadata.title), /matched/i);
    assert.equal(metadata.description, DESCRIPTION);
    assert.match(String(metadata.description), new RegExp(String(CORPUS_COUNT)));
    assert.match(String(metadata.description), /grounded/i);
  });

  test("OpenGraph + Twitter tags are present and consistent", () => {
    const og = metadata.openGraph as
      | { siteName?: string; title?: string; type?: string }
      | null
      | undefined;
    assert.equal(og?.siteName, "Granted");
    assert.equal(og?.title, TITLE);
    assert.equal(og?.type, "website");
    const tw = metadata.twitter as
      | { card?: string; title?: string }
      | null
      | undefined;
    assert.equal(tw?.card, "summary_large_image");
    assert.equal(tw?.title, TITLE);
  });
});

describe("welcome structured data (JSON-LD)", () => {
  const graph = structuredData["@graph"];
  const org = graph.find((n) => n["@type"] === "Organization");
  const app = graph.find((n) => n["@type"] === "SoftwareApplication");

  test("serializes to valid JSON with schema.org context", () => {
    const json = JSON.stringify(structuredData);
    const parsed = JSON.parse(json);
    assert.equal(parsed["@context"], "https://schema.org");
    assert.ok(Array.isArray(parsed["@graph"]));
  });

  test("declares Organization + SoftwareApplication for Granted", () => {
    assert.ok(org, "Organization node present");
    assert.ok(app, "SoftwareApplication node present");
    assert.equal(org?.name, "Granted");
    assert.equal(app?.name, "Granted");
  });

  test("app claims are grounded — the real committed opportunity count, free to start", () => {
    assert.ok(app && "description" in app);
    const desc = (app as { description: string }).description;
    assert.match(desc, new RegExp(String(CORPUS_COUNT)));
    assert.match(desc, /grants\.gov/);
    assert.match(desc, /SAM\.gov/);
    const offers = (app as { offers: { price: string } }).offers;
    assert.equal(offers.price, "0");
  });

  test("makes no auto-file / fabrication claim (trust guardrail)", () => {
    const blob = JSON.stringify(structuredData).toLowerCase();
    assert.doesNotMatch(blob, /auto-?file|submits? (your )?application|files? (your )?application/);
    assert.doesNotMatch(blob, /guaranteed/);
  });
});

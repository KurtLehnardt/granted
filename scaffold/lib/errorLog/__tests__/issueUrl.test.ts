import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildIssueUrl, ISSUE_NEW_URL, issueTitle, MAX_ISSUE_URL_LENGTH, type IssueError } from "../issueUrl";

const context = { version: "0.2.3", os: "win32 10.0.26200 x64", provider: "cloud (anthropic)", searchMode: "builtin" };

function parse(url: string) {
  const u = new URL(url);
  return { base: `${u.origin}${u.pathname}`, title: u.searchParams.get("title") ?? "", body: u.searchParams.get("body") ?? "", labels: u.searchParams.get("labels") };
}

const err = (i: number, extra: Partial<IssueError> = {}): IssueError => ({
  id: `E-${"ABCDEFGHJK"[i % 10].repeat(6)}`,
  time: `2026-10-0${(i % 9) + 1}T10:00:00.000Z`,
  area: "search",
  message: `The search didn't complete (${i})`,
  stack: "at match (lib/match.ts:10:5)\nat run (lib/run.ts:3:1)",
  ...extra,
});

describe("the issue link", () => {
  test("a GitHub new-issue link with a title, the bug label and the body", () => {
    const { url } = buildIssueUrl({ context, errors: [err(1)], errorId: err(1).id });
    const p = parse(url);
    assert.equal(p.base, ISSUE_NEW_URL);
    assert.equal(p.labels, "bug");
    assert.match(p.title, /^Problem: The search didn't complete \(1\) \[E-BBBBBB\]$/);
    for (const heading of ["### What happened", "### Error ID", "### Environment", "### Recent errors"]) assert.ok(p.body.includes(heading), heading);
    assert.match(p.body, /Granted version: 0\.2\.3/);
    assert.match(p.body, /Operating system: win32 10\.0\.26200 x64/);
    assert.match(p.body, /Model provider: cloud \(anthropic\)/);
    assert.match(p.body, /Search mode: builtin/);
    assert.match(p.body, /E-BBBBBB/);
    assert.match(p.body, /at match \(lib\/match\.ts:10:5\)/);
  });

  test("everything is percent-encoded: &, #, newlines, quotes and non-ASCII survive the round trip", () => {
    const message = `a & b # c ? d = e + f "q" 'r' % 100 — naïve\nsecond line`;
    const { url } = buildIssueUrl({ context, errors: [err(1, { message })] });
    assert.doesNotMatch(url.slice(ISSUE_NEW_URL.length), /[ \n#"]/);
    assert.ok(parse(url).body.includes(message));
  });

  test("the headings match the repo's issue template", () => {
    const template = readFileSync(join(process.cwd(), "..", ".github", "ISSUE_TEMPLATE", "bug_report.yml"), "utf8");
    for (const label of ["What happened", "Error ID", "Environment", "Recent errors"]) assert.ok(template.includes(`label: ${label}`), label);
  });

  test("the clicked error goes first, wherever it is in the log", () => {
    const errors = [err(1), err(2), err(3)];
    const { url } = buildIssueUrl({ context, errors, errorId: err(3).id });
    const body = parse(url).body;
    assert.ok(body.indexOf("(3)") < body.indexOf("(1)"));
  });

  test("no errors: still a usable link", () => {
    const { url, included } = buildIssueUrl({ context, errors: [] });
    assert.equal(included, 0);
    assert.equal(parse(url).title, "Problem report");
    assert.match(parse(url).body, /No errors were recorded/);
  });

  test("a code fence in an error can't break out of the block", () => {
    const { url } = buildIssueUrl({ context, errors: [err(1, { message: "```\n# injected heading" })] });
    const body = parse(url).body;
    assert.equal(body.match(/```/g)?.length, 2);
  });
});

describe("length cap", () => {
  test("stays under ~7,000 characters, keeping the most recent errors and saying how many were left out", () => {
    const errors = Array.from({ length: 40 }, (_, i) => err(i, { message: `error ${i} ${"detail ".repeat(60)}` }));
    const link = buildIssueUrl({ context, errors });
    assert.ok(link.url.length <= MAX_ISSUE_URL_LENGTH, `${link.url.length}`);
    assert.ok(link.included >= 1 && link.included < 20);
    assert.equal(link.omitted, 40 - link.included);
    const body = parse(link.url).body;
    assert.match(body, /error 0 /);
    assert.doesNotMatch(body, /error 39 /);
    assert.match(body, new RegExp(`${link.omitted} more errors were left out`));
    assert.match(body, /Copy log/);
  });

  test("one enormous error is shortened rather than dropped", () => {
    const link = buildIssueUrl({ context, errors: [err(1, { message: "huge ".repeat(5000), stack: "at x\n".repeat(500) })], errorId: err(1).id });
    assert.ok(link.url.length <= MAX_ISSUE_URL_LENGTH);
    assert.equal(link.included, 1);
    assert.match(parse(link.url).body, /huge huge/);
  });

  test("any max length is respected", () => {
    for (const max of [500, 1500, 3000]) {
      const link = buildIssueUrl({ context, errors: Array.from({ length: 10 }, (_, i) => err(i)), maxLength: max });
      assert.ok(link.url.length <= max, `${max}: ${link.url.length}`);
    }
  });
});

describe("no secrets leave in the link", () => {
  test("even if the log somehow held them (sanitized again here), with this computer's own context too", () => {
    const errors = [
      err(1, {
        message: "401 from provider: sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ for kurt@example.com",
        stack: "at C:\\Users\\kurt\\granted\\scaffold\\lib\\llm\\client.ts:1:1",
      }),
      err(2, { message: "GET https://x.example/v1?key=AIzaSyA1234567890abcdefghijkl failed; my-own-secret-xyz" }),
    ];
    const { url } = buildIssueUrl({ context, errors, errorId: errors[0].id, sanitize: { user: "kurt", secrets: ["my-own-secret-xyz"] } });
    const decoded = decodeURIComponent(url);
    for (const leak of ["sk-ant-api03", "ZZZZZZZZ", "kurt@example.com", "C:\\Users\\kurt", "AIzaSy", "my-own-secret-xyz"]) {
      assert.ok(!decoded.includes(leak), `leaked ${leak}`);
    }
    assert.ok(!/\bkurt\b/i.test(decoded), "user name leaked");
    assert.match(decoded, /\[redacted-key\]/);
    assert.match(parse(url).title, /\[redacted-key\]/);
  });

  test("context values are sanitized too", () => {
    const { url } = buildIssueUrl({ context: { ...context, os: "linux /home/kurt/x" }, errors: [] });
    assert.doesNotMatch(decodeURIComponent(url), /kurt/);
  });

  test("the title is short", () => {
    assert.ok(issueTitle({ errors: [err(1, { message: "m".repeat(500) })], errorId: err(1).id }).length < 110);
    assert.match(issueTitle({ errors: [], source: "installer" }), /^Problem report \(installer\)$/);
  });
});

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  browserIssueUrl,
  errorIdOf,
  errorWithId,
  MAX_CLIENT_REPORTS,
  reportClientError,
  resetClientReportsForTests,
} from "../client";
import { isErrorId, newErrorId } from "../errorId";

function fakeFetch() {
  const sent: Array<{ url: string; body: any }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 201 });
  }) as unknown as typeof fetch;
  return { sent, f };
}

beforeEach(() => resetClientReportsForTests());

describe("correlation ids", () => {
  test("short, readable, distinct", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newErrorId()));
    assert.ok(ids.size > 495);
    for (const id of Array.from(ids)) assert.ok(isErrorId(id), id);
    assert.equal(isErrorId("E-0O1I00"), false);
    assert.equal(isErrorId("nope"), false);
  });
});

describe("reportClientError", () => {
  test("posts a sanitized entry to /api/logs and returns its id", () => {
    const { sent, f } = fakeFetch();
    const id = reportClientError("search", new Error("failed for jane@example.com with sk-ant-AAAAAAAAAAAAAAAAAAAA"), { fetchImpl: f });
    assert.ok(isErrorId(id));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "/api/logs");
    assert.equal(sent[0].body.action, "log");
    assert.equal(sent[0].body.entry.id, id);
    assert.equal(sent[0].body.entry.area, "search");
    assert.equal(sent[0].body.entry.message, "failed for [email] with [redacted-key]");
  });

  test("an error the server already logged keeps the server's id, and isn't sent again", () => {
    const { sent, f } = fakeFetch();
    const e = errorWithId("The search didn't complete.", "E-ABCDEF");
    assert.equal(errorIdOf(e), "E-ABCDEF");
    assert.equal(reportClientError("search", e, { fetchImpl: f }), "E-ABCDEF");
    assert.equal(sent.length, 0);
    assert.equal(errorIdOf(errorWithId("x", "garbage")), undefined);
  });

  test("the same error again within seconds reuses the first id", () => {
    const { sent, f } = fakeFetch();
    let now = 1000;
    const a = reportClientError("page", "boom", { fetchImpl: f, now: () => now });
    now += 1000;
    const b = reportClientError("page", "boom", { fetchImpl: f, now: () => now });
    now += 10_000;
    const c = reportClientError("page", "boom", { fetchImpl: f, now: () => now });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(sent.length, 2);
  });

  test("an error loop stops reporting after a cap, but still hands out ids", () => {
    const { sent, f } = fakeFetch();
    for (let i = 0; i < MAX_CLIENT_REPORTS + 20; i++) assert.ok(isErrorId(reportClientError("page", `e${i}`, { fetchImpl: f })));
    assert.equal(sent.length, MAX_CLIENT_REPORTS);
  });

  test("never throws: a failing or missing fetch, odd values", () => {
    const failing = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const throwing = (() => {
      throw new Error("sync");
    }) as unknown as typeof fetch;
    for (const v of [undefined, null, 1, { a: 1 }, Symbol("x")]) {
      assert.doesNotThrow(() => reportClientError("page", v, { fetchImpl: failing }));
      assert.doesNotThrow(() => reportClientError("page", `${String(v)}2`, { fetchImpl: throwing }));
    }
  });
});

test("the browser's own report link carries this error, sanitized", () => {
  const url = browserIssueUrl({ errorId: "E-ABCDEF", area: "search", message: "bad key sk-ant-AAAAAAAAAAAAAAAAAAAA" });
  const body = new URL(url).searchParams.get("body")!;
  assert.match(body, /E-ABCDEF/);
  assert.match(body, /bad key \[redacted-key\]/);
});

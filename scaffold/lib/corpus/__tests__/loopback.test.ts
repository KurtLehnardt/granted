import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackIp, isLoopbackRequest } from "../loopback";

function reqWithHeaders(headers: Record<string, string>, ip?: string) {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    ip,
  };
}

describe("isLoopbackIp", () => {
  test("accepts loopback forms", () => {
    assert.equal(isLoopbackIp("127.0.0.1"), true);
    assert.equal(isLoopbackIp("127.10.20.30"), true);
    assert.equal(isLoopbackIp("::1"), true);
    assert.equal(isLoopbackIp("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackIp("localhost"), true);
  });
  test("rejects non-loopback addresses", () => {
    assert.equal(isLoopbackIp("10.0.0.5"), false);
    assert.equal(isLoopbackIp("8.8.8.8"), false);
    assert.equal(isLoopbackIp("203.0.113.9"), false);
  });
});

describe("isLoopbackRequest", () => {
  test("x-forwarded-for loopback -> true", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ "x-forwarded-for": "127.0.0.1" })), true);
  });
  test("x-forwarded-for first hop non-loopback -> false", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ "x-forwarded-for": "203.0.113.9, 127.0.0.1" })), false);
  });
  test("x-real-ip loopback -> true, non-loopback -> false", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ "x-real-ip": "::1" })), true);
    assert.equal(isLoopbackRequest(reqWithHeaders({ "x-real-ip": "8.8.8.8" })), false);
  });
  test("no proxy headers and no req.ip -> treated as loopback (local dev)", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({})), true);
  });
  test("falls back to req.ip when no proxy headers", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({}, "203.0.113.9")), false);
    assert.equal(isLoopbackRequest(reqWithHeaders({}, "127.0.0.1")), true);
  });
});

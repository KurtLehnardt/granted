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
  test("a spoofed X-Forwarded-For claiming loopback is NOT trusted on its own", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ "x-forwarded-for": "127.0.0.1" })), false);
  });
  test("a spoofed X-Real-IP claiming loopback is NOT trusted on its own", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ "x-real-ip": "::1" })), false);
  });
  test("no address info at all -> denied, not assumed local", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({})), false);
  });
  test("same-origin Sec-Fetch-Site (the real SettingsForm fetch()) -> true", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ "sec-fetch-site": "same-origin" })), true);
  });
  test("cross-site Sec-Fetch-Site (another tab's page POSTing here) -> false", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ "sec-fetch-site": "cross-site" })), false);
    assert.equal(isLoopbackRequest(reqWithHeaders({ "sec-fetch-site": "same-site" })), false);
  });
  test("Origin that doesn't match Host -> false even with a loopback IP", () => {
    assert.equal(
      isLoopbackRequest(reqWithHeaders({ origin: "http://evil.example", host: "localhost:3000" }, "127.0.0.1")),
      false,
    );
  });
  test("Origin matching Host -> true", () => {
    assert.equal(
      isLoopbackRequest(reqWithHeaders({ origin: "http://localhost:3000", host: "localhost:3000" })),
      true,
    );
  });
  test("trusts req.ip (platform-supplied, not client headers) directly", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({}, "203.0.113.9")), false);
    assert.equal(isLoopbackRequest(reqWithHeaders({}, "127.0.0.1")), true);
  });
});

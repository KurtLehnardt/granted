import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackIp, isLoopbackRequest } from "../loopback";

function reqWithHeaders(headers: Record<string, string>) {
  return { headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
}

const LOCAL = { "x-forwarded-for": "127.0.0.1", host: "localhost:3000" };

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
  test("the real SettingsForm same-origin fetch() -> true", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ ...LOCAL, "sec-fetch-site": "same-origin" })), true);
  });
  test("no X-Forwarded-For at all -> denied, not assumed local", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ host: "localhost:3000", "sec-fetch-site": "same-origin" })), false);
  });
  test("X-Forwarded-For first hop not loopback -> false", () => {
    assert.equal(
      isLoopbackRequest(
        reqWithHeaders({ "x-forwarded-for": "192.168.1.20", host: "localhost:3000", "sec-fetch-site": "same-origin" }),
      ),
      false,
    );
  });
  test("a LAN browser opening the app by its LAN IP -> false (Host isn't loopback)", () => {
    assert.equal(
      isLoopbackRequest(
        reqWithHeaders({
          "x-forwarded-for": "127.0.0.1",
          host: "192.168.1.5:3000",
          origin: "http://192.168.1.5:3000",
          "sec-fetch-site": "same-origin",
        }),
      ),
      false,
    );
  });
  test("DNS rebinding (Host/Origin point at the attacker's domain) -> false", () => {
    assert.equal(
      isLoopbackRequest(
        reqWithHeaders({
          "x-forwarded-for": "127.0.0.1",
          host: "evil.example:3000",
          origin: "http://evil.example:3000",
          "sec-fetch-site": "same-origin",
        }),
      ),
      false,
    );
  });
  test("cross-site Sec-Fetch-Site, no matching Origin -> false", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ ...LOCAL, "sec-fetch-site": "cross-site" })), false);
    assert.equal(isLoopbackRequest(reqWithHeaders({ ...LOCAL, "sec-fetch-site": "same-site" })), false);
  });
  test("Origin that doesn't match Host -> false even with loopback XFF/Host", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ ...LOCAL, origin: "http://evil.example" })), false);
  });
  test("Origin matching Host -> true", () => {
    assert.equal(
      isLoopbackRequest(reqWithHeaders({ ...LOCAL, origin: "http://localhost:3000" })),
      true,
    );
  });
  test("neither Sec-Fetch-Site nor Origin present -> false", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders(LOCAL)), false);
  });
  test("Sec-Fetch-Site: none (browser-initiated navigation) -> true", () => {
    assert.equal(isLoopbackRequest(reqWithHeaders({ ...LOCAL, "sec-fetch-site": "none" })), true);
  });
});

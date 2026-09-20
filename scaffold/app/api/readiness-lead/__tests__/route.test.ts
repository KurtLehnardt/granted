import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "../route";
import { __resetRateLimits } from "@/lib/security/rateLimit";

/**
 * GTM free-tool email-capture route (STUB). Contract: validate the payload,
 * return { ok: true } on a good email, 400 on a bad one — and never a 5xx.
 * Real persistence is a documented TODO in the route.
 */

function post(body: string): NextRequest {
  return new NextRequest("http://localhost/api/readiness-lead", { method: "POST", body });
}

test("invalid JSON body -> 400", async () => {
  __resetRateLimits();
  const res = await POST(post("{ not json"));
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test("missing email -> 400", async () => {
  __resetRateLimits();
  const res = await POST(post(JSON.stringify({ grade: 80 })));
  assert.equal(res.status, 400);
});

test("malformed email -> 400", async () => {
  __resetRateLimits();
  const res = await POST(post(JSON.stringify({ email: "not-an-email" })));
  assert.equal(res.status, 400);
});

test("valid email -> { ok: true }", async () => {
  __resetRateLimits();
  const res = await POST(post(JSON.stringify({ email: "user@startup.io", grade: 82 })));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("valid email without a grade still succeeds", async () => {
  __resetRateLimits();
  const res = await POST(post(JSON.stringify({ email: "user@startup.io" })));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { makeAnthropicClientForKey } from "@/lib/llm/client";
import { resolveAnthropicKey } from "@/lib/llm/config";
import { MODEL } from "@/lib/claude";

/**
 * POST /api/llm/test-key — "Test key" button in Settings. Loopback-only (it
 * can spend real Anthropic credit). Makes ONE minimal request (max_tokens: 1,
 * on the app's existing hosted model) with the saved key, or a not-yet-saved
 * one passed in the body so a user can verify before hitting Save. Never
 * echoes the key back, on success or failure.
 */

export type TestKeyDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  resolveAnthropicKey: typeof resolveAnthropicKey;
  makeAnthropicClientForKey: typeof makeAnthropicClientForKey;
};

const REAL_DEPS: TestKeyDeps = { isLoopbackRequest, resolveAnthropicKey, makeAnthropicClientForKey };

export async function handleTestKeyPost(
  req: { headers: { get(name: string): string | null }; json: () => Promise<unknown> },
  deps: Partial<TestKeyDeps> = {},
): Promise<Response> {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ ok: false, error: "This setting is only available from localhost." }, { status: 403 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* no body -> test the saved key */
  }

  const provided = typeof body?.anthropicApiKey === "string" ? body.anthropicApiKey.trim() : undefined;
  const key = provided || d.resolveAnthropicKey();
  if (!key) {
    return NextResponse.json({ ok: false, error: "No Anthropic API key saved or provided." }, { status: 400 });
  }

  try {
    const client = d.makeAnthropicClientForKey(key, { timeout: 15_000, maxRetries: 0 });
    await client.messages.create({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    return NextResponse.json({ ok: true });
  } catch {
    // Never surface the SDK's raw error text — it can echo request details.
    return NextResponse.json({ ok: false, error: "That key didn't work. Double-check it and try again." });
  }
}

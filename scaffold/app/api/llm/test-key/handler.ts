import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { makeAnthropicClientForKey } from "@/lib/llm/client";
import { resolveAnthropicKey } from "@/lib/llm/config";
import { MODEL } from "@/lib/claude";

// POST /api/llm/test-key — "Test key" button. Loopback-only (spends real credit). One minimal request, saved or draft key. Never echoes the key.

// Never surface the SDK's raw error text — it can echo request details.
function describeTestKeyError(err: unknown): string {
  const status = err instanceof Anthropic.APIError ? err.status : undefined;
  if (status === 401 || status === 403) return "That key didn't work. Double-check it and try again.";
  if (status === 429) return "Anthropic is rate-limiting requests right now. The key looks fine — try again shortly.";
  if (typeof status === "number" && status >= 500) {
    return "Anthropic's API is temporarily unavailable. The key looks fine — try again shortly.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Couldn't reach Anthropic's API. Check your network connection and try again.";
  }
  return "That key didn't work. Double-check it and try again.";
}

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
  } catch (err) {
    return NextResponse.json({ ok: false, error: describeTestKeyError(err) });
  }
}

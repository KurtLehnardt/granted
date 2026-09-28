import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { readLlmConfig, writeLlmConfig, type LlmConfigFile, type ProviderName } from "@/lib/llm/config";

/**
 * POST /api/llm/config — the Settings Local/Cloud switch's write path.
 * Loopback-only (same guard as /api/corpus/refresh): this writes a plaintext
 * API key to disk, so it must never be reachable off the machine running the
 * app. Never logs the key, on success or failure.
 */

export type LlmConfigDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  readLlmConfig: typeof readLlmConfig;
  writeLlmConfig: typeof writeLlmConfig;
};

const REAL_DEPS: LlmConfigDeps = { isLoopbackRequest, readLlmConfig, writeLlmConfig };

// Real Anthropic keys are "sk-ant-" + a long opaque token; this is deliberately
// loose about the token's alphabet (base64url-ish) but strict about the
// prefix and length, which catches near-every paste mistake.
const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]+$/;
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 200;

function isValidKey(key: string): boolean {
  return key.length >= MIN_KEY_LENGTH && key.length <= MAX_KEY_LENGTH && KEY_PATTERN.test(key);
}

export async function handleLlmConfigPost(
  req: { headers: { get(name: string): string | null }; json: () => Promise<unknown> },
  deps: Partial<LlmConfigDeps> = {},
): Promise<Response> {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "This setting is only available from localhost." }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const provider: unknown = body?.provider;
  if (provider !== "ollama" && provider !== "anthropic") {
    return NextResponse.json({ error: 'provider must be "ollama" or "anthropic".' }, { status: 400 });
  }

  const current = d.readLlmConfig();
  const patch: LlmConfigFile = { provider: provider as ProviderName };
  let anthropicApiKey = current.anthropicApiKey;

  if (body?.clearAnthropicKey === true) {
    anthropicApiKey = undefined;
  }

  if (body?.anthropicApiKey !== undefined) {
    if (typeof body.anthropicApiKey !== "string") {
      return NextResponse.json({ error: "anthropicApiKey must be a string." }, { status: 400 });
    }
    const trimmed = body.anthropicApiKey.trim();
    if (trimmed.length > 0) {
      if (!isValidKey(trimmed)) {
        return NextResponse.json(
          { error: "That doesn't look like a valid Anthropic API key (it should start with sk-ant-)." },
          { status: 400 },
        );
      }
      anthropicApiKey = trimmed;
    }
  }

  if (provider === "anthropic" && !anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Add an Anthropic API key before switching to Cloud (Claude)." },
      { status: 400 },
    );
  }

  patch.anthropicApiKey = anthropicApiKey;
  const saved = d.writeLlmConfig(patch);

  return NextResponse.json({
    provider: saved.provider,
    hasAnthropicKey: Boolean(saved.anthropicApiKey || process.env.ANTHROPIC_API_KEY),
  });
}

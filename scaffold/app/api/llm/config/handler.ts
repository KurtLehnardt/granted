import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import {
  readLlmConfig,
  writeLlmConfig,
  isValidAnthropicKey,
  type LlmConfigFile,
  type ProviderName,
} from "@/lib/llm/config";

// POST /api/llm/config — Settings Local/Cloud switch write path. Loopback-only (writes a plaintext key to disk). Never logs the key.

export type LlmConfigDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  readLlmConfig: typeof readLlmConfig;
  writeLlmConfig: typeof writeLlmConfig;
};

const REAL_DEPS: LlmConfigDeps = { isLoopbackRequest, readLlmConfig, writeLlmConfig };

// A placeholder/malformed env value (e.g. .env.example's "sk-ant-...") never counts as a usable env key.
function hasValidEnvKey(): boolean {
  const envKey = process.env.ANTHROPIC_API_KEY;
  return Boolean(envKey && isValidAnthropicKey(envKey));
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
      if (!isValidAnthropicKey(trimmed)) {
        return NextResponse.json(
          { error: "That doesn't look like a valid Anthropic API key (it should start with sk-ant-)." },
          { status: 400 },
        );
      }
      anthropicApiKey = trimmed;
    }
  }

  if (provider === "anthropic" && !anthropicApiKey && !hasValidEnvKey()) {
    return NextResponse.json(
      { error: "Add an Anthropic API key before switching to Cloud (Claude)." },
      { status: 400 },
    );
  }

  patch.anthropicApiKey = anthropicApiKey;
  const saved = d.writeLlmConfig(patch);

  return NextResponse.json({
    provider: saved.provider,
    hasAnthropicKey: Boolean(saved.anthropicApiKey || hasValidEnvKey()),
  });
}

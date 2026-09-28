import { NextResponse } from "next/server";
import { isLocalLlm, defaultLocalModel } from "@/lib/llm/client";
import { listOllamaChatModels } from "@/lib/llm/ollamaInfo";
import { resolveAnthropicKey, resolveAnthropicKeySource } from "@/lib/llm/config";

// Next 14 would otherwise prerender this at build time, freezing the backend/model list.
export const dynamic = "force-dynamic";

export async function GET() {
  const local = isLocalLlm();
  const key = resolveAnthropicKey();
  // Never return the key itself — only whether one is set, its last 4 chars, and its source.
  const providerInfo = {
    provider: local ? ("ollama" as const) : ("anthropic" as const),
    hasAnthropicKey: Boolean(key),
    anthropicKeyHint: key ? key.slice(-4) : undefined,
    anthropicKeySource: resolveAnthropicKeySource(),
  };
  if (!local) return NextResponse.json({ local: false, ...providerInfo });
  return NextResponse.json({
    local: true,
    model: defaultLocalModel(),
    models: await listOllamaChatModels(),
    ...providerInfo,
  });
}

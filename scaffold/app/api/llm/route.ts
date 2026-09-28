import { NextResponse } from "next/server";
import { isLocalLlm, defaultLocalModel } from "@/lib/llm/client";
import { listOllamaChatModels } from "@/lib/llm/ollamaInfo";
import { resolveAnthropicKey } from "@/lib/llm/config";

// Next 14 would otherwise prerender this at build time, freezing the backend/model list.
export const dynamic = "force-dynamic";

export async function GET() {
  const local = isLocalLlm();
  const key = resolveAnthropicKey();
  // Never return the key itself — only whether one is set and its last 4 chars,
  // enough for the Settings UI to show "Key saved ••••abcd".
  const providerInfo = {
    provider: local ? ("ollama" as const) : ("anthropic" as const),
    hasAnthropicKey: Boolean(key),
    anthropicKeyHint: key ? key.slice(-4) : undefined,
  };
  if (!local) return NextResponse.json({ local: false, ...providerInfo });
  return NextResponse.json({
    local: true,
    model: defaultLocalModel(),
    models: await listOllamaChatModels(),
    ...providerInfo,
  });
}

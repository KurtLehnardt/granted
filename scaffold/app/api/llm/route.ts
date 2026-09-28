import { NextResponse } from "next/server";
import { isLocalLlm, defaultLocalModel } from "@/lib/llm/client";
import { listOllamaChatModels } from "@/lib/llm/ollamaInfo";
import { resolveCloudConfig, resolveCloudApiKey, resolveCloudModel, publicKeySource } from "@/lib/llm/config";
import { EMBEDDINGS_IS_OPENAI } from "@/lib/embed";

// Next 14 would otherwise prerender this at build time, freezing the backend/model list.
export const dynamic = "force-dynamic";

export async function GET() {
  if (isLocalLlm()) {
    return NextResponse.json({
      local: true,
      provider: "ollama" as const,
      model: defaultLocalModel(),
      models: await listOllamaChatModels(),
      openAiEmbeddings: EMBEDDINGS_IS_OPENAI,
    });
  }

  const cfg = resolveCloudConfig();
  if (!cfg) {
    return NextResponse.json({ local: false, provider: "cloud" as const, openAiEmbeddings: EMBEDDINGS_IS_OPENAI });
  }

  // Never return the key itself — only whether one resolved, its last 4 chars, and where it came from.
  const resolved = resolveCloudApiKey(cfg);
  return NextResponse.json({
    local: false,
    provider: "cloud" as const,
    openAiEmbeddings: EMBEDDINGS_IS_OPENAI,
    cloud: {
      providerId: cfg.providerId,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      model: resolveCloudModel(cfg),
      hasKey: Boolean(resolved.key),
      ...(resolved.key ? { keyHint: resolved.key.slice(-4) } : {}),
      keySource: publicKeySource(cfg.keySource),
    },
  });
}

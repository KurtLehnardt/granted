import { NextResponse } from "next/server";
import { isLocalLlm, defaultLocalModel } from "@/lib/llm/client";
import { listOllamaChatModels } from "@/lib/llm/ollamaInfo";
import { resolveCloudConfig, resolveCloudApiKey, publicKeySource, isEnvCloudConfig } from "@/lib/llm/config";
import { buildLocalEmbeddingsStatus } from "@/lib/embeddings/localEmbeddings";

// Next 14 would otherwise prerender this at build time, freezing the backend/model list.
export const dynamic = "force-dynamic";

// Kept regardless of the active Local/Cloud provider: a saved cloud config
// must stay visible (and removable) while Local is active, not just while
// Cloud is — see ModelSection.tsx's Remove button.
function buildCloudBlock(cfg: NonNullable<ReturnType<typeof resolveCloudConfig>>) {
  // Never return the key itself — only whether one resolved, its last 4 chars, and where it came from.
  const resolved = resolveCloudApiKey(cfg);
  return {
    providerId: cfg.providerId,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    // The user's saved choice only — never the provider's default, which
    // would otherwise get echoed back and re-saved against another provider.
    ...(cfg.model ? { model: cfg.model } : {}),
    hasKey: Boolean(resolved.key),
    ...(resolved.key ? { keyHint: resolved.key.slice(-4) } : {}),
    keySource: publicKeySource(cfg.keySource),
    // From ANTHROPIC_API_KEY / OPENAI_API_KEY in .env.local, not saved in
    // Settings: Settings' Remove can't remove it (it would just come back).
    ...(isEnvCloudConfig() ? { fromEnv: true } : {}),
  };
}

export async function GET() {
  const cfg = resolveCloudConfig();
  const cloud = cfg ? buildCloudBlock(cfg) : undefined;
  // Settings → Local's background local-search setup (state/progress/error), built once per
  // request — see lib/embeddings/localEmbeddings.ts.
  const localEmbeddings = buildLocalEmbeddingsStatus();

  if (isLocalLlm()) {
    return NextResponse.json({
      local: true,
      provider: "ollama" as const,
      model: defaultLocalModel(),
      models: await listOllamaChatModels(),
      localEmbeddings,
      ...(cloud ? { cloud } : {}),
    });
  }

  if (!cfg) {
    return NextResponse.json({ local: false, provider: "cloud" as const, localEmbeddings });
  }

  return NextResponse.json({
    local: false,
    provider: "cloud" as const,
    localEmbeddings,
    cloud,
  });
}

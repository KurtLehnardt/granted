import { NextResponse } from "next/server";
import { isLocalLlm } from "@/lib/llm/client";
import { getOllamaStatus } from "@/lib/llm/ollamaStatus";
import { resolveCloudConfig, resolveCloudApiKey, publicKeySource, isEnvCloudConfig, resolveOperationMode } from "@/lib/llm/config";
import { buildSearchStatus } from "@/lib/embeddings/searchStatus";
import { withErrorLogging } from "@/lib/errorLog/withErrorLogging";
import { isLoopbackRequest } from "@/lib/corpus/loopback";

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

async function getLlmStatus(req: Request) {
  // Unlike /api/match, /api/interview and /api/competitors, this is a
  // read-only GET status endpoint that never calls an LLM — this guard is NOT
  // about preventing spend. The risk here is a minor information leak: the
  // response exposes a key hint (last 4 chars), the key-file's resolved path,
  // and the provider name, none of which should be visible off this machine.
  if (!isLoopbackRequest(req)) {
    return NextResponse.json({ error: "Only available from this computer" }, { status: 403 });
  }

  const cfg = resolveCloudConfig();
  const cloud = cfg ? buildCloudBlock(cfg) : undefined;
  // The "Search" line: which embeddings search uses and the built-in model's download state
  // (lib/embeddings/searchStatus.ts), built once per request.
  const search = buildSearchStatus();
  const operationMode = resolveOperationMode();

  if (isLocalLlm()) {
    // Settings → Model → Local: installed / running / models / what to download (lib/llm/ollamaStatus.ts).
    const ollama = await getOllamaStatus();
    return NextResponse.json({
      local: true,
      operationMode,
      provider: "ollama" as const,
      model: ollama.defaultModel, // what "Default" actually runs: an installed model when there is one
      models: ollama.chatModels,
      ollama,
      search,
      ...(cloud ? { cloud } : {}),
    });
  }

  if (!cfg) {
    return NextResponse.json({ local: false, operationMode, provider: "cloud" as const, search });
  }

  return NextResponse.json({
    local: false,
    operationMode,
    provider: "cloud" as const,
    search,
    cloud,
  });
}

export const GET = withErrorLogging("llm-config", getLlmStatus);

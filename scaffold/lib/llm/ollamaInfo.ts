import { normalizeOpenAiBaseUrl } from "./baseUrl";
import { isEmbeddingModel, type OllamaModel } from "./ollamaModels";

export type { OllamaModel };

const TAGS_TIMEOUT_MS = 1_500;

/** Ollama's native API root (LLM_BASE_URL minus its OpenAI-compatible /v1). */
export function ollamaHost(): string {
  return normalizeOpenAiBaseUrl(process.env.LLM_BASE_URL || "http://localhost:11434/v1").replace(/\/v1$/, "");
}

/** Ollama's `parameter_size` ("3.1B") in billions; anything else -> undefined. */
export function parseParamsB(parameterSize: unknown): number | undefined {
  if (typeof parameterSize !== "string") return undefined;
  const m = /^([\d.]+)\s*B$/i.exec(parameterSize.trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Installed Ollama chat models (embedding models excluded), fetched fresh each call;
 *  [] on any error, timeout, or non-Ollama server. */
export async function listOllamaChatModels(): Promise<OllamaModel[]> {
  try {
    const res = await fetch(`${ollamaHost()}/api/tags`, {
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const models: any[] = Array.isArray(json?.models) ? json.models : [];
    return models
      .filter((m) => typeof m?.name === "string" && m.name.length > 0 && !isEmbeddingModel(m))
      .map((m) => ({ name: m.name, paramsB: parseParamsB(m.details?.parameter_size) }));
  } catch {
    return [];
  }
}

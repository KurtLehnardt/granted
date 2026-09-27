import { normalizeOpenAiBaseUrl } from "./baseUrl";

/**
 * Ollama's `GET /api/tags` — the installed-models list, used to (a) show the
 * active model's parameter size in SearchProgress's local-model estimate and
 * (b) populate the Settings model picker. Fails soft to `[]` for any error,
 * timeout, or non-Ollama OpenAI-compatible server — this is a nicety, never a
 * requirement for a search to run.
 */

export type OllamaModel = { name: string; paramsB?: number };

const TAGS_TIMEOUT_MS = 1_500;

/** The bare host `/api/tags` lives on — LLM_BASE_URL with the OpenAI-compatible `/v1` stripped. */
function ollamaHost(): string {
  const base = normalizeOpenAiBaseUrl(process.env.LLM_BASE_URL || "http://localhost:11434/v1");
  return base.replace(/\/v1$/, "");
}

/** "3.1B" -> 3.1. Anything else (missing, "7M", malformed) -> undefined. */
export function parseParamsB(parameterSize: unknown): number | undefined {
  if (typeof parameterSize !== "string") return undefined;
  const m = /^([\d.]+)\s*B$/i.exec(parameterSize.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Ollama's convention for embedding-only models (e.g. "nomic-embed-text"). */
export function isEmbeddingModel(name: string): boolean {
  return /embed/i.test(name);
}

async function fetchTags(): Promise<OllamaModel[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TAGS_TIMEOUT_MS);
  try {
    const res = await fetch(`${ollamaHost()}/api/tags`, { signal: ac.signal });
    if (!res.ok) return [];
    const json: any = await res.json();
    const models = Array.isArray(json?.models) ? json.models : [];
    return models
      .map((m: any) => ({
        name: typeof m?.name === "string" ? m.name : "",
        paramsB: parseParamsB(m?.details?.parameter_size),
      }))
      .filter((m: OllamaModel) => m.name.length > 0);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

let tagsCache: Promise<OllamaModel[]> | null = null;

/** All installed Ollama models (chat + embedding), cached for the life of the process. */
export function listOllamaModels(): Promise<OllamaModel[]> {
  if (!tagsCache) tagsCache = fetchTags();
  return tagsCache;
}

/** Test-only: drop the in-process cache so the next call re-fetches. */
export function resetOllamaModelsCache(): void {
  tagsCache = null;
}

/** Installed CHAT models only (embedding models excluded) — what the local-only
 *  Settings model picker offers, and the set /api/match validates `body.model` against. */
export async function listOllamaChatModels(): Promise<OllamaModel[]> {
  const all = await listOllamaModels();
  return all.filter((m) => !isEmbeddingModel(m.name));
}

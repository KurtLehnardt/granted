import { listOllamaChatModels } from "./ollamaInfo";
import { resolveDefaultLocalModel } from "./ollamaModels";

/** The configured local default: LOCAL_LLM_MODEL, else gemma4:latest. It may not be installed. */
export function configuredLocalModel(): string {
  return process.env.LOCAL_LLM_MODEL || "gemma4:latest";
}

const CACHE_MS = 10_000;
let cache: { at: number; key: string; model: string } | undefined;

/**
 * The model a Local LLM call with no model picked runs on: the configured one
 * if Ollama has it, else the best installed chat model (resolveDefaultLocalModel).
 * Reads Ollama's /api/tags, cached for a few seconds so a search's many calls
 * don't each ask. Falls back to the configured model when Ollama can't be read.
 */
export async function resolveLocalDefaultModel(): Promise<string> {
  const configured = configuredLocalModel();
  const key = `${process.env.LLM_BASE_URL ?? ""}|${configured}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.model;
  const installed = await listOllamaChatModels();
  const model = resolveDefaultLocalModel(configured, installed.map((m) => m.name));
  cache = { at: Date.now(), key, model };
  return model;
}

/** Test-only. */
export function resetLocalDefaultCache(): void {
  cache = undefined;
}

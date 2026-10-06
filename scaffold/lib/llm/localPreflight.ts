import { ollamaHost } from "./ollamaInfo";
import { defaultLocalModel } from "./client";
import { startOllamaAndWait } from "./ollamaJobs";
import { probeOllama, splitModels } from "./ollamaStatus";
import { canManageHost, detectOllamaInstalled } from "./ollamaLocate";
import { pickNotInstalled, resolveDefaultLocalModel, sameModel } from "./ollamaModels";
import { LocalSetupError } from "./searchErrors";
import type { LlmInfo } from "./types";

export type LocalPreflightDeps = {
  host: string;
  fetch: typeof fetch;
  /** The configured default (LOCAL_LLM_MODEL, else gemma4:latest). */
  defaultModel: string;
  detectInstalled: () => boolean;
  /** Granted may start Ollama for this host (default: this machine, port 11434). */
  canManage: (host: string) => boolean;
  /** Start the daemon and wait for it; true once it answers. */
  start: () => Promise<boolean>;
};

function realDeps(): LocalPreflightDeps {
  return {
    host: ollamaHost(),
    fetch: (...args) => fetch(...args),
    defaultModel: defaultLocalModel(),
    detectInstalled: () => detectOllamaInstalled(),
    canManage: canManageHost,
    // A search shouldn't hang on a daemon that won't come up: wait less than Settings does.
    start: () => startOllamaAndWait({ startTimeoutMs: 45_000 }),
  };
}

/**
 * Before a Local search: make sure Ollama answers (starting it if it's installed
 * on this machine but stopped) and has a chat model. Returns the model to run:
 * the user's pick if installed (else says so via `onStatus` and uses Default).
 * Throws a LocalSetupError, whose message says what to fix, instead of letting
 * the search fail with a generic error. An OpenAI-compatible server that isn't
 * Ollama is passed through unchecked.
 */
export async function prepareLocalSearch(
  requestedModel: string | undefined,
  onStatus: (label: string) => void = () => {},
  deps: Partial<LocalPreflightDeps> = {},
): Promise<LlmInfo> {
  const d = { ...realDeps(), ...deps };
  let probe = await probeOllama(d.host, d.fetch);
  // Only Ollama on this machine (port 11434) is started for you; LM Studio, vLLM etc. aren't Ollama.
  const manageable = d.canManage(d.host);
  if (!probe.reachable && manageable && d.detectInstalled()) {
    onStatus("Starting Ollama…");
    if (await d.start()) probe = await probeOllama(d.host, d.fetch);
  }
  if (!probe.reachable) {
    throw manageable ? new LocalSetupError("ollama_unreachable") : new LocalSetupError("server_unreachable", { host: d.host });
  }
  if (!probe.isOllama) return { local: true, model: d.defaultModel };

  const { chatModels } = splitModels(probe.models);
  if (chatModels.length === 0) throw new LocalSetupError("no_chat_models");
  const names = chatModels.map((m) => m.name);
  // "Default": the configured model if installed, else the best installed chat model — always installed here.
  const fallback = resolveDefaultLocalModel(d.defaultModel, names);
  const pick = requestedModel ? names.find((n) => sameModel(n, requestedModel)) : undefined;
  if (requestedModel && !pick) onStatus(pickNotInstalled(requestedModel, fallback));
  const model = pick ?? fallback;
  const hit = chatModels.find((m) => m.name === model)!;
  return { local: true, model: hit.name, paramsB: hit.paramsB };
}

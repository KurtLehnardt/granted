import { ollamaHost } from "./ollamaInfo";
import { defaultLocalModel } from "./client";
import { startOllamaAndWait } from "./ollamaJobs";
import { probeOllama, splitModels, isLocalHost, detectOllamaInstalled } from "./ollamaStatus";
import { effectiveLocalModel, resolveDefaultLocalModel, sameModel } from "./ollamaModels";
import { LocalSetupError } from "./searchErrors";
import type { LlmInfo } from "./types";

export type LocalPreflightDeps = {
  host: string;
  fetch: typeof fetch;
  /** The configured default (LOCAL_LLM_MODEL, else gemma4:latest). */
  defaultModel: string;
  detectInstalled: () => boolean;
  /** Start the daemon and wait for it; true once it answers. */
  start: () => Promise<boolean>;
};

function realDeps(): LocalPreflightDeps {
  return {
    host: ollamaHost(),
    fetch: (...args) => fetch(...args),
    defaultModel: defaultLocalModel(),
    detectInstalled: () => detectOllamaInstalled(),
    // A search shouldn't hang on a daemon that won't come up: wait less than Settings does.
    start: () => startOllamaAndWait({ startTimeoutMs: 45_000 }),
  };
}

/**
 * Before a Local search: make sure Ollama answers (starting it if it's installed
 * on this machine but stopped) and that the model the search would use is
 * installed. Returns the model to run; throws a LocalSetupError, whose message
 * says what to fix, instead of letting the search fail with a generic error.
 * An OpenAI-compatible server that isn't Ollama is passed through unchecked.
 */
export async function prepareLocalSearch(
  requestedModel: string | undefined,
  onStatus: (label: string) => void = () => {},
  deps: Partial<LocalPreflightDeps> = {},
): Promise<LlmInfo> {
  const d = { ...realDeps(), ...deps };
  let probe = await probeOllama(d.host, d.fetch);
  if (!probe.reachable && isLocalHost(d.host) && d.detectInstalled()) {
    onStatus("Starting Ollama…");
    if (await d.start()) probe = await probeOllama(d.host, d.fetch);
  }
  if (!probe.reachable) throw new LocalSetupError("ollama_unreachable");
  if (!probe.isOllama) return { local: true, model: d.defaultModel };

  const { chatModels } = splitModels(probe.models);
  if (chatModels.length === 0) throw new LocalSetupError("no_chat_models");
  const names = chatModels.map((m) => m.name);
  // "Default" is the configured model if installed, else the best installed chat model.
  const model = effectiveLocalModel(requestedModel, names, resolveDefaultLocalModel(d.defaultModel, names));
  const hit = chatModels.find((m) => sameModel(m.name, model));
  if (!hit) throw new LocalSetupError("local_model_missing", model);
  return { local: true, model: hit.name, paramsB: hit.paramsB };
}

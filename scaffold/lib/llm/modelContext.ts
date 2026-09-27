import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Threads the per-request local-model choice (Settings model picker) down to
 * the OpenAI-compat shim in ./client.ts without changing that shim's call
 * signature or any of its callers (lib/claude.ts's scoring/batching stays
 * untouched). One request = one `withLocalModel` scope around the whole
 * pipeline call; every LLM call made inside it — via awaits, batches,
 * whatever — sees the same model.
 */
const als = new AsyncLocalStorage<string>();

/** Run `fn` with `model` as the active local model for every call inside it.
 *  `model` undefined (hosted, or no override chosen) just runs `fn` as-is. */
export function withLocalModel<T>(model: string | undefined, fn: () => T): T {
  return model ? als.run(model, fn) : fn();
}

/** The active local model for the current request, if one was set. */
export function currentLocalModel(): string | undefined {
  return als.getStore();
}

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<string>();

/** Runs `fn` with `model` as the local model for every LLM call made inside it. */
export function withLocalModel<T>(model: string | undefined, fn: () => T): T {
  return model ? als.run(model, fn) : fn();
}

export function currentLocalModel(): string | undefined {
  return als.getStore();
}

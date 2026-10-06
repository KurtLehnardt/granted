/**
 * Pure, client-safe Ollama model + status logic, shared by the server (status
 * route, the pre-search check in app/api/match) and Settings → Model → Local.
 * No Node imports here: ModelSection.tsx imports it in the browser.
 */
import { PREFERRED_CHAT_MODELS } from "../../scripts/lib/modelTiers.mjs";

export type OllamaModel = { name: string; paramsB?: number };

/** Where the local setup stands, in the order a user has to fix it. */
export type OllamaState =
  | "not_installed" // no Ollama on this machine
  | "not_running" // installed (or a remote host), but nothing answers at the host
  | "no_chat_models" // running, but only embedding models (or none) are installed
  | "model_missing" // running with chat models, but not the one searches would use
  | "external" // the endpoint answers but isn't Ollama (LM Studio, vLLM, ...): nothing to manage
  | "ok";

/** A background job the status route reports (start / pull / install), for progress. */
export type OllamaJob = {
  status: "running" | "done" | "error";
  /** The model being pulled (pull jobs only). */
  model?: string;
  /** 0–100 when known. */
  pct?: number;
  /** Human-readable progress line ("Downloading 1.2 GB of 4.7 GB"). */
  message?: string;
  error?: string;
};

/** GET /api/llm/ollama — everything Settings → Model → Local needs to say what's wrong and offer the fix. */
export type OllamaStatus = {
  /** Ollama is on this machine (or is answering, which implies it). */
  installed: boolean;
  /** Something answers at `host`. */
  running: boolean;
  /** What answers at `host` is Ollama (its /api/tags works). */
  isOllama: boolean;
  host: string;
  /** The host is this machine, so Granted can install / start Ollama itself. */
  canManage: boolean;
  platform: string;
  chatModels: OllamaModel[];
  embeddingModels: string[];
  /** The model "Default" runs: the configured one if installed, else the best installed chat model (resolveDefaultLocalModel). */
  defaultModel: string;
  /** The configured default (LOCAL_LLM_MODEL, else gemma4:latest), installed or not. */
  configuredModel: string;
  /** For "Download a model": the setup-local tier for this machine's memory, plus alternatives. */
  recommended: { model: string; note: string; memGB: number | null };
  suggestions: string[];
  install: {
    /** "winget"/"download": a one-click install on Windows; null: show the link and command. */
    auto: "winget" | "download" | null;
    command: string;
    url: string;
  };
  jobs: { start?: OllamaJob; pull?: OllamaJob; install?: OllamaJob };
};

const EMBEDDING_NAME = /embed|\bbge\b|bge-|minilm|paraphrase-/i;
const EMBEDDING_FAMILY = /bert/i; // nomic-bert, bert: encoder-only, can't chat

/**
 * True for an embedding-only model (nomic-embed-text, mxbai-embed-large,
 * all-minilm, bge-m3, ...), which can't run a search's chat prompts. Uses the
 * model's `capabilities` when /api/tags reports them, else its name and family.
 */
export function isEmbeddingModel(m: {
  name: string;
  details?: { family?: unknown; families?: unknown };
  capabilities?: unknown;
}): boolean {
  // Newer Ollama lists what a model can do: ["embedding"] vs ["completion", ...]. Trust it when present.
  if (Array.isArray(m.capabilities) && m.capabilities.length > 0) {
    return m.capabilities.includes("embedding") && !m.capabilities.includes("completion");
  }
  if (EMBEDDING_NAME.test(m.name)) return true;
  const fams = [m.details?.family, ...(Array.isArray(m.details?.families) ? m.details!.families as unknown[] : [])];
  return fams.some((f) => typeof f === "string" && EMBEDDING_FAMILY.test(f));
}

/** Ollama treats "gemma4" as "gemma4:latest"; compare names that way. */
export function normalizeModelTag(name: string): string {
  const n = name.trim();
  if (!n) return n;
  const lastSegment = n.split("/").pop() ?? n;
  return lastSegment.includes(":") ? n : `${n}:latest`;
}

export function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeModelTag(a).toLowerCase() === normalizeModelTag(b).toLowerCase();
}

/**
 * The model a Local search actually runs on: the user's pick (Settings) when it's
 * installed, else `fallback` — Default, already resolved to an installed model
 * (resolveDefaultLocalModel). Returns the installed model's own spelling.
 */
export function effectiveLocalModel(requested: string | null | undefined, installed: string[], fallback: string): string {
  return (requested ? installed.find((n) => sameModel(n, requested)) : undefined) ?? fallback;
}

/** Said in Settings and in the search's progress when a picked model is gone. */
export function pickNotInstalled(pick: string, using: string): string {
  return `Your pick ${pick} isn't installed; using ${using}.`;
}

/**
 * The model "Default" actually runs, so it's never a model that isn't there:
 * the configured one (LOCAL_LLM_MODEL, else gemma4:latest) if installed; else
 * the best installed model in setup-local's MODEL_TIERS order; else the first
 * installed chat model; only then the configured one (reported as missing).
 * `installedChat` must already exclude embedding models.
 */
export function resolveDefaultLocalModel(configured: string, installedChat: string[]): string {
  const chat = installedChat.filter((n) => !isEmbeddingModel({ name: n }));
  const hit = chat.find((n) => sameModel(n, configured));
  if (hit) return hit;
  for (const preferred of PREFERRED_CHAT_MODELS as string[]) {
    const p = chat.find((n) => sameModel(n, preferred));
    if (p) return p;
  }
  return chat[0] ?? configured;
}

/** Pure: which state the local setup is in, for the model searches would use. */
export function classifyOllamaStatus(input: {
  installed: boolean;
  running: boolean;
  isOllama: boolean;
  chatModels: OllamaModel[];
  model: string;
}): OllamaState {
  if (!input.running) return input.installed ? "not_running" : "not_installed";
  if (!input.isOllama) return "external";
  if (input.chatModels.length === 0) return "no_chat_models";
  if (!input.chatModels.some((m) => sameModel(m.name, input.model))) return "model_missing";
  return "ok";
}

/** A model tag safe to hand to Ollama's /api/pull ("qwen2.5:7b", "library/x:tag", "hf.co/org/repo:Q4_K_M"). */
export function isValidModelTag(tag: unknown): tag is string {
  return typeof tag === "string" && /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,199}$/.test(tag) && !tag.includes("..");
}

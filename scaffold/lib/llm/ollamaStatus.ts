import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ollamaHost, parseParamsB } from "./ollamaInfo";
import { defaultLocalModel } from "./client";
import { getOllamaJobs, hasWinget } from "./ollamaJobs";
import { isEmbeddingModel, resolveDefaultLocalModel, type OllamaModel, type OllamaStatus } from "./ollamaModels";
import {
  MODEL_TIERS,
  recommendModel,
  manualInstallCommand,
  ollamaWindowsDir,
  withOllamaOnPath,
  OLLAMA_DOWNLOAD_URL,
} from "../../scripts/lib/ollamaSetup.mjs";

/** What answers at the Ollama host's /api/tags. */
export type TagsProbe =
  | { reachable: true; isOllama: true; models: Array<{ name: string; details?: any }> }
  | { reachable: true; isOllama: false }
  | { reachable: false };

export async function probeOllama(host: string, fetchImpl: typeof fetch = fetch, timeoutMs = 1_500): Promise<TagsProbe> {
  let res: Response;
  try {
    res = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch {
    return { reachable: false };
  }
  if (!res.ok) return { reachable: true, isOllama: false };
  try {
    const json: any = await res.json();
    if (!Array.isArray(json?.models)) return { reachable: true, isOllama: false };
    const models = json.models.filter((m: any) => typeof m?.name === "string" && m.name.length > 0);
    return { reachable: true, isOllama: true, models };
  } catch {
    return { reachable: true, isOllama: false };
  }
}

/** Split /api/tags models into chat models (with sizes) and embedding-only models. */
export function splitModels(models: Array<{ name: string; details?: any }>): { chatModels: OllamaModel[]; embeddingModels: string[] } {
  const chatModels: OllamaModel[] = [];
  const embeddingModels: string[] = [];
  for (const m of models) {
    if (isEmbeddingModel(m)) embeddingModels.push(m.name);
    else chatModels.push({ name: m.name, paramsB: parseParamsB(m.details?.parameter_size) });
  }
  return { chatModels, embeddingModels };
}

/** True when `host` is this machine, so Granted can install / start Ollama for it. */
export function isLocalHost(host: string): boolean {
  try {
    const h = new URL(host).hostname.toLowerCase();
    return h === "localhost" || h === "[::1]" || h === "::1" || h === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

export type InstallProbeDeps = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
  /** Exit status of `ollama --version`, or null when it can't run. */
  ollamaVersionStatus: (env: Record<string, string | undefined>) => number | null;
};

const REAL_INSTALL_PROBE: InstallProbeDeps = {
  platform: process.platform,
  env: process.env,
  exists: existsSync,
  ollamaVersionStatus: (env) => {
    try {
      return spawnSync("ollama", ["--version"], { timeout: 4_000, env: env as NodeJS.ProcessEnv, windowsHide: true }).status;
    } catch {
      return null;
    }
  },
};

/** Ollama's binary is on this machine: its usual install paths, else `ollama --version` on PATH. */
export function detectOllamaInstalled(deps: Partial<InstallProbeDeps> = {}): boolean {
  const d = { ...REAL_INSTALL_PROBE, ...deps };
  const candidates: string[] = [];
  if (d.platform === "win32") {
    if (d.env.LOCALAPPDATA) {
      const dir = ollamaWindowsDir(d.env.LOCALAPPDATA);
      candidates.push(path.win32.join(dir, "ollama.exe"), path.win32.join(dir, "ollama app.exe"));
    }
    if (d.env.ProgramFiles) candidates.push(path.win32.join(d.env.ProgramFiles, "Ollama", "ollama.exe"));
  } else if (d.platform === "darwin") {
    candidates.push("/Applications/Ollama.app", "/usr/local/bin/ollama", "/opt/homebrew/bin/ollama");
  } else {
    candidates.push("/usr/local/bin/ollama", "/usr/bin/ollama");
  }
  if (candidates.some((p) => d.exists(p))) return true;
  const env = withOllamaOnPath(d.env, d.platform, d.env.LOCALAPPDATA) as Record<string, string | undefined>;
  return d.ollamaVersionStatus(env) === 0;
}

/** This machine's memory in whole GB, or null when unknown. */
export function memoryGB(): number | null {
  const n = Math.floor(os.totalmem() / 1024 ** 3);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** setup-local's recommendation for `memGB`, plus alternatives that also fit (largest first). */
export function suggestModels(memGB: number | null): { recommended: OllamaStatus["recommended"]; suggestions: string[] } {
  const tier = recommendModel(memGB ?? NaN);
  const fitting = MODEL_TIERS.filter((t: { minGB: number }) => t.minGB <= tier.minGB);
  const suggestions = [tier.model, tier.alt, ...fitting.map((t: { model: string }) => t.model)]
    .filter((m, i, all) => all.indexOf(m) === i)
    .slice(0, 4);
  return { recommended: { model: tier.model, note: tier.note, memGB }, suggestions };
}

export type StatusDeps = {
  host: string;
  platform: NodeJS.Platform;
  fetch: typeof fetch;
  detectInstalled: () => boolean;
  hasWinget: () => boolean;
  memGB: () => number | null;
  defaultModel: () => string;
  jobs: typeof getOllamaJobs;
};

function realStatusDeps(): StatusDeps {
  return {
    host: ollamaHost(),
    platform: process.platform,
    fetch: (...args) => fetch(...args),
    detectInstalled: () => detectOllamaInstalled(),
    hasWinget,
    memGB: memoryGB,
    defaultModel: defaultLocalModel,
    jobs: getOllamaJobs,
  };
}

/**
 * GET /api/llm/ollama's body: whether Ollama is installed and running, its chat
 * and embedding models, the default model, what to download, how to install.
 * The UI derives the state (lib/llm/ollamaModels.ts classifyOllamaStatus) with
 * the model the user picked, which only the browser knows.
 */
export async function getOllamaStatus(deps: Partial<StatusDeps> = {}): Promise<OllamaStatus> {
  const d = { ...realStatusDeps(), ...deps };
  const canManage = isLocalHost(d.host);
  const probe = await probeOllama(d.host, d.fetch);
  // A remote host can't be checked for an install: treat it as installed-but-unreachable.
  const installed = probe.reachable || !canManage || d.detectInstalled();
  const { chatModels, embeddingModels } = probe.reachable && probe.isOllama ? splitModels(probe.models) : { chatModels: [], embeddingModels: [] };
  const { recommended, suggestions } = suggestModels(d.memGB());
  const auto = d.platform === "win32" && canManage ? (d.hasWinget() ? "winget" : "download") : null;
  return {
    installed,
    running: probe.reachable,
    isOllama: probe.reachable && probe.isOllama,
    host: d.host,
    canManage,
    platform: d.platform,
    chatModels,
    embeddingModels,
    defaultModel: resolveDefaultLocalModel(d.defaultModel(), chatModels.map((m) => m.name)),
    configuredModel: d.defaultModel(),
    recommended,
    suggestions,
    install: { auto, command: manualInstallCommand(d.platform), url: OLLAMA_DOWNLOAD_URL },
    jobs: d.jobs(),
  };
}

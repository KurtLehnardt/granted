import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ollamaWindowsDir, withOllamaOnPath } from "../../scripts/lib/ollamaSetup.mjs";

// Where Ollama is installed, and whether Granted may install / start it for a host.
// No dependencies on the job or status modules (both use this).

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

/**
 * Where Ollama is installed on this machine: the first of its usual install paths
 * that exists (preferring the Windows tray app, which also runs the daemon), else
 * "ollama" when `ollama --version` works from PATH, else null. The start job
 * launches exactly this (setup-local's launchOllamaDaemon `exePath`).
 */
export function locateOllama(deps: Partial<InstallProbeDeps> = {}): string | null {
  const d = { ...REAL_INSTALL_PROBE, ...deps };
  const candidates: string[] = [];
  if (d.platform === "win32") {
    const dirs = [
      d.env.LOCALAPPDATA ? ollamaWindowsDir(d.env.LOCALAPPDATA) : undefined,
      d.env.ProgramFiles ? path.win32.join(d.env.ProgramFiles, "Ollama") : undefined,
    ].filter((x): x is string => Boolean(x));
    for (const dir of dirs) candidates.push(path.win32.join(dir, "ollama app.exe"), path.win32.join(dir, "ollama.exe"));
  } else if (d.platform === "darwin") {
    candidates.push("/Applications/Ollama.app/Contents/Resources/ollama", "/opt/homebrew/bin/ollama", "/usr/local/bin/ollama");
  } else {
    candidates.push("/usr/local/bin/ollama", "/usr/bin/ollama");
  }
  const found = candidates.find((p) => d.exists(p));
  if (found) return found;
  const env = withOllamaOnPath(d.env, d.platform, d.env.LOCALAPPDATA) as Record<string, string | undefined>;
  return d.ollamaVersionStatus(env) === 0 ? "ollama" : null;
}

/** Ollama is installed on this machine (see locateOllama). */
export function detectOllamaInstalled(deps: Partial<InstallProbeDeps> = {}): boolean {
  return locateOllama(deps) !== null;
}

/** Ollama's own port. A local server on another port (LM Studio, vLLM) isn't Ollama: never start or install Ollama for it. */
export const OLLAMA_PORT = 11434;

export function isOllamaPort(host: string): boolean {
  try {
    return new URL(host).port === String(OLLAMA_PORT);
  } catch {
    return false;
  }
}

/** Granted can install / start Ollama for `host`: it's this machine, on Ollama's port. */
export function canManageHost(host: string): boolean {
  return isLocalHost(host) && isOllamaPort(host);
}


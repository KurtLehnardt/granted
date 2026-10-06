/**
 * Ollama setup helpers shared by the CLI (scripts/setup-local.mjs) and the app's
 * Settings → Model → Local panel (lib/llm/ollamaJobs.ts): the memory→model
 * recommendation table, install commands/guidance, and launching the daemon.
 * Pure apart from `launchOllamaDaemon`, whose spawn is injectable.
 */
import { spawn } from "node:child_process";
import { join, win32 } from "node:path";
import { MODEL_TIERS } from "./modelTiers.mjs";

export { MODEL_TIERS };

/** Ollama's download page — the manual-install fallback on every platform. */
export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
/** Ollama's official Windows installer (Inno Setup; accepts /VERYSILENT). */
export const OLLAMA_WINDOWS_INSTALLER_URL = "https://ollama.com/download/OllamaSetup.exe";

/** The one-line install command to show a user on `platform`. */
export function manualInstallCommand(platform) {
  if (platform === "win32") return "winget install -e --id Ollama.Ollama";
  if (platform === "darwin") return "brew install ollama";
  return "curl -fsSL https://ollama.com/install.sh | sh";
}

/**
 * Lowest macOS major version Ollama's .app/.dmg (and the Homebrew cask) support.
 * Below this the app won't launch and Homebrew has no bottle — only the release's
 * CLI tarball runs. Bump this if Ollama raises its floor again.
 */
export const OLLAMA_MIN_MACOS = 14;

/**
 * Parse `sw_vers -productVersion` ("12.7.6", "26.4") → major version number.
 * Returns null on anything unparseable, so a failed detection degrades to the
 * generic guidance rather than wrongly claiming a Mac is too old.
 */
export function parseMacosMajor(text) {
  const m = String(text ?? "").trim().match(/^(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pick a recommended model for `memGB` gigabytes of usable memory/VRAM.
 * Non-finite / non-positive input is treated conservatively (smallest tier), so
 * a failed detection never over-recommends. Returns the matching tier object.
 */
export function recommendModel(memGB) {
  if (!Number.isFinite(memGB) || memGB <= 0) {
    return MODEL_TIERS[MODEL_TIERS.length - 1];
  }
  for (const tier of MODEL_TIERS) {
    if (memGB >= tier.minGB) return tier;
  }
  return MODEL_TIERS[MODEL_TIERS.length - 1];
}

/**
 * Automatic Ollama install command for this platform, or null → manual `installGuidance`.
 * @param {string} platform
 * @param {{ hasWinget?: boolean, hasBrew?: boolean, macosMajor?: number | null }} [opts]
 */
export function pickAutoInstallCommand(platform, { hasWinget = false, hasBrew = false, macosMajor = null } = {}) {
  if (platform === "win32" && hasWinget) {
    return {
      cmd: "winget",
      args: [
        "install",
        "-e",
        "--id",
        "Ollama.Ollama",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
      label: "winget install -e --id Ollama.Ollama",
    };
  }
  const macTooOld = macosMajor !== null && macosMajor < OLLAMA_MIN_MACOS;
  if (platform === "darwin" && hasBrew && !macTooOld) {
    return { cmd: "brew", args: ["install", "ollama"], label: "brew install ollama" };
  }
  return null;
}

/** Windows install dir for the Ollama CLI/daemon (winget's default target). */
export function ollamaWindowsDir(localAppData) {
  return win32.join(String(localAppData ?? ""), "Programs", "Ollama");
}

/**
 * `env` with the Windows Ollama install dir appended to PATH, so a just-installed
 * `ollama` resolves in child processes without a shell restart. Appended, so an
 * `ollama` already on PATH still wins.
 */
export function withOllamaOnPath(env, platform, localAppData) {
  if (platform !== "win32" || !localAppData) return env;
  const dir = ollamaWindowsDir(localAppData);
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  const existing = env[key] || "";
  if (existing.split(";").includes(dir)) return env;
  return { ...env, [key]: existing ? `${existing};${dir}` : dir };
}

/**
 * Poll `fetchTags` (an injectable `() => Promise<boolean ok>`) until it
 * resolves true, or `timeoutMs` elapses. `sleepFn` is injectable so tests
 * don't wait for real. Returns true iff the daemon answered within budget.
 *
 * @param {() => Promise<boolean>} fetchTags
 * @param {{ timeoutMs?: number, intervalMs?: number, sleepFn?: (ms: number) => Promise<void> }} [opts]
 */
export async function waitForDaemon(fetchTags, { timeoutMs = 120000, intervalMs = 2000, sleepFn } = {}) {
  const sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  for (;;) {
    if (await fetchTags()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}

/** Platform → the human install guidance shown when Ollama is missing. */
/**
 * Platform-specific Ollama install instructions.
 *
 * @param {string} platform - a `process.platform` value ("darwin"/"win32"/…).
 * @param {number | null} [macosMajor] - macOS major version from
 *   `parseMacosMajor`, or null when unknown/not macOS. When null the generic
 *   guidance is returned, so a failed detection never wrongly claims a Mac is
 *   too old for Ollama's app.
 * @returns {string}
 */
export function installGuidance(platform, macosMajor = null) {
  if (platform === "darwin") {
    // Ollama's .app/.dmg (and the Homebrew cask) are built for macOS
    // OLLAMA_MIN_MACOS+. On an older Mac the download page hands you an app that
    // refuses to launch, and Homebrew itself has dropped those releases (no
    // bottles), so `brew install ollama` fails too. The release's CLI tarball is
    // a universal binary that DOES run there — it just has no .app wrapper, so
    // the daemon has to be started by hand and won't survive a reboot.
    if (macosMajor !== null && macosMajor < OLLAMA_MIN_MACOS) {
      return [
        `  Your macOS (${macosMajor}) is older than Ollama's app requires (${OLLAMA_MIN_MACOS}+),`,
        "  so the download page and `brew install ollama` will NOT work. Use the CLI build:",
        "",
        "    curl -fsSL -o ollama-darwin.tgz \\",
        "      https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz",
        "    mkdir -p ~/.local/ollama && tar xzf ollama-darwin.tgz -C ~/.local/ollama",
        "    ln -sf ~/.local/ollama/ollama /usr/local/bin/ollama",
        "",
        "  Then start it:   `ollama serve` in another terminal (re-run after each reboot).",
      ].join("\n");
    }
    return [
      "  Install Ollama:  https://ollama.com/download   (or: brew install ollama)",
      "  Then start it:   open the Ollama app, or run `ollama serve` in another terminal.",
    ].join("\n");
  }
  if (platform === "win32") {
    return [
      "  Install Ollama:  https://ollama.com/download",
      "  Then start it:   launch the Ollama app (it runs a background daemon).",
    ].join("\n");
  }
  // linux + anything else
  return [
    "  Install Ollama:  curl -fsSL https://ollama.com/install.sh | sh",
    "  Then start it:   `ollama serve` (or the systemd service: `systemctl start ollama`).",
  ].join("\n");
}

/**
 * Launch the Ollama daemon detached, with stdio NOT inherited — a `start`-launched
 * Windows child inherits our stdio pipes otherwise, so it (and any grandchild it
 * spawns) can keep them open forever and hang a caller waiting on the child to exit.
 * `spawnFn` is injectable for tests; returns the child (unref'd) it spawned.
 * @param {string} platform
 * @param {object} [opts]
 * @param {string} [opts.localAppData]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(cmd: string, args: string[], options: object) => import("node:child_process").ChildProcess} [opts.spawnFn]
 */
export function launchOllamaDaemon(platform, opts = {}) {
  const { localAppData = "", env, spawnFn = spawn } = opts;
  const child =
    platform === "win32"
      ? spawnFn("cmd", ["/c", "start", "", join(ollamaWindowsDir(localAppData), "ollama app.exe")], {
          stdio: "ignore",
          detached: true,
          windowsHide: true,
          env,
        })
      : spawnFn("ollama", ["serve"], { detached: true, stdio: "ignore", env });
  child.on("error", () => {});
  child.unref();
  return child;
}

/**
 * The file-system and network half of "Open Granted" (the screen shown once
 * the install finishes): reading/writing scaffold/.env.local, probing
 * whether Granted is answering, and waiting for `npm run dev` to come up.
 *
 * Kept free of any `electron` import, like ipcPure.ts and for the same
 * reason — a plain Node test runner can't import a module that imports
 * `electron` — so this is integration-tested directly against a real
 * temp folder and a real HTTP server. ipc.ts does only the Electron glue
 * (IPC handlers, opening console windows, shell.openExternal).
 */
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ActionResult, ApiKeysInput, GrantedSetupState, OpenIn, SaveKeysResult } from "../shared/ipc";
import {
  applyApiKeys,
  currentEnvValue,
  envHasHostedKeys,
  envIsLocalConfigured,
  isAnthropicKeyFormat,
  isOpenAiKeyFormat,
  looksLikeGranted,
  macStatusLockPath,
  parseOpenInSetting,
  parseStatusFile,
  resolveTaskStatus,
  settingsHasProvider,
  statusLockPath,
  type StatusFile,
  withOpenInSetting,
} from "./ipcPure";

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export function readEnvLocal(scaffoldDir: string): Promise<string | null> {
  return readTextOrNull(join(scaffoldDir, ".env.local"));
}

export async function getSetupState(installDir: string, settingsPath: string): Promise<GrantedSetupState> {
  const scaffoldDir = join(installDir, "scaffold");
  const env = (await readEnvLocal(scaffoldDir)) ?? "";
  const openaiKeySet = isOpenAiKeyFormat(currentEnvValue(env, "OPENAI_API_KEY"));
  const anthropicKeySet = isAnthropicKeyFormat(currentEnvValue(env, "ANTHROPIC_API_KEY"));
  return {
    installDir,
    installed: existsSync(join(scaffoldDir, "package.json")),
    openaiKeySet,
    anthropicKeySet,
    hostedKeysSet: envHasHostedKeys(env),
    localConfigured: envIsLocalConfigured(env, await readTextOrNull(join(scaffoldDir, "data", "local", "corpus-meta.json"))),
    settingsProviderSet: settingsHasProvider(await readTextOrNull(join(scaffoldDir, "data", "local", "llm-config.json"))),
    // win32-gated, not just existsSync: scaffold/scripts/windows/*.ps1 are
    // ordinary files tracked in the repo, present on a real clone on every
    // platform, not only Windows's — without this guard these would read
    // true on a real macOS install too, which is exactly what made
    // startGranted's `background` wrongly route into the win32 tray path
    // there (see ipc.ts). Tray/shortcuts/own-window stay Windows-only for
    // now regardless of whether the files happen to be on disk.
    trayAvailable: process.platform === "win32" && existsSync(windowsScriptPath(scaffoldDir, "granted-tray.ps1")),
    shortcutsAvailable: process.platform === "win32" && existsSync(windowsScriptPath(scaffoldDir, "shortcuts.ps1")),
    appWindowAvailable: process.platform === "win32" && existsSync(windowsScriptPath(scaffoldDir, "open-granted.ps1")),
    openIn: parseOpenInSetting(await readTextOrNull(settingsPath)),
  };
}

/** Saves the "open in" preference to the settings file the tray and open-granted.ps1 read, keeping its other settings. */
export async function saveOpenIn(settingsPath: string, openIn: OpenIn): Promise<ActionResult> {
  try {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, withOpenInSetting(await readTextOrNull(settingsPath), openIn), "utf8");
    return { ok: true, message: openIn === "window" ? "Granted will open in its own window." : "Granted will open in your browser." };
  } catch (err) {
    console.error("saveOpenIn failed:", err);
    return { ok: false, message: "Couldn't save where Granted opens." };
  }
}

/** scaffold/scripts/windows/<name> — the tray, shortcut and icon files (one place builds this path). */
export function windowsScriptPath(scaffoldDir: string, name: "granted-tray.ps1" | "shortcuts.ps1" | "open-granted.ps1"): string {
  return join(scaffoldDir, "scripts", "windows", name);
}

/**
 * Writes the form's keys into scaffold/.env.local. Starts from .env.example
 * when there's no .env.local yet (as setup.mjs does), but writes nothing at
 * all unless a key to score with (OpenAI's or Claude's, see applyApiKeys)
 * ends up set: a rejected form must not leave a half-configured file behind.
 * Search itself needs no key, because it runs on Granted's built-in model.
 */
export async function saveApiKeys(scaffoldDir: string, keys: ApiKeysInput): Promise<SaveKeysResult> {
  const envPath = join(scaffoldDir, ".env.local");
  try {
    const before = (await readEnvLocal(scaffoldDir)) ?? (await readFile(join(scaffoldDir, ".env.example"), "utf8"));
    const { text, missing, invalid } = applyApiKeys(before, {
      OPENAI_API_KEY: keys.openaiApiKey,
      ANTHROPIC_API_KEY: keys.anthropicApiKey,
      EXA_API_KEY: keys.exaApiKey,
    });
    if (invalid.length > 0) {
      const problems = invalid.map((k) =>
        k === "OPENAI_API_KEY"
          ? "That OpenAI key doesn't look right — OpenAI keys start with sk- and are at least 20 characters."
          : "That Claude key doesn't look right — Anthropic keys start with sk-ant- and are at least 20 characters.",
      );
      return { ok: false, message: `${problems.join(" ")} Check for a missing part of the paste.` };
    }
    if (missing.length > 0) {
      return {
        ok: false,
        suggestLocal: true,
        message:
          "Granted needs one API key to score the grants it finds: an OpenAI key or a Claude key. Search itself runs on this computer and needs no key. " +
          "You can add another provider (Gemini, Groq and others) in Settings once Granted is open, or use local models instead, which need no keys.",
      };
    }
    await writeFile(envPath, text, "utf8");
    return { ok: true, message: "Saved your keys to .env.local." };
  } catch (err) {
    // Never echo the keys themselves — only where it failed.
    console.error("saveApiKeys failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, message: `Couldn't write ${envPath}. Check that the folder still exists and isn't read-only.` };
  }
}

/** Whether a process is still running (signal 0 only checks; EPERM means it exists but isn't ours). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A status file's current content, or null if it's missing/unreadable/not yet valid. */
export async function readStatusFile(statusPath: string): Promise<StatusFile | null> {
  const raw = await readTextOrNull(statusPath);
  return raw === null ? null : parseStatusFile(raw);
}

/**
 * Whether the window that writes `statusPath` is still open.
 *
 * win32: the primary check is its exclusive lock on `<status>.lock`
 * (STATUS_LOCK_LINE) — Node's open fails with EBUSY while that window holds
 * it, and succeeds once Windows has released it at process exit. That can't
 * be fooled by PID reuse. Fallback when there's no lock file (it couldn't be
 * created, or an older script): whether the recorded pid exists.
 *
 * Everywhere else (install-macos.sh's, and ipc.ts's launchMacScaffoldTask's
 * own — see macStatusLockPath): both create the same `<status>.lock.d`
 * DIRECTORY right as they start and remove it exactly when they're done
 * (cleanly or with an error) — there's no OS-enforced exclusive hold to ask
 * about the way win32 has, only whether the directory is still there. Gone
 * means that side already ran its cleanup — it already wrote its final
 * status, so there's nothing left "alive" to ask about (this is only ever
 * consulted while state is still "running", so that race doesn't apply: a
 * status that's already done/error is never routed through this function
 * at all — see resolveTaskStatus). Still there means either genuinely still
 * running, or killed outright in a way that skipped that cleanup (a
 * SIGKILL, say) — the pid resolves that, the same fallback win32 uses when
 * it has no lock file at all, and for the same reason: a bare pid check, on
 * its own, can't tell this process from an unrelated one that later reused
 * the same number. This requires BOTH macOS producers to keep creating and
 * removing that directory — a producer that didn't would make "gone" mean
 * nothing, which is exactly why launchMacScaffoldTask does too, even though
 * it has no Windows-style console window to otherwise justify one.
 */
export function isStatusWindowAlive(statusPath: string, pid: number): boolean {
  if (process.platform === "win32") {
    const lockPath = statusLockPath(statusPath);
    if (existsSync(lockPath)) {
      try {
        closeSync(openSync(lockPath, "r+"));
        return false;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return true;
        // Anything else (it vanished between the checks, …): fall through to the pid.
      }
    }
    return isProcessAlive(pid);
  }
  if (!existsSync(macStatusLockPath(statusPath))) return false;
  return isProcessAlive(pid);
}

/** readStatusFile, with a closed task window turned into an error (see resolveTaskStatus). */
export async function readTaskStatus(statusPath: string): Promise<StatusFile | null> {
  return resolveTaskStatus(await readStatusFile(statusPath), (pid) => isStatusWindowAlive(statusPath, pid));
}

/**
 * "granted" = Granted's page answered; "other" = something answered with a
 * different page (another app — or Granted's own error page); "busy" =
 * something accepted the connection but didn't answer in time (e.g. Next.js
 * still compiling the first request); "down" = nothing is listening.
 */
export type ProbeResult = "granted" | "other" | "busy" | "down";

export async function probeGranted(url: string, timeoutMs: number): Promise<ProbeResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return looksLikeGranted(await res.text()) ? "granted" : "other";
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") return "busy";
    return "down";
  }
}

export type StartOutcome =
  | { ok: true }
  | { ok: false; reason: "exited" }
  | { ok: false; reason: "timeout"; lastProbe: ProbeResult | null };

/**
 * Waits for Granted to serve its page. `readStatus` reports the server's
 * console window (null when there's no window to watch — e.g. waiting on a
 * server that was already starting); its status only leaves "running" if
 * the server exits or its window is closed, which — before it ever
 * answered — means it failed. Everything time-related is injectable so
 * tests don't wait for real.
 */
export async function waitForGrantedToStart(opts: {
  probe: () => Promise<ProbeResult>;
  readStatus: () => Promise<StatusFile | null>;
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<StartOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = now();
  let lastProbe: ProbeResult | null = null;
  while (now() - startedAt < opts.timeoutMs) {
    const status = await opts.readStatus();
    if (status?.state === "done" || status?.state === "error") return { ok: false, reason: "exited" };
    lastProbe = await opts.probe();
    if (lastProbe === "granted") return { ok: true };
    await sleep(opts.intervalMs);
  }
  return { ok: false, reason: "timeout", lastProbe };
}

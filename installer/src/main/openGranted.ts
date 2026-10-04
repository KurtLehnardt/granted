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
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionResult, ApiKeysInput, GrantedSetupState, InstallStatusEvent } from "../shared/ipc";
import { applyApiKeys, envHasHostedKeys, envIsLocalConfigured, looksLikeGranted, parseInstallStatusJson } from "./ipcPure";

export async function readEnvLocal(scaffoldDir: string): Promise<string | null> {
  try {
    return await readFile(join(scaffoldDir, ".env.local"), "utf8");
  } catch {
    return null;
  }
}

export async function getSetupState(installDir: string): Promise<GrantedSetupState> {
  const scaffoldDir = join(installDir, "scaffold");
  const env = (await readEnvLocal(scaffoldDir)) ?? "";
  return {
    installDir,
    installed: existsSync(join(scaffoldDir, "package.json")),
    hostedKeysSet: envHasHostedKeys(env),
    localConfigured: envIsLocalConfigured(env),
  };
}

/**
 * Writes the form's keys into scaffold/.env.local. Starts from .env.example
 * when there's no .env.local yet (as setup.mjs does), but writes nothing at
 * all unless both required keys end up set — a rejected form must not leave
 * a half-configured file behind.
 */
export async function saveApiKeys(scaffoldDir: string, keys: ApiKeysInput): Promise<ActionResult> {
  const envPath = join(scaffoldDir, ".env.local");
  try {
    const before = (await readEnvLocal(scaffoldDir)) ?? (await readFile(join(scaffoldDir, ".env.example"), "utf8"));
    const { text, missing } = applyApiKeys(before, {
      OPENAI_API_KEY: keys.openaiApiKey,
      ANTHROPIC_API_KEY: keys.anthropicApiKey,
      EXA_API_KEY: keys.exaApiKey,
    });
    if (missing.length > 0) {
      const names = missing.map((k) => (k === "OPENAI_API_KEY" ? "OpenAI" : "Anthropic"));
      return { ok: false, message: `Granted needs your ${names.join(" and ")} API key${names.length > 1 ? "s" : ""} to run.` };
    }
    await writeFile(envPath, text, "utf8");
    return { ok: true, message: "Saved your keys to .env.local." };
  } catch (err) {
    // Never echo the keys themselves — only where it failed.
    console.error("saveApiKeys failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, message: `Couldn't write ${envPath}. Check that the folder still exists and isn't read-only.` };
  }
}

/** A status file's current content, or null if it's missing/unreadable/not yet valid. */
export async function readStatusFile(statusPath: string): Promise<InstallStatusEvent | null> {
  try {
    return parseInstallStatusJson(await readFile(statusPath, "utf8"));
  } catch {
    return null;
  }
}

/** "granted" = Granted answered; "other" = something else answered; "down" = nothing answered. */
export type ProbeResult = "granted" | "other" | "down";

export async function probeGranted(url: string, timeoutMs: number): Promise<ProbeResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return looksLikeGranted(await res.text()) ? "granted" : "other";
  } catch {
    return "down";
  }
}

export type StartOutcome = { ok: true } | { ok: false; reason: "exited" | "timeout" };

/**
 * Waits for a just-launched `npm run dev` to serve Granted's page. Its
 * console window's status file only ever leaves "running" if the server
 * process exits — which, before it ever answered, means it failed — so
 * that's checked first on every round. Everything time-related is
 * injectable so tests don't wait for real.
 */
export async function waitForGrantedToStart(opts: {
  probe: () => Promise<ProbeResult>;
  readStatus: () => Promise<InstallStatusEvent | null>;
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<StartOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = now();
  while (now() - startedAt < opts.timeoutMs) {
    const status = await opts.readStatus();
    if (status?.state === "done" || status?.state === "error") return { ok: false, reason: "exited" };
    if ((await opts.probe()) === "granted") return { ok: true };
    await sleep(opts.intervalMs);
  }
  return { ok: false, reason: "timeout" };
}

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ollamaHost } from "./ollamaInfo";
import type { OllamaJob } from "./ollamaModels";
import {
  launchOllamaDaemon,
  pickAutoInstallCommand,
  waitForDaemon,
  withOllamaOnPath,
  OLLAMA_WINDOWS_INSTALLER_URL,
} from "../../scripts/lib/ollamaSetup.mjs";

/**
 * Background jobs behind Settings → Model → Local's buttons: start the Ollama
 * daemon, pull a model, install Ollama (Windows). One of each at a time, kept
 * in memory on globalThis (survives dev hot reload) so a reload of the
 * Settings page picks the progress back up from GET /api/llm/ollama.
 *
 * Daemon launch and install commands are scripts/lib/ollamaSetup.mjs's — the
 * same code `npm run setup:local` runs.
 */

type Jobs = { start?: OllamaJob; pull?: OllamaJob; install?: OllamaJob };
type JobState = { jobs: Jobs; startPromise?: Promise<boolean> };

const G = globalThis as typeof globalThis & { __grantedOllamaJobs?: JobState };
const state: JobState = (G.__grantedOllamaJobs ??= { jobs: {} });

export function getOllamaJobs(): Jobs {
  const { start, pull, install } = state.jobs;
  return {
    ...(start ? { start: { ...start } } : {}),
    ...(pull ? { pull: { ...pull } } : {}),
    ...(install ? { install: { ...install } } : {}),
  };
}

/** Test-only. */
export function resetOllamaJobs(): void {
  state.jobs = {};
  state.startPromise = undefined;
}

export type OllamaJobDeps = {
  host: string;
  platform: NodeJS.Platform;
  fetch: typeof fetch;
  /** Launches the daemon (default: setup-local's launchOllamaDaemon). */
  launch: () => void;
  /** How long to wait for a launched daemon to answer. */
  startTimeoutMs: number;
  pollIntervalMs: number;
  /** Runs a command to completion, streaming output lines; resolves its exit code. */
  runCommand: (cmd: string, args: string[], onLine: (line: string) => void) => Promise<number>;
  hasWinget: () => boolean;
  tmpDir: string;
};

function childEnv(): NodeJS.ProcessEnv {
  return withOllamaOnPath(process.env, process.platform, process.env.LOCALAPPDATA) as NodeJS.ProcessEnv;
}

function realRunCommand(cmd: string, args: string[], onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: childEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(-1);
      return;
    }
    const feed = (buf: Buffer) => {
      for (const raw of buf.toString("utf8").split(/[\r\n]+/)) {
        const line = raw.replace(/[^\x20-\x7E▀-▟]/g, "").trim();
        if (line) onLine(line);
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

let wingetCache: boolean | undefined;
/** winget is available (Windows), checked once per process. */
export function hasWinget(): boolean {
  if (wingetCache === undefined) {
    try {
      wingetCache = spawnSync("winget", ["--version"], { timeout: 5000, windowsHide: true }).status === 0;
    } catch {
      wingetCache = false;
    }
  }
  return wingetCache;
}

function realDeps(): OllamaJobDeps {
  return {
    host: ollamaHost(),
    platform: process.platform,
    fetch: (...args) => fetch(...args),
    launch: () => {
      launchOllamaDaemon(process.platform, { localAppData: process.env.LOCALAPPDATA || "", env: childEnv() });
    },
    // The first start after an install can take over a minute (setup-local waits 120s).
    startTimeoutMs: 90_000,
    pollIntervalMs: 1_500,
    runCommand: realRunCommand,
    hasWinget,
    tmpDir: os.tmpdir(),
  };
}

/** True when Ollama answers /api/tags at `host`. */
export async function ollamaAnswers(host: string, fetchImpl: typeof fetch = fetch, timeoutMs = 1_500): Promise<boolean> {
  try {
    const res = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Start the Ollama daemon if it isn't answering, and wait for it. Concurrent
 * callers (Settings' auto-start, a Local search) share one attempt. Resolves
 * true once it answers. Progress is reported as the `start` job.
 */
export function startOllamaAndWait(deps: Partial<OllamaJobDeps> = {}): Promise<boolean> {
  if (state.startPromise) return state.startPromise;
  const d = { ...realDeps(), ...deps };
  const job: OllamaJob = { status: "running", message: "Starting Ollama…" };
  state.jobs.start = job;
  const p = (async () => {
    try {
      if (await ollamaAnswers(d.host, d.fetch)) {
        Object.assign(job, { status: "done", message: "Ollama is running." });
        return true;
      }
      try {
        d.launch();
      } catch (e) {
        Object.assign(job, { status: "error", error: `Couldn't launch Ollama: ${(e as Error).message}` });
        return false;
      }
      job.message = "Waiting for Ollama to start (the first start can take a minute)…";
      const up = await waitForDaemon(() => ollamaAnswers(d.host, d.fetch), {
        timeoutMs: d.startTimeoutMs,
        intervalMs: d.pollIntervalMs,
      });
      if (up) Object.assign(job, { status: "done", message: "Ollama is running." });
      else
        Object.assign(job, {
          status: "error",
          error: `Ollama didn't start within ${Math.round(d.startTimeoutMs / 1000)} seconds. Open the Ollama app yourself (or run "ollama serve"), then check again.`,
        });
      return up;
    } finally {
      state.startPromise = undefined;
    }
  })();
  state.startPromise = p;
  return p;
}

/** Fire-and-forget start for the status route; returns the job as it stands. */
export function startOllama(deps: Partial<OllamaJobDeps> = {}): OllamaJob {
  void startOllamaAndWait(deps);
  return { ...state.jobs.start! };
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

const gb = (n: number) => `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;

/**
 * Pull `model` through Ollama's /api/pull, reading its NDJSON progress stream.
 * Calls `onProgress` with an overall percentage (summed over every layer seen)
 * and a status line. Throws with Ollama's own message on failure.
 */
export async function pullModelStream(
  host: string,
  model: string,
  onProgress: (p: { pct?: number; message: string }) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(`${host}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `model` is the current field; older Ollama builds read `name`.
      body: JSON.stringify({ model, name: model, stream: true }),
    });
  } catch {
    throw new Error("Couldn't reach Ollama. Start it, then try the download again.");
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let msg = text;
    try {
      msg = JSON.parse(text)?.error ?? text;
    } catch {
      /* plain text */
    }
    throw new Error(msg ? `Ollama couldn't download ${model}: ${msg}` : `Ollama couldn't download ${model} (HTTP ${res.status}).`);
  }

  const layers = new Map<string, { total: number; completed: number }>();
  let succeeded = false;
  const handle = (line: string) => {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof ev?.error === "string") throw new Error(`Ollama couldn't download ${model}: ${ev.error}`);
    if (ev?.status === "success") {
      succeeded = true;
      onProgress({ pct: 100, message: `Downloaded ${model}.` });
      return;
    }
    if (typeof ev?.digest === "string" && typeof ev?.total === "number" && ev.total > 0) {
      layers.set(ev.digest, { total: ev.total, completed: typeof ev.completed === "number" ? ev.completed : 0 });
    }
    let total = 0;
    let done = 0;
    layers.forEach((l) => {
      total += l.total;
      done += Math.min(l.completed, l.total);
    });
    if (total > 0 && typeof ev?.digest === "string") {
      onProgress({ pct: Math.min(99, Math.floor((done / total) * 100)), message: `Downloading ${model}: ${gb(done)} of ${gb(total)}` });
    } else if (typeof ev?.status === "string") {
      onProgress({ message: `${ev.status[0].toUpperCase()}${ev.status.slice(1)}…` });
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handle(line);
    }
    if (done) break;
  }
  if (buf.trim()) handle(buf.trim());
  if (!succeeded) throw new Error(`The download of ${model} stopped before it finished. Try again.`);
}

/**
 * Start pulling `model` in the background (one pull at a time). Returns the job,
 * or `{ busy }` when a different model is already downloading.
 */
export function pullModel(model: string, deps: Partial<OllamaJobDeps> = {}): { job: OllamaJob; busy?: string } {
  const current = state.jobs.pull;
  if (current?.status === "running") {
    return current.model === model ? { job: { ...current } } : { job: { ...current }, busy: current.model };
  }
  const d = { ...realDeps(), ...deps };
  const job: OllamaJob = { status: "running", model, pct: 0, message: `Starting the download of ${model}…` };
  state.jobs.pull = job;
  void pullModelStream(
    d.host,
    model,
    (p) => {
      if (p.pct !== undefined) job.pct = p.pct;
      job.message = p.message;
    },
    d.fetch,
  ).then(
    () => Object.assign(job, { status: "done", pct: 100, message: `Downloaded ${model}.` }),
    (e) => Object.assign(job, { status: "error", error: (e as Error).message }),
  );
  return { job: { ...job } };
}

// ---------------------------------------------------------------------------
// Install (Windows)
// ---------------------------------------------------------------------------

async function downloadFile(url: string, dest: string, fetchImpl: typeof fetch, onPct: (pct: number) => void): Promise<void> {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const out = createWriteStream(dest);
  let got = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      if (total) onPct(Math.floor((got / total) * 100));
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
}

/**
 * Install Ollama on Windows: winget (Ollama.Ollama), falling back to the
 * official installer run silently, then start the daemon. One at a time.
 */
export function installOllama(deps: Partial<OllamaJobDeps> = {}): OllamaJob {
  const current = state.jobs.install;
  if (current?.status === "running") return { ...current };
  const d = { ...realDeps(), ...deps };
  const job: OllamaJob = { status: "running", pct: 0, message: "Installing Ollama…" };
  state.jobs.install = job;

  void (async () => {
    let installed = false;
    const winget = d.hasWinget() ? pickAutoInstallCommand(d.platform, { hasWinget: true }) : null;
    if (winget) {
      job.message = `Installing Ollama with ${winget.label}…`;
      const code = await d.runCommand(winget.cmd, winget.args, (line) => {
        const m = /(\d{1,3})\s*%/.exec(line);
        if (m) job.pct = Math.min(99, Number(m[1]));
        job.message = `winget: ${line.slice(0, 160)}`;
      });
      installed = code === 0;
    }
    if (!installed) {
      try {
        job.pct = 0;
        job.message = "Downloading the Ollama installer from ollama.com…";
        const dest = path.join(d.tmpDir, "OllamaSetup.exe");
        await downloadFile(OLLAMA_WINDOWS_INSTALLER_URL, dest, d.fetch, (pct) => {
          job.pct = Math.min(99, pct);
          job.message = `Downloading the Ollama installer: ${pct}%`;
        });
        job.message = "Running the Ollama installer…";
        const code = await d.runCommand(dest, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"], () => {});
        installed = code === 0;
      } catch {
        installed = false;
      }
    }
    if (!installed) {
      Object.assign(job, {
        status: "error",
        error: "Couldn't install Ollama automatically. Download it from https://ollama.com/download, run the installer, then check again.",
      });
      return;
    }
    job.pct = 100;
    job.message = "Ollama is installed. Starting it…";
    const up = await startOllamaAndWait(d);
    if (up) Object.assign(job, { status: "done", message: "Ollama is installed and running." });
    else
      Object.assign(job, {
        status: "error",
        error: "Ollama is installed but didn't start. Open the Ollama app from the Start menu, then check again.",
      });
  })();
  return { ...job };
}

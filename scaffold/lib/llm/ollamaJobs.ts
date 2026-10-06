import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ollamaHost } from "./ollamaInfo";
import { locateOllama } from "./ollamaLocate";
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
 * Pulls and installs can be cancelled, and fail on their own when they make no
 * progress for `idleMs` — a job is never stuck "running".
 *
 * Daemon launch and install commands are scripts/lib/ollamaSetup.mjs's — the
 * same code `npm run setup:local` runs.
 */

export type OllamaJobKind = "start" | "pull" | "install";
type Jobs = { start?: OllamaJob; pull?: OllamaJob; install?: OllamaJob };
type JobState = {
  jobs: Jobs;
  startPromise?: Promise<boolean>;
  controllers: Partial<Record<OllamaJobKind, AbortController>>;
};

const G = globalThis as typeof globalThis & { __grantedOllamaJobs?: JobState };
const state: JobState = (G.__grantedOllamaJobs ??= { jobs: {}, controllers: {} });
state.controllers ??= {};

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
  for (const c of Object.values(state.controllers)) c?.abort();
  state.jobs = {};
  state.controllers = {};
  state.startPromise = undefined;
}

const CANCELLED = "Cancelled.";

/** Cancel a running job (aborts its download, kills its installer). False when nothing of that kind is running. */
export function cancelOllamaJob(kind: OllamaJobKind): boolean {
  const job = state.jobs[kind];
  if (job?.status !== "running") return false;
  Object.assign(job, { status: "error", error: CANCELLED, pct: undefined });
  state.controllers[kind]?.abort(new Error(CANCELLED));
  return true;
}

export type OllamaJobDeps = {
  host: string;
  platform: NodeJS.Platform;
  fetch: typeof fetch;
  /** Launches the daemon (default: setup-local's launchOllamaDaemon on the install locateOllama found). */
  launch: () => void;
  /** How long to wait for a launched daemon to answer. */
  startTimeoutMs: number;
  pollIntervalMs: number;
  /** A download that makes no progress for this long fails. */
  idleMs: number;
  /** Runs a command to completion, streaming output lines; resolves its exit code. Killed when `signal` aborts. */
  runCommand: (cmd: string, args: string[], onLine: (line: string) => void, signal?: AbortSignal) => Promise<number>;
  hasWinget: () => boolean;
  /** The downloaded installer is signed by Ollama (Authenticode: Valid, signer contains "Ollama"). */
  verifySignature: (file: string) => Promise<boolean>;
  tmpDir: string;
};

function childEnv(): NodeJS.ProcessEnv {
  return withOllamaOnPath(process.env, process.platform, process.env.LOCALAPPDATA) as NodeJS.ProcessEnv;
}

function realRunCommand(cmd: string, args: string[], onLine: (line: string) => void, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(-1);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { env: childEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(-1);
      return;
    }
    const kill = () => {
      try {
        // winget/the installer may spawn children: take the whole tree down on Windows.
        if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
        else child.kill();
      } catch {
        /* already gone */
      }
    };
    signal?.addEventListener("abort", kill, { once: true });
    const feed = (buf: Buffer) => {
      for (const raw of buf.toString("utf8").split(/[\r\n]+/)) {
        const line = raw.replace(/[^\x20-\x7E▀-▟]/g, "").trim();
        if (line) onLine(line);
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", () => resolve(-1));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      resolve(code ?? -1);
    });
  });
}

/** Authenticode check via PowerShell: status Valid and a signer subject naming Ollama. */
async function realVerifySignature(file: string): Promise<boolean> {
  let out = "";
  const literal = file.replace(/'/g, "''");
  const code = await realRunCommand(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$s = Get-AuthenticodeSignature -LiteralPath '${literal}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
    ],
    (line) => (out = line),
  );
  return code === 0 && isTrustedOllamaSignature(out);
}

/** Pure: Get-AuthenticodeSignature's "Status|Subject" line is a valid signature by Ollama. */
export function isTrustedOllamaSignature(line: string): boolean {
  const [status, subject = ""] = line.split("|");
  return status?.trim() === "Valid" && /ollama/i.test(subject);
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
      // The install actually found (e.g. under Program Files), else `ollama serve` from PATH.
      launchOllamaDaemon(process.platform, {
        localAppData: process.env.LOCALAPPDATA || "",
        env: childEnv(),
        exePath: locateOllama() ?? "ollama",
      });
    },
    // The first start after an install can take over a minute (setup-local waits 120s).
    startTimeoutMs: 90_000,
    pollIntervalMs: 1_500,
    idleMs: 60_000,
    runCommand: realRunCommand,
    hasWinget,
    verifySignature: realVerifySignature,
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

/**
 * Read a byte stream to the end, failing if `idleMs` passes with no data or
 * `signal` aborts. The reader is cancelled (connection released) on any failure.
 */
async function readWithIdleTimeout(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  idleMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: Error) => void reader.cancel(reason).catch(() => {});
  const onAbort = () => stop(new Error(CANCELLED));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new IdleError()), idleMs);
      });
      const { value, done } = await Promise.race([reader.read(), idle]);
      clearTimeout(timer);
      if (signal?.aborted) throw new Error(CANCELLED);
      if (done) return;
      if (value) await onChunk(value);
    }
  } catch (e) {
    stop(e as Error);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* a pending read after cancel: the cancel already released the connection */
    }
  }
}

class IdleError extends Error {
  constructor() {
    super("stalled");
    this.name = "IdleError";
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

export const downloadStopped = (model: string) => `The download of ${model} stopped before it finished. Try again.`;

/**
 * Pull `model` through Ollama's /api/pull, reading its NDJSON progress stream.
 * Calls `onProgress` with an overall percentage (summed over every layer seen)
 * and a status line. Throws with Ollama's own message when it reports one, a
 * "stopped before it finished" message when the stream dies or stalls for
 * `idleMs`, and "Cancelled." when `signal` aborts.
 */
export async function pullModelStream(
  host: string,
  model: string,
  onProgress: (p: { pct?: number; message: string }) => void,
  fetchImpl: typeof fetch = fetch,
  opts: { signal?: AbortSignal; idleMs?: number } = {},
): Promise<void> {
  const { signal, idleMs = 60_000 } = opts;
  let res: Response;
  try {
    res = await fetchImpl(`${host}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `model` is the current field; older Ollama builds read `name`.
      body: JSON.stringify({ model, name: model, stream: true }),
      signal,
    });
  } catch {
    if (signal?.aborted) throw new Error(CANCELLED);
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
  let ollamaError: string | undefined;
  const handle = (line: string) => {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof ev?.error === "string") {
      ollamaError = `Ollama couldn't download ${model}: ${ev.error}`;
      throw new Error(ollamaError);
    }
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

  const decoder = new TextDecoder();
  let buf = "";
  try {
    await readWithIdleTimeout(
      res.body,
      (chunk) => {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handle(line);
        }
      },
      idleMs,
      signal,
    );
    if (buf.trim()) handle(buf.trim());
  } catch (e) {
    if (signal?.aborted) throw new Error(CANCELLED);
    if (ollamaError) throw e;
    // The connection dropped, or no progress for idleMs: never a raw socket error.
    throw new Error(downloadStopped(model));
  }
  if (!succeeded) throw new Error(downloadStopped(model));
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
  const ac = new AbortController();
  state.jobs.pull = job;
  state.controllers.pull = ac;
  void pullModelStream(
    d.host,
    model,
    (p) => {
      if (job.status !== "running") return;
      if (p.pct !== undefined) job.pct = p.pct;
      job.message = p.message;
    },
    d.fetch,
    { signal: ac.signal, idleMs: d.idleMs },
  )
    .then(
      () => {
        if (job.status === "running") Object.assign(job, { status: "done", pct: 100, message: `Downloaded ${model}.` });
      },
      (e) => {
        if (job.status === "running") Object.assign(job, { status: "error", error: (e as Error).message });
      },
    )
    .finally(() => {
      if (state.controllers.pull === ac) delete state.controllers.pull;
    });
  return { job: { ...job } };
}

// ---------------------------------------------------------------------------
// Install (Windows)
// ---------------------------------------------------------------------------

async function downloadFile(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
  onPct: (pct: number) => void,
  opts: { signal?: AbortSignal; idleMs: number },
): Promise<void> {
  const res = await fetchImpl(url, { redirect: "follow", signal: opts.signal });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const out = createWriteStream(dest);
  let got = 0;
  try {
    await readWithIdleTimeout(
      res.body,
      async (value) => {
        got += value.byteLength;
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
        if (total) onPct(Math.floor((got / total) * 100));
      },
      opts.idleMs,
      opts.signal,
    );
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  if (total && got < total) throw new Error("The installer download stopped before it finished.");
}

/**
 * Install Ollama on Windows: winget (Ollama.Ollama), falling back to the
 * official installer — downloaded to a unique temp file, run silently only if
 * its Authenticode signature is valid and Ollama's — then start the daemon.
 * One at a time; cancellable.
 */
export function installOllama(deps: Partial<OllamaJobDeps> = {}): OllamaJob {
  const current = state.jobs.install;
  if (current?.status === "running") return { ...current };
  const d = { ...realDeps(), ...deps };
  const job: OllamaJob = { status: "running", pct: 0, message: "Installing Ollama…" };
  const ac = new AbortController();
  const signal = ac.signal;
  state.jobs.install = job;
  state.controllers.install = ac;
  const update = (patch: Partial<OllamaJob>) => {
    if (job.status === "running") Object.assign(job, patch);
  };

  void (async () => {
    let installed = false;
    let failure = "Couldn't install Ollama automatically.";
    const winget = d.hasWinget() ? pickAutoInstallCommand(d.platform, { hasWinget: true }) : null;
    if (winget) {
      update({ message: `Installing Ollama with ${winget.label}…` });
      const code = await d.runCommand(
        winget.cmd,
        winget.args,
        (line) => {
          const m = /(\d{1,3})\s*%/.exec(line);
          update({ ...(m ? { pct: Math.min(99, Number(m[1])) } : {}), message: `winget: ${line.slice(0, 160)}` });
        },
        signal,
      );
      installed = code === 0;
    }
    if (!installed && !signal.aborted) {
      const dest = path.join(d.tmpDir, `OllamaSetup-${Date.now()}-${randomBytes(4).toString("hex")}.exe`);
      try {
        update({ pct: 0, message: "Downloading the Ollama installer from ollama.com…" });
        await downloadFile(
          OLLAMA_WINDOWS_INSTALLER_URL,
          dest,
          d.fetch,
          (pct) => update({ pct: Math.min(99, pct), message: `Downloading the Ollama installer: ${pct}%` }),
          { signal, idleMs: d.idleMs },
        );
        update({ message: "Checking the installer's signature…" });
        if (!(await d.verifySignature(dest))) {
          failure = "The downloaded installer isn't signed by Ollama, so Granted didn't run it.";
        } else {
          update({ message: "Running the Ollama installer…" });
          installed = (await d.runCommand(dest, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"], () => {}, signal)) === 0;
        }
      } catch {
        installed = false;
      } finally {
        try {
          rmSync(dest, { force: true });
        } catch {
          /* still locked by an installer that's exiting: the OS temp cleanup gets it */
        }
      }
    }
    if (state.controllers.install === ac) delete state.controllers.install;
    if (signal.aborted) return; // cancelOllamaJob already set the job's state
    if (!installed) {
      update({
        status: "error",
        error: `${failure} Download it from https://ollama.com/download, run the installer, then check again.`,
      });
      return;
    }
    update({ pct: 100, message: "Ollama is installed. Starting it…" });
    const up = await startOllamaAndWait(d);
    if (up) update({ status: "done", message: "Ollama is installed and running." });
    else
      update({
        status: "error",
        error: "Ollama is installed but didn't start. Open the Ollama app from the Start menu, then check again.",
      });
  })();
  return { ...job };
}

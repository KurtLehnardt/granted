#!/usr/bin/env node
/**
 * Granted — guided fully-local setup (Ollama).
 *
 *   npm run setup:local            (from the scaffold/ directory)
 *   npm run setup:local -- --yes   (non-interactive; sane defaults)
 *
 * Takes a self-hoster all the way to a fully-offline run in one command:
 *   1. Detects OS + available memory/GPU to recommend a chat model.
 *   2. Verifies Ollama is installed and its daemon is reachable, offering to install
 *      it (winget on Windows, Homebrew on macOS 14+) before falling back to guidance.
 *   3. Installs a NEW recommended model or lets you pick an EXISTING one.
 *   4. Makes sure the built-in search model is downloaded (`npm run model:fetch`).
 *      Search doesn't go through Ollama: it runs nomic-embed-text-v1.5 in the app
 *      itself, against corpus vectors that ship with Granted (the same vectors
 *      Ollama's nomic-embed-text produces), so there is no embedding model to pull
 *      and nothing to re-embed.
 *   5. Merges the local env into scaffold/.env.local (never clobbering a value you
 *      already set).
 *
 * Mirrors scripts/setup.mjs: idempotent, never overwrites an existing non-empty
 * value, never leaves a half-written .env.local. Cross-platform (no bash/
 * PowerShell-only assumptions in the control flow) — child processes are branched
 * on process.platform.
 *
 * The pure logic (memory→model recommendation, env merge, and every command-output
 * parser) is exported and unit-tested in scripts/__tests__/setupLocal.test.ts;
 * none of the tests need a TTY or a live Ollama.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  OLLAMA_MIN_MACOS,
  parseMacosMajor,
  MODEL_TIERS,
  recommendModel,
  pickAutoInstallCommand,
  ollamaWindowsDir,
  withOllamaOnPath,
  waitForDaemon,
  installGuidance,
  launchOllamaDaemon,
} from "./lib/ollamaSetup.mjs";

// Shared with the app's Settings → Model → Local panel (lib/llm/ollamaJobs.ts);
// re-exported so existing importers (and the tests) keep their paths.
export {
  OLLAMA_MIN_MACOS,
  parseMacosMajor,
  MODEL_TIERS,
  recommendModel,
  pickAutoInstallCommand,
  ollamaWindowsDir,
  withOllamaOnPath,
  waitForDaemon,
  installGuidance,
  launchOllamaDaemon,
};

const SCAFFOLD = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = join(SCAFFOLD, ".env.local");
const EXAMPLE = join(SCAFFOLD, ".env.example");

const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const OLLAMA_API_TAGS = "http://localhost:11434/api/tags";
// Non-interactive fallback when memory detection is unreliable and we can't ask:
// a middling small model that runs on modest hardware.
const DEFAULT_MODEL_WHEN_UNKNOWN = "llama3.2:3b";

// ---------------------------------------------------------------------------
// PURE LOGIC (exported + unit-tested — no I/O, no child processes)
// ---------------------------------------------------------------------------

/** Return the value already set for `key` in env text, or "" if blank/absent. */
export function currentValue(text, key) {
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

/** Replace `key=...` in place, or append it if the key isn't present. */
export function upsert(text, key, value) {
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, "m").test(text)) {
    return text.replace(new RegExp(`^${key}=.*$`, "m"), line);
  }
  return `${text.replace(/\s*$/, "")}\n${line}\n`;
}

/**
 * Merge `updates` (a plain {KEY: value} object) into env text WITHOUT clobbering
 * any key that already holds a non-empty value — the exact idempotent contract
 * scripts/setup.mjs uses for keys. Returns the merged text plus which keys were
 * written (`applied`) and which were left as-is (`skipped`, with the existing
 * value) so the caller can report both honestly.
 */
export function mergeEnvLocal(text, updates) {
  let out = text;
  const applied = [];
  const skipped = [];
  for (const [key, value] of Object.entries(updates)) {
    const existing = currentValue(out, key);
    if (existing) {
      skipped.push({ key, existing });
      continue;
    }
    out = upsert(out, key, value);
    applied.push({ key, value });
  }
  return { text: out, applied, skipped };
}

/** Coerce to a number, but treat null/blank strings as NaN (Number("") is 0). */
function toNum(v) {
  if (v == null) return NaN;
  if (typeof v === "string" && v.trim() === "") return NaN;
  return Number(v);
}

/** Bytes → whole GB (floored). Non-finite/negative/blank → NaN. */
export function bytesToGB(bytes) {
  const n = toNum(bytes);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.floor(n / 1024 ** 3);
}

/** Kilobytes → whole GB (floored). `/proc/meminfo` reports kB. */
export function kbToGB(kb) {
  const n = toNum(kb);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.floor(n / (1024 * 1024));
}

/** Mebibytes → whole GB (floored). `nvidia-smi` reports MiB. */
export function mibToGB(mib) {
  const n = toNum(mib);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.floor(n / 1024);
}

/** Parse `sysctl -n hw.memsize` (bytes on one line) → GB. */
export function parseSysctlMemsize(stdout) {
  return bytesToGB(String(stdout ?? "").trim());
}

/**
 * Parse `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`
 * (one MiB integer per GPU) → the LARGEST GPU's VRAM in GB, or NaN if none.
 */
export function parseNvidiaSmi(stdout) {
  const gbs = String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => mibToGB(l))
    .filter((n) => Number.isFinite(n));
  return gbs.length ? Math.max(...gbs) : NaN;
}

/** Parse `/proc/meminfo` text → total RAM in GB (from the `MemTotal:` line). */
export function parseProcMeminfo(text) {
  const m = String(text ?? "").match(/^MemTotal:\s+(\d+)\s*kB/mi);
  return m ? kbToGB(m[1]) : NaN;
}

/**
 * Parse a Windows PowerShell numeric dump (e.g. Win32_ComputerSystem
 * TotalPhysicalMemory in bytes, or Win32_VideoController AdapterRAM in bytes) →
 * the LARGEST value in GB. AdapterRAM is a uint32 capped at ~4GB — the caller
 * warns about that; this just extracts numbers robustly from noisy output.
 */
export function parseWinBytes(stdout) {
  const nums = String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map((l) => bytesToGB(l))
    .filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) : NaN;
}

/**
 * Parse `ollama list` stdout → array of model names (the first column). Skips the
 * header row and blank lines. Tolerant of the varying column widths Ollama emits.
 */
export function parseOllamaList(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^NAME\b/i.test(l))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean);
}


// ---------------------------------------------------------------------------
// I/O + child-process helpers (impure; kept thin so the pure parsers do the work)
// ---------------------------------------------------------------------------

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
function heading(s) {
  console.log(`\n${c.b(s)}`);
}

const ARGS = process.argv.slice(2);
const YES = ARGS.includes("--yes") || ARGS.includes("-y");
const IS_TTY = Boolean(process.stdin.isTTY);

function ask(query) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Yes/No prompt. In --yes mode returns `dflt` without prompting. */
async function confirm(query, dflt = true) {
  if (YES) return dflt;
  const hint = dflt ? c.dim("[Y/n]") : c.dim("[y/N]");
  const a = (await ask(`  ${query} ${hint} `)).toLowerCase();
  if (a === "") return dflt;
  return a === "y" || a === "yes";
}

/** Run a command, capturing stdout. Returns stdout string on success, else null. */
function run(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000, env: childEnv() });
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout;
    return null;
  } catch {
    return null;
  }
}

/** Run a command with inherited stdio (progress visible) → boolean success. */
function runInherit(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { stdio: "inherit", env: childEnv() });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** GET the Ollama tags endpoint to confirm the daemon is up. Returns models[] or null. */
async function ollamaDaemonModels() {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(OLLAMA_API_TAGS, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json?.models) ? json.models : [];
  } catch {
    return null;
  }
}

/** Extend the live env for THIS process's child_process calls (Windows PATH fix-up). */
function childEnv() {
  return withOllamaOnPath(process.env, process.platform, process.env.LOCALAPPDATA);
}

/** `node scripts/fetch-model.mjs`: download (or verify) the built-in search model, output shown live. Resolves true on success. */
function runFetchModel() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(SCAFFOLD, "scripts", "fetch-model.mjs")], { cwd: SCAFFOLD, stdio: "inherit" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}


/** Try to install Ollama automatically (winget on Windows, brew on macOS 14+). */
async function tryAutoInstall(platform, macosMajor) {
  const hasWinget = platform === "win32" && Boolean(run("winget", ["--version"]));
  const hasBrew = platform === "darwin" && Boolean(run("brew", ["--version"]));
  const choice = pickAutoInstallCommand(platform, { hasWinget, hasBrew, macosMajor });
  if (!choice) return false;

  const proceed = await confirm(`Install Ollama automatically now (${choice.label})?`, true);
  if (!proceed) return false;

  console.log(c.dim(`\n  Running: ${choice.cmd} ${choice.args.join(" ")}`));
  const ok = runInherit(choice.cmd, choice.args);
  if (!ok) {
    console.log(c.y("\n  Automatic install failed. Falling back to manual guidance."));
    return false;
  }
  console.log(`  ${c.g("✓")} Ollama installed`);

  // Start the daemon (Windows: the app; else `ollama serve` detached), then
  // poll for it — the observed first start can take well over a minute.
  // Skip launching if it's already up: winget's installer often starts the
  // app itself, and on Windows a `start`-launched child inherits our stdio
  // pipes, so spawning it again (or with those pipes) can hang indefinitely.
  const alreadyUp = (await ollamaDaemonModels()) !== null;
  if (!alreadyUp) {
    try {
      launchOllamaDaemon(platform, { localAppData: process.env.LOCALAPPDATA || "", env: childEnv() });
    } catch {
      /* best-effort */
    }
  }

  console.log(c.dim("  Waiting for the Ollama daemon to come up (can take over a minute on first start)…"));
  const up = await waitForDaemon(async () => (await ollamaDaemonModels()) !== null);
  if (up) {
    console.log(`  ${c.g("✓")} daemon reachable at ${c.dim("localhost:11434")}`);
  } else {
    console.log(c.y("\n  Daemon still not reachable after waiting. Falling back to manual guidance."));
  }
  return up;
}

/**
 * Detect usable memory/VRAM for a model recommendation.
 * Returns { gb, source, reliable }. `reliable:false` (or gb=null) means "ask the
 * user". Every parser is the pure, tested one above — this just feeds it output.
 */
function detectMemory() {
  const platform = process.platform;

  if (platform === "darwin") {
    // Apple Silicon / Intel: unified (or system) memory in bytes.
    const out = run("sysctl", ["-n", "hw.memsize"]);
    const gb = parseSysctlMemsize(out);
    if (Number.isFinite(gb) && gb > 0) {
      return { gb, source: "unified/system memory (sysctl hw.memsize)", reliable: true };
    }
    return { gb: null, source: "sysctl unavailable", reliable: false };
  }

  if (platform === "linux") {
    // Prefer a discrete NVIDIA GPU's VRAM; fall back to system RAM.
    const smi = run("nvidia-smi", [
      "--query-gpu=memory.total",
      "--format=csv,noheader,nounits",
    ]);
    const vram = parseNvidiaSmi(smi);
    if (Number.isFinite(vram) && vram > 0) {
      return { gb: vram, source: "NVIDIA GPU VRAM (nvidia-smi)", reliable: true };
    }
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf8");
      const ram = parseProcMeminfo(meminfo);
      if (Number.isFinite(ram) && ram > 0) {
        return { gb: ram, source: "system RAM (/proc/meminfo)", reliable: true };
      }
    } catch {
      /* fall through */
    }
    return { gb: null, source: "no nvidia-smi and /proc/meminfo unreadable", reliable: false };
  }

  if (platform === "win32") {
    // Prefer NVIDIA VRAM; else PowerShell. AdapterRAM is a uint32 capped at 4GB
    // (unreliable), so we prefer TotalPhysicalMemory and flag the caveat.
    const smi = run("nvidia-smi", [
      "--query-gpu=memory.total",
      "--format=csv,noheader,nounits",
    ]);
    const vram = parseNvidiaSmi(smi);
    if (Number.isFinite(vram) && vram > 0) {
      return { gb: vram, source: "NVIDIA GPU VRAM (nvidia-smi)", reliable: true };
    }
    const totalOut = run("powershell", [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
    ]);
    const totalRam = parseWinBytes(totalOut);
    if (Number.isFinite(totalRam) && totalRam > 0) {
      return {
        gb: totalRam,
        source: "total system RAM (Win32_ComputerSystem) — GPU VRAM unknown",
        reliable: true,
      };
    }
    // Last resort: AdapterRAM, explicitly flagged unreliable (uint32 4GB cap).
    const adapterOut = run("powershell", [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty AdapterRAM)",
    ]);
    const adapter = parseWinBytes(adapterOut);
    if (Number.isFinite(adapter) && adapter > 0) {
      return {
        gb: adapter,
        source: "GPU AdapterRAM (Win32_VideoController) — CAPS AT ~4GB, unreliable",
        reliable: false,
      };
    }
    return { gb: null, source: "PowerShell CIM queries unavailable", reliable: false };
  }

  return { gb: null, source: `unsupported platform ${platform}`, reliable: false };
}

/** Ask the user their memory in GB (used when detection is unreliable). */
async function askMemoryGB() {
  if (YES) return null;
  const a = await ask(
    `  ${c.b("How much GPU VRAM / unified memory do you have, in GB?")} ${c.dim("(e.g. 8, 16, 32 — Enter to skip)")} `,
  );
  const n = Number(a.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    c.b("\nGranted — guided local-model setup\n") +
      c.dim("Go fully local (Ollama): scoring, explanations, AND embeddings on your machine.\n"),
  );

  // 1) OS.
  const platform = process.platform;
  const osName =
    platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
  const macosMajor = platform === "darwin" ? parseMacosMajor(run("sw_vers", ["-productVersion"])) : null;
  console.log(`${c.g("✓")} Detected OS: ${c.b(osName)} ${c.dim(`(${platform})`)}`);

  // 2) Ollama installed + daemon reachable.
  heading("Ollama");
  let version = run("ollama", ["--version"]);
  let daemonUp = false;
  if (!version) {
    console.log(c.y("  Ollama isn't installed (or not on your PATH).\n"));
    const installed = await tryAutoInstall(platform, macosMajor);
    version = run("ollama", ["--version"]);
    daemonUp = installed && Boolean(version);
    if (!version) {
      console.log(installGuidance(platform, macosMajor));
      console.log(c.dim("\n  Install + start Ollama, then re-run: ") + c.g("npm run setup:local"));
      process.exit(1);
    }
  }
  console.log(`  ${c.g("✓")} ollama installed ${c.dim(version.trim().split(/\r?\n/)[0] || "")}`);

  if (!daemonUp) {
    const daemonModels = await ollamaDaemonModels();
    daemonUp = daemonModels !== null;
  }
  if (!daemonUp) {
    console.log(c.y("\n  Ollama is installed but its daemon isn't reachable at localhost:11434.\n"));
    console.log(installGuidance(platform, macosMajor));
    console.log(c.dim("\n  Start the daemon, then re-run: ") + c.g("npm run setup:local"));
    process.exit(1);
  }
  console.log(`  ${c.g("✓")} daemon reachable at ${c.dim("localhost:11434")}`);

  // 3) New vs existing chat model.
  heading("Choose a chat model");
  const installed = parseOllamaList(run("ollama", ["list"]) ?? "");
  // Non-embedding models are the chat candidates.
  const chatInstalled = installed.filter((m) => !m.toLowerCase().includes("embed"));

  let chosenModel = null;
  let useExisting = false;
  if (chatInstalled.length > 0) {
    console.log(c.dim(`  You already have: ${chatInstalled.join(", ")}`));
    useExisting = await confirm("Use one of your EXISTING models (instead of installing a new one)?", false);
  }

  if (useExisting) {
    if (YES) {
      chosenModel = chatInstalled[0];
    } else {
      chatInstalled.forEach((m, i) => console.log(`    ${c.b(String(i + 1))}. ${m}`));
      const pick = await ask(`  Which one? ${c.dim(`[1-${chatInstalled.length}, default 1]`)} `);
      const idx = Number(pick) - 1;
      chosenModel = chatInstalled[Number.isInteger(idx) && idx >= 0 && idx < chatInstalled.length ? idx : 0];
    }
    console.log(`  ${c.g("✓")} Using existing model: ${c.b(chosenModel)}`);
  } else {
    // 4) Recommend by detected memory.
    let { gb, source, reliable } = detectMemory();
    if (gb != null) {
      console.log(`  ${c.dim("Detected memory:")} ${c.b(`${gb} GB`)} ${c.dim(`— ${source}`)}`);
    }
    if (!reliable || gb == null) {
      if (gb != null) console.log(c.y(`  Memory detection may be unreliable (${source}).`));
      const asked = await askMemoryGB();
      if (asked != null) gb = asked;
    }

    const tier = recommendModel(Number.isFinite(gb) ? gb : NaN);
    const recommended = gb == null && YES ? DEFAULT_MODEL_WHEN_UNKNOWN : tier.model;
    console.log(`\n  ${c.b("Recommended:")} ${c.g(recommended)} ${c.dim(`— ${tier.note}`)}`);
    console.log(c.dim(`  (alternative: ${tier.alt}; or type any Ollama tag, e.g. qwen2.5:7b)`));

    if (YES) {
      chosenModel = recommended;
    } else {
      const typed = await ask(`  Model tag to install ${c.dim(`[Enter for ${recommended}]`)}: `);
      chosenModel = typed || recommended;
    }

    // Pull the chat model.
    console.log(c.dim(`\n  Pulling ${chosenModel} … (first pull can take a while)`));
    if (!runInherit("ollama", ["pull", chosenModel])) {
      console.log(
        c.r(`\n  Failed to pull "${chosenModel}".`) +
          c.dim(
            "\n  Check the tag exists (https://ollama.com/library) and the daemon is running, then re-run.\n" +
              "  Nothing was written to .env.local.",
          ),
      );
      process.exit(1);
    }
    console.log(`  ${c.g("✓")} Pulled ${c.b(chosenModel)}`);
  }

  // 5) The built-in search model. Search runs in the app, not through Ollama, so this is
  //    a download of model files (not an Ollama pull), and failing it isn't fatal: the app
  //    downloads them itself on the first search.
  heading("Search model (built in)");
  console.log(
    c.dim(
      "  Search runs on a small built-in model (nomic-embed-text-v1.5) inside Granted, against\n" +
        "  vectors that ship with it. Nothing to re-embed and no key needed.",
    ),
  );
  const modelOk = await runFetchModel();
  if (!modelOk) {
    console.log(c.y("  ! Couldn't download the search model now. Granted will download it on your first search."));
  }

  // 6) Merge into .env.local (single write; never half-written).
  heading("Write scaffold/.env.local");
  if (!existsSync(ENV)) {
    if (existsSync(EXAMPLE)) {
      copyFileSync(EXAMPLE, ENV);
      console.log(`  ${c.g("✓")} Created .env.local from .env.example`);
    } else {
      writeFileSync(ENV, "");
      console.log(`  ${c.g("✓")} Created empty .env.local`);
    }
  }
  const before = readFileSync(ENV, "utf8");
  const updates = {
    LLM_PROVIDER: "ollama",
    LOCAL_LLM_MODEL: chosenModel,
    LLM_BASE_URL: OLLAMA_BASE_URL,
    // Competitor & market analysis is free on local inference — enable it so it
    // works out of the box. (mergeEnvLocal never clobbers a value you already set.)
    NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS: "true",
  };
  const { text, applied, skipped } = mergeEnvLocal(before, updates);
  writeFileSync(ENV, text); // one atomic-ish write of the fully-merged text
  for (const { key, value } of applied) console.log(`  ${c.g("✓")} set ${key}=${value}`);
  for (const { key, existing } of skipped) {
    console.log(c.y(`  • kept existing ${key}=${existing} ${c.dim("(edit .env.local by hand to change it)")}`));
  }
  if (skipped.some((s) => s.key === "LOCAL_LLM_MODEL" && s.existing !== chosenModel)) {
    console.log(
      c.y(`  ! LOCAL_LLM_MODEL is already ${currentValue(text, "LOCAL_LLM_MODEL")}, not ${chosenModel} — `) +
        c.dim("edit .env.local if you meant to switch."),
    );
  }

  // A setup from before the built-in model pointed EMBEDDINGS_BASE_URL at Ollama and re-embedded
  // the corpus. That still works (search keeps using it), but the built-in model is simpler.
  if (currentValue(text, "EMBEDDINGS_BASE_URL")) {
    console.log(
      c.y("  • EMBEDDINGS_BASE_URL is set in .env.local, so search keeps using that embedder.") +
        c.dim(" Remove EMBEDDINGS_BASE_URL and EMBEDDINGS_MODEL to use the built-in search model instead."),
    );
  }

  // 7) Success summary.
  heading("You're fully local — next steps");
  console.log(`  ${c.dim("Chat model:")}      ${c.b(chosenModel)}`);
  console.log(`  ${c.dim("Search:")}          ${c.b("Built-in, on this computer")} ${c.dim("(nomic-embed-text-v1.5)")}`);
  console.log(`  ${c.dim("Config written:")}  scaffold/.env.local`);
  console.log(`\n  ${c.b("Now run:")} ${c.g("npm run dev")}   ${c.dim("→ http://localhost:3000")}`);
  console.log(
    c.dim(
      "  Local scoring is slower than hosted Claude (a single GPU serves batches serially).\n" +
        "  See the README's 'The honest tradeoff' section for the details.\n",
    ),
  );
  if (!IS_TTY && !YES) {
    console.log(c.dim("  (Non-interactive run detected — pass --yes for unattended defaults.)"));
  }
  process.exit(0);
}

const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMainModule) {
  main().catch((err) => {
    console.error(c.r(`\nUnexpected error: ${err?.message || err}`));
    console.error(c.dim("Nothing partial was written to .env.local unless a '✓ set' line printed above."));
    process.exit(1);
  });
}

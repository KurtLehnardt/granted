#!/usr/bin/env node
/**
 * Granted — guided fully-local setup (Ollama).
 *
 *   npm run setup:local            (from the scaffold/ directory)
 *   npm run setup:local -- --yes   (non-interactive; sane defaults)
 *
 * Takes a self-hoster all the way to a fully-offline run in one command:
 *   1. Detects OS + available memory/GPU to recommend a chat model.
 *   2. Verifies Ollama is installed and its daemon is reachable (does NOT try to
 *      install Ollama itself — just prints the platform-specific guidance).
 *   3. Installs a NEW recommended model or lets you pick an EXISTING one.
 *   4. ALWAYS pulls the SEPARATE embeddings model (`nomic-embed-text`) — the seam
 *      people miss: `LLM_PROVIDER=ollama` moves only scoring/explanations, NOT the
 *      query embedding, which otherwise 401s against OpenAI (or silently costs).
 *   5. Merges the local env into scaffold/.env.local (never clobbering a value you
 *      already set), then offers to re-embed the corpus so query + corpus dims
 *      match (a 512-dim OpenAI corpus vs a 768-dim local query = broken retrieval).
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
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const SCAFFOLD = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = join(SCAFFOLD, ".env.local");
const EXAMPLE = join(SCAFFOLD, ".env.example");

const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const OLLAMA_API_TAGS = "http://localhost:11434/api/tags";
const EMBED_MODEL = "nomic-embed-text";
// Non-interactive fallback when memory detection is unreliable and we can't ask:
// a middling small model that runs on modest hardware.
const DEFAULT_MODEL_WHEN_UNKNOWN = "llama3.2:3b";

// ---------------------------------------------------------------------------
// PURE LOGIC (exported + unit-tested — no I/O, no child processes)
// ---------------------------------------------------------------------------

/**
 * Memory (GB) → recommended Ollama chat model. A small, easy-to-edit table of
 * WIDELY-AVAILABLE public tags. Ordered high→low; `recommendModel` picks the
 * first tier the machine clears.
 */
export const MODEL_TIERS = [
  {
    minGB: 32,
    model: "qwen2.5:14b",
    alt: "llama3.1:8b",
    note: "Best local quality; needs ~32GB+ of memory/VRAM.",
  },
  {
    minGB: 16,
    model: "qwen2.5:7b",
    alt: "llama3.1:8b",
    note: "Strong, well-calibrated local default for 16–32GB.",
  },
  {
    minGB: 8,
    model: "llama3.2:3b",
    alt: "qwen2.5:3b",
    note: "Good balance for 8–16GB machines.",
  },
  {
    minGB: 0,
    model: "llama3.2:1b",
    alt: "qwen2.5:1.5b",
    note: "Fits small/4GB GPUs, but quality is rougher and scoring is slow.",
  },
];

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

/** Platform → the human install guidance shown when Ollama is missing. */
export function installGuidance(platform) {
  if (platform === "darwin") {
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
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout;
    return null;
  } catch {
    return null;
  }
}

/** Run a command with inherited stdio (progress visible) → boolean success. */
function runInherit(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { stdio: "inherit" });
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
  console.log(`${c.g("✓")} Detected OS: ${c.b(osName)} ${c.dim(`(${platform})`)}`);

  // 2) Ollama installed + daemon reachable.
  heading("Ollama");
  const version = run("ollama", ["--version"]);
  if (!version) {
    console.log(c.y("  Ollama isn't installed (or not on your PATH).\n"));
    console.log(installGuidance(platform));
    console.log(c.dim("\n  Install + start Ollama, then re-run: ") + c.g("npm run setup:local"));
    process.exit(1);
  }
  console.log(`  ${c.g("✓")} ollama installed ${c.dim(version.trim().split(/\r?\n/)[0] || "")}`);

  const daemonModels = await ollamaDaemonModels();
  if (daemonModels === null) {
    console.log(c.y("\n  Ollama is installed but its daemon isn't reachable at localhost:11434.\n"));
    console.log(installGuidance(platform));
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

  // 5) ALWAYS ensure the SEPARATE embeddings model.
  heading("Embeddings model (the seam people miss)");
  console.log(
    c.dim(
      "  Embeddings are a SEPARATE model from the chat LLM. Without a local embedder,\n" +
        "  your query embedding still calls OpenAI — a 401 (or a silent hosted call) even\n" +
        `  with LLM_PROVIDER=ollama. Pulling ${EMBED_MODEL} closes that seam.`,
    ),
  );
  const haveEmbed = parseOllamaList(run("ollama", ["list"]) ?? "").some((m) => m.startsWith(EMBED_MODEL));
  if (haveEmbed) {
    console.log(`  ${c.g("✓")} ${EMBED_MODEL} already installed`);
  } else {
    console.log(c.dim(`  Pulling ${EMBED_MODEL} …`));
    if (!runInherit("ollama", ["pull", EMBED_MODEL])) {
      console.log(
        c.r(`\n  Failed to pull "${EMBED_MODEL}".`) +
          c.dim("\n  Retrieval can't go local without it. Fix the daemon and re-run. Nothing was written to .env.local."),
      );
      process.exit(1);
    }
    console.log(`  ${c.g("✓")} Pulled ${c.b(EMBED_MODEL)}`);
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
    EMBEDDINGS_BASE_URL: OLLAMA_BASE_URL,
    EMBEDDINGS_MODEL: EMBED_MODEL,
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

  // 7) Offer to re-embed the corpus with the local embedder.
  heading("Re-embed the corpus (the step people forget)");
  console.log(
    c.dim(
      "  The committed corpus is OpenAI 512-dim vectors. Your local query embeds at a\n" +
        `  different size (${EMBED_MODEL} is 768-dim), so retrieval is broken until you\n` +
        "  re-embed the corpus with the SAME local model. Runs `npm run data:embed` (~1–2 min).",
    ),
  );
  const doEmbed = await confirm("Re-embed the corpus now?", true);
  if (doEmbed) {
    console.log(c.dim("\n  Re-embedding locally … (reads scaffold/.env.local; nothing leaves your machine)"));
    const ok = runInherit("npm", ["run", "data:embed"]);
    if (ok) {
      console.log(`  ${c.g("✓")} Corpus re-embedded with ${EMBED_MODEL}`);
    } else {
      console.log(
        c.y("\n  data:embed didn't finish cleanly.") +
          c.dim(
            `\n  Your .env.local is set correctly — just run ${"`npm run data:embed`"} again in scaffold/\n` +
              "  once the daemon is up. Retrieval stays broken until it completes.",
          ),
      );
    }
  } else {
    console.log(
      c.y("  Skipped.") +
        c.dim(` Retrieval will be broken until you run ${"`npm run data:embed`"} (dim mismatch).`),
    );
  }

  // 8) Success summary.
  heading("You're fully local — next steps");
  console.log(`  ${c.dim("Chat model:")}      ${c.b(chosenModel)}`);
  console.log(`  ${c.dim("Embeddings:")}      ${c.b(EMBED_MODEL)} ${c.dim(`@ ${OLLAMA_BASE_URL}`)}`);
  console.log(`  ${c.dim("Config written:")}  scaffold/.env.local`);
  if (!doEmbed) console.log(c.y("  ! Run `npm run data:embed` before searching — retrieval is broken otherwise."));
  console.log(`\n  ${c.b("Now run:")} ${c.g("npm run dev")}   ${c.dim("→ http://localhost:3000")}`);
  console.log(
    c.dim(
      "  Local scoring is slower than hosted Claude (a single GPU serves batches serially).\n" +
        "  See the README 'Run on a local model' section for the tradeoffs.\n",
    ),
  );
  if (!IS_TTY && !YES) {
    console.log(c.dim("  (Non-interactive run detected — pass --yes for unattended defaults.)"));
  }
  process.exit(0);
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error(c.r(`\nUnexpected error: ${err?.message || err}`));
    console.error(c.dim("Nothing partial was written to .env.local unless a '✓ set' line printed above."));
    process.exit(1);
  });
}

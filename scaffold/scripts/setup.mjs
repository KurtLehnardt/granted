#!/usr/bin/env node
/**
 * Granted — one-shot local setup.
 *
 *   npm run setup      (from the scaffold/ directory)
 *
 * Scaffolds `.env.local`, collects the API keys (every one optional: search runs on a built-in model
 * with no key, and one OpenAI or Anthropic key does the scoring), installs dependencies, downloads the
 * search model, and prints exactly what to do next. Idempotent and safe
 * to re-run — it never overwrites a key you've already set, and it never prints a
 * key back to the screen. It does NOT touch any cloud account; the README covers
 * the Supabase / Google-OAuth steps that genuinely require a dashboard.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { setupKeyReport } from "./lib/setupKeys.mjs";

const SCAFFOLD = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = join(SCAFFOLD, ".env.local");
const EXAMPLE = join(SCAFFOLD, ".env.example");

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function heading(s) {
  console.log(`\n${c.b(s)}`);
}

// --- Node version guard (Next.js 14 needs >= 18.17; we recommend 20+) ----------
const major = Number(process.versions.node.split(".")[0]);
if (Number.isFinite(major) && major < 18) {
  console.error(
    c.y(`\nGranted needs Node 18.17+ (20 LTS recommended). You have ${process.versions.node}.`) +
      `\nInstall a newer Node (https://nodejs.org or nvm) and re-run.\n`,
  );
  process.exit(1);
}

// --- .env upsert helpers -------------------------------------------------------
/** Return the value already set for `key` in env text, or "" if blank/absent. */
function currentValue(text, key) {
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}
/** Replace `key=...` in place, or append it if the key isn't present. */
function upsert(text, key, value) {
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, "m").test(text)) {
    return text.replace(new RegExp(`^${key}=.*$`, "m"), line);
  }
  return `${text.replace(/\s*$/, "")}\n${line}\n`;
}

// --- prompts (hidden for secrets) ---------------------------------------------
// Two clean input paths. At a real TTY (the normal `npm run setup`), readline
// prompts with masked entry for secrets. When stdin is PIPED (CI / scripted /
// `printf ... | npm run setup`), readline's per-question terminal mode mis-reads
// lines and leaves awaits unsettled — so we buffer stdin once and hand out one
// line per prompt. Both always resolve.
const IS_TTY = Boolean(process.stdin.isTTY);

let _pipedLines = null;
async function readPipedLine() {
  if (_pipedLines === null) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    _pipedLines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  }
  return _pipedLines.length ? _pipedLines.shift() : "";
}

function askTTY(query, hidden) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Suppress echo so pasted keys never render or land in scrollback.
      rl._writeToOutput = () => {};
      process.stdout.write(query);
    }
    rl.question(hidden ? "" : query, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function ask(query, { hidden = false } = {}) {
  if (IS_TTY) return askTTY(query, hidden);
  process.stdout.write(query);
  const line = await readPipedLine();
  process.stdout.write("\n");
  return line.trim();
}

async function collectKey(text, key, label, { required, help }) {
  const existing = currentValue(text, key);
  if (existing && !existing.startsWith("sk-...") && existing !== "sk-ant-...") {
    console.log(`  ${c.g("✓")} ${key} already set — keeping it.`);
    return text;
  }
  console.log(`\n${c.b(label)} ${required ? c.y("(required)") : c.dim("(optional — Enter to skip)")}`);
  if (help) console.log(c.dim(`  ${help}`));
  const value = await ask(`  ${key} = `, { hidden: true });
  if (!value) {
    if (required) console.log(c.y(`  Left blank — set ${key} in .env.local before the app will work.`));
    return text;
  }
  return upsert(text, key, value);
}

// --- main ----------------------------------------------------------------------
console.log(c.b("\nGranted — local setup\n") + c.dim("Federal funding intelligence with a calibrated, honest \"no.\"\n"));

// 1) .env.local from the template.
if (!existsSync(ENV)) {
  if (!existsSync(EXAMPLE)) {
    console.error(c.y("Missing .env.example — are you running this from scaffold/?"));
    process.exit(1);
  }
  copyFileSync(EXAMPLE, ENV);
  console.log(`${c.g("✓")} Created .env.local from .env.example`);
} else {
  console.log(`${c.g("✓")} .env.local already exists — will only fill in missing keys.`);
}

let text = readFileSync(ENV, "utf8");

heading("API keys");
console.log(c.dim("Pasted keys are hidden and written straight to .env.local (gitignored)."));
// Every key is optional. Search runs on the built-in model with no key (or on
// OpenAI's embeddings when an OpenAI key is present, as before). Scoring needs one
// provider: an Anthropic key (Claude), an OpenAI key, another provider set in
// Settings → Model, or a local model (npm run setup:local). See lib/llm/config.ts
// resolveCloudConfig and lib/embeddings/spaces.ts.
text = await collectKey(text, "ANTHROPIC_API_KEY", "Anthropic (Claude, for scoring and explanations)", {
  required: false,
  help: "https://console.anthropic.com/settings/keys. One scoring key is enough: this one or OpenAI's.",
});
text = await collectKey(text, "OPENAI_API_KEY", "OpenAI (scoring if you skip Claude; search uses its embeddings when set)", {
  required: false,
  help: "https://platform.openai.com/api-keys. Not needed for search: without it, search runs on this computer.",
});
text = await collectKey(text, "EXA_API_KEY", "Exa (optional — live web competitors)", {
  required: false,
  help: "https://dashboard.exa.ai — only needed for the deep competitor analysis' web results.",
});

writeFileSync(ENV, text);
console.log(`\n${c.g("✓")} Saved .env.local`);

// 2) Dependencies.
heading("Dependencies");
const wantsInstall = (await ask(`  Run "npm ci" now? ${c.dim("[Y/n]")} `)).toLowerCase();
if (wantsInstall === "" || wantsInstall === "y") {
  console.log(c.dim("  Installing… (this can take a minute)"));
  try {
    execSync("npm ci", { cwd: SCAFFOLD, stdio: "inherit" });
    console.log(`${c.g("✓")} Dependencies installed`);
  } catch {
    console.log(c.y("  npm ci failed — run it yourself in scaffold/ and check the output."));
  }
} else {
  console.log(c.dim("  Skipped — run `npm ci` in scaffold/ before starting."));
}

// 3) The built-in search model (about 275 MB, into scaffold/models/). Not fatal:
// the app downloads it on the first search if this fails.
heading("Search model");
try {
  execSync("node scripts/fetch-model.mjs", { cwd: SCAFFOLD, stdio: "inherit" });
} catch {
  console.log(c.y("  Couldn't download it now. Granted will download it on your first search (or run npm run model:fetch)."));
}

// 4) Next steps. The key rules live in scripts/lib/setupKeys.mjs (tested), with the same
// shape checks the app uses, so a truncated paste is caught here rather than on the first search.
const keys = setupKeyReport(readFileSync(ENV, "utf8"));

heading("You're set — next steps");
if (!keys.hasScoringKey) {
  console.log(
    c.y("  ! No scoring key yet. Search works without one, but scoring the matches needs a provider:") +
      c.dim("\n    add ANTHROPIC_API_KEY or OPENAI_API_KEY to scaffold/.env.local, pick another provider in Settings → Model,") +
      c.dim("\n    or run fully local: npm run setup:local"),
  );
}
if (keys.openAiMalformed) {
  console.log(c.y("  ! OPENAI_API_KEY doesn't look like an OpenAI key (they start with sk- and are 20+ characters) — check scaffold/.env.local."));
}
if (keys.anthropicMalformed) {
  console.log(c.y("  ! ANTHROPIC_API_KEY doesn't look like a Claude key (they start with sk-ant-) — fix it in scaffold/.env.local."));
}
console.log(
  c.dim(
    keys.searchUses === "openai"
      ? "  Search uses OpenAI embeddings (your OpenAI key). SEARCH_EMBEDDINGS=builtin in .env.local runs it on this computer instead."
      : "  Search runs on this computer with the built-in model. No key needed.",
  ),
);
console.log(`  ${c.b("1.")} Start the app:      ${c.g("npm run dev")}   ${c.dim("→ http://localhost:3000")}`);
console.log(`  ${c.b("2.")} Describe a company in the box and run a search. That's the whole core app.`);
console.log(c.dim("     (The 4,698-opportunity corpus ships committed — no data pipeline needed to start.)"));
console.log(`\n  ${c.b("Optional, when you want them")} ${c.dim("(see README):")}`);
console.log(`  • Run fully on a local model    → ${c.g("npm run setup:local")} ${c.dim("(guided Ollama setup — no API keys, offline)")}`);
console.log(`  • Live competitor web results  → add ${c.g("EXA_API_KEY")} + set ${c.g("NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS=true")}`);
console.log(`  • The honest "don't apply" layer → set ${c.g("NEXT_PUBLIC_FLAG_DISCERNMENT_LAYER=true")}`);
console.log(`  • Real Google sign-in           → a Supabase project + Google OAuth (README: "Real sign-in")`);
console.log("");

// Clean, deterministic exit (no lingering readline handles on any platform).
process.exit(0);

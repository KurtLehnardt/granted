#!/usr/bin/env node
/**
 * Granted — one-shot local setup.
 *
 *   npm run setup      (from the scaffold/ directory)
 *
 * Scaffolds `.env.local`, collects the API key(s) — OpenAI is the one required key; Anthropic and Exa are optional —
 * installs dependencies, and prints exactly what to do next. Idempotent and safe
 * to re-run — it never overwrites a key you've already set, and it never prints a
 * key back to the screen. It does NOT touch any cloud account; the README covers
 * the Supabase / Google-OAuth steps that genuinely require a dashboard.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

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
// One key is enough: OpenAI powers search (embeddings) and, with no Anthropic
// key, the scoring too (lib/llm/config.ts resolveCloudConfig). Anthropic is an
// optional upgrade for scoring + explanations. A Claude key alone can't search
// (Anthropic has no embeddings API) — use `npm run setup:local` for that.
text = await collectKey(text, "OPENAI_API_KEY", "OpenAI (search, and scoring if you skip Anthropic)", {
  required: true,
  help: "Get one at https://platform.openai.com/api-keys. Search needs it — or run fully local instead: npm run setup:local",
});
text = await collectKey(text, "ANTHROPIC_API_KEY", "Anthropic (optional — Claude for scoring + explanations)", {
  required: false,
  help: "https://console.anthropic.com/settings/keys — without it, OpenAI's gpt-4o-mini does the scoring.",
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

// 3) Next steps.
// The same shape check the app uses (lib/llm/providers.ts isValidOpenAiKeyFormat:
// sk- prefix, 20–200 chars, no whitespace) — so a truncated paste is caught here,
// not as "No cloud provider is configured" on the first search.
const finalEnv = readFileSync(ENV, "utf8");
const openAiKey = currentValue(finalEnv, "OPENAI_API_KEY");
const openAiKeyLooksValid = /^sk-\S{17,197}$/.test(openAiKey) && openAiKey !== "sk-...";
const anthropicKey = currentValue(finalEnv, "ANTHROPIC_API_KEY");
const anthropicKeyLooksValid = !anthropicKey || anthropicKey === "sk-ant-..." || /^sk-ant-[A-Za-z0-9_-]{13,193}$/.test(anthropicKey);

heading("You're set — next steps");
if (!openAiKey || openAiKey === "sk-...") {
  console.log(c.y("  ! Search needs OPENAI_API_KEY — add it to scaffold/.env.local, or run fully local: npm run setup:local"));
} else if (!openAiKeyLooksValid) {
  console.log(c.y("  ! OPENAI_API_KEY doesn't look like an OpenAI key (they start with sk- and are 20+ characters) — check scaffold/.env.local."));
}
if (!anthropicKeyLooksValid) {
  console.log(c.y("  ! ANTHROPIC_API_KEY doesn't look like a Claude key (they start with sk-ant-) — fix it in scaffold/.env.local, or remove it to score with OpenAI."));
}
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

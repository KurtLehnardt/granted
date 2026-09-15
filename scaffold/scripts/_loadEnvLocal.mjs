/**
 * Best-effort loader for scaffold/.env.local, for the data-pipeline scripts that
 * run via plain `node` / `npm run data:*`. Unlike the Next.js app, a bare `node`
 * invocation does NOT auto-load .env.local — so without this, a self-hoster who
 * puts EMBEDDINGS_BASE_URL / EMBEDDINGS_MODEL in .env.local (as the README +
 * .env.example instruct) and runs `npm run data:embed` would silently fall back
 * to the OpenAI default, writing a 512-dim corpus that mismatches a local model's
 * runtime query vectors (broken retrieval). Loading .env.local here makes the
 * documented offline flow actually work with no inline env.
 *
 * Parses simple `KEY=VALUE` (optionally `export KEY=VALUE`) lines and seeds
 * process.env, but ONLY for keys not already set — so a real shell / CI env still
 * wins. No dependency and no `--env-file` (which needs Node 20.6+): it works on
 * any Node that runs the rest of the pipeline. NEVER prints a value.
 *
 * Imported for its side effect at the TOP of the data scripts:
 *   import "./_loadEnvLocal.mjs";
 * It is also exported so a caller can invoke it explicitly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function loadEnvLocal() {
  // scaffold/scripts/_loadEnvLocal.mjs -> scaffold/.env.local. Resolved relative
  // to THIS file, so it finds the right .env.local regardless of the caller's cwd.
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
  let text;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return; // no .env.local — rely on whatever's already in the environment
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // real shell / CI env wins
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

// Run on import so a plain `import "./_loadEnvLocal.mjs";` is enough. Idempotent
// (only-if-unset), so an explicit loadEnvLocal() call later is harmless.
loadEnvLocal();

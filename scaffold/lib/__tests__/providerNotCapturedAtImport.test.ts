import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard: the selected LLM provider must never be captured at MODULE
 * SCOPE.
 *
 * `resolveProvider()` reads the on-disk LLM config, and the Settings
 * Local/Cloud switch (#210) rewrites that file while the server is running —
 * `readLlmConfig` re-reads it whenever the file's mtime changes. So the answer
 * to "are we on a local model?" changes between requests, with no restart.
 *
 * A top-level `const X = isLocalLlm() ? a : b` freezes whichever provider
 * happened to be selected when the module was first imported. The symptom is
 * nasty precisely because it is invisible: everything looks right, but a
 * provider-sized timeout or batch size keeps using the OLD provider's value
 * until the process restarts. That bit `app/api/competitors/route.ts`, whose
 * wall-clock budget is 30 min on a local model and 110s on a cloud one — switch
 * to local mid-session and the synthesis was still killed at 110s.
 *
 * `lib/claude.ts` has always done this correctly (every `isLocalLlm()` call
 * sits inside a function). This scan keeps it that way as the codebase grows.
 *
 * It is a STATIC scan, so it only catches the direct, textual case: a top-level
 * declaration whose initializer calls one of the provider predicates. A value
 * laundered through a helper that is itself called at module scope would slip
 * past it. That is an accepted limit — this guards the shape that has actually
 * caused a bug, cheaply, rather than pretending to be a type-level proof.
 */

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCAFFOLD = join(__dirname, "..", "..");
const ROOTS = ["app", "lib", "components"];

/** Provider-dependent predicates whose answer can change between requests. */
const PROVIDER_PREDICATES = ["isLocalLlm", "resolveProvider"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Top-level (column-0) `const`/`let`/`var` declarations only. Anything indented
 * is inside a function, class or block — which is exactly where these calls
 * belong, so indentation is the signal we key on.
 */
function moduleScopeProviderCaptures(source: string): string[] {
  const offenders: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^(const|let|var)\s/.test(line)) continue;
    // `const f = () => ...` / `const f = function ...` is a FUNCTION, so the
    // call inside it is lazy and correct — skip it, or every helper defined as
    // a const arrow would be flagged.
    if (/=\s*(async\s+)?(function\b|(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/.test(line)) continue;
    // A top-level declaration can span lines; gather until the statement looks
    // closed, so `const X =\n  isLocalLlm() ? a : b;` is caught too.
    let statement = line;
    for (let j = i + 1; j < lines.length && !/;\s*$/.test(statement); j++) {
      statement += "\n" + lines[j];
      if (/^(const|let|var|function|export|class)\s/.test(lines[j])) break;
    }
    if (PROVIDER_PREDICATES.some((p) => statement.includes(`${p}(`))) {
      offenders.push(`line ${i + 1}: ${line.trim()}`);
    }
  }
  return offenders;
}

describe("the LLM provider is never captured at module scope", () => {
  test("no top-level declaration calls a provider predicate", () => {
    const failures: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(SCAFFOLD, root))) {
        for (const hit of moduleScopeProviderCaptures(readFileSync(file, "utf8"))) {
          failures.push(`${relative(SCAFFOLD, file)} ${hit}`);
        }
      }
    }
    assert.deepEqual(
      failures,
      [],
      "These capture the provider at import time, so they go stale when Settings " +
        "switches Local/Cloud mid-session. Move the call inside a function:\n  " +
        failures.join("\n  "),
    );
  });

  test("the scan actually detects the shape it is guarding against", () => {
    // Without this, a broken matcher would make the suite above pass silently.
    assert.deepEqual(moduleScopeProviderCaptures("const B = isLocalLlm() ? 1 : 2;"), [
      "line 1: const B = isLocalLlm() ? 1 : 2;",
    ]);
    assert.deepEqual(
      moduleScopeProviderCaptures("const B =\n  Number(process.env.X) || (isLocalLlm() ? 1 : 2);"),
      ["line 1: const B ="],
    );
    // The correct shapes stay clean: inside a function, or indented in a block.
    assert.deepEqual(moduleScopeProviderCaptures("function b() {\n  return isLocalLlm() ? 1 : 2;\n}"), []);
    assert.deepEqual(moduleScopeProviderCaptures("const b = () => {\n  return isLocalLlm();\n};"), []);
    assert.deepEqual(moduleScopeProviderCaptures("const b = async () => isLocalLlm();"), []);
    assert.deepEqual(moduleScopeProviderCaptures("const b = function () {\n  return isLocalLlm();\n};"), []);
    // ...but the exemption must not swallow a real capture that merely returns a function.
    assert.deepEqual(moduleScopeProviderCaptures("const B = isLocalLlm() ? 1 : 2;"), [
      "line 1: const B = isLocalLlm() ? 1 : 2;",
    ]);
  });
});

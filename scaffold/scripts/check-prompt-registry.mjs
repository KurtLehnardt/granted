#!/usr/bin/env node
/**
 * check-prompt-registry — two checks over the prompt registry (CON-04,
 * R10.2), both exit-1-on-violation:
 *
 * 1. INLINE-PROMPT CHECK. Flags model-prompt strings written inline in
 *    application code instead of living in `lib/prompts/registry.ts`
 *    ("prompts are not edited inline in application code").
 *
 *    Scope: any call that looks like an Anthropic SDK message-creation call
 *    (`....messages.create({ ... })`) anywhere under `lib/` or `app/`,
 *    excluding `lib/prompts/**` (the registry itself, which is allowed to
 *    hold prompt text). Within such a call:
 *
 *      - a `system` property whose value is a literal (string / template
 *        literal), rather than a reference to a registry-loaded value
 *        (e.g. `loadPrompt(id).template`), is flagged.
 *      - a message `content` property that is a fully static string/template
 *        literal (no `${...}` interpolation) over a length threshold is
 *        flagged — a real user/data payload always interpolates request
 *        data, so a long *static* literal here is almost certainly a
 *        hand-written prompt that should be registered instead.
 *
 *    This intentionally does NOT flag ordinary long strings elsewhere in the
 *    codebase (UI copy, sample text, etc.) — only literals passed directly
 *    into an SDK message-creation call, which is where an inline prompt
 *    would actually reach the model.
 *
 * 2. BANNED-PHRASINGS CHECK (C2). Flags definitive-eligibility language in
 *    any registered prompt template. This product NEVER determines
 *    eligibility (R8 / `explainMatches` rule 1: "appears to align", "you may
 *    qualify", "verify with the program officer" — never an assertion of
 *    fact). A prompt that tells the model it's fine to say "you are
 *    eligible" or "guaranteed" would undo that guarantee at the source, so
 *    this scans every `*_TEMPLATE` constant in `lib/prompts/registry.ts`
 *    (every version, active or historical) for `BANNED_PHRASES` below —
 *    case-insensitive substring match.
 *
 * Usage: node scripts/check-prompt-registry.mjs
 * Exit code 0 = clean, 1 = violations found (or scan error).
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The pure, dependency-free banned-phrasings core lives in its own module so
// runtime code (lib/apply/draft.ts, bundled by webpack) can import it without
// dragging in `typescript`/`node:fs`/`new URL(...)` from this build script.
// Re-exported below so every existing importer of THIS file is unchanged.
import { BANNED_PHRASES, findBannedPhrases } from "./banned-phrases.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["lib", "app"];
const EXCLUDE_DIR_PARTS = ["node_modules", ".next", "lib/prompts"];
const LONG_STATIC_CONTENT_THRESHOLD = 120; // chars

// `BANNED_PHRASES` + `findBannedPhrases` are defined in ./banned-phrases.mjs
// (imported above) and re-exported here so every existing importer of this file
// — the check:prompts gate, its tests, and the G2 drafting guard/tests — keeps
// importing them from `check-prompt-registry.mjs` unchanged.
export { BANNED_PHRASES, findBannedPhrases };

/** @param {string} dir */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (EXCLUDE_DIR_PARTS.some((p) => rel === p || rel.startsWith(p + "/"))) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if ([".ts", ".tsx"].includes(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

function isStringish(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function textOf(node) {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return "";
}

function looksLikeMessagesCreateCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const calleeText = node.expression.getText();
  return /\.messages\.create$/.test(calleeText) || /\bmessages\.create$/.test(calleeText);
}

function lineOf(sf, pos) {
  const { line } = sf.getLineAndCharacterOfPosition(pos);
  return line + 1;
}

function checkFile(filePath) {
  const relPath = relative(ROOT, filePath);
  const source = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations = [];

  function visitCallArgs(objArg) {
    if (!ts.isObjectLiteralExpression(objArg)) return;
    for (const prop of objArg.properties) {
      if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
      const propName = prop.name.getText();

      if (propName === "system") {
        if (isStringish(prop.initializer)) {
          violations.push({
            line: lineOf(sf, prop.initializer.getStart()),
            reason: "inline `system` prompt string — move it into lib/prompts/registry.ts and use loadPrompt(id).template",
            preview: textOf(prop.initializer).slice(0, 60).replace(/\s+/g, " "),
          });
        } else if (ts.isTemplateExpression(prop.initializer)) {
          violations.push({
            line: lineOf(sf, prop.initializer.getStart()),
            reason: "inline `system` prompt template literal — move the static text into lib/prompts/registry.ts",
            preview: prop.initializer.getText().slice(0, 60).replace(/\s+/g, " "),
          });
        }
      }

      if (propName === "messages" && ts.isArrayLiteralExpression(prop.initializer)) {
        for (const el of prop.initializer.elements) {
          if (!ts.isObjectLiteralExpression(el)) continue;
          const contentProp = el.properties.find(
            (p) => ts.isPropertyAssignment(p) && p.name?.getText() === "content"
          );
          if (!contentProp || !ts.isPropertyAssignment(contentProp)) continue;
          const init = contentProp.initializer;
          if (isStringish(init) && textOf(init).length > LONG_STATIC_CONTENT_THRESHOLD) {
            violations.push({
              line: lineOf(sf, init.getStart()),
              reason: `static message content literal (${textOf(init).length} chars, no interpolation) — a real payload interpolates request data; if this is prompt text, register it`,
              preview: textOf(init).slice(0, 60).replace(/\s+/g, " "),
            });
          }
        }
      }
    }
  }

  function visit(node) {
    if (looksLikeMessagesCreateCall(node) && node.arguments[0]) {
      visitCallArgs(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return violations.map((v) => ({ file: relPath, ...v }));
}

/**
 * Banned-phrasings check, operating on already-loaded SOURCE TEXT rather than
 * a file path — this is what makes it directly unit-testable with a seeded
 * string (see scripts/__tests__/check-prompt-registry.test.ts) without
 * needing a real file on disk.
 *
 * Scans every top-level `const FOO_TEMPLATE = "..."` / `` `...` `` declaration
 * (any `_TEMPLATE`-suffixed identifier — this matches every prompt constant
 * in lib/prompts/registry.ts, active version or historical, e.g.
 * EXTRACT_PROFILE_V1_TEMPLATE, EXPLAIN_MATCHES_V2_TEMPLATE) for BANNED_PHRASES.
 */
export function checkBannedPhrasingsInSource(source, filePath) {
  const relPath = relative(ROOT, filePath);
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      /_TEMPLATE$/.test(node.name.text) &&
      node.initializer &&
      isStringish(node.initializer)
    ) {
      const text = textOf(node.initializer);
      for (const phrase of findBannedPhrases(text)) {
        violations.push({
          file: relPath,
          line: lineOf(sf, node.initializer.getStart()),
          reason: `banned definitive-eligibility phrase "${phrase}" in ${node.name.text} — this product never presents a definitive eligibility determination (see BANNED_PHRASES in scripts/check-prompt-registry.mjs)`,
          preview: phrase,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return violations;
}

/** Reads `filePath` and runs `checkBannedPhrasingsInSource` on its contents. */
export function checkBannedPhrasingsInFile(filePath) {
  return checkBannedPhrasingsInSource(readFileSync(filePath, "utf8"), filePath);
}

function main() {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const inlineViolations = files.flatMap(checkFile);

  const registryPath = join(ROOT, "lib", "prompts", "registry.ts");
  const bannedViolations = checkBannedPhrasingsInFile(registryPath);

  const allViolations = [...inlineViolations, ...bannedViolations];

  if (allViolations.length === 0) {
    console.log(
      `check-prompt-registry: OK — no inline prompt strings found outside lib/prompts/ (scanned ${files.length} files), and no banned definitive-eligibility phrasings in lib/prompts/registry.ts.`,
    );
    process.exit(0);
  }

  console.error(`check-prompt-registry: found ${allViolations.length} violation(s):\n`);
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}  ${v.reason}\n    "${v.preview}${v.preview.length >= 60 ? "…" : ""}"`);
  }
  if (inlineViolations.length > 0) {
    console.error("\nRegister inline prompts in lib/prompts/registry.ts (see extractProfile/explainMatches/explainWeakField for the pattern) and load them via loadPrompt(id).template.");
  }
  if (bannedViolations.length > 0) {
    console.error("\nRemove or rephrase banned definitive-eligibility language in the flagged prompt template(s) — hedge instead (\"appears to align\", \"you may qualify\", \"verify with the program officer\").");
  }
  process.exit(1);
}

// Run only when executed directly (`node scripts/check-prompt-registry.mjs`),
// not when imported as a module (e.g. by the test file, which needs the
// exported functions without triggering `process.exit()`).
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}

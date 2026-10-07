/**
 * Every script entry point (scripts/*.mjs, scripts/lib/*.mjs) must at least
 * parse. REGRESSION (review of #286): a duplicated import in
 * refresh-corpus.mjs ("Identifier 'logError' has already been declared")
 * stopped corpus refresh from starting at all, and no test noticed, because
 * nothing imported that script. `node --check` catches syntax and early
 * errors like that without running anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS = join(process.cwd(), "scripts");
const files = [
  ...readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs")).map((f) => join(SCRIPTS, f)),
  ...readdirSync(join(SCRIPTS, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => join(SCRIPTS, "lib", f)),
];

test("there are scripts to check (run from scaffold/)", () => {
  assert.ok(files.some((f) => f.endsWith("refresh-corpus.mjs")), "refresh-corpus.mjs found");
});

for (const file of files) {
  test(`node --check ${file.slice(SCRIPTS.length + 1).replace(/\\/g, "/")}`, () => {
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
}

test("the check really catches a duplicate import", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: 'import { a } from "./x.mjs";\nimport { a } from "./x.mjs";\n',
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already been declared/);
});

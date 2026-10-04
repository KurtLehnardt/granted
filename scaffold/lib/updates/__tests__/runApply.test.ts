import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runApplyInBackground } from "../runApply";
import { readApplyState, _resetApplyStateForTests } from "../applyState";

type Call = { command: string; args: string[]; options: Record<string, unknown> };
type Step = { code: number; stdout?: string; stderr?: string } | { throws: Error } | { errorEvent: Error };

/** Every spawn call made by every test in this file — checked at the end for a forbidden
 *  reset/force command, across the WHOLE suite, not just per-test. */
const ALL_CALLS: Call[] = [];

function makeSpawn(scripted: Step[]) {
  const calls: Call[] = [];
  let i = 0;
  const spawn = (command: string, args: string[], options: Record<string, unknown>) => {
    const call = { command, args, options };
    calls.push(call);
    ALL_CALLS.push(call);
    const step = scripted[i++];
    if (!step) throw new Error(`fakeSpawn called more times (${i}) than scripted (${scripted.length})`);
    if ("throws" in step) throw step.throws;

    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // Scheduled via microtask so the real runCommand() has already attached its stdout/stderr/
    // error/close listeners (which happens synchronously right after spawnImpl returns) before
    // any event fires — otherwise the emission would be lost.
    queueMicrotask(() => {
      if ("errorEvent" in step) {
        child.emit("error", step.errorEvent);
        return;
      }
      if (step.stdout) child.stdout.emit("data", Buffer.from(step.stdout));
      if (step.stderr) child.stderr.emit("data", Buffer.from(step.stderr));
      child.emit("close", step.code);
    });
    return child;
  };
  return { spawn, calls };
}

const BASE_DEPS = {
  cwd: "/repo",
  env: {} as NodeJS.ProcessEnv,
  platform: "linux" as NodeJS.Platform,
  execPath: "/usr/bin/node",
};

beforeEach(() => {
  _resetApplyStateForTests();
});

// Meta-assertion over the WHOLE file's recorded spawn calls, not just one test's — runs after
// every test above has populated ALL_CALLS. A plain assertion failure inside `after` fails the run.
after(() => {
  for (const call of ALL_CALLS) {
    const joined = call.args.join(" ");
    assert.doesNotMatch(joined, /reset|--force\b|(?<!-)-f\b/, `forbidden flag in: ${call.command} ${joined}`);
  }
});

describe("runApplyInBackground", () => {
  test("pull success -> npm spawned -> markApplyDone", async () => {
    const { spawn, calls } = makeSpawn([{ code: 0 }, { code: 0 }]);
    await runApplyInBackground({ ...BASE_DEPS, spawn });
    assert.equal(calls.length, 2);
    assert.equal(readApplyState().phase, "done");
  });

  test("pull failure (nonzero exit, stderr set) -> markApplyFailed with that stderr; npm never spawned", async () => {
    const { spawn, calls } = makeSpawn([{ code: 1, stderr: "fatal: not a git repository" }]);
    await runApplyInBackground({ ...BASE_DEPS, spawn });
    assert.equal(calls.length, 1, "npm must never be spawned after a failed pull");
    const state = readApplyState();
    assert.equal(state.phase, "failed");
    assert.equal(state.error, "fatal: not a git repository");
  });

  test("pull failure with no stderr falls back to stdout, then to a generic exit-code message", async () => {
    const { spawn: spawnStdoutOnly } = makeSpawn([{ code: 1, stdout: "some stdout output" }]);
    await runApplyInBackground({ ...BASE_DEPS, spawn: spawnStdoutOnly });
    assert.equal(readApplyState().error, "some stdout output");

    _resetApplyStateForTests();
    const { spawn: spawnNeither } = makeSpawn([{ code: 7 }]);
    await runApplyInBackground({ ...BASE_DEPS, spawn: spawnNeither });
    assert.equal(readApplyState().error, "git pull exited with code 7");
  });

  test("npm failure after a successful pull -> markApplyFailed with npm's stderr; markApplyDone never called", async () => {
    const { spawn, calls } = makeSpawn([{ code: 0 }, { code: 1, stderr: "npm ERR! some failure" }]);
    await runApplyInBackground({ ...BASE_DEPS, spawn });
    assert.equal(calls.length, 2);
    const state = readApplyState();
    assert.equal(state.phase, "failed");
    assert.equal(state.error, "npm ERR! some failure");
  });

  test("git pull's args always include --ff-only", async () => {
    const { spawn, calls } = makeSpawn([{ code: 0 }, { code: 0 }]);
    await runApplyInBackground({ ...BASE_DEPS, spawn });
    assert.equal(calls[0].command, "git");
    assert.deepEqual(calls[0].args, ["pull", "--ff-only"]);
  });

  test("never runs a plain `git pull` (no --ff-only is never acceptable, even implicitly)", async () => {
    const { spawn, calls } = makeSpawn([{ code: 0 }, { code: 0 }]);
    await runApplyInBackground({ ...BASE_DEPS, spawn });
    assert.ok(calls[0].args.includes("--ff-only"));
  });

  test("npm_execpath present -> re-invokes via execPath [npm_execpath, 'ci']", async () => {
    const { spawn, calls } = makeSpawn([{ code: 0 }, { code: 0 }]);
    await runApplyInBackground({
      ...BASE_DEPS,
      env: { NODE_ENV: "test", npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js" },
      spawn,
    });
    assert.equal(calls[1].command, "/usr/bin/node");
    assert.deepEqual(calls[1].args, ["/usr/local/lib/node_modules/npm/bin/npm-cli.js", "ci"]);
  });

  test("npm_execpath absent + win32 -> falls back to npm.cmd", async () => {
    const { spawn, calls } = makeSpawn([{ code: 0 }, { code: 0 }]);
    await runApplyInBackground({ ...BASE_DEPS, env: { NODE_ENV: "test" }, platform: "win32", spawn });
    assert.equal(calls[1].command, "npm.cmd");
    assert.deepEqual(calls[1].args, ["ci"]);
  });

  test("npm_execpath absent + non-win32 -> falls back to plain npm", async () => {
    const { spawn, calls } = makeSpawn([{ code: 0 }, { code: 0 }]);
    await runApplyInBackground({ ...BASE_DEPS, env: { NODE_ENV: "test" }, platform: "linux", spawn });
    assert.equal(calls[1].command, "npm");
    assert.deepEqual(calls[1].args, ["ci"]);
  });

  test("a synchronously-throwing spawn (git binary missing) is caught, not thrown out of runApplyInBackground", async () => {
    const { spawn } = makeSpawn([{ throws: new Error("spawn git ENOENT") }]);
    await assert.doesNotReject(runApplyInBackground({ ...BASE_DEPS, spawn }));
    const state = readApplyState();
    assert.equal(state.phase, "failed");
    assert.match(state.error ?? "", /ENOENT/);
  });

  test("an 'error' event from the pull child is caught, not thrown", async () => {
    const { spawn } = makeSpawn([{ errorEvent: new Error("spawn git ENOENT") }]);
    await assert.doesNotReject(runApplyInBackground({ ...BASE_DEPS, spawn }));
    assert.equal(readApplyState().phase, "failed");
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { getLocalCommit } from "../git";

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  return child;
}

const VALID_SHA = "a".repeat(40);

describe("getLocalCommit", () => {
  test("resolves {sha} on exit 0 with a valid 40-hex-char SHA on stdout", async () => {
    const child = fakeChild();
    const promise = getLocalCommit("/repo", () => child);
    child.stdout.emit("data", Buffer.from(`${VALID_SHA}\n`));
    child.emit("close", 0);
    assert.deepEqual(await promise, { sha: VALID_SHA });
  });

  test("resolves {sha} when stdout arrives in multiple chunks", async () => {
    const child = fakeChild();
    const promise = getLocalCommit("/repo", () => child);
    child.stdout.emit("data", Buffer.from(VALID_SHA.slice(0, 10)));
    child.stdout.emit("data", Buffer.from(VALID_SHA.slice(10)));
    child.stdout.emit("data", Buffer.from("\n"));
    child.emit("close", 0);
    assert.deepEqual(await promise, { sha: VALID_SHA });
  });

  test("resolves {notAGitCheckout: true} on a nonzero exit", async () => {
    const child = fakeChild();
    const promise = getLocalCommit("/repo", () => child);
    child.stdout.emit("data", Buffer.from(VALID_SHA));
    child.emit("close", 128);
    assert.deepEqual(await promise, { notAGitCheckout: true });
  });

  test("resolves {notAGitCheckout: true} on a spawn 'error' event (missing git binary)", async () => {
    const child = fakeChild();
    const promise = getLocalCommit("/repo", () => child);
    child.emit("error", new Error("spawn git ENOENT"));
    assert.deepEqual(await promise, { notAGitCheckout: true });
  });

  test("resolves {notAGitCheckout: true} when spawn throws synchronously", async () => {
    const result = await getLocalCommit("/repo", () => {
      throw new Error("ENOENT");
    });
    assert.deepEqual(result, { notAGitCheckout: true });
  });

  test("resolves {notAGitCheckout: true} on malformed/non-hex stdout", async () => {
    const child = fakeChild();
    const promise = getLocalCommit("/repo", () => child);
    child.stdout.emit("data", Buffer.from("not-a-sha\n"));
    child.emit("close", 0);
    assert.deepEqual(await promise, { notAGitCheckout: true });
  });

  test("resolves {notAGitCheckout: true} on a too-short hex string even with exit 0", async () => {
    const child = fakeChild();
    const promise = getLocalCommit("/repo", () => child);
    child.stdout.emit("data", Buffer.from("abc123\n"));
    child.emit("close", 0);
    assert.deepEqual(await promise, { notAGitCheckout: true });
  });

  test("calls spawn with array args only (git, ['rev-parse', 'HEAD']) and the given cwd — never a shell string", async () => {
    let calledWith: [string, string[], Record<string, unknown>] | null = null;
    const child = fakeChild();
    const promise = getLocalCommit("/my/repo", (cmd, args, opts) => {
      calledWith = [cmd, args, opts];
      return child;
    });
    child.stdout.emit("data", Buffer.from(VALID_SHA));
    child.emit("close", 0);
    await promise;
    assert.deepEqual(calledWith, ["git", ["rev-parse", "HEAD"], { cwd: "/my/repo", windowsHide: true }]);
  });

  test("never rejects, even on an unexpected close code", async () => {
    const child = fakeChild();
    const promise = getLocalCommit("/repo", () => child);
    child.emit("close", null);
    await assert.doesNotReject(promise);
  });
});

/**
 * Integration: the install's console window, run exactly as the GUI runs it
 * (`powershell.exe -NoExit -File <script>`, the script from
 * windowsInstallScriptFor) around a stand-in for the install that just
 * reports "done" or "error". After a successful install the window closes by
 * itself; after an error it stays open so the message can be read. Windows only.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { INSTALL_WINDOW_CLOSE_SECONDS, windowsDownloadAndRun, windowsInstallScriptFor } from "../ipcPure";

describe("the install window closes itself only after a successful install", { skip: process.platform !== "win32" && "Windows only" }, () => {
  let root: string;
  const started: ChildProcess[] = [];

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "granted-installwindow-it-"));
  });
  after(async () => {
    for (const c of started) if (c.exitCode === null) c.kill();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** Runs the window's script around `install`; resolves with its exit code, or "still open" after waitMs. */
  async function runWindow(name: string, install: string, waitMs: number): Promise<number | "still open"> {
    const status = join(root, `${name}.json`);
    const script = join(root, `${name}.ps1`);
    await writeFile(script, windowsInstallScriptFor(status, install), "utf8");
    // stdin kept open: a -NoExit window left at its prompt waits there (as a
    // real one does for the user) instead of reading end-of-input and quitting.
    const child = spawn("powershell.exe", ["-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", script], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    started.push(child);
    return new Promise((resolveRun) => {
      const timer = setTimeout(() => resolveRun("still open"), waitMs);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolveRun(code ?? -1);
      });
    });
  }

  const report = (state: string): string =>
    `Set-Content -LiteralPath $env:GRANTED_STATUS_FILE -Value '{"state":"${state}","message":null,"pid":0}' -Encoding utf8`;
  /**
   * The install the way the real one-liner runs it: a script string through
   * `iex` (irm … | iex). The real install-windows.ps1 ends a successful run
   * with `return` and an error with `exit 1` (Die) -- which behave differently
   * inside iex, and that difference is what makes the window close or stay.
   */
  const viaIex = (body: string): string => `iex @'\r\n${body}\r\n'@`;

  test("done (the install script's `return`, run through iex): the window closes by itself (exit 0) a few seconds later", async () => {
    const t0 = Date.now();
    const result = await runWindow("done", viaIex(`${report("done")}\r\nreturn\r\nWrite-Host 'never'`), (INSTALL_WINDOW_CLOSE_SECONDS + 20) * 1000);
    assert.equal(result, 0);
    assert.ok(Date.now() - t0 >= INSTALL_WINDOW_CLOSE_SECONDS * 1000, "after the few seconds that let 'Installed' be read");
  });

  test("an error (the install script's Die: report, then `exit 1`, through iex): the window stays open", async () => {
    assert.equal(await runWindow("error", viaIex(`${report("error")}\r\nexit 1`), (INSTALL_WINDOW_CLOSE_SECONDS + 5) * 1000), "still open");
    // The stand-in really ran (so "still open" isn't just a slow start).
    assert.match(await readFile(join(root, "error.json"), "utf8"), /"state":"error"/);
  });

  test("no status at all (the install never got going): the window stays open", async () => {
    assert.equal(await runWindow("nothing", "Write-Host 'something went wrong before reporting'", (INSTALL_WINDOW_CLOSE_SECONDS + 5) * 1000), "still open");
  });

  test("REGRESSION (user, v0.2.0 install): GitHub unreachable -> a plain error in the status file, and the window stays open", async () => {
    const result = await runWindow("unreachable", windowsDownloadAndRun("http://127.0.0.1:9/install-windows.ps1", "v0.2.0", [1]), 25_000);
    assert.equal(result, "still open");
    const status = JSON.parse((await readFile(join(root, "unreachable.json"), "utf8")).replace(/^﻿/, "")) as { state: string; message: string };
    assert.equal(status.state, "error");
    assert.match(status.message, /^Couldn't download the Granted installer from GitHub \(.+\)\. Check your internet connection \(and your VPN, if you use one\), then click Try again\.$/);
  });

  test("a download that fails at first (a VPN reconnecting) is retried, and then the install runs", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      if (hits < 3) {
        res.writeHead(503);
        res.end("busy");
        return;
      }
      res.end(`${report("done")}
return
`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/install-windows.ps1`;
      const result = await runWindow("retried", windowsDownloadAndRun(url, null, [1, 1, 1]), (INSTALL_WINDOW_CLOSE_SECONDS + 30) * 1000);
      assert.equal(result, 0, "the install ran and the window closed itself");
      assert.equal(hits, 3);
    } finally {
      server.close();
    }
  });
});

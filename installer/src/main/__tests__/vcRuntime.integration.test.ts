/**
 * Integration: install-windows.ps1's Microsoft Visual C++ runtime step
 * (Get-MissingVCRuntime / Install-VCRuntime, extracted from the actual file
 * like installStatus.integration.test.ts does) in a real powershell.exe.
 *
 * The built-in search model's onnxruntime DLL needs msvcp140.dll,
 * msvcp140_1.dll, vcruntime140.dll and vcruntime140_1.dll, which a clean
 * Windows box lacks. The step installs them (winget, else Microsoft's
 * installer) and must never fail the install. A temp folder stands in for
 * System32 and script blocks stand in for winget and the download, so nothing
 * is really installed and no UAC prompt appears.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSTALL_SCRIPT = resolve(process.cwd(), "..", "install-windows.ps1");
const BOUNDARY = 'Write-Status "running" $null';
const DLLS = ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

function realHeaderBlock(): string {
  const source = readFileSync(INSTALL_SCRIPT, "utf8");
  const at = source.indexOf(BOUNDARY);
  assert.ok(at > 0, `install-windows.ps1 no longer contains '${BOUNDARY}'`);
  const header = source.slice(0, at);
  assert.ok(header.includes("function Install-VCRuntime"), "Install-VCRuntime must be defined before the script starts doing things");
  return header;
}

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

describe(
  "install-windows.ps1: the Visual C++ runtime step",
  { skip: (process.platform !== "win32" || !existsSync(INSTALL_SCRIPT)) && "Windows only, run from installer/" },
  () => {
    let dir: string;
    let n = 0;
    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "granted-vcruntime-it-"));
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    /** Runs `action` after the real header, with $sys a fake System32 holding `present`. */
    async function run(present: string[], action: string): Promise<{ code: number; out: string; sys: string }> {
      const name = `case${n++}`;
      const sys = join(dir, `${name}-system32`);
      await mkdir(sys, { recursive: true });
      for (const f of present) await writeFile(join(sys, f), "");
      const script = join(dir, `${name}.ps1`);
      const install = DLLS.map((f) => `Set-Content -LiteralPath (Join-Path $sys '${f}') -Value ''`).join("; ");
      await writeFile(
        script,
        `${realHeaderBlock()}\n$sys = ${psq(sys)}\n$installAll = { ${install} }\n${action}\n`,
        "utf8",
      );
      try {
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
          env: { ...process.env, GRANTED_STATUS_FILE: join(dir, `${name}-status.json`) },
          windowsHide: true,
        });
        return { code: 0, out: stdout, sys };
      } catch (e) {
        const err = e as { code?: number; stdout?: string };
        return { code: err.code ?? 1, out: err.stdout ?? "", sys };
      }
    }

    test("Get-MissingVCRuntime lists exactly the DLLs that aren't there", async () => {
      const { out } = await run(["msvcp140.dll", "vcruntime140.dll"], "(Get-MissingVCRuntime $sys) -join ','");
      assert.equal(out.trim(), "msvcp140_1.dll,vcruntime140_1.dll");
    });

    test("all four present: nothing is installed", async () => {
      const { out } = await run(DLLS, "$r = Install-VCRuntime -SystemDir $sys -UseWinget $true -WingetInstall { 'WINGET-RAN' } -DownloadInstall { 'DOWNLOAD-RAN' }; \"RESULT=$r\"");
      assert.match(out, /RESULT=True/);
      assert.doesNotMatch(out, /WINGET-RAN|DOWNLOAD-RAN/);
    });

    test("missing: winget installs it, and the download is never tried", async () => {
      const { out } = await run([], "$r = Install-VCRuntime -SystemDir $sys -UseWinget $true -WingetInstall $installAll -DownloadInstall { 'DOWNLOAD-RAN' }; \"RESULT=$r\"");
      assert.match(out, /RESULT=True/);
      assert.doesNotMatch(out, /DOWNLOAD-RAN/);
    });

    test("winget fails: Microsoft's installer is the fallback", async () => {
      const { out } = await run([], "$r = Install-VCRuntime -SystemDir $sys -UseWinget $true -WingetInstall { throw 'winget broke' } -DownloadInstall $installAll; \"RESULT=$r\"");
      assert.match(out, /winget didn't work \(winget broke\)/);
      assert.match(out, /RESULT=True/);
    });

    test("no winget: straight to Microsoft's installer", async () => {
      const { out } = await run([], "$r = Install-VCRuntime -SystemDir $sys -UseWinget $false -WingetInstall { 'WINGET-RAN' } -DownloadInstall $installAll; \"RESULT=$r\"");
      assert.match(out, /RESULT=True/);
      assert.doesNotMatch(out, /WINGET-RAN/);
    });

    test("everything fails: a warning naming keyword-only search and the download link, and the install carries on", async () => {
      const { code, out } = await run(
        [],
        "$r = Install-VCRuntime -SystemDir $sys -UseWinget $true -WingetInstall { throw 'no' } -DownloadInstall { throw 'offline' }; \"RESULT=$r\"; 'CARRIED-ON'",
      );
      assert.equal(code, 0);
      assert.match(out, /RESULT=False/);
      assert.match(out, /keyword-only mode/);
      assert.match(out, /aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe/);
      assert.match(out, /CARRIED-ON/);
    });
  },
);

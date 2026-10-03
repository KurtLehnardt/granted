import { clipboard, ipcMain } from "electron";
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  INSTALL_ONE_LINERS,
  NODE_MAJOR_MIN,
  type OpenInstallTerminalResult,
  type PrereqReport,
  type ToolCheckResult,
  isSupportedPlatform,
} from "../shared/ipc";

const execFileAsync = promisify(execFile);

/**
 * Runs `<cmd> --version` via array-arg execFile (never a shell string), and
 * extracts the first `major.minor.patch`-shaped version number it can find
 * in stdout. Missing binaries / non-zero exits are reported as
 * `present: false`, not thrown — a prereq check must never crash the UI.
 */
async function checkVersionedTool(cmd: string, args: string[]): Promise<ToolCheckResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000, windowsHide: true });
    const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return { present: true, version: stdout.trim() || null, major: null };
    }
    return {
      present: true,
      version: match[0],
      major: Number.parseInt(match[1], 10),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // Binary genuinely not found on PATH — the expected "not installed" case.
      return { present: false, version: null, major: null };
    }
    return {
      present: false,
      version: null,
      major: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkPrereqs(): Promise<PrereqReport> {
  const [git, node] = await Promise.all([
    checkVersionedTool("git", ["--version"]),
    checkVersionedTool("node", ["--version"]),
  ]);

  const nodeOk = node.present && node.major !== null && node.major >= NODE_MAJOR_MIN;

  return {
    platform: process.platform,
    git,
    node,
    nodeMajorMin: NODE_MAJOR_MIN,
    allSatisfied: git.present && nodeOk,
  };
}

/** AppleScript string-literal escaping (backslashes and double quotes only). */
function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function openInstallTerminal(): Promise<OpenInstallTerminalResult> {
  const platform = process.platform;

  if (!isSupportedPlatform(platform)) {
    return {
      ok: false,
      message: `Unsupported platform: ${platform}. Copy the install command manually from the README.`,
      command: "",
    };
  }

  const command = INSTALL_ONE_LINERS[platform];
  clipboard.writeText(command);

  try {
    if (platform === "darwin") {
      const script = escapeForAppleScript(command);
      await execFileAsync("osascript", [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        `tell application "Terminal" to do script "${script}"`,
      ]);
      return {
        ok: true,
        message: "Opened Terminal and started the installer. The command is also on your clipboard.",
        command,
      };
    }

    if (platform === "win32") {
      // The one-liner must NOT appear on powershell.exe's command line:
      // Microsoft Defender's cloud ML flags `-Command "irm <url> | iex"` as
      // Trojan:Win32/Commando.A!ml and blocks/kills the process (seen on
      // Windows 11, regardless of the parent process's signature). The same
      // one-liner run from inside a script file is not flagged, so write it
      // verbatim to a temp .ps1 and run that. -File (unlike -Command) also
      // keeps the -NoExit window open when install-windows.ps1 calls `exit 1`,
      // so the user can actually read the error.
      const scriptPath = join(tmpdir(), "granted-install.ps1");
      await writeFile(scriptPath, `${command}\r\n`, "utf8");
      // Launched via `start` rather than spawning powershell.exe directly:
      // libuv implements `detached` with DETACHED_PROCESS, which gives a
      // console app no console window at all (PowerShell then runs invisibly
      // and -NoExit exits on stdin EOF), while a non-detached child is
      // killed when the installer closes. `start` gives it a real, new
      // console window that outlives us. /s + verbatim args so cmd takes
      // the quoted script path literally even if it contains spaces.
      const child = spawn(
        "cmd.exe",
        [
          "/d",
          "/s",
          "/c",
          `"start "" powershell.exe -NoExit -ExecutionPolicy Bypass -File "${scriptPath}""`,
        ],
        {
          // install-windows.ps1 clones into .\granted relative to its working
          // directory. Without this it inherits ours — the app's own folder
          // (or wherever it was launched from) — so start in the user's home
          // folder, same as a freshly opened PowerShell window would.
          cwd: homedir(),
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          windowsVerbatimArguments: true,
        },
      );
      // spawn() reports launch failures (ENOENT, EPERM from AV, ...) via an
      // async 'error' event, not a throw — wait for it so the catch below
      // sees them instead of the main process crashing on an unhandled event.
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      const installDir = resolve(homedir(), process.env["GRANTED_INSTALL_DIR"] || "granted");
      return {
        ok: true,
        message: `Opened PowerShell and started the installer — Granted will be installed to ${installDir}. If that window closes before it finishes, paste the command from your clipboard into PowerShell.`,
        command,
      };
    }

    // linux: no uniform way to detect/launch a specific terminal emulator
    // across desktop environments. Clipboard + clear instructions is the
    // honest M1-scope answer rather than guessing at gnome-terminal/konsole/
    // xterm/etc.
    return {
      ok: true,
      message:
        "The install command has been copied to your clipboard. Open a terminal and paste it (Ctrl+Shift+V in most terminal emulators) to run it.",
      command,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Couldn't open a terminal automatically (${err instanceof Error ? err.message : String(err)}). The command is on your clipboard — paste it into a terminal.`,
      command,
    };
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle("prereqs:check", () => checkPrereqs());
  ipcMain.handle("terminal:open-install", () => openInstallTerminal());
}

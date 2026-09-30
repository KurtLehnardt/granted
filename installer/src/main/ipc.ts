import { clipboard, ipcMain } from "electron";
import { execFile, spawn } from "node:child_process";
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
      const child = spawn("powershell.exe", ["-NoExit", "-Command", command], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
      return {
        ok: true,
        message: "Opened PowerShell and started the installer. The command is also on your clipboard.",
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

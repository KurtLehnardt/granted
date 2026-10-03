/**
 * Shared IPC contract between main and renderer.
 *
 * Kept dependency-free (no Node/Electron/DOM imports) so it can be imported
 * from main, preload, and renderer code alike.
 */

/** Same floor as install-macos.sh / install-linux.sh / install-windows.ps1
 * and scaffold/scripts/setup.mjs's Node-version guard. Must stay in sync
 * with those — this is intentionally re-declared here rather than imported,
 * since installer/ does not depend on scaffold/ for M1. */
export const NODE_MAJOR_MIN = 22;

export type SupportedPlatform = "darwin" | "win32" | "linux";

export interface ToolCheckResult {
  /** Whether the binary was found and ran successfully. */
  present: boolean;
  /** Raw version string reported by the tool (e.g. "2.50.1", "v22.10.0"), or null if unavailable. */
  version: string | null;
  /** Parsed major version number, or null if it couldn't be parsed. */
  major: number | null;
  /** Error message if the check failed for a reason other than "not found". */
  error?: string;
}

export interface PrereqReport {
  /** process.platform's raw value (e.g. "darwin", "win32", "linux", ...). */
  platform: string;
  git: ToolCheckResult;
  node: ToolCheckResult;
  /** The minimum Node major version Granted requires (see NODE_MAJOR_MIN). */
  nodeMajorMin: number;
  /** True only when both git is present and node meets nodeMajorMin. */
  allSatisfied: boolean;
}

export interface OpenInstallTerminalResult {
  ok: boolean;
  /** Human-readable summary of what happened, for display in the UI. */
  message: string;
  /** The one-liner command that was run/copied, so the UI can also show it. */
  command: string;
  /**
   * Whether a `terminal:install-status` event will eventually follow this
   * call (currently: only a successful Windows launch). The renderer uses
   * this — rather than re-deriving "is this Windows" from separately
   * fetched prereq-check state — to decide whether to keep its UI in a
   * waiting state until that event arrives.
   */
  pollingStarted: boolean;
}

/**
 * Pushed from main → renderer once the escape-hatch's spawned install
 * actually finishes (or is given up on) — see ipc.ts's `pollInstallStatus`.
 * Currently only ever sent on win32: install-windows.ps1 is the only script
 * that reports a real sentinel back (macOS/Linux weren't found to have the
 * same false-success gap in validation, and extending this there is
 * unverified, not silently assumed done).
 */
export interface InstallStatusEvent {
  state: "running" | "done" | "error";
  message?: string | null;
}

/**
 * The exact, already-published, already-revalidated one-liners from the
 * README / install-*.sh / install-windows.ps1. Not reimplemented — just
 * referenced here so the GUI's escape hatch runs the identical command.
 */
export const INSTALL_ONE_LINERS: Record<SupportedPlatform, string> = {
  darwin:
    'bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-macos.sh)"',
  linux:
    'bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-linux.sh)"',
  win32:
    "irm https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-windows.ps1 | iex",
};

export function isSupportedPlatform(p: string): p is SupportedPlatform {
  return p === "darwin" || p === "win32" || p === "linux";
}

/** contextBridge surface exposed to the renderer as `window.api`. */
export interface GrantedInstallerApi {
  checkPrereqs: () => Promise<PrereqReport>;
  openInstallTerminal: () => Promise<OpenInstallTerminalResult>;
  /** Subscribe to install-status pushes (see InstallStatusEvent). Returns an unsubscribe function. */
  onInstallStatus: (listener: (status: InstallStatusEvent) => void) => () => void;
}

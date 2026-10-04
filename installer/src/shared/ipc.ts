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

/** Where Granted got installed, and how far its first-run setup already got. */
export interface GrantedSetupState {
  /** Absolute path of the clone (install-windows.ps1's $TargetDir, resolved). */
  installDir: string;
  /** True once the clone's scaffold/package.json exists. */
  installed: boolean;
  /** OPENAI_API_KEY and ANTHROPIC_API_KEY are both set to real (non-placeholder) values. */
  hostedKeysSet: boolean;
  /** `npm run setup:local` already pointed .env.local at Ollama. */
  localConfigured: boolean;
}

/** What the "Use my API keys" form sends. Blank = leave whatever is already there. */
export interface ApiKeysInput {
  openaiApiKey: string;
  anthropicApiKey: string;
  exaApiKey: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Pushed from main → renderer when a long-running "Open Granted" step
 * finishes: the fully-local setup (`npm run setup:local -- --yes`, which can
 * take half an hour) or starting the app itself (`npm run dev`, then waiting
 * for it to answer before opening the browser).
 */
export interface TaskStatusEvent {
  task: "local-setup" | "start-app";
  state: "done" | "error";
  message?: string | null;
  /** start-app only: where Granted is (or would have been) served. */
  url?: string;
}

/** contextBridge surface exposed to the renderer as `window.api`. */
export interface GrantedInstallerApi {
  checkPrereqs: () => Promise<PrereqReport>;
  openInstallTerminal: () => Promise<OpenInstallTerminalResult>;
  /** Subscribe to install-status pushes (see InstallStatusEvent). Returns an unsubscribe function. */
  onInstallStatus: (listener: (status: InstallStatusEvent) => void) => () => void;
  getSetupState: () => Promise<GrantedSetupState>;
  /** Writes the keys into scaffold/.env.local (same rules as scaffold/scripts/setup.mjs). */
  saveApiKeys: (keys: ApiKeysInput) => Promise<ActionResult>;
  /** Opens a PowerShell window running `npm run setup:local -- --yes`; a TaskStatusEvent follows. */
  runLocalSetup: () => Promise<ActionResult>;
  /** Starts `npm run dev` in its own window and opens the browser once it answers; a TaskStatusEvent follows. */
  startGranted: () => Promise<ActionResult>;
  onTaskStatus: (listener: (status: TaskStatusEvent) => void) => () => void;
  /** Closes the installer window. */
  quit: () => void;
}

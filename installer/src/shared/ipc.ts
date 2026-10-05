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
  /** OPENAI_API_KEY is set to a real (non-placeholder) value. */
  openaiKeySet: boolean;
  /** ANTHROPIC_API_KEY is set to a real (non-placeholder) value. */
  anthropicKeySet: boolean;
  /** What hosted (API-key) mode needs to run: the OpenAI key (search). The Anthropic key is optional. */
  hostedKeysSet: boolean;
  /** `npm run setup:local` finished: .env.local points at Ollama AND the corpus was re-embedded to match. */
  localConfigured: boolean;
  /** This install has scripts/windows/granted-tray.ps1, so Granted can run in the background with a tray icon. */
  trayAvailable: boolean;
  /** This install has scripts/windows/shortcuts.ps1, so Desktop/Start menu shortcuts can be offered. */
  shortcutsAvailable: boolean;
  /** This install has scripts/windows/open-granted.ps1, so Granted can open in its own window (Edge/Chrome app mode). */
  appWindowAvailable: boolean;
  /** The saved preference: open Granted in its own window, or in a browser tab. */
  openIn: OpenIn;
}

/** Where Granted opens: its own app window, or a tab in the default browser. */
export type OpenIn = "window" | "browser";

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
  /**
   * start-app only: Granted runs in the background with a tray icon
   * (scripts/windows/granted-tray.ps1) rather than in a console window the
   * user must keep open. False only for an older install without that script.
   */
  background?: boolean;
  /** start-app "done" only: whether Granted opened in its own window or a browser tab. */
  openedIn?: OpenIn;
}

/** saveApiKeys's result: `suggestLocal` = offer "use local models instead" (no usable search key was given). */
export interface SaveKeysResult extends ActionResult {
  suggestLocal?: boolean;
}

/** startGranted's result: `background` says whether it's starting in the background (tray icon) or a console window. */
export interface StartResult extends ActionResult {
  background?: boolean;
}

/** Which "Granted" shortcuts to create (the installer's checkboxes). */
export interface ShortcutChoice {
  desktop: boolean;
  startMenu: boolean;
}

export interface ShortcutsResult extends ActionResult {
  /** The .lnk files created. */
  created: string[];
}

/** contextBridge surface exposed to the renderer as `window.api`. */
export interface GrantedInstallerApi {
  checkPrereqs: () => Promise<PrereqReport>;
  openInstallTerminal: () => Promise<OpenInstallTerminalResult>;
  /** Subscribe to install-status pushes (see InstallStatusEvent). Returns an unsubscribe function. */
  onInstallStatus: (listener: (status: InstallStatusEvent) => void) => () => void;
  getSetupState: () => Promise<GrantedSetupState>;
  /** Writes the keys into scaffold/.env.local (same rules as scaffold/scripts/setup.mjs). */
  saveApiKeys: (keys: ApiKeysInput) => Promise<SaveKeysResult>;
  /** Opens a PowerShell window running `npm run setup:local -- --yes`; a TaskStatusEvent follows. */
  runLocalSetup: () => Promise<ActionResult>;
  /** Starts Granted in the background (tray icon) and opens it once it answers; a TaskStatusEvent follows. */
  startGranted: () => Promise<StartResult>;
  onTaskStatus: (listener: (status: TaskStatusEvent) => void) => () => void;
  /** Creates the "Granted" Desktop and/or Start menu shortcut. */
  createShortcuts: (choice: ShortcutChoice) => Promise<ShortcutsResult>;
  /** Saves where Granted opens from now on (the installer, the tray and the shortcuts all follow it). */
  setOpenIn: (openIn: OpenIn) => Promise<ActionResult>;
  /** Closes the installer window. */
  quit: () => void;
}

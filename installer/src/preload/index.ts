import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  ActionResult,
  ApiKeysInput,
  GrantedInstallerApi,
  GrantedSetupState,
  InstallStatusEvent,
  InstallVersionPlan,
  OpenIn,
  OpenInstallTerminalResult,
  PrereqReport,
  SaveKeysResult,
  ShortcutChoice,
  ShortcutsResult,
  StartResult,
  TaskStatusEvent,
} from "../shared/ipc";

/**
 * The ONLY surface exposed to the renderer. No raw `ipcRenderer` or
 * `require` ever crosses into the untrusted renderer context — every
 * exposed method is a specific, narrow, already-invoked call.
 */
const api: GrantedInstallerApi = {
  checkPrereqs: (): Promise<PrereqReport> => ipcRenderer.invoke("prereqs:check"),
  planInstallVersion: (checkForUpdates: boolean): Promise<InstallVersionPlan> =>
    ipcRenderer.invoke("install:plan-version", checkForUpdates),
  openInstallTerminal: (checkForUpdates: boolean): Promise<OpenInstallTerminalResult> =>
    ipcRenderer.invoke("terminal:open-install", checkForUpdates),
  onInstallStatus: (listener: (status: InstallStatusEvent) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: InstallStatusEvent): void => listener(status);
    ipcRenderer.on("terminal:install-status", handler);
    return () => ipcRenderer.removeListener("terminal:install-status", handler);
  },
  getSetupState: (): Promise<GrantedSetupState> => ipcRenderer.invoke("granted:get-setup-state"),
  saveApiKeys: (keys: ApiKeysInput): Promise<SaveKeysResult> => ipcRenderer.invoke("granted:save-api-keys", keys),
  runLocalSetup: (): Promise<ActionResult> => ipcRenderer.invoke("granted:run-local-setup"),
  startGranted: (): Promise<StartResult> => ipcRenderer.invoke("granted:start"),
  onTaskStatus: (listener: (status: TaskStatusEvent) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: TaskStatusEvent): void => listener(status);
    ipcRenderer.on("granted:task-status", handler);
    return () => ipcRenderer.removeListener("granted:task-status", handler);
  },
  createShortcuts: (choice: ShortcutChoice): Promise<ShortcutsResult> => ipcRenderer.invoke("granted:create-shortcuts", choice),
  setOpenIn: (openIn: OpenIn): Promise<ActionResult> => ipcRenderer.invoke("granted:set-open-in", openIn),
  quit: (): void => ipcRenderer.send("app:quit"),
  reportProblem: (message: string, where: string): Promise<ActionResult> => ipcRenderer.invoke("app:report-problem", message, where),
};

contextBridge.exposeInMainWorld("api", api);

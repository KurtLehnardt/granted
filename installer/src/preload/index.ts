import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  GrantedInstallerApi,
  InstallStatusEvent,
  OpenInstallTerminalResult,
  PrereqReport,
} from "../shared/ipc";

/**
 * The ONLY surface exposed to the renderer. No raw `ipcRenderer` or
 * `require` ever crosses into the untrusted renderer context — every
 * exposed method is a specific, narrow, already-invoked call.
 */
const api: GrantedInstallerApi = {
  checkPrereqs: (): Promise<PrereqReport> => ipcRenderer.invoke("prereqs:check"),
  openInstallTerminal: (): Promise<OpenInstallTerminalResult> =>
    ipcRenderer.invoke("terminal:open-install"),
  onInstallStatus: (listener: (status: InstallStatusEvent) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: InstallStatusEvent): void => listener(status);
    ipcRenderer.on("terminal:install-status", handler);
    return () => ipcRenderer.removeListener("terminal:install-status", handler);
  },
};

contextBridge.exposeInMainWorld("api", api);

import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { registerIpcHandlers, stopOllamaIfStarted, manageOllama } from "./ipc";

// Ubuntu 24.04+'s chrome-sandbox / unpacked-run issue (see installer's
// scripts/run-electron-vite.mjs for the full explanation) is NOT fixable
// here. A real validation pass proved Electron's native sandbox check
// aborts the process before any main-process JavaScript — including this
// file — ever runs, so an app.commandLine.appendSwitch("no-sandbox") call
// (tried first, here) can never execute in time. The actual fix has to
// set ELECTRON_DISABLE_SANDBOX in the environment the electron binary
// itself is launched with, before it starts — done in
// scripts/run-electron-vite.mjs, which `npm run dev`/`preview` now go
// through instead of calling electron-vite directly.

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 720,
    minHeight: 560,
    title: "Granted Installer",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      // Security baseline — non-negotiable, even for this minimal M1 UI.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Any link the renderer tries to open in a new window goes to the OS
  // browser instead of a second Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => {
  if (manageOllama) {
    stopOllamaIfStarted();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

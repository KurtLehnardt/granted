import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { registerIpcHandlers } from "./ipc";

// Linux only, unpacked (dev/source) runs only. A real Windows-VM-style
// validation pass on Ubuntu 24.04 found the app can't even launch from
// source there: `npm install` extracts chrome-sandbox as 755/non-root,
// but Ubuntu 24.04+ also restricts unprivileged user namespaces, so
// Chromium can't fall back to that sandboxing path either and aborts
// with a fatal SUID-sandbox error instead of showing a window. The
// correct fix for a REAL release is a properly packaged build (an
// electron-builder/etc. package sets chrome-sandbox's ownership/mode
// correctly at build time) — that doesn't exist yet, and until it does,
// `app.isPackaged` is false for every real user of this app, so this
// line would need to be revisited (not just left in place unexamined)
// once real Linux packaging lands. Must run before app.whenReady() —
// Chromium reads this switch during its own early startup.
if (process.platform === "linux" && !app.isPackaged) {
  app.commandLine.appendSwitch("no-sandbox");
}

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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

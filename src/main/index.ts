import { app, BrowserWindow, session } from "electron";
import { join } from "node:path";
import { bootstrap } from "../core/bootstrap";
import { CSP, DEV_CSP } from "./csp";
import { registerIpc } from "./ipc";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;

function installCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [DEV_URL ? DEV_CSP : CSP],
      },
    });
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: "DDD — De Developer Dashboard",
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    // Tauri's `Overlay` + `hiddenTitle`: on macOS the traffic lights sit over
    // the page and the stylesheet leaves them a lane (`data-platform="mac"`).
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}

/** `DDD_SMOKE=1`: prove preload, bridge and core meet, then quit. */
function smoke(win: BrowserWindow): void {
  win.webContents.once("did-finish-load", async () => {
    try {
      const g = (await win.webContents.executeJavaScript('window.ddd.invoke("global_load")')) as {
        environments: unknown[];
      };
      console.log(`ddd: smoke ok — ${g.environments.length} environment(s)`);
      app.exit(0);
    } catch (e) {
      console.error("ddd: smoke failed:", e);
      app.exit(1);
    }
  });
}

app.whenReady().then(() => {
  try {
    bootstrap();
  } catch (e) {
    console.error(`ddd: bootstrap failed: ${e instanceof Error ? e.message : e}`);
  }
  installCsp();
  registerIpc();
  const win = createWindow();
  if (process.env.DDD_SMOKE) smoke(win);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

import { app, BrowserWindow, session } from "electron";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../core/bootstrap";
import { CSP, DEV_CSP } from "./csp";
import { registerIpc } from "./ipc";
import { allowNavigation } from "./navigation";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;

/** The smoke never touches the real `~/.ddd` (spec §8): give it a scratch home
 *  unless the caller pinned one. Must run before `bootstrap()`. */
function smokeHomeIfNeeded(): void {
  if (process.env.DDD_SMOKE && !process.env.DDD_HOME) {
    const home = mkdtempSync(join(tmpdir(), "ddd-smoke-"));
    process.env.DDD_HOME = home;
    console.log(`ddd: smoke home → ${home}`);
  }
}

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
  // A reload is a navigation to the page's own URL and must get through;
  // everything else is refused. See navigation.ts.
  win.webContents.on("will-navigate", (e, url) => {
    if (!allowNavigation(win.webContents.getURL(), url)) e.preventDefault();
  });

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}

/** Registers a `securitypolicyviolation` listener, fires a cross-origin
 *  `fetch` the CSP's `connect-src 'self'` must refuse, and resolves whether a
 *  violation on `connect-src` was actually observed. Run through
 *  `executeJavaScript` so it sees the real, delivered policy — not the source
 *  string — under whatever load path the window used (`file://` or `app://`). */
const CSP_PROBE = `
  new Promise((resolve) => {
    let seen = false;
    document.addEventListener("securitypolicyviolation", (e) => {
      if (e.violatedDirective && e.violatedDirective.startsWith("connect-src")) seen = true;
    });
    fetch("https://example.invalid/").catch(() => {});
    setTimeout(() => resolve(seen), 500);
  })
`;

/** `DDD_SMOKE=1`: prove preload, bridge, core, node:sqlite, @napi-rs/keyring
 *  and the CSP all meet inside Electron's main process, then quit. */
function smoke(win: BrowserWindow): void {
  win.webContents.once("did-finish-load", async () => {
    try {
      const invoke = (cmd: string, args: unknown = {}) =>
        win.webContents.executeJavaScript(`window.ddd.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

      const g = (await invoke("global_load")) as { environments: unknown[] };
      await invoke("paths_info", { env: "default" });
      await invoke("event_log", { env: "default", event: { kind: "smoke.run" } });
      const rows = (await invoke("events_query", { env: "default", kindPrefix: "smoke." })) as unknown[];
      if (rows.length !== 1) throw new Error(`events_query: expected 1 row, got ${rows.length}`);
      const secretExists = await invoke("secret_exists", { env: "default", key: "smoke-none" });
      if (secretExists !== false) throw new Error(`secret_exists: expected false, got ${secretExists}`);

      const cspEnforced = (await win.webContents.executeJavaScript(CSP_PROBE)) as boolean;
      console.log(cspEnforced ? "ddd: smoke csp enforced" : "ddd: smoke csp NOT enforced");
      if (!cspEnforced) throw new Error("csp not enforced");

      console.log(
        `ddd: smoke ok — ${g.environments.length} environment(s), paths_info, event_log/events_query (1 row), secret_exists(false), csp enforced`,
      );
      const shotPath = process.env.DDD_SMOKE_SHOT;
      if (shotPath) {
        await new Promise((r) => setTimeout(r, 1500));
        const image = await win.webContents.capturePage();
        writeFileSync(shotPath, image.toPNG());
        console.log(`ddd: smoke shot → ${shotPath}`);
      }
      app.exit(0);
    } catch (e) {
      console.error("ddd: smoke failed:", e);
      app.exit(1);
    }
  });
}

app.whenReady().then(() => {
  smokeHomeIfNeeded();
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

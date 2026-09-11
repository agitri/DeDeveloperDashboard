import { app, BrowserWindow, session, shell } from "electron";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../core/bootstrap";
import { defaultGlobal } from "../core/models";
import { writeJson } from "../core/store";
import type { Emitter } from "../core/emitter";
import { ProjectWatcher } from "../core/watcher";
import * as secrets from "../core/secrets";
import type { SyncDeps } from "../core/sync/adapter";
import { Scheduler } from "../core/sync/scheduler";
import { CSP, DEV_CSP } from "./csp";
import { createCommands } from "./commands";
import { registerIpc } from "./ipc";
import { allowNavigation } from "./navigation";

const DEV_URL = process.env.ELECTRON_RENDERER_URL;

/** Every open window hears every event. There is one window today; the
 *  loop is what makes a second one free. */
const emitter: Emitter = {
  emit(name, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(name, payload);
      } catch {
        /* a window closing mid-send is not an error */
      }
    }
  },
};

const watcher = new ProjectWatcher(emitter);

/** Every request the sync engine makes gets a timeout; nothing in core can
 *  hang the scheduler on a silent socket. */
const timedFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });

const syncDeps: SyncDeps = {
  fetch: timedFetch,
  secrets,
  openUrl: (url) => shell.openExternal(url),
  emit: emitter,
};
const scheduler = new Scheduler(syncDeps);

/** The smoke never touches the real `~/.ddd` (spec §8): give it a scratch home
 *  unless the caller pinned one, and a scratch Electron profile always, so its
 *  localStorage never bleeds into the user's. Must run before the app is ready
 *  and before `bootstrap()`. The scratch home starts with `look: "console"`
 *  so the smoke can prove the preload seeds the look on a first boot. */
function smokeHomeIfNeeded(): void {
  if (!process.env.DDD_SMOKE) return;
  if (!process.env.DDD_HOME) {
    const home = mkdtempSync(join(tmpdir(), "ddd-smoke-"));
    process.env.DDD_HOME = home;
    const g = defaultGlobal();
    g.appearance.look = "console";
    writeJson(join(home, "global.json"), g);
    console.log(`ddd: smoke home → ${home}`);
  }
  app.setPath("userData", join(process.env.DDD_HOME, "electron-profile"));
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

      // First boot of a fresh profile whose global.json says Console: the
      // preload must have seeded the look before the page decided.
      const bootedLook = await win.webContents.executeJavaScript('document.documentElement.getAttribute("data-look")');
      if (bootedLook !== "console") throw new Error(`boot look: expected "console", got ${JSON.stringify(bootedLook)}`);

      const g = (await invoke("global_load")) as { environments: unknown[] };
      await invoke("paths_info", { env: "default" });
      await invoke("event_log", { env: "default", event: { kind: "smoke.run" } });
      const rows = (await invoke("events_query", { env: "default", kindPrefix: "smoke." })) as unknown[];
      if (rows.length !== 1) throw new Error(`events_query: expected 1 row, got ${rows.length}`);
      const secretExists = await invoke("secret_exists", { env: "default", key: "smoke-none" });
      if (secretExists !== false) throw new Error(`secret_exists: expected false, got ${secretExists}`);

      const none = (await invoke("projects_list", { env: "default" })) as unknown[];
      if (none.length !== 0) throw new Error(`projects_list: expected 0, got ${none.length}`);
      const home = process.env.DDD_HOME!;
      const card = (await invoke("project_register", { env: "default", path: home })) as { id: string; exists: boolean; git: { isRepo: boolean } };
      if (!card.exists || card.git.isRepo) throw new Error(`project_register: unexpected card ${JSON.stringify(card)}`);
      const one = (await invoke("projects_list", { env: "default" })) as unknown[];
      if (one.length !== 1) throw new Error(`projects_list: expected 1, got ${one.length}`);
      await invoke("editors_list");
      await invoke("terminals_list");

      // Prove ddd://project-changed travels end to end: a real filesystem
      // write, through the watcher and the emitter, out through the preload
      // bridge, into the renderer. The registered project root is the
      // scratch home itself, so .ddd does not exist at registration time and
      // the watcher is on the shallow root — mkdir .ddd alone is the
      // noticed event; the todos write is a second one for good measure.
      // `window.ddd.on` returns an unsubscribe function, which
      // executeJavaScript cannot clone back across IPC — discard it.
      await win.webContents.executeJavaScript(
        `window.ddd.on("ddd://project-changed", (p) => { window.__dddChanged = p; }); undefined;`,
      );
      mkdirSync(join(home, ".ddd"), { recursive: true });
      await new Promise((r) => setTimeout(r, 500));
      writeFileSync(join(home, ".ddd", "todos.json"), '{"todos":[]}');

      type Changed = { environmentId: string; projectId: string } | null;
      let changed: Changed = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        changed = (await win.webContents.executeJavaScript("window.__dddChanged")) as Changed;
        if (changed) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!changed || changed.projectId !== card.id) {
        throw new Error(`project-changed: expected projectId ${JSON.stringify(card.id)}, got ${JSON.stringify(changed)}`);
      }
      console.log("ddd: smoke project-changed ok");

      // The sync engine: a mock connection, one sync, reads, the gate, the event.
      await win.webContents.executeJavaScript(`window.ddd.on("ddd://items-changed", (p) => { window.__dddItems = p; }); undefined;`);
      const settings = (await invoke("settings_load", { env: "default" })) as { connections: unknown[] };
      settings.connections.push({ id: "mock-1", provider: "mock", label: "Mock", status: "disconnected", scopes: [], config: {}, lastSyncAt: null, error: null });
      await invoke("settings_save", { env: "default", settings });
      const synced = await invoke("sync_now", { env: "default" });
      if (synced !== 10) throw new Error(`sync_now: expected 10, got ${synced}`);
      const items = (await invoke("items_query", { env: "default", filter: { kind: "pull_request" } })) as { id: string }[];
      if (items.length !== 2) throw new Error(`items_query: expected 2 pull requests, got ${items.length}`);
      const outcome = (await invoke("item_action", { env: "default", itemId: items[0]!.id, action: "comment", input: "smoke" })) as string;
      if (!outcome.startsWith("mock: comment")) throw new Error(`item_action: ${outcome}`);
      const acted = (await invoke("events_query", { env: "default", kindPrefix: "item." })) as unknown[];
      if (acted.length !== 1) throw new Error(`events_query item.*: expected 1, got ${acted.length}`);
      const itemsChanged = (await win.webContents.executeJavaScript("window.__dddItems")) as { connectionId?: string } | undefined;
      if (itemsChanged?.connectionId !== "mock-1") throw new Error(`items-changed did not reach the renderer: ${JSON.stringify(itemsChanged)}`);
      await invoke("cache_clear", { env: "default" });
      console.log("ddd: smoke sync ok");

      const cspEnforced = (await win.webContents.executeJavaScript(CSP_PROBE)) as boolean;
      console.log(cspEnforced ? "ddd: smoke csp enforced" : "ddd: smoke csp NOT enforced");
      if (!cspEnforced) throw new Error("csp not enforced");

      console.log(
        `ddd: smoke ok — ${g.environments.length} environment(s), boot look seeded, paths_info, event_log/events_query (1 row), secret_exists(false), projects (register/list), project-changed, sync (mock: sync_now/items_query/item_action/items-changed), csp enforced`,
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

smokeHomeIfNeeded();

app.whenReady().then(() => {
  try {
    bootstrap();
  } catch (e) {
    console.error(`ddd: bootstrap failed: ${e instanceof Error ? e.message : e}`);
  }
  installCsp();
  registerIpc(createCommands({ emit: emitter, watcher, scheduler, sync: syncDeps }));
  if (!process.env.DDD_SMOKE) scheduler.start();
  const win = createWindow();
  if (process.env.DDD_SMOKE) smoke(win);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => scheduler.stop());

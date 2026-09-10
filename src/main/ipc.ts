/**
 * One channel, `ddd:invoke`, dispatching into the registry. The reply is an
 * envelope rather than a thrown error because Electron prefixes rejected
 * `handle` errors with "Error invoking remote method…", and the frontend
 * expects the Rust error's bare message.
 */
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { DddError } from "../core/error";
import type { Handler } from "./commands";
import { dispatch, type HostHandler } from "./dispatch";

const LAYOUT_FILTER = [{ name: "DDD layout", extensions: ["json"] }];

const owner = (event: unknown) => BrowserWindow.fromWebContents((event as IpcMainInvokeEvent).sender) ?? undefined;

/** The commands that were Tauri plugins: dialogs pick paths, the shell opens things. */
const host: Record<string, HostHandler> = {
  async dialog_save({ suggestedName }, event) {
    const r = await dialog.showSaveDialog(owner(event)!, { defaultPath: suggestedName, filters: LAYOUT_FILTER });
    return r.canceled || !r.filePath ? null : r.filePath;
  },
  async dialog_open_file(_args, event) {
    const r = await dialog.showOpenDialog(owner(event)!, { properties: ["openFile"], filters: LAYOUT_FILTER });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  async dialog_pick_directory(_args, event) {
    const r = await dialog.showOpenDialog(owner(event)!, { properties: ["openDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  async open_external({ url }) {
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      throw DddError.invalid(`not a URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw DddError.invalid(`refusing to open a ${parsed.protocol} URL`);
    }
    await shell.openExternal(parsed.toString());
  },
  /** Show a folder in the OS file manager. A directory on disk, never a URL. */
  reveal_path({ path }) {
    shell.showItemInFolder(String(path));
  },
};

export function registerIpc(commands: Record<string, Handler>): void {
  ipcMain.handle("ddd:invoke", (event, cmd: unknown, args: unknown) => dispatch(cmd, args, event, host, commands));
}

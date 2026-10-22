import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DddBridge } from "../shared/bridge";

type Envelope = { ok: true; value: unknown } | { ok: false; error: string };

const bridge: DddBridge = {
  async invoke(cmd, args) {
    const reply = (await ipcRenderer.invoke("ddd:invoke", cmd, args ?? {})) as Envelope;
    if (reply.ok) return reply.value as never;
    // Tauri rejected with the error's text as a bare string; so does this.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw reply.error;
  },
  on(event, handler) {
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on(event, wrapped);
    return () => {
      ipcRenderer.off(event, wrapped);
    };
  },
};

// The renderer picks its look from `localStorage["ddd:look"]` before React
// mounts (see src/renderer/src/lib/look.ts). The cache is per origin and per
// profile, so a first boot rendered Classic and then asked for a reload. The
// preload runs before any page script and shares the page's storage: seed it
// from global.json so the first paint is already the saved look.
// The preload compiles under the node tsconfig, without the DOM lib; this is
// the one page global it touches.
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
const look: unknown = ipcRenderer.sendSync("ddd:boot-look");
if (look === "console" || look === "classic") {
  try {
    if (localStorage.getItem("ddd:look") !== look) localStorage.setItem("ddd:look", look);
  } catch {
    /* storage unavailable: the renderer falls back to its own cache */
  }
}

contextBridge.exposeInMainWorld("ddd", bridge);

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DddBridge } from "../shared/bridge";

type Envelope = { ok: true; value: unknown } | { ok: false; error: string };

const bridge: DddBridge = {
  async invoke(cmd, args) {
    const reply = (await ipcRenderer.invoke("ddd:invoke", cmd, args ?? {})) as Envelope;
    if (reply.ok) return reply.value as never;
    // Tauri rejected with the error's text as a bare string; so does this.
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

contextBridge.exposeInMainWorld("ddd", bridge);

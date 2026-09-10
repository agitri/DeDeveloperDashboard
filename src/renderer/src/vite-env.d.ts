/// <reference types="vite/client" />

interface Window {
  /** Present only inside the Electron window. See src/shared/bridge.ts. */
  ddd?: import("../../shared/bridge").DddBridge;
}

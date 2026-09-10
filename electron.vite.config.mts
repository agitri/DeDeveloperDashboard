import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // externalizeDepsPlugin keeps node_modules as runtime requires, which is what
  // a native module (@napi-rs/keyring) needs.
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  // DEV_CSP hardcodes ws://localhost:5173 / http://localhost:5173 — pin the
  // dev server's port so it can never drift from what the policy allows.
  renderer: { plugins: [react()], server: { port: 5173, strictPort: true } },
});

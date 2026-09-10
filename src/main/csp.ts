/**
 * The webview's content policy, pinned. These are `tauri.conf.json`'s `csp`
 * and `devCsp` with the Tauri-only `ipc:` / `http://ipc.localhost` sources
 * removed — Electron's bridge is `contextBridge`, not a URL.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** electron-vite's dev server: a websocket for HMR and React's inline refresh preamble. */
export const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:5173 http://localhost:5173",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The value of one directive, or null when the policy does not set it. */
export function directive(policy: string, name: string): string | null {
  for (const part of policy.split(";")) {
    const [key, ...rest] = part.trim().split(/\s+/);
    if (key === name) return rest.join(" ");
  }
  return null;
}

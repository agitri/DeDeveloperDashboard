/**
 * What the preload exposes as `window.ddd`, and all the renderer ever sees of
 * Electron. `invoke` mirrors Tauri's: snake_case command, camelCase args, and
 * a failure rejects with the error's message as a bare string.
 */
export interface DddBridge {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a backend event. Returns the unsubscribe. */
  on(event: string, handler: (payload: unknown) => void): () => void;
}

/**
 * The look the window should boot with.
 *
 * The renderer decides between Console and Classic before React mounts, from
 * a localStorage cache (`ddd:look`), because settings only arrive later over
 * async IPC. That cache is per origin and per profile: the dev window on
 * `http://localhost` and the build on `file://` each start empty, so the first
 * boot of either rendered Classic and asked for a reload. The preload asks for
 * this value synchronously and seeds the cache before any page script runs.
 *
 * Reads the same `global.json` that `global_load` will read a moment later, so
 * a first run creates the file exactly once, here.
 */
import { globalLoad } from "../core/global";

export type Look = "console" | "classic";

/** `null` when the home cannot be read: the renderer then falls back to its
 *  own cache, which is what it did before this existed. */
export function bootLook(): Look | null {
  try {
    const look: unknown = globalLoad().appearance.look;
    return look === "console" || look === "classic" ? look : null;
  } catch {
    return null;
  }
}

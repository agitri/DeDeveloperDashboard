/**
 * The keymap's schema belongs to the frontend action registry, so the core
 * stores it verbatim rather than pretending to understand it. One keymap for
 * the whole app: shortcuts are muscle memory.
 */
import { EnvRoot, globalKeymapFile } from "./paths";
import { readJsonOpt, writeJson } from "./store";
import { globalLoad } from "./global";

export function keymapLoad(): unknown {
  const path = globalKeymapFile();
  const found = readJsonOpt(path);
  if (found !== null) return found;
  // Adopt whatever the active environment had, once, so a customised keymap
  // survives the move.
  const active = globalLoad().activeEnvironmentId;
  let legacy: unknown;
  try {
    legacy = readJsonOpt(EnvRoot.open(active).keymapFile());
  } catch {
    legacy = null;
  }
  if (legacy === null) return null;
  writeJson(path, legacy);
  return legacy;
}

export function keymapSave(keymap: unknown): void {
  writeJson(globalKeymapFile(), keymap);
}

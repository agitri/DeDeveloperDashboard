/**
 * `~/.ddd/global.json`: the environment list, the active one, and the one
 * appearance for the whole app. Port of the environment half of `commands.rs`.
 */
import { existsSync, rmSync } from "node:fs";
import { DddError } from "./error";
import { EnvRoot, globalFile } from "./paths";
import { readJson, readJsonOpt, writeJson } from "./store";
import { defaultGlobal, globalFromJson, type AppearanceSettings, type Global, type StoredGlobal } from "./models";
import { appearanceFromJson, settingsLoad } from "./settings";
import * as secrets from "./secrets";

export function globalLoad(): Global {
  const path = globalFile();
  if (!existsSync(path)) {
    const g = defaultGlobal();
    writeJson(path, g);
    return g;
  }
  // Rust's `read_json` returns `Global::default()` — appearance already filled,
  // no migration, no write — for a file that is missing or unparsable.
  const stored: StoredGlobal = readJson(path, globalFromJson, () => defaultGlobal() as StoredGlobal);
  if (stored.appearance === null) {
    stored.appearance = migrateAppearance(stored.activeEnvironmentId);
    // Written back once so the migration never runs again, and so the adopted
    // values are visible in the file the user can read.
    writeJson(path, stored);
  }
  return stored as Global;
}

/**
 * Appearance used to live in every environment's `settings.json`. Adopt the
 * active environment's copy so the app looks the same after the upgrade as it
 * did before it, then never look again. Read as raw JSON on purpose: `Settings`
 * no longer has the field.
 */
function migrateAppearance(activeEnv: string): AppearanceSettings {
  let root: EnvRoot;
  try {
    root = EnvRoot.open(activeEnv);
  } catch {
    return appearanceFromJson(null);
  }
  let raw: unknown = null;
  try {
    raw = readJsonOpt(root.settingsFile());
  } catch {
    raw = null;
  }
  const block = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).appearance : null;
  return appearanceFromJson(block);
}

function globalSave(g: Global): void {
  writeJson(globalFile(), g);
}

/** Appearance is one setting for the whole app, so it is saved on
 *  `global.json` rather than on whichever environment happened to be in front. */
export function globalAppearanceSave(appearance: AppearanceSettings): Global {
  const g = globalLoad();
  g.appearance = appearance;
  globalSave(g);
  return g;
}

export function environmentCreate(id: string, name: string, color: string): Global {
  const g = globalLoad();
  if (g.environments.some((e) => e.id === id)) {
    throw DddError.config(`environment ${JSON.stringify(id)} already exists`);
  }
  // Creating the root before recording it means a crash leaves an unused
  // directory, not a dangling reference the UI would choke on.
  EnvRoot.open(id);
  g.environments.push({ id, name, color, hidden: false, collapsed: false });
  globalSave(g);
  return g;
}

export interface EnvironmentPatch {
  name?: string;
  color?: string;
  hidden?: boolean;
  collapsed?: boolean;
}

export function environmentUpdate(id: string, patch: EnvironmentPatch): Global {
  const g = globalLoad();
  const env = g.environments.find((e) => e.id === id);
  if (!env) throw DddError.notFound(`environment ${JSON.stringify(id)}`);
  // `!= null` skips both undefined and null: a JSON-IPC caller sending an
  // absent field as `null` must never write a literal `null` into a field
  // that is a plain string/boolean on disk.
  if (patch.name != null) env.name = patch.name;
  if (patch.color != null) env.color = patch.color;
  if (patch.collapsed != null) env.collapsed = patch.collapsed;
  // Focus mode is a visibility toggle, never a data operation.
  if (patch.hidden != null) env.hidden = patch.hidden;
  globalSave(g);
  return g;
}

export function environmentSetActive(id: string): Global {
  const g = globalLoad();
  if (!g.environments.some((e) => e.id === id)) {
    throw DddError.notFound(`environment ${JSON.stringify(id)}`);
  }
  g.activeEnvironmentId = id;
  globalSave(g);
  return g;
}

/** Deleting an environment deletes *all* of its data: its directory and every
 *  keychain entry its connections own. */
export function environmentDelete(id: string): Global {
  const g = globalLoad();
  if (g.environments.length <= 1) {
    throw DddError.config("cannot delete the last environment");
  }
  const env = EnvRoot.open(id);
  try {
    for (const c of settingsLoad(env).connections) {
      try {
        secrets.del(env, c.id);
      } catch {
        // A keychain refusal must not strand the directory delete.
      }
    }
  } catch {
    // Unreadable settings: nothing to clean in the keychain.
  }
  if (existsSync(env.dir)) rmSync(env.dir, { recursive: true, force: true });
  g.environments = g.environments.filter((e) => e.id !== id);
  if (g.activeEnvironmentId === id) g.activeEnvironmentId = g.environments[0]!.id;
  globalSave(g);
  return g;
}

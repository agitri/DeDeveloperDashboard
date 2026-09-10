import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scratchEnv } from "../core/testing";
import { HOST_COMMANDS, commands } from "./commands";

const TAURI_LIB = resolve(__dirname, "../../../DDD/src-tauri/src/lib.rs");

/** The names Tauri registers, read from the source of truth when it is around. */
function tauriHandlers(): string[] | null {
  if (!existsSync(TAURI_LIB)) return null;
  const src = readFileSync(TAURI_LIB, "utf8");
  const block = src.slice(src.indexOf("generate_handler![") + "generate_handler![".length);
  const body = block.slice(0, block.indexOf("]"));
  return [...body.matchAll(/commands::(\w+)/g)].map((m) => m[1]!);
}

describe("the command registry", () => {
  it.skipIf(tauriHandlers() === null)("only registers names the Tauri app has, so the frontend contract holds", () => {
    const known = new Set(tauriHandlers()!);
    const invented = Object.keys(commands).filter((name) => !known.has(name) && !HOST_COMMANDS.includes(name));
    expect(invented).toEqual([]);
  });

  it("has every phase-0 command", () => {
    for (const name of [
      "global_load", "global_appearance_save",
      "environment_create", "environment_update", "environment_set_active", "environment_delete",
      "layout_load", "layout_save", "layout_file_write", "layout_file_read",
      "settings_load", "settings_save", "keymap_load", "keymap_save",
      "event_log", "events_query", "events_clear",
      "secret_set", "secret_exists", "secret_delete",
      "paths_info", "path_exists",
    ]) {
      expect(commands[name], name).toBeTypeOf("function");
    }
  });

  it("dispatches with the Tauri argument keys", async () => {
    const { home } = scratchEnv("registry");
    const g = (await commands.global_load!({})) as { activeEnvironmentId: string };
    expect(g.activeEnvironmentId).toBe("default");
    await commands.environment_create!({ id: "work", name: "Work", color: "#000" });
    await commands.layout_save!({ env: "work", layout: { version: 1, groups: [], tabs: [] } });
    expect(await commands.path_exists!({ path: `${home}/environments/work/layout.json` })).toBe(true);
    await commands.event_log!({ env: "work", event: { kind: "tab.switch" } });
    const rows = (await commands.events_query!({ env: "work", kindPrefix: "tab." })) as unknown[];
    expect(rows).toHaveLength(1);
    const info = (await commands.paths_info!({ env: "work" })) as { environmentDir: string };
    expect(info.environmentDir).toBe(`${home}/environments/work`);
  });

  it("validates layout_save's input instead of writing it as-is", async () => {
    const { home } = scratchEnv("registry-layout-validate");
    expect(() =>
      commands.layout_save!({ env: "default", layout: { tabs: [{ id: "t" }] } }),
    ).toThrow(/missing field `name`/);

    await commands.layout_save!({ env: "default", layout: { tabs: [{ id: "t", name: "T" }] } });
    const onDisk = JSON.parse(readFileSync(`${home}/environments/default/layout.json`, "utf8"));
    expect(onDisk.tabs[0].widgets).toEqual([]);
    expect(onDisk.groups).toEqual([]);
  });
});

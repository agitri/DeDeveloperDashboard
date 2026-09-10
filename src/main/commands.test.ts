import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scratchEnv } from "../core/testing";
import { HOST_COMMANDS, createCommands } from "./commands";
import { recordingEmitter } from "../core/emitter";

const commands = createCommands({ emit: recordingEmitter() });

const TAURI_LIB = resolve(__dirname, "../../../DDD/src-tauri/src/lib.rs");

/** The names Tauri registers, read from the source of truth when it is around. */
function tauriHandlers(): string[] | null {
  if (!existsSync(TAURI_LIB)) return null;
  const src = readFileSync(TAURI_LIB, "utf8");
  const block = src.slice(src.indexOf("generate_handler![") + "generate_handler![".length);
  const body = block.slice(0, block.indexOf("]"));
  return [...body.matchAll(/commands::(\w+)/g)].map((m) => m[1]!);
}

/**
 * Every Tauri command phase 0 has deliberately not ported yet. Built from the
 * diff of the two lists at the time of writing — a NEW command landing in
 * `lib.rs` is not in this set, so it fails the test below until someone
 * acknowledges it here (by porting it, or by adding it to this list).
 */
const NOT_YET_PORTED = new Set([
  "projects_list",
  "project_register",
  "project_unregister",
  "editors_list",
  "terminals_list",
  "launch_path",
  "open_in_editor",
  "project_reload",
  "project_launch",
  "items_query",
  "repos_list",
  "repo_add_local",
  "repo_forget",
  "calendar_list",
  "calendar_event_save",
  "calendar_event_delete",
  "repo_scan",
  "repo_link",
  "repo_unlink",
  "repo_clone",
  "dev_servers_list",
  "dev_server_probe",
  "dev_server_stop",
  "widget_instructions_load",
  "widget_instructions_save",
  "widget_instructions_clear",
  "widget_instructions_template",
  "widget_instructions_compile",
  "eol_board",
  "eol_watch",
  "eol_unwatch",
  "eol_watchlist",
  "products_list",
  "product_approve",
  "product_revoke",
  "product_start",
  "product_stop",
  "product_log",
  "mcp_consent",
  "mcp_probe",
  "sync_now",
  "item_action",
  "cache_clear",
  "ai_actions_for",
  "ai_draft",
  "ai_context_for",
  "connection_connect",
  "connection_uses_oauth",
]);

describe("the command registry", () => {
  it.skipIf(tauriHandlers() === null)("only registers names the Tauri app has, so the frontend contract holds", () => {
    const known = new Set(tauriHandlers()!);
    const invented = Object.keys(commands).filter((name) => !known.has(name) && !HOST_COMMANDS.includes(name));
    expect(invented).toEqual([]);
  });

  it.skipIf(tauriHandlers() === null)(
    "every Tauri command is either registered or acknowledged as not yet ported",
    () => {
      const unaccountedFor = tauriHandlers()!.filter(
        (name) => !(name in commands) && !NOT_YET_PORTED.has(name),
      );
      expect(unaccountedFor).toEqual([]);
    },
  );

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

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve, join } from "node:path";
import { scratchEnv } from "../core/testing";
import { HOST_COMMANDS, createCommands } from "./commands";
import { recordingEmitter } from "../core/emitter";
import { ProjectWatcher } from "../core/watcher";

const emitter = recordingEmitter();
const watcher = new ProjectWatcher(emitter);
const commands = createCommands({ emit: emitter, watcher });
afterAll(() => watcher.close());

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

describe("project commands", () => {
  it("register, list, reload, unregister — with the Tauri argument keys", async () => {
    scratchEnv("registry-projects");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-proj-")));
    mkdirSync(join(dir, ".ddd"));
    writeFileSync(join(dir, ".ddd", "config.json"), JSON.stringify({ name: "Cmd" }));

    expect(await commands.projects_list!({ env: "default" })).toEqual([]);
    const card = (await commands.project_register!({ env: "default", path: dir })) as { id: string; name: string; exists: boolean };
    expect(card.name).toBe("Cmd");
    expect(card.exists).toBe(true);
    const listed = (await commands.projects_list!({ env: "default" })) as { id: string }[];
    expect(listed.map((p) => p.id)).toEqual([card.id]);
    const reloaded = (await commands.project_reload!({ env: "default", id: card.id })) as { name: string };
    expect(reloaded.name).toBe("Cmd");
    await expect(commands.project_reload!({ env: "default", id: "nope" })).rejects.toThrow('project "nope"');
    await commands.project_unregister!({ env: "default", id: card.id });
    expect(await commands.projects_list!({ env: "default" })).toEqual([]);
  });

  it("lists editors and terminals without throwing", async () => {
    expect(Array.isArray(await commands.editors_list!({}))).toBe(true);
    expect(Array.isArray(await commands.terminals_list!({}))).toBe(true);
  });

  it("launching a project logs an event and honours a project's own terminal template", async () => {
    const { env } = scratchEnv("registry-launch");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-launch-")));
    const proof = join(dir, "proof.txt");
    mkdirSync(join(dir, ".ddd"));
    // The project's config wins over the global terminal, and a template is
    // a full command — so this launches nothing visible.
    writeFileSync(join(dir, ".ddd", "config.json"), JSON.stringify({ terminal: `/bin/sh -c "echo {cmd} > ${proof}"` }));
    const card = (await commands.project_register!({ env: "default", path: dir })) as { id: string };
    await commands.project_launch!({ env: "default", id: card.id });
    for (let i = 0; i < 50 && !existsSync(proof); i++) await new Promise((r) => setTimeout(r, 20));
    expect(readFileSync(proof, "utf8").trim()).toBe("claude");
    const rows = (await commands.events_query!({ env: "default", kindPrefix: "project." })) as { kind: string; project: string }[];
    expect(rows[0]).toMatchObject({ kind: "project.launch", project: basename(dir) });
    void env;
  });

  it("refuses to launch or open what is not there", async () => {
    await expect(commands.launch_path!({ path: "/nowhere/at/all" })).rejects.toThrow("is not a directory");
    await expect(commands.open_in_editor!({ path: "/nowhere/at/all" })).rejects.toThrow("is not a directory");
  });
});
